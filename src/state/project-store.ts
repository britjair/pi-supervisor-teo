// Хранилище проекта .sdlc/ целиком: задачи, index, lock, снимки Policy (02-storage.md).

import { mkdir, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getStage, type LoadedPolicy } from "../domain/policy.js";
import { TaskCorruptedError, TaskNotFoundError } from "../errors/errors.js";
import { PolicySnapshotStore } from "../policy/snapshot-store.js";
import type { Clock } from "../util/clock.js";
import { onCleanup } from "../util/cleanup.js";
import type { FaultInjector } from "../util/fault.js";
import type { IdGenerator } from "../util/ids.js";
import { IndexStore, indexEntry, indexMatches } from "./index-store.js";
import { GITIGNORE_CONTENT, projectLayout, type ProjectLayout } from "./layout.js";
import { LockManager, pidAlive, type HeldLock } from "./lock-manager.js";
import { TaskStore, type TaskSnapshot } from "./state-store.js";
import { findCaseInsensitive } from "./task-key.js";

export type ProjectDeps = {
  projectRoot: string;
  /** null — только для doctor при невалидной Policy: названия этапов тогда неизвестны */
  policy: LoadedPolicy | null;
  clock: Clock;
  ids: IdGenerator;
  faults?: FaultInjector;
  hostname: string;
  pid: number;
  processStartedAt: string;
  isAlive?: (pid: number) => boolean;
  heartbeatMs?: number;
  log?: (message: string) => void;
};

export type TaskListing =
  | { key: string; ok: true; snapshot: TaskSnapshot }
  | { key: string; ok: false; error: TaskCorruptedError };

/** Временный файл writeFileAtomic: .<name>.<pid>.<hex>.tmp */
const TMP_FILE_RE = /^\..+\.(\d+)\.[0-9a-f]+\.tmp$/;
/** Временный каталог создания задачи: .new-<pid>-<hex>-<key> */
const NEW_TASK_DIR_RE = /^\.new-(\d+)-[0-9a-f]+-/;

export class ProjectStore {
  readonly layout: ProjectLayout;
  readonly tasks: TaskStore;
  readonly index: IndexStore;
  readonly locks: LockManager;
  readonly snapshots: PolicySnapshotStore;
  private readonly isAlive: (pid: number) => boolean;

  constructor(private readonly deps: ProjectDeps) {
    this.layout = projectLayout(deps.projectRoot);
    this.isAlive = deps.isAlive ?? pidAlive;
    this.index = new IndexStore(this.layout.index, deps.clock);
    this.tasks = new TaskStore({
      layout: this.layout,
      clock: deps.clock,
      ids: deps.ids,
      ...(deps.faults ? { faults: deps.faults } : {}),
      ...(deps.log ? { log: deps.log } : {}),
      afterCommit: (state) => this.index.upsert(indexEntry(state, this.stageTitle)),
    });
    this.locks = new LockManager({
      file: this.layout.lock,
      clock: deps.clock,
      hostname: deps.hostname,
      pid: deps.pid,
      processStartedAt: deps.processStartedAt,
      isAlive: this.isAlive,
      ...(deps.heartbeatMs !== undefined ? { heartbeatMs: deps.heartbeatMs } : {}),
    });
    this.snapshots = new PolicySnapshotStore(this.layout.policiesDir);
  }

  /** Название этапа по текущей Policy; null — этапа в Policy нет. */
  readonly stageTitle = (stageId: string): string | null =>
    this.deps.policy ? (getStage(this.deps.policy.spec, stageId)?.title ?? null) : null;

  get policy(): LoadedPolicy {
    if (!this.deps.policy) throw new Error("Хранилище открыто без Policy");
    return this.deps.policy;
  }

  async sdlcExists(): Promise<boolean> {
    return stat(this.layout.sdlcDir).then(
      (s) => s.isDirectory(),
      () => false,
    );
  }

  /** Создать .sdlc/ и .sdlc/.gitignore (D18). Только для mutating-операций после preflight. */
  async ensureSdlcDir(): Promise<void> {
    await mkdir(this.layout.sdlcDir, { recursive: true, mode: 0o700 });
    await writeFile(this.layout.gitignore, GITIGNORE_CONTENT, { flag: "wx", mode: 0o644 }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
  }

  /** Все задачи проекта без записи на диск. Повреждённые возвращаются с ошибкой, а не бросают. */
  async listTasks(): Promise<TaskListing[]> {
    const out: TaskListing[] = [];
    for (const key of await this.tasks.listKeys()) {
      try {
        out.push({ key, ok: true, snapshot: await this.tasks.read(key) });
      } catch (err) {
        if (err instanceof TaskCorruptedError) out.push({ key, ok: false, error: err });
        else if (err instanceof TaskNotFoundError) continue; // каталог удалили между readdir и чтением
        else throw err;
      }
    }
    return out;
  }

  /** Ключ задачи в том регистре, в котором создан каталог; null — задачи нет. */
  async resolveKey(input: string): Promise<string | null> {
    return findCaseInsensitive(input, await this.tasks.listKeys());
  }

  /** Ключ существующей задачи или TaskNotFoundError (exit 4). */
  async requireKey(input: string): Promise<string> {
    const key = (await this.sdlcExists()) ? await this.resolveKey(input) : null;
    if (!key) throw new TaskNotFoundError(`Задача ${input} не найдена в проекте ${this.layout.projectRoot}.`);
    return key;
  }

  /**
   * Выполнить mutating-операцию под lock-ом проекта (02-storage.md §10.4).
   * `create: true` — разрешено создать .sdlc (создание задачи); иначе .sdlc должен существовать.
   */
  async withLock<T>(
    opts: { command: string; taskKey: string | null; create?: boolean },
    fn: (lock: HeldLock) => Promise<T>,
  ): Promise<T> {
    if (opts.create) await this.ensureSdlcDir();
    const lock = await this.locks.acquire({ command: opts.command, taskKey: opts.taskKey });
    const unregister = onCleanup(() => lock.release());
    try {
      const removed = await this.removeOrphans();
      if (removed.length > 0) this.deps.log?.(`удалены осиротевшие временные файлы: ${removed.join(", ")}`);
      await this.deliverOutboxes();
      await this.syncIndex();
      return await fn(lock);
    } finally {
      unregister();
      await lock.release();
    }
  }

  /**
   * Дописать в журналы недоставленный outbox всех задач (02-storage.md §7.3). Только под lock-ом.
   * Иначе события упавшей записи ждали бы, пока кто-нибудь загрузит именно эту задачу,
   * а завершённую задачу mutating-команды не загружают.
   */
  async deliverOutboxes(): Promise<string[]> {
    const delivered: string[] = [];
    for (const t of await this.listTasks()) {
      if (t.ok && t.snapshot.undelivered.length > 0) {
        await this.tasks.load(t.key);
        delivered.push(t.key);
      }
    }
    if (delivered.length > 0) this.deps.log?.(`доставлен outbox задач: ${delivered.join(", ")}`);
    return delivered;
  }

  /** Перестроить index.json, если он расходится с state-файлами. Только под lock-ом. */
  async syncIndex(): Promise<boolean> {
    const valid = (await this.listTasks()).filter((t) => t.ok);
    const states = valid.map((t) => t.snapshot.state);
    if (indexMatches(await this.index.read(), states)) return false;
    await this.index.write(states.map((s) => indexEntry(s, this.stageTitle)));
    return true;
  }

  /** Временные файлы и каталоги, оставленные умершими процессами (02-storage.md §7.1). */
  async findOrphans(): Promise<string[]> {
    const dirs = [this.layout.sdlcDir, this.layout.policiesDir, this.layout.tasksDir];
    for (const key of await this.tasks.listKeys()) {
      const t = this.tasks.task(key);
      dirs.push(t.dir, t.runsDir, t.artifactsDir);
    }
    const out: string[] = [];
    for (const dir of dirs) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const m = (e.isFile() ? TMP_FILE_RE : e.isDirectory() && dir === this.layout.tasksDir ? NEW_TASK_DIR_RE : null)?.exec(
          e.name,
        );
        const pid = m?.[1] ? Number(m[1]) : null;
        if (pid !== null && pid !== this.deps.pid && !this.isAlive(pid)) out.push(path.join(dir, e.name));
      }
    }
    return out;
  }

  async removeOrphans(): Promise<string[]> {
    const orphans = await this.findOrphans();
    for (const p of orphans) await rm(p, { recursive: true, force: true }).catch(() => unlink(p).catch(() => undefined));
    return orphans.map((p) => path.relative(this.layout.sdlcDir, p));
  }
}
