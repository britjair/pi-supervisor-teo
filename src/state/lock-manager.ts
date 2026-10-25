// Project lock .sdlc/project.lock.json, 02-storage.md §10.

import { open, readFile, stat, unlink } from "node:fs/promises";
import { z } from "zod";
import { LockConflictError, LockLostError, type LockHolder } from "../errors/errors.js";
import type { Clock } from "../util/clock.js";
import { randomHex } from "../util/ids.js";
import { writeFileAtomic } from "./atomic-file.js";

export type ProjectLock = {
  pid: number;
  hostname: string;
  processStartedAt: string;
  /** null, пока процесс в меню */
  taskKey: string | null;
  /** "interactive" | "new" | "resume" | "recover" | "cancel" | "doctor" */
  command: string;
  acquiredAt: string;
  heartbeatAt: string;
  /** Случайный id владельца */
  nonce: string;
};

const lockSchema = z.object({
  pid: z.int().positive(),
  hostname: z.string(),
  processStartedAt: z.string(),
  taskKey: z.string().nullable(),
  command: z.string(),
  acquiredAt: z.string(),
  heartbeatAt: z.string(),
  nonce: z.string().min(1),
});

export type LockInspection =
  | { kind: "none" }
  | {
      kind: "held";
      lock: ProjectLock;
      /** null — процесс на другом хосте, проверить нельзя */
      alive: boolean | null;
      stale: boolean;
    }
  /** Файл есть, но не разбирается: его только что создали или он повреждён */
  | { kind: "unreadable"; mtimeMs: number; stale: boolean };

export type LockDeps = {
  file: string;
  clock: Clock;
  hostname: string;
  pid: number;
  processStartedAt: string;
  isAlive?: (pid: number) => boolean;
  heartbeatMs?: number;
  /** Неразбираемый lock старше этого считается протухшим */
  unreadableStaleMs?: number;
};

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM — процесс есть, но принадлежит другому пользователю
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const code = (err: unknown) => (err as NodeJS.ErrnoException).code;

export function holderOf(inspection: LockInspection): LockHolder {
  if (inspection.kind !== "held") return null;
  const { pid, hostname, taskKey, command, heartbeatAt } = inspection.lock;
  return { pid, hostname, taskKey, command, heartbeatAt };
}

export class LockManager {
  private readonly isAlive: (pid: number) => boolean;
  private readonly heartbeatMs: number;
  private readonly unreadableStaleMs: number;

  constructor(private readonly deps: LockDeps) {
    this.isAlive = deps.isAlive ?? pidAlive;
    this.heartbeatMs = deps.heartbeatMs ?? 5_000;
    this.unreadableStaleMs = deps.unreadableStaleMs ?? 30_000;
  }

  get file(): string {
    return this.deps.file;
  }

  /** Кто держит lock. Только чтение. */
  async inspect(): Promise<LockInspection> {
    let text: string;
    let mtimeMs: number;
    try {
      [text, mtimeMs] = await Promise.all([readFile(this.deps.file, "utf8"), stat(this.deps.file).then((s) => s.mtimeMs)]);
    } catch (err) {
      if (code(err) === "ENOENT") return { kind: "none" };
      throw err;
    }
    let lock: ProjectLock | null = null;
    try {
      const parsed = lockSchema.safeParse(JSON.parse(text));
      if (parsed.success) lock = parsed.data;
    } catch {
      lock = null;
    }
    if (!lock) {
      return { kind: "unreadable", mtimeMs, stale: this.deps.clock.now().getTime() - mtimeMs > this.unreadableStaleMs };
    }
    // Чужой хост — никогда не протухший автоматически: каталог может лежать на сетевом диске.
    // Живой PID — не протухший даже со старым heartbeat: PID мог быть переиспользован, снимает человек.
    if (lock.hostname !== this.deps.hostname) return { kind: "held", lock, alive: null, stale: false };
    const alive = this.isAlive(lock.pid);
    return { kind: "held", lock, alive, stale: !alive };
  }

  async acquire(opts: { command: string; taskKey: string | null; onLost?: (err: LockLostError) => void }): Promise<HeldLock> {
    const nonce = randomHex(8);
    const now = this.deps.clock.now().toISOString();
    const lock: ProjectLock = {
      pid: this.deps.pid,
      hostname: this.deps.hostname,
      processStartedAt: this.deps.processStartedAt,
      taskKey: opts.taskKey,
      command: opts.command,
      acquiredAt: now,
      heartbeatAt: now,
      nonce,
    };

    // Попытка; takeover протухшего; повторы, пока takeover выполняет другой процесс
    for (let attempt = 0; attempt < 6; attempt++) {
      if (await this.tryCreate(lock)) {
        return new HeldLock(this.deps.file, lock, this.deps.clock, this.heartbeatMs, opts.onLost);
      }
      const inspection = await this.inspect();
      if (inspection.kind === "none") continue;
      if (!inspection.stale) throw new LockConflictError(conflictText(inspection), holderOf(inspection));
      await this.takeover(inspection);
    }
    throw new LockConflictError("Не удалось захватить lock проекта: его одновременно захватывают другие процессы.", null);
  }

  private async tryCreate(lock: ProjectLock): Promise<boolean> {
    let fh;
    try {
      fh = await open(this.deps.file, "wx", 0o600);
    } catch (err) {
      if (code(err) === "EEXIST") return false;
      throw err;
    }
    try {
      await fh.writeFile(JSON.stringify(lock, null, 2) + "\n");
      await fh.sync();
    } finally {
      await fh.close();
    }
    return true;
  }

  /**
   * Убрать протухший lock. Takeover выполняется под отдельным mutex-файлом (wx): внутри него
   * протухший lock перепроверяется по nonce и удаляется, а новый lock создаёт обычный wx в acquire().
   * Пока файл lock-а существует, создать его не может никто, а удаляет его только владелец mutex-а
   * и только протухший, поэтому из процессов, одновременно увидевших протухший lock, выиграет один.
   * Голый rename этого не гарантирует: можно унести уже свежий lock, захваченный между проверкой и rename.
   */
  private async takeover(inspection: Exclude<LockInspection, { kind: "none" }>): Promise<void> {
    const mutex = `${this.deps.file}.takeover`;
    let fh;
    try {
      fh = await open(mutex, "wx", 0o600);
    } catch (err) {
      if (code(err) !== "EEXIST") throw err;
      // Mutex оставлен процессом, умершим посреди takeover
      const age = await stat(mutex).then((st) => this.deps.clock.now().getTime() - st.mtimeMs, () => 0);
      if (age > this.unreadableStaleMs) await unlink(mutex).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
      return;
    }
    try {
      await fh.writeFile(JSON.stringify({ pid: this.deps.pid, hostname: this.deps.hostname }) + "\n");
      await fh.close();
      fh = null;
      const current = await this.inspect();
      const same =
        (current.kind === "held" && inspection.kind === "held" && current.lock.nonce === inspection.lock.nonce) ||
        (current.kind === "unreadable" && inspection.kind === "unreadable");
      if (same && current.stale) await unlink(this.deps.file).catch(() => undefined);
    } finally {
      await fh?.close();
      await unlink(mutex).catch(() => undefined);
    }
  }
}

export class HeldLock {
  private timer: NodeJS.Timeout | null;
  /** Идущий heartbeat: release() его дожидается, чтобы он не записал файл после удаления */
  private beating: Promise<void> | null = null;
  private released = false;
  private readonly controller = new AbortController();

  constructor(
    readonly file: string,
    private lock: ProjectLock,
    private readonly clock: Clock,
    heartbeatMs: number,
    private readonly onLost?: (err: LockLostError) => void,
  ) {
    // Ошибка записи не роняет процесс: следующий тик снова сверит nonce
    this.timer = setInterval(() => void this.heartbeat().catch(() => undefined), heartbeatMs);
    this.timer.unref();
  }

  get nonce(): string {
    return this.lock.nonce;
  }

  /** Прерывается, если lock потерян. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get info(): ProjectLock {
    return { ...this.lock };
  }

  /** Сменить задачу, которую обрабатывает процесс. */
  async setTask(taskKey: string | null): Promise<void> {
    this.lock = { ...this.lock, taskKey };
    await this.heartbeat();
  }

  /** Обновить heartbeat, предварительно сверив nonce: файл чужой — lock потерян. */
  async heartbeat(): Promise<void> {
    if (this.beating) return this.beating;
    if (this.released || this.controller.signal.aborted) return;
    this.beating = (async () => {
      if (!(await this.ownsFile())) {
        this.lose();
        return;
      }
      this.lock = { ...this.lock, heartbeatAt: this.clock.now().toISOString() };
      await writeFileAtomic(this.file, JSON.stringify(this.lock, null, 2) + "\n");
    })().finally(() => {
      this.beating = null;
    });
    return this.beating;
  }

  private async ownsFile(): Promise<boolean> {
    try {
      const parsed = lockSchema.safeParse(JSON.parse(await readFile(this.file, "utf8")));
      return parsed.success && parsed.data.nonce === this.lock.nonce;
    } catch {
      return false;
    }
  }

  private lose(): void {
    this.stop();
    const err = new LockLostError(
      "Lock проекта перехвачен другим процессом. Работа остановлена, чтобы два процесса не меняли задачу одновременно.",
    );
    this.controller.abort(err);
    this.onLost?.(err);
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Освободить: удалить файл, только если он всё ещё наш. Повторный вызов — no-op. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.stop();
    await this.beating?.catch(() => undefined);
    if (await this.ownsFile()) await unlink(this.file).catch(() => undefined);
  }
}

function conflictText(inspection: Exclude<LockInspection, { kind: "none" }>): string {
  if (inspection.kind === "unreadable") return "Проект занят другим процессом sdlc (lock-файл только что создан или повреждён).";
  return "Проект занят другим процессом sdlc.";
}
