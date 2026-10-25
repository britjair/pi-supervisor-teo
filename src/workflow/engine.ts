// Workflow engine, 03-engine.md §3: автомат над state.phase. Каждый шаг загружает state,
// выбирает один обработчик, обработчик фиксирует результат одним commit. Процесс может умереть
// в любой точке: следующий запуск продолжит с фазы из state (recovery — recovery.ts).

import { SessionPool } from "../agents/session-pool.js";
import type { AgentRuntime } from "../agents/runtime.js";
import { validatorResolvers } from "../agents/tools/supervisor-control-tools.js";
import type { TaskEvent } from "../domain/events.js";
import type { LoadedPolicy } from "../domain/policy.js";
import { LockLostError, UserAbortError } from "../errors/errors.js";
import type { ProjectStore } from "../state/project-store.js";
import { RunStore } from "../state/run-store.js";
import type { TaskLayout } from "../state/layout.js";
import type { Choice, HumanAnswer, HumanIO, QuestionView } from "../ui/human-io.js";
import { askQuestion } from "../ui/plain/human-question.js";
import type { Style } from "../ui/plain/style.js";
import type { Clock } from "../util/clock.js";
import type { Exec } from "../util/exec.js";
import { noFaults, type FaultInjector } from "../util/fault.js";
import type { IdGenerator } from "../util/ids.js";
import { awaitAgent, startAgent } from "./agent-step.js";
import type { CycleMemory, EngineCore, EngineOptions } from "./context.js";
import { applyDecision } from "./decision-executor.js";
import { askHumanStep } from "./human-step.js";
import { InterruptRequest, type ExitOutcome } from "./outcome.js";
import { policyGate, type PolicyConfirm } from "./policy-gate.js";
import { recoverOnOpen } from "./recovery.js";
import type { EngineReporter } from "./reporter.js";
import { awaitSupervisor, startSupervisor } from "./supervisor-step.js";
import { awaitWait, tickingWaitControl, type WaitControl } from "./wait-step.js";

export type EngineDeps = {
  key: string;
  store: ProjectStore;
  runtime: AgentRuntime;
  policy: LoadedPolicy;
  loadPolicy: () => Promise<LoadedPolicy>;
  human: HumanIO | null;
  reporter: EngineReporter;
  clock: Clock;
  ids: IdGenerator;
  exec: Exec;
  style: Style;
  faults?: FaultInjector;
  options?: Partial<EngineOptions>;
  /** Сигнал lock-а: его потеря останавливает движок без записи */
  lockSignal?: AbortSignal;
  waitControl?: WaitControl;
  /** Пауза; в тестах — продвижение FakeClock */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Подтверждение изменённой Policy в режиме confirm; null — нет терминала */
  confirmPolicy?: PolicyConfirm | null;
};

function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class Engine implements EngineCore {
  readonly key: string;
  readonly store: ProjectStore;
  readonly runtime: AgentRuntime;
  readonly pool: SessionPool;
  readonly human: HumanIO | null;
  readonly waitControl: WaitControl;
  readonly reporter: EngineReporter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly faults: FaultInjector;
  readonly exec: Exec;
  readonly style: Style;
  readonly options: EngineOptions;
  readonly signal: AbortSignal;
  readonly reported = new Set<string>();
  policy: LoadedPolicy;
  cycle: CycleMemory | null = null;

  private readonly controller = new AbortController();
  private readonly sleeper: (ms: number, signal: AbortSignal) => Promise<void>;
  private checkNowPending: boolean;

  constructor(private readonly deps: EngineDeps) {
    this.key = deps.key;
    this.store = deps.store;
    this.runtime = deps.runtime;
    this.human = deps.human;
    this.reporter = deps.reporter;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.faults = deps.faults ?? noFaults;
    this.exec = deps.exec;
    this.style = deps.style;
    this.policy = deps.policy;
    this.options = { noWait: deps.options?.noWait ?? false, checkNow: deps.options?.checkNow ?? false };
    this.checkNowPending = this.options.checkNow;
    this.signal = deps.lockSignal ? AbortSignal.any([this.controller.signal, deps.lockSignal]) : this.controller.signal;
    this.sleeper = deps.sleep ?? realSleep;
    this.waitControl = deps.waitControl ?? tickingWaitControl((ms) => this.sleep(ms));
    this.pool = new SessionPool(deps.runtime, (_file, role, e) => {
      const actor = role;
      if (e.type === "text") this.reporter.emit({ type: "text", actor, text: e.delta });
      else if (e.type === "tool.started") this.reporter.emit({ type: "tool.started", actor, toolName: e.toolName, argsPreview: e.argsPreview });
      else if (e.type === "tool.finished") this.reporter.emit({ type: "tool.finished", actor, toolName: e.toolName, ok: e.ok });
    });
  }

  task(): TaskLayout {
    return this.store.tasks.task(this.key);
  }

  runs(): RunStore {
    return new RunStore(this.task());
  }

  sleep(ms: number): Promise<void> {
    return this.sleeper(ms, this.signal);
  }

  interrupt(signal: "SIGINT" | "SIGTERM"): void {
    if (!this.controller.signal.aborted) this.controller.abort(new InterruptRequest(signal));
  }

  async events(): Promise<TaskEvent[]> {
    return (await this.store.tasks.journal(this.key).readAll()).events;
  }

  async ask(view: QuestionView): Promise<HumanAnswer> {
    if (!this.human) throw new Error("нет терминала для вопроса человеку");
    return askQuestion(this.human, view, this.style);
  }

  select<T>(title: string, choices: ReadonlyArray<Choice<T>>): Promise<T> {
    if (!this.human) throw new Error("нет терминала");
    return this.human.select(title, choices);
  }

  /** Основной цикл (03-engine.md §3). */
  async run(): Promise<ExitOutcome> {
    try {
      const recovered = await recoverOnOpen(this);
      if (recovered) return recovered;
      for (;;) {
        this.signal.throwIfAborted();
        const state = await this.store.tasks.load(this.key);
        let outcome: ExitOutcome | void | "changed" | null = null;
        switch (state.phase) {
          case "halted":
            return state.status === "terminal"
              ? { kind: "terminal" }
              : state.status === "cancelled"
                ? { kind: "cancelled" }
                : { kind: "blocked", code: state.statusReason?.code ?? null };
          case "agent_pending":
            outcome = await policyGate(this, state, this.deps.loadPolicy, this.deps.confirmPolicy ?? null);
            if (outcome === null) outcome = await startAgent(this, state);
            break;
          case "agent_running":
            outcome = await awaitAgent(this, state);
            break;
          case "supervisor_pending":
            outcome = await policyGate(this, state, this.deps.loadPolicy, this.deps.confirmPolicy ?? null);
            if (outcome === null) outcome = await startSupervisor(this, state);
            break;
          case "supervisor_running":
            outcome = await awaitSupervisor(this, state);
            break;
          case "decision_pending":
            await applyDecision(this, state, validatorResolvers(this).attachment);
            break;
          case "human_pending":
            outcome = await askHumanStep(this, state);
            break;
          case "waiting":
            outcome = await awaitWait(this, state, () => {
              const v = this.checkNowPending;
              this.checkNowPending = false;
              return v;
            });
            break;
        }
        if (outcome && outcome !== "changed") return outcome;
      }
    } catch (err) {
      const reason = this.signal.aborted ? this.signal.reason : err;
      if (reason instanceof LockLostError) throw reason;
      if (reason instanceof InterruptRequest) return this.stop(reason.signal);
      if (err instanceof UserAbortError) return this.stop("SIGINT");
      throw err;
    } finally {
      await this.pool.dispose();
    }
  }

  /** Подтверждённая остановка (03-engine.md §9): прервать сессии, записать interrupted. */
  private async stop(signal: "SIGINT" | "SIGTERM"): Promise<ExitOutcome> {
    if (!this.controller.signal.aborted) this.controller.abort(new InterruptRequest(signal));
    await this.pool.abortAll(5_000);
    const state = await this.store.tasks.load(this.key);
    const payload = { signal, phase: state.phase, runId: state.currentRun?.runId ?? null };
    if (state.phase === "halted") return { kind: "interrupted", signal };
    // Вопрос человеку просто ждёт: status = waiting_human не меняется (инвариант с pendingHumanRequest)
    if (state.status === "waiting_human") {
      await this.store.tasks.appendDirect(this.key, "runtime.interrupted", "cli", payload);
    } else {
      await this.store.tasks.commit(this.key, (s, c) => {
        c.emit("runtime.interrupted", "cli", payload);
        return { ...s, status: "interrupted" };
      });
    }
    return { kind: "interrupted", signal };
  }
}
