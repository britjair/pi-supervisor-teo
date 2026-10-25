// runtime.json — живая телеметрия процесса (02-storage.md §9). Не источник истины.

import { readFile, unlink } from "node:fs/promises";
import type { Usage } from "../domain/runs.js";
import type { Phase } from "../domain/task-state.js";
import type { Clock } from "../util/clock.js";
import { writeFileAtomic } from "./atomic-file.js";

export type RuntimeInfo = {
  pid: number;
  hostname: string;
  startedAt: string;
  heartbeatAt: string;
  phase: Phase;
  actor: "agent" | "supervisor" | "human" | "cli";
  agentId: string | null;
  attempt: number | null;
  activity: string;
  currentTool: string | null;
  phaseStartedAt: string;
  usage: Usage;
};

export async function readRuntimeInfo(file: string): Promise<RuntimeInfo | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as RuntimeInfo;
  } catch {
    return null;
  }
}

type Fields = Omit<RuntimeInfo, "pid" | "hostname" | "startedAt" | "heartbeatAt" | "phaseStartedAt">;

/** Пишет не чаще раза в секунду; смена фазы записывается сразу. */
export class RuntimeInfoWriter {
  private current: RuntimeInfo | null = null;
  private lastWriteMs = -Infinity;
  private pending: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly clock: Clock,
    private readonly proc: { pid: number; hostname: string; startedAt: string },
    private readonly intervalMs = 1_000,
  ) {}

  update(fields: Fields): Promise<void> {
    const now = this.clock.now();
    const phaseChanged = this.current?.phase !== fields.phase;
    this.current = {
      ...this.proc,
      ...fields,
      heartbeatAt: now.toISOString(),
      phaseStartedAt: phaseChanged || !this.current ? now.toISOString() : this.current.phaseStartedAt,
    };
    const wait = this.lastWriteMs + this.intervalMs - now.getTime();
    if (phaseChanged || wait <= 0) return this.flush();
    if (!this.pending) {
      this.pending = setTimeout(() => void this.flush(), wait);
      this.pending.unref();
    }
    return this.chain;
  }

  flush(): Promise<void> {
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    const snapshot = this.current;
    if (!snapshot) return this.chain;
    this.lastWriteMs = this.clock.now().getTime();
    this.chain = this.chain.then(() => writeFileAtomic(this.file, JSON.stringify(snapshot, null, 2) + "\n"));
    return this.chain;
  }

  /** Штатный выход: файл удаляется. */
  async remove(): Promise<void> {
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    this.current = null;
    await this.chain.catch(() => undefined);
    await unlink(this.file).catch(() => undefined);
  }
}
