// Адаптер строгого workflow-ядра к одной пользовательской сессии Pi (X3).
// Пользовательский ход становится agent run, а supervisor остаётся отдельной сессией в .teo.

import { appendFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentBeforeSettleEvent } from "@earendil-works/pi-coding-agent";
import { PiAgentRuntime } from "../agents/pi/pi-agent-runtime.js";
import { inspectPiSessionFile, readPiTranscript } from "../agents/pi/session-inspector.js";
import { SessionPool } from "../agents/session-pool.js";
import type { AgentRuntime, ToolResult } from "../agents/runtime.js";
import { validatorResolvers } from "../agents/tools/supervisor-control-tools.js";
import { getAgent, getStage, type LoadedPolicy } from "../domain/policy.js";
import type { AgentReport, AgentRunRecord, ReportBlockerInput, ReportResultInput } from "../domain/runs.js";
import type { AgentRunRef, SettleReason, TaskState } from "../domain/task-state.js";
import type { AppContext } from "../app.js";
import type { HeldLock } from "../state/lock-manager.js";
import type { ProjectStore } from "../state/project-store.js";
import { RunStore } from "../state/run-store.js";
import type { TaskLayout } from "../state/layout.js";
import { noFaults } from "../util/fault.js";
import { resolveWithin } from "../util/paths.js";
import { redact } from "../util/redact.js";
import { settleRun } from "../workflow/agent-step.js";
import type { CycleMemory, EngineCore } from "../workflow/context.js";
import { applyDecision } from "../workflow/decision-executor.js";
import { silentReporter } from "../workflow/reporter.js";
import { awaitSupervisor, startSupervisor } from "../workflow/supervisor-step.js";
import { finishWait, waitHumanMessage, type WaitControl } from "../workflow/wait-step.js";

const LAST_TEXT_MAX = 4 * 1024;
const REPORT_TOOLS = ["report_result", "report_blocker"] as const;
export const extensionReportTools = (): readonly string[] => REPORT_TOOLS;

const pad3 = (n: number) => String(n).padStart(3, "0");
const isUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

/** Host-транскрипты всегда читаются нашим Pi JSONL reader, даже когда supervisor в тесте — FakeRuntime. */
class HostTranscriptRuntime implements AgentRuntime {
  constructor(private readonly inner: AgentRuntime) {}
  resolveModel: AgentRuntime["resolveModel"] = (ref) => this.inner.resolveModel(ref);
  openSession: AgentRuntime["openSession"] = (spec) => this.inner.openSession(spec);
  inspectSessionFile: AgentRuntime["inspectSessionFile"] = (file) =>
    path.basename(file).startsWith("host-") ? inspectPiSessionFile(file) : this.inner.inspectSessionFile(file);
  readTranscript: AgentRuntime["readTranscript"] = (file, opts) =>
    path.basename(file).startsWith("host-") ? readPiTranscript(file, opts) : this.inner.readTranscript(file, opts);
  probe: AgentRuntime["probe"] = () => this.inner.probe();
  dispose: AgentRuntime["dispose"] = () => this.inner.dispose();
}

class ExtensionCore implements EngineCore {
  readonly pool: SessionPool;
  readonly human = null;
  readonly waitControl: WaitControl = { next: async () => ({ kind: "quit" }) };
  readonly reporter = silentReporter;
  readonly faults = noFaults;
  readonly options = { noWait: true, checkNow: false };
  readonly reported = new Set<string>();
  cycle: CycleMemory | null = null;

  constructor(
    readonly key: string,
    readonly store: ProjectStore,
    readonly runtime: AgentRuntime,
    readonly clock: AppContext["clock"],
    readonly ids: AppContext["ids"],
    readonly exec: AppContext["exec"],
    readonly style: AppContext["style"],
    readonly signal: AbortSignal,
    public policy: LoadedPolicy,
  ) {
    this.pool = new SessionPool(runtime, () => undefined);
  }

  task(): TaskLayout {
    return this.store.tasks.task(this.key);
  }
  runs(): RunStore {
    return new RunStore(this.task());
  }
  async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (this.signal.aborted) return reject(this.signal.reason);
      const onAbort = () => {
        clearTimeout(timer);
        reject(this.signal.reason);
      };
      const timer = setTimeout(() => {
        this.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  async ask(): Promise<never> {
    throw new Error("вопрос человеку обрабатывает ExtensionHost");
  }
  interrupt(): void {}
  async events() {
    return (await this.store.tasks.journal(this.key).readAll()).events;
  }
}

export type SupervisorResult = {
  /** Решение до применения; null, если supervisor заблокировал задачу без решения. */
  decision: TaskState["pendingDecision"];
  state: TaskState;
};

export class ExtensionWorkflow {
  private readonly core: ExtensionCore;
  private llmMessagesSeen: number | null = null;
  private currentReportedRun: string | null = null;

  constructor(opts: {
    key: string;
    app: AppContext;
    store: ProjectStore;
    lock: HeldLock;
    policy: LoadedPolicy;
    runtime?: AgentRuntime;
  }) {
    const runtime = new HostTranscriptRuntime(opts.runtime ?? new PiAgentRuntime({ cwd: opts.store.layout.projectRoot }));
    this.core = new ExtensionCore(
      opts.key,
      opts.store,
      runtime,
      opts.app.clock,
      opts.app.ids,
      opts.app.exec,
      opts.app.style,
      opts.lock.signal,
      opts.policy,
    );
  }

  get policy(): LoadedPolicy {
    return this.core.policy;
  }

  /** Guard после report_*: синхронный признак для текущего logical run. */
  isReported(): boolean {
    return this.currentReportedRun !== null;
  }

  /** agent_pending → agent_running без отдельной агентской сессии: агентом является host Pi. */
  async beginAgentTurn(_promptText: string): Promise<TaskState> {
    const state = await this.core.store.tasks.load(this.core.key);
    if (state.phase === "agent_running") return state;
    if (state.phase !== "agent_pending" || !state.nextAgentInput) {
      throw new Error(`нельзя начать ход агента из phase=${state.phase}`);
    }
    this.core.policy = this.core.store.policyOf(state.process);
    const stage = getStage(this.core.policy.spec, state.stage);
    if (!stage || stage.kind !== "work") throw new Error(`этап ${state.stage} отсутствует или терминальный`);
    const input = state.nextAgentInput;
    const fresh = input.kind === "initial" || input.kind === "restart";
    const previous = state.currentRun;
    const agentId = fresh ? stage.agent : (previous?.agentId ?? stage.agent);
    if (!getAgent(this.core.policy.spec, agentId)) throw new Error(`агента ${agentId} нет в Policy`);

    const now = this.core.clock.now().toISOString();
    const newRun = fresh;
    let run: AgentRunRef;
    if (newRun) {
      const attempt = (state.agentRunCounters[agentId] ?? 0) + 1;
      run = {
        runId: this.core.ids.next(state.lastEventId),
        agentId,
        attempt,
        stage: state.stage,
        sessionFile: `sessions/host-${agentId}-${pad3(attempt)}.jsonl`,
        sessionMode: input.kind === "restart" ? "restart" : "fresh",
        status: "running",
        settleReason: null,
        promptsSent: [],
        startedAt: now,
        finishedAt: null,
      };
    } else {
      if (!previous) throw new Error(`nextAgentInput.kind=${input.kind} без currentRun`);
      run = { ...previous, status: "running", settleReason: null, finishedAt: null };
    }

    const promptId = this.core.ids.next();
    const oldRecord = newRun ? null : await this.core.runs().read(run.runId);
    const record: AgentRunRecord = oldRecord
      ? {
          ...oldRecord,
          input,
          prompts: [...oldRecord.prompts, { promptId, kind: input.kind, sentAt: now }],
          report: null,
          reportsHistory: oldRecord.report ? [...oldRecord.reportsHistory, oldRecord.report] : oldRecord.reportsHistory,
          settleReason: null,
          error: null,
          finishedAt: null,
        }
      : {
          runId: run.runId,
          agentId,
          attempt: run.attempt,
          stage: state.stage,
          sessionFile: run.sessionFile,
          sessionMode: run.sessionMode,
          input,
          prompts: [{ promptId, kind: input.kind, sentAt: now }],
          report: null,
          reportsHistory: [],
          settleReason: null,
          error: null,
          lastAssistantText: null,
          toolStats: {},
          usage: null,
          startedAt: now,
          finishedAt: null,
        };
    await this.core.runs().write(record);
    this.currentReportedRun = null;

    return this.core.store.tasks.commit(this.core.key, (s, c) => {
      if (newRun) {
        c.emit("agent.started", "cli", {
          runId: run.runId,
          agentId,
          attempt: run.attempt,
          sessionFile: run.sessionFile,
          sessionMode: run.sessionMode,
          stage: s.stage,
        });
        if (input.kind === "restart" && previous) {
          c.emit("agent.restarted", "cli", {
            previousRunId: previous.runId,
            runId: run.runId,
            decisionId: input.decisionId,
            consecutiveRestarts: s.consecutiveRestarts + 1,
          });
        }
      } else {
        c.emit("agent.continued", "cli", { runId: run.runId, decisionId: input.decisionId });
      }
      c.emit("agent.prompted", "cli", { runId: run.runId, promptId, kind: input.kind });
      return {
        ...s,
        phase: "agent_running",
        nextAgentInput: null,
        currentRun: { ...run, promptsSent: [...run.promptsSent, promptId] },
        agentRunCounters: newRun ? { ...s.agentRunCounters, [agentId]: run.attempt } : s.agentRunCounters,
        consecutiveRestarts: newRun && input.kind === "restart" ? s.consecutiveRestarts + 1 : s.consecutiveRestarts,
      };
    }, { expectedVersion: state.version });
  }

  async executeReport(name: "report_result" | "report_blocker", input: ReportResultInput | ReportBlockerInput): Promise<ToolResult> {
    return name === "report_result"
      ? this.writeReport({ kind: "result", at: this.core.clock.now().toISOString(), data: input as ReportResultInput })
      : this.writeReport({ kind: "blocker", at: this.core.clock.now().toISOString(), data: input as ReportBlockerInput });
  }

  private async writeReport(raw: AgentReport): Promise<ToolResult> {
    const state = await this.core.store.tasks.load(this.core.key);
    const run = state.currentRun;
    if (state.phase !== "agent_running" || !run || run.status !== "running") {
      return { content: "NO_ACTIVE_RUN: текущий запуск агента уже завершён", isError: true };
    }
    const record = await this.core.runs().read(run.runId);
    if (!record) return { content: "NO_ACTIVE_RUN: запись запуска не найдена", isError: true };
    if (record.report) return { content: "ALREADY_REPORTED: отчёт уже записан. Заверши ход.", isError: true, terminate: true };

    let report = raw;
    if (raw.kind === "result" && raw.data.artifacts) {
      const artifacts: NonNullable<ReportResultInput["artifacts"]> = [];
      for (const a of raw.data.artifacts) {
        if (isUrl(a.pathOrUrl)) {
          artifacts.push(a);
          continue;
        }
        const target = await resolveWithin([this.core.store.layout.projectRoot], this.core.store.layout.projectRoot, a.pathOrUrl);
        if (!target) return { content: `ARTIFACT_OUTSIDE_PROJECT: путь ${a.pathOrUrl} вне проекта`, isError: true };
        artifacts.push({ ...a, pathOrUrl: path.relative(this.core.store.layout.projectRoot, target) || "." });
      }
      report = { ...raw, data: { ...raw.data, artifacts } };
    }
    await this.core.runs().write({ ...record, report });
    this.currentReportedRun = run.runId;
    await this.core.store.tasks.commit(this.core.key, (s, c) => {
      c.emit("agent.reported", "agent", { runId: run.runId, kind: report.kind, summary: report.data.summary });
      return s;
    });
    return { content: "Отчёт записан. Supervisor проверит его независимо. Заверши ход.", terminate: true };
  }

  /** Снимок новых LLM-сообщений host-сессии в redacted Pi JSONL для read_agent_transcript. */
  private async snapshotTranscript(run: AgentRunRef, messages: unknown[]): Promise<string | null> {
    const file = path.join(this.core.task().dir, run.sessionFile);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    let exists = true;
    try {
      await stat(file);
    } catch {
      exists = false;
    }
    if (!exists) await appendFile(file, JSON.stringify({ type: "session", version: 1, id: run.runId, cwd: this.core.store.layout.projectRoot }) + "\n");

    let from: number;
    if (this.llmMessagesSeen === null || this.llmMessagesSeen > messages.length) {
      const lastUser = messages.findLastIndex((m) => typeof m === "object" && m !== null && (m as { role?: unknown }).role === "user");
      from = Math.max(0, lastUser);
    } else {
      from = this.llmMessagesSeen;
    }
    for (const message of messages.slice(from)) {
      await appendFile(file, JSON.stringify({ type: "message", message: redact(message) }) + "\n");
    }
    this.llmMessagesSeen = messages.length;
    return lastAssistantText(messages);
  }

  /** agent_running → supervisor_pending, без запуска supervisor-а (используется /teo pause). */
  async settleOnly(event: AgentBeforeSettleEvent): Promise<TaskState> {
    const state = await this.core.store.tasks.load(this.core.key);
    if (state.phase !== "agent_running" || !state.currentRun) return state;
    const run = state.currentRun;
    const lastText = await this.snapshotTranscript(run, event.context.llmMessages as unknown[]);
    const record = await this.core.runs().read(run.runId);
    let reason: SettleReason;
    if (event.outcome === "aborted") reason = "aborted";
    else if (event.outcome === "error") reason = "runtime_error";
    else if (record?.report?.kind === "result") reason = "reported_result";
    else if (record?.report?.kind === "blocker") reason = "reported_blocker";
    else reason = "unstructured_settle";
    await settleRun(this.core, state, reason, {
      ...(event.outcome === "error" ? { error: "пользовательская сессия Pi завершила ход с ошибкой" } : {}),
      ...(lastText ? { lastAssistantText: lastText.slice(-LAST_TEXT_MAX) } : {}),
    });
    this.currentReportedRun = null;
    return this.core.store.tasks.load(this.core.key);
  }

  /** agent_running → supervisor → decision applied. */
  async settleAndSupervise(event: AgentBeforeSettleEvent): Promise<SupervisorResult> {
    const state = await this.settleOnly(event);
    if (state.phase !== "supervisor_pending") return { decision: null, state };
    return this.superviseAndApply();
  }

  /** Закрытие/падение host Pi посреди хода: run становится interrupted и ждёт supervisor recovery. */
  async interruptActiveRun(signal: string | null = null): Promise<TaskState> {
    const state = await this.core.store.tasks.load(this.core.key);
    const run = state.currentRun;
    if (state.phase !== "agent_running" || !run) return state;
    const now = this.core.clock.now().toISOString();
    const record = await this.core.runs().read(run.runId);
    if (record) await this.core.runs().write({ ...record, settleReason: "interrupted", finishedAt: now });
    return this.core.store.tasks.commit(this.core.key, (s, c) => {
      c.emit("runtime.interrupted", "cli", { signal, phase: s.phase, runId: run.runId });
      c.emit("agent.settled", "cli", { runId: run.runId, reason: "interrupted" });
      return {
        ...s,
        status: "interrupted",
        phase: "supervisor_pending",
        currentRun: { ...run, status: "settled", settleReason: "interrupted", finishedAt: now },
        supervisor: { ...s.supervisor, trigger: { kind: "recovered", ref: run.runId } },
      };
    }, { expectedVersion: state.version });
  }

  /** Восстановить оборванную фазу при session_start новой копии Pi. */
  async recoverOnBind(): Promise<TaskState> {
    let state = await this.core.store.tasks.load(this.core.key);
    if (state.phase === "agent_running") state = await this.interruptActiveRun(null);
    if (state.phase === "supervisor_running") {
      state = await this.core.store.tasks.commit(this.core.key, (s, c) => {
        c.emit("runtime.recovered", "cli", { phase: s.phase, action: "supervisor_reevaluate", details: { cycle: s.supervisor.cycle } });
        return { ...s, status: "interrupted", phase: "supervisor_pending", supervisor: { ...s.supervisor, trigger: { kind: "reevaluate", ref: null } } };
      }, { expectedVersion: state.version });
    } else if (state.status === "interrupted" && (state.phase === "supervisor_pending" || state.phase === "decision_pending")) {
      state = await this.core.store.tasks.commit(this.core.key, (s, c) => {
        c.emit("runtime.recovered", "cli", { phase: s.phase, action: "host_session_resumed", details: { runId: s.currentRun?.runId ?? null } });
        return s;
      }, { expectedVersion: state.version });
    }
    return state;
  }

  async finishWaiting(): Promise<TaskState> {
    const state = await this.core.store.tasks.load(this.core.key);
    if (state.phase !== "waiting") return state;
    await finishWait(this.core, state, "due");
    return this.core.store.tasks.load(this.core.key);
  }

  async waitingHumanMessage(text: string): Promise<TaskState> {
    const state = await this.core.store.tasks.load(this.core.key);
    if (state.phase !== "waiting") return state;
    await waitHumanMessage(this.core, state, text, "chat");
    return this.core.store.tasks.load(this.core.key);
  }

  /** Новый цикл supervisor-а после ответа на ask_human или recovery. */
  async superviseAndApply(): Promise<SupervisorResult> {
    let state = await this.core.store.tasks.load(this.core.key);
    this.core.policy = this.core.store.policyOf(state.process);
    if (state.phase === "supervisor_pending") await startSupervisor(this.core, state);
    for (;;) {
      state = await this.core.store.tasks.load(this.core.key);
      if (state.phase === "supervisor_running") {
        await awaitSupervisor(this.core, state);
        continue;
      }
      if (state.phase === "decision_pending") {
        const decision = state.pendingDecision;
        const next = await applyDecision(this.core, state, validatorResolvers(this.core).attachment);
        return { decision, state: next };
      }
      return { decision: null, state };
    }
  }

  async dispose(): Promise<void> {
    await this.core.pool.dispose();
    await this.core.runtime.dispose();
  }
}

function lastAssistantText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object" || (m as { role?: unknown }).role !== "assistant") continue;
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") return content || null;
    if (Array.isArray(content)) {
      const text = content
        .filter((b): b is { type: string; text?: unknown } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text")
        .map((b) => String(b.text ?? ""))
        .join("\n");
      return text || null;
    }
  }
  return null;
}
