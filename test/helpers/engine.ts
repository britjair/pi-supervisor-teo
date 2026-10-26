// Обвязка движка для integration-тестов: проект с git, FakeClock, FakeAgentRuntime.
// Каждый вызов run() — отдельный «процесс»: новый Engine, новый пул сессий, свой lock.

import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FakeAgentRuntime } from "../../src/agents/fake/fake-runtime.js";
import { createTask } from "../../src/commands/new.js";
import type { TaskEvent } from "../../src/domain/events.js";
import type { LoadedPolicy } from "../../src/domain/policy.js";
import type { AgentRunRecord } from "../../src/domain/runs.js";
import type { TaskState } from "../../src/domain/task-state.js";
import { parsePolicyBytes } from "../../src/policy/policy-loader.js";
import { ProjectStore } from "../../src/state/project-store.js";
import type { HumanIO } from "../../src/ui/human-io.js";
import { createStyle } from "../../src/ui/plain/style.js";
import { execFileNoThrow } from "../../src/util/exec.js";
import { noFaults, type FaultInjector } from "../../src/util/fault.js";
import { createIdGenerator } from "../../src/util/ids.js";
import { Engine } from "../../src/workflow/engine.js";
import type { ExitOutcome } from "../../src/workflow/outcome.js";
import type { PolicyConfirm } from "../../src/workflow/policy-gate.js";
import { CollectingReporter } from "../../src/workflow/reporter.js";
import type { WaitControl } from "../../src/workflow/wait-step.js";
import { FakeClock } from "./fake-clock.js";
import { validDir } from "./paths.js";
import { runProcess, sandbox, type Sandbox } from "./tmp.js";

export const DED = path.join(validDir, "discover-execute-done.md");

export type RunOptions = {
  human?: HumanIO | null;
  faults?: FaultInjector;
  waitControl?: WaitControl;
  noWait?: boolean;
  checkNow?: boolean;
  confirmPolicy?: PolicyConfirm | null;
  /** Прервать движок: вызывается с функцией interrupt после старта */
  onEngine?: (engine: Engine) => void;
};

export class Harness {
  readonly clock = new FakeClock();
  readonly ids = createIdGenerator(this.clock);
  readonly fake: FakeAgentRuntime;
  reporter = new CollectingReporter();
  store!: ProjectStore;
  sb!: Sandbox;
  policyText: string;

  constructor(policyText: string, fake = new FakeAgentRuntime()) {
    this.policyText = policyText;
    this.fake = fake;
  }

  static async create(opts: { policy?: string; git?: boolean } = {}): Promise<Harness> {
    const h = new Harness(opts.policy ?? readFileSync(DED, "utf8"));
    h.sb = await sandbox(h.policyText, { git: opts.git !== false });
    if (opts.git !== false) {
      await writeFile(path.join(h.sb.project, "README.md"), "# project\n");
      await runProcess("git", ["add", "-A"], h.sb.project);
      await runProcess("git", ["commit", "-qm", "init"], h.sb.project);
    }
    h.store = h.newStore();
    return h;
  }

  get project(): string {
    return this.sb.project;
  }

  loadPolicy = async (): Promise<LoadedPolicy> => parsePolicyBytes(await readFile(this.sb.policyPath), this.sb.policyPath);

  async setPolicy(text: string): Promise<void> {
    this.policyText = text;
    await writeFile(this.sb.policyPath, text);
  }

  newStore(faults: FaultInjector = noFaults): ProjectStore {
    return new ProjectStore({
      projectRoot: this.sb.project,
      processes: [{ name: this.sb.process, path: this.sb.policyPath, builtin: false, ok: true, policy: parsePolicyBytes(Buffer.from(this.policyText), this.sb.policyPath) }],
      processesDir: this.sb.processesDir,
      clock: this.clock,
      ids: this.ids,
      faults,
      hostname: os.hostname(),
      pid: process.pid,
      processStartedAt: this.clock.now().toISOString(),
    });
  }

  async createTask(key = "T-1", description = "Создай NOTES.md"): Promise<TaskState> {
    return createTask(this.store, { key, title: `Задача ${key}`, description, process: this.sb.process });
  }

  /** Один «процесс»: новый store и Engine под lock-ом проекта. */
  async run(key = "T-1", opts: RunOptions = {}): Promise<ExitOutcome> {
    const faults = opts.faults ?? noFaults;
    const store = this.newStore(faults);
    this.store = store;
    const policy = await this.loadPolicy();
    return store.withLock({ command: "resume", taskKey: key }, async (lock) => {
      const engine = new Engine({
        key,
        store,
        runtime: this.fake,
        policy,
        loadPolicy: this.loadPolicy,
        human: opts.human ?? null,
        reporter: this.reporter,
        clock: this.clock,
        ids: this.ids,
        exec: execFileNoThrow,
        style: createStyle(false),
        faults,
        options: { noWait: opts.noWait ?? false, checkNow: opts.checkNow ?? false },
        lockSignal: lock.signal,
        ...(opts.waitControl ? { waitControl: opts.waitControl } : {}),
        sleep: async (ms) => this.clock.advance(ms),
        confirmPolicy: opts.confirmPolicy ?? null,
      });
      opts.onEngine?.(engine);
      return engine.run();
    });
  }

  taskDir(key = "T-1"): string {
    return path.join(this.sb.project, ".teo", "tasks", key);
  }

  async state(key = "T-1"): Promise<TaskState> {
    return JSON.parse(await readFile(path.join(this.taskDir(key), "state.json"), "utf8")) as TaskState;
  }

  async events(key = "T-1"): Promise<TaskEvent[]> {
    return (await readFile(path.join(this.taskDir(key), "events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as TaskEvent);
  }

  async types(key = "T-1"): Promise<string[]> {
    return (await this.events(key)).map((e) => e.type);
  }

  async run_(runId: string, key = "T-1"): Promise<AgentRunRecord> {
    return JSON.parse(await readFile(path.join(this.taskDir(key), "runs", `${runId}.json`), "utf8")) as AgentRunRecord;
  }

  /** Prompt-ы, отправленные в сессию (по окончанию пути). */
  promptsTo(suffix: string): string[] {
    return this.fake.prompts.filter((p) => p.file.endsWith(suffix)).map((p) => p.prompt);
  }

  git(...args: string[]) {
    return runProcess("git", args, this.sb.project);
  }
}
