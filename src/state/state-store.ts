// state.json задачи: загрузка, commit с outbox, создание задачи (02-storage.md §3, §7).
//
// Два режима чтения:
// - read()  — без lock-а (status, history, меню): ничего не пишет, недоставленный outbox
//             возвращается отдельно, оборванный хвост журнала пропускается;
// - load()  — под lock-ом: контроль подмены, ремонт хвоста журнала, доставка outbox.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EventActor, EventPayloads, EventType, TaskEvent } from "../domain/events.js";
import { checkInvariants, haltedState, type TaskState } from "../domain/task-state.js";
import { StateVersionConflictError, TaskCorruptedError, TaskNotFoundError } from "../errors/errors.js";
import type { Clock } from "../util/clock.js";
import { noFaults, type FaultInjector } from "../util/fault.js";
import { randomHex, type IdGenerator } from "../util/ids.js";
import { writeFileAtomic } from "./atomic-file.js";
import { EventJournal, fileStamp } from "./event-store.js";
import { taskLayout, type ProjectLayout, type TaskLayout } from "./layout.js";
import { describeZodIssues, taskStateSchema } from "./state-schema.js";

/** Сколько последних событий журнала сверяется с outbox (02-storage.md §7.3). */
const OUTBOX_TAIL = 64;

export type CommitContext = {
  /** Время записи (ISO 8601 UTC), одно на всю транзакцию */
  now: string;
  /**
   * Добавить событие в транзакцию. Возвращает его id: на него можно сослаться в state или другом событии.
   * Payload можно передать функцией от id, если событие ссылается само на себя (human.requested.requestId).
   */
  emit<K extends EventType>(type: K, actor: EventActor, payload: EventPayloads[K] | ((id: string) => EventPayloads[K])): string;
};

/** Чистая функция: новый state по текущему. События добавляются через ctx.emit. */
export type Mutator = (state: TaskState, ctx: CommitContext) => TaskState;

/** Начальный state без полей, которые проставляет хранилище. */
export type NewTaskState = Omit<TaskState, "version" | "updatedAt" | "outbox" | "lastEventId">;

export type TaskSnapshot = {
  state: TaskState;
  /** Последние события журнала (до 64), по порядку */
  recent: TaskEvent[];
  /** События outbox, которых ещё нет в журнале */
  undelivered: TaskEvent[];
};

export type StoreDeps = {
  layout: ProjectLayout;
  clock: Clock;
  ids: IdGenerator;
  faults?: FaultInjector;
  /** После каждой записи state (обновление index.json). Ошибки только логируются. */
  afterCommit?: (state: TaskState) => Promise<void>;
  log?: (message: string) => void;
};

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

function serialize(state: TaskState): string {
  return JSON.stringify(state, null, 2) + "\n";
}

export class TaskStore {
  private readonly faults: FaultInjector;
  /** Последняя запись этого процесса по каждой задаче: hash файла и сам state (02-storage.md §7.5) */
  private readonly written = new Map<string, { hash: string; state: TaskState }>();

  constructor(private readonly deps: StoreDeps) {
    this.faults = deps.faults ?? noFaults;
  }

  task(key: string): TaskLayout {
    return taskLayout(this.deps.layout, key);
  }

  journal(key: string): EventJournal {
    return new EventJournal(this.task(key).events, key);
  }

  /** Имена каталогов задач. Скрытые (временные каталоги создания) пропускаются. */
  async listKeys(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.deps.layout.tasksDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name).sort();
  }

  // ---------- чтение ----------

  private async readStateFile(key: string): Promise<{ state: TaskState; bytes: Buffer }> {
    const t = this.task(key);
    let bytes: Buffer;
    try {
      bytes = await readFile(t.state);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const dirExists = await stat(t.dir).then((s) => s.isDirectory(), () => false);
      if (dirExists) throw new TaskCorruptedError(key, t.state, "нет state.json");
      throw new TaskNotFoundError(`Задача ${key} не найдена.`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString("utf8"));
    } catch (err) {
      throw new TaskCorruptedError(key, t.state, `state.json не разбирается как JSON (${(err as Error).message})`);
    }
    const parsed = taskStateSchema.safeParse(raw);
    if (!parsed.success) throw new TaskCorruptedError(key, t.state, describeZodIssues(parsed.error));
    const state = parsed.data as TaskState;
    const violations = checkInvariants(state, key);
    if (violations.length > 0) throw new TaskCorruptedError(key, t.state, violations.join("; "));
    return { state, bytes };
  }

  /** Событие без изменения state (02-storage.md §6.2: «Меняет state = нет»): прямо в журнал. */
  async appendDirect<K extends EventType>(key: string, type: K, actor: EventActor, payload: EventPayloads[K]): Promise<TaskEvent> {
    const state = await this.load(key);
    const tail = await this.journal(key).readTail(1);
    const after = [state.lastEventId, tail.events.at(-1)?.id].filter((x): x is string => !!x).sort().at(-1) ?? null;
    const event = {
      id: this.deps.ids.next(after),
      timestamp: this.deps.clock.now().toISOString(),
      taskKey: key,
      type,
      stateVersion: state.version,
      actor,
      payload,
    } as TaskEvent;
    await this.journal(key).append([event]);
    return event;
  }

  /** Только state.json, без журнала. */
  async readState(key: string): Promise<TaskState> {
    return (await this.readStateFile(key)).state;
  }

  /** Чтение без записи: для процессов без lock-а. */
  async read(key: string): Promise<TaskSnapshot> {
    const { state } = await this.readStateFile(key);
    const tail = await this.journal(key).readTail(OUTBOX_TAIL);
    return { state, recent: tail.events, undelivered: undeliveredOutbox(state, tail.events) };
  }

  /**
   * Загрузка под lock-ом. Подмена state после нашей записи → blocked/STATE_TAMPERED;
   * оборванный хвост журнала переносится в .corrupt-файл; недоставленный outbox дописывается.
   */
  async load(key: string): Promise<TaskState> {
    const { state, bytes } = await this.readStateFile(key);
    const mine = this.written.get(key);
    if (mine && mine.hash !== sha256(bytes)) return this.blockTampered(key, bytes, mine.state);

    const journal = this.journal(key);
    let tail = await journal.readTail(OUTBOX_TAIL);
    let repaired: { movedTo: string; bytes: number } | null = null;
    if (tail.broken) {
      const movedTo = await journal.cutBrokenTail(tail.broken, fileStamp(this.deps.clock.now()));
      repaired = { movedTo: path.basename(movedTo), bytes: tail.broken.bytes.length };
      this.deps.log?.(`${key}: оборванный хвост журнала перенесён в ${movedTo}`);
      tail = await journal.readTail(OUTBOX_TAIL);
    }
    await journal.append(undeliveredOutbox(state, tail.events));
    this.written.set(key, { hash: sha256(bytes), state });

    if (!repaired) return state;
    const details = repaired;
    return this.commit(key, (s, ctx) => {
      ctx.emit("runtime.recovered", "cli", { phase: s.phase, action: "truncated_event_tail", details });
      return s;
    });
  }

  // ---------- запись ----------

  /** Транзакция state + events (02-storage.md §7.3). Возвращает записанный state. */
  async commit(key: string, mutator: Mutator, opts: { expectedVersion?: number } = {}): Promise<TaskState> {
    const current = await this.load(key);
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== current.version) {
      throw new StateVersionConflictError(
        `Задача ${key}: ожидалась версия state ${opts.expectedVersion}, текущая ${current.version}`,
      );
    }
    const { ctx, events } = this.transaction(key, current.version + 1, current.lastEventId);
    const next = mutator(structuredClone(current), ctx);
    return this.write(key, this.finalize(next, current.version + 1, ctx.now, events, current.lastEventId), events);
  }

  /**
   * Создание задачи: каталог собирается под временным именем и переименовывается целиком,
   * поэтому наполовину созданной задачи не бывает. Существование ключа проверяет вызывающий код под lock-ом.
   */
  async create(
    key: string,
    build: (ctx: CommitContext) => NewTaskState,
    files: { taskMd: (now: string) => string },
  ): Promise<TaskState> {
    const t = this.task(key);
    const { ctx, events } = this.transaction(key, 1, null);
    const state = this.finalize({ ...build(ctx), version: 1, updatedAt: ctx.now, outbox: [], lastEventId: "" }, 1, ctx.now, events, null);
    this.assertValid(state, key);

    await mkdir(this.deps.layout.tasksDir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.deps.layout.tasksDir, `.new-${process.pid}-${randomHex(4)}-${key}`);
    try {
      await mkdir(tmp, { mode: 0o700 });
      for (const dir of ["artifacts", "runs", "sessions"]) await mkdir(path.join(tmp, dir), { mode: 0o700 });
      await writeFile(path.join(tmp, "task.md"), files.taskMd(ctx.now), { mode: 0o600 });
      await writeFileAtomic(path.join(tmp, "state.json"), serialize(state));
      if (await stat(t.dir).then(() => true, () => false)) throw new Error(`Каталог задачи ${t.dir} уже существует`);
      await rename(tmp, t.dir);
    } catch (err) {
      await rm(tmp, { recursive: true, force: true });
      throw err;
    }
    this.written.set(key, { hash: sha256(serialize(state)), state });
    return this.afterWrite(key, state, events);
  }

  // ---------- внутреннее ----------

  private transaction(key: string, version: number, lastEventId: string | null) {
    const now = this.deps.clock.now().toISOString();
    const events: TaskEvent[] = [];
    let last = lastEventId;
    const ctx: CommitContext = {
      now,
      emit: (type, actor, payload) => {
        const id = this.deps.ids.next(last);
        last = id;
        const body = typeof payload === "function" ? payload(id) : payload;
        events.push({ id, timestamp: now, taskKey: key, type, stateVersion: version, actor, payload: body } as TaskEvent);
        return id;
      },
    };
    return { ctx, events };
  }

  private finalize(
    next: TaskState,
    version: number,
    now: string,
    events: TaskEvent[],
    previousLastEventId: string | null,
  ): TaskState {
    const lastEventId = events.at(-1)?.id ?? previousLastEventId;
    if (!lastEventId) throw new Error("Первая запись state должна содержать хотя бы одно событие");
    return { ...next, version, updatedAt: now, outbox: events, lastEventId };
  }

  private assertValid(state: TaskState, key: string): void {
    const violations = checkInvariants(state, key);
    // Нарушение здесь — ошибка логики вызывающего кода, а не повреждение файла: на диск не пишем
    if (violations.length > 0) throw new Error(`Задача ${key}: запись нарушает инварианты state: ${violations.join("; ")}`);
  }

  private async write(key: string, state: TaskState, events: TaskEvent[]): Promise<TaskState> {
    this.assertValid(state, key);
    const data = serialize(state);
    await writeFileAtomic(this.task(key).state, data); // ← точка коммита
    this.written.set(key, { hash: sha256(data), state });
    return this.afterWrite(key, state, events);
  }

  private async afterWrite(key: string, state: TaskState, events: TaskEvent[]): Promise<TaskState> {
    const info = { events: events.map((e) => e.type) };
    this.faults.check("after-state-commit", info);
    await this.journal(key).append(events);
    this.faults.check("after-event-append", info);
    try {
      await this.deps.afterCommit?.(state);
    } catch (err) {
      this.deps.log?.(`${key}: index.json не обновлён: ${(err as Error).message}`);
    }
    return state;
  }

  /** state.json изменён не этим процессом (02-storage.md §7.5). */
  private async blockTampered(key: string, bytes: Buffer, lastGood: TaskState): Promise<TaskState> {
    const t = this.task(key);
    const now = this.deps.clock.now();
    const copy = `${t.state}.tampered-${fileStamp(now)}`;
    await writeFileAtomic(copy, bytes);
    this.deps.log?.(`${key}: state.json изменён извне, копия сохранена в ${copy}`);

    // Журнал мог не получить события последней нашей записи
    const tail = await this.journal(key).readTail(OUTBOX_TAIL);
    await this.journal(key).append(undeliveredOutbox(lastGood, tail.events));

    const version = lastGood.version + 1;
    const { ctx, events } = this.transaction(key, version, lastGood.lastEventId);
    const message = `state.json изменён не процессом sdlc; изменённая копия: ${path.basename(copy)}`;
    ctx.emit("task.blocked", "cli", { code: "STATE_TAMPERED", message, by: "cli" });
    const blocked = haltedState(structuredClone(lastGood), "blocked", { code: "STATE_TAMPERED", message, at: ctx.now });
    return this.write(key, this.finalize(blocked, version, ctx.now, events, lastGood.lastEventId), events);
  }
}

/**
 * События outbox, которых нет в журнале: id не встречается среди последних событий
 * и больше максимального id журнала (ULID монотонны, сравнение лексикографическое).
 */
export function undeliveredOutbox(state: TaskState, journalTail: readonly TaskEvent[]): TaskEvent[] {
  const ids = new Set(journalTail.map((e) => e.id));
  const maxId = journalTail.at(-1)?.id ?? null;
  return state.outbox.filter((e) => !ids.has(e.id) && (maxId === null || e.id > maxId));
}
