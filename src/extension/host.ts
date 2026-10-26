// ExtensionHost (docs/07-extension-mode.md §4.3–4.4): задача teo в пользовательской сессии Pi.
// X2: binding, роль/tools/model, lock, журнал чата. X3: logical agent runs, report tools,
// supervisor в отдельной сессии и применение решений внутри agent_before_settle.

import path from "node:path";
import type {
  AgentBeforeSettleEvent,
  AgentBeforeSettleEventResult,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { guardToolCall } from "../agents/guard.js";
import { toPiTool } from "../agents/pi/pi-tool-adapter.js";
import { stageKickoff, stageSection } from "../agents/prompts/extension-prompts.js";
import type { AgentRuntime, TeoToolDefinition } from "../agents/runtime.js";
import { agentBuiltinTools } from "../agents/session-spec.js";
import { reportBlockerSchema, reportResultSchema } from "../agents/tools/child-tools.js";
import type { AppContext } from "../app.js";
import { startCommand } from "../app.js";
import { goalTitle, createTask, keyError, titleError } from "../commands/new.js";
import { getAgent, getStage, parseModelRef, type AgentDef, type LoadedPolicy, type WorkStage } from "../domain/policy.js";
import type { ReportBlockerInput, ReportResultInput } from "../domain/runs.js";
import { isFinished, isHalted, type HumanRequest, type TaskState } from "../domain/task-state.js";
import { UsageError } from "../errors/errors.js";
import { GOAL_PROCESS } from "../policy/process-catalog.js";
import type { HeldLock } from "../state/lock-manager.js";
import type { ProjectStore } from "../state/project-store.js";
import { msg } from "../ui/messages.js";
import { readTaskDescription } from "../workflow/agent-step.js";
import { errorText, extensionAppContext } from "./run-command.js";
import { ExtensionWorkflow, extensionReportTools, type SupervisorResult } from "./workflow.js";

/** Запись сессии Pi с привязкой: key = null — задача отвязана командой /teo stop. */
export const BINDING_ENTRY = "teo-binding";
export type BindingEntry = { key: string | null; projectRoot: string };

/** Часть ExtensionAPI, которой пользуется хост (фейк в тестах реализует только её). */
export type HostPi = Pick<
  ExtensionAPI,
  | "on"
  | "registerTool"
  | "appendEntry"
  | "sendMessage"
  | "getActiveTools"
  | "setActiveTools"
  | "getAllTools"
  | "setModel"
  | "getThinkingLevel"
  | "setThinkingLevel"
>;

type Model = NonNullable<ExtensionContext["model"]>;
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

type Binding = {
  key: string;
  sessionId: string;
  app: AppContext;
  store: ProjectStore;
  lock: HeldLock;
  workflow: ExtensionWorkflow;
  release: () => Promise<void>;
  /** Что было у пользователя до привязки: вернуть при /teo stop или завершении. */
  saved: { tools: string[]; model: Model | undefined; thinking: ThinkingLevel };
  /** Этап, для которого уже применена модель роли (D38): не переключать на каждом ходу. */
  modelAppliedFor: string | null;
};

type StageView = { state: TaskState; policy: LoadedPolicy; stage: WorkStage; agent: AgentDef };

export class ExtensionHost {
  private binding: Binding | null = null;

  constructor(
    private readonly pi: HostPi,
    /** Только для embedding/tests; обычное расширение берёт home пользователя процесса Pi. */
    private readonly homeDir?: string,
    /** Детерминированный supervisor в integration-тестах; production создаёт PiAgentRuntime. */
    private readonly runtimeFactory?: () => AgentRuntime,
  ) {}

  get boundKey(): string | null {
    return this.binding?.key ?? null;
  }

  register(): void {
    this.registerReportTools();
    this.pi.on("session_start", (_e, ctx) => this.guarded(ctx, () => this.onSessionStart(ctx)));
    this.pi.on("session_shutdown", () => this.detach());
    this.pi.on("before_agent_start", (e, ctx) => this.guarded(ctx, () => this.onBeforeAgentStart(e, ctx)));
    this.pi.on("agent_before_settle", (e, ctx) => this.guarded(ctx, () => this.onBeforeSettle(e, ctx)));
    this.pi.on("input", (e, ctx) => this.guarded(ctx, () => this.onInput(e)));
    this.pi.on("tool_call", (e, ctx) => this.onToolCall(e, ctx));
  }

  // ---------- команды ----------

  /** /teo start [KEY]: новая задача через диалоги Pi, затем привязка и старт роли этапа. */
  async start(ctx: ExtensionCommandContext, keyArg: string | undefined): Promise<void> {
    this.assertFree();
    const { ctx: app } = extensionAppContext(ctx.cwd, this.homeDir);
    const { store } = await startCommand(app);
    const existing = await store.tasks.listKeys();
    const process = await this.chooseProcess(ctx, store);
    if (!process) return;
    const isGoal = process === GOAL_PROCESS;
    const key = keyArg ?? (await ctx.ui.input(msg.extension.askKey, "PAY-142"))?.trim();
    if (!key) return;
    const keyProblem = keyError(key, existing);
    if (keyProblem) throw new UsageError(keyProblem);
    const description = (await ctx.ui.editor(isGoal ? msg.newTask.goal : msg.newTask.description))?.trim();
    if (!description) return;
    const titleAnswer = await ctx.ui.input(msg.newTask.taskTitle, isGoal ? goalTitle(description) : "");
    if (titleAnswer === undefined) return;
    const title = titleAnswer.trim() || (isGoal ? goalTitle(description) : "");
    const titleProblem = titleError(title);
    if (titleProblem) throw new UsageError(titleProblem);
    const state = await createTask(store, { key, title, description, process });
    await this.bind(ctx, state.key, { kickoff: true });
  }

  /** /teo goal <цель>: режим цели без вопросов — ключ GOAL-N, название из цели (D35). */
  async goal(ctx: ExtensionCommandContext, text: string): Promise<void> {
    this.assertFree();
    const description = text.trim();
    if (!description) throw new UsageError(msg.extension.goalUsage);
    const { ctx: app } = extensionAppContext(ctx.cwd, this.homeDir);
    const { store } = await startCommand(app);
    const keys = await store.tasks.listKeys();
    let n = 1;
    while (keys.some((k) => k.toUpperCase() === `GOAL-${n}`)) n++;
    const state = await createTask(store, { key: `GOAL-${n}`, title: goalTitle(description), description, process: GOAL_PROCESS });
    await this.bind(ctx, state.key, { kickoff: true });
  }

  /** /teo resume KEY: продолжить существующую задачу в этой сессии. */
  async resume(ctx: ExtensionCommandContext, keyArg: string | undefined): Promise<void> {
    if (!keyArg) throw new UsageError(msg.extension.resumeUsage);
    if (this.binding?.key.toUpperCase() === keyArg.toUpperCase()) return ctx.ui.notify(msg.extension.alreadyBound(this.binding.key), "info");
    this.assertFree();
    await this.bind(ctx, keyArg, { kickoff: true });
  }

  /** /teo stop: отвязать задачу от сессии и вернуть пользователю его инструменты и модель. */
  async stop(ctx: ExtensionContext): Promise<void> {
    const b = this.binding;
    if (!b) return ctx.ui.notify(msg.extension.notBound, "info");
    await this.closeBinding(b, ctx, "stop", "human");
    ctx.ui.notify(msg.extension.stopped(b.key), "info");
  }

  // ---------- события Pi ----------

  /** Перезапуск Pi с привязанной сессией: задача продолжает держать binding (recovery хода — X4). */
  private async onSessionStart(ctx: ExtensionContext): Promise<void> {
    if (this.binding) return;
    const entry = ctx.sessionManager
      .getEntries()
      .filter((e): e is typeof e & { type: "custom"; customType: string; data?: unknown } => e.type === "custom" && "customType" in e && e.customType === BINDING_ENTRY)
      .at(-1);
    const data = entry?.data as BindingEntry | undefined;
    if (!data?.key || path.resolve(data.projectRoot) !== path.resolve(ctx.cwd)) return;
    try {
      await this.bind(ctx, data.key, { kickoff: false, auto: true });
    } catch (err) {
      ctx.ui.notify(msg.extension.autoResumeFailed(data.key, err instanceof Error ? err.message : String(err)), "warning");
    }
  }

  /** Начало host agent run: роль в system section, state → agent_running, tools/model этапа. */
  private async onBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<void> {
    const b = this.binding;
    if (!b) return;
    const pending = await this.stageView(b);
    if (!pending) return;
    event.systemPromptOptions.sections["teo_stage"] = await this.roleSection(b, pending);
    if (pending.state.phase === "agent_pending") await b.workflow.beginAgentTurn(promptText(event));
    const view = (await this.stageView(b)) ?? pending;
    await this.configureRole(b, view, ctx);
  }

  /** Конец хода: settle → отдельный supervisor → применить решение → продолжить ту же сессию. */
  private async onBeforeSettle(event: AgentBeforeSettleEvent, ctx: ExtensionContext): Promise<AgentBeforeSettleEventResult | void> {
    const b = this.binding;
    if (!b) return;
    const current = await b.store.tasks.load(b.key);
    if (current.phase !== "agent_running") return;
    ctx.ui.setStatus("teo", msg.extension.supervisorChecking(b.key, current.supervisor.cycle + 1));
    let result = await b.workflow.settleAndSupervise(event);

    // ask_human может породить следующий supervisor-цикл прямо в том же boundary (D39).
    for (;;) {
      if (!result.decision) {
        if (isHalted(result.state)) return this.finishResult(b, ctx, result.state);
        await this.refreshStatus(b, ctx);
        return;
      }
      if (result.decision.action !== "ask_human") break;
      const answered = await this.answerSupervisorQuestion(b, ctx, result.state.pendingHumanRequest);
      if (!answered) {
        ctx.ui.setStatus("teo", msg.extension.waitingHuman(b.key));
        return { entries: [customMessage(msg.extension.questionDeferred)], continue: false };
      }
      result = await b.workflow.superviseAndApply();
    }

    return this.applyInHostSession(b, ctx, result);
  }

  /** Сообщение пользователя при привязанной задаче — подтверждение для guard humanResponse (D40). */
  private async onInput(event: InputEvent): Promise<InputEventResult | void> {
    const b = this.binding;
    const text = event.text.trim();
    if (!b || event.source === "extension" || !text || text.startsWith("/")) return;
    b.lock.signal.throwIfAborted();
    await b.store.tasks.commit(b.key, (s, c) => {
      c.emit("human.responded", "human", { requestId: null, answer: text, selectedOption: null, channel: "chat" });
      return s;
    });
    return { action: "continue" };
  }

  /** Guard роли этапа: внутри .teo — только artifacts задачи; после report_* ход должен завершиться. */
  private async onToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void> {
    const b = this.binding;
    if (!b) return;
    const t = b.store.tasks.task(b.key);
    const verdict = await guardToolCall(
      {
        role: "agent",
        projectRoot: b.store.layout.projectRoot,
        taskDir: t.dir,
        writableInsideTeo: [t.artifactsDir],
        readableRoots: [b.store.layout.projectRoot],
        isReported: () => b.workflow.isReported(),
      },
      event.toolName,
      event.input,
      ctx.cwd,
    );
    return verdict.allow ? undefined : { block: true, reason: verdict.reason, terminate: verdict.terminate };
  }

  // ---------- X3: решения supervisor-а ----------

  private async applyInHostSession(
    b: Binding,
    ctx: ExtensionContext,
    result: SupervisorResult,
  ): Promise<AgentBeforeSettleEventResult | void> {
    const decision = result.decision;
    if (!decision) return isHalted(result.state) ? this.finishResult(b, ctx, result.state) : undefined;

    switch (decision.action) {
      case "continue_current_agent": {
        const text = msg.extension.continueAgent(decision.input.message);
        await b.workflow.beginAgentTurn(text);
        const view = await this.requireStageView(b);
        await this.configureRole(b, view, ctx);
        return { entries: [customMessage(text)], continue: true };
      }
      case "restart_current_agent": {
        const text = msg.extension.restartAgent(decision.input.reason, decision.input.message);
        await b.workflow.beginAgentTurn(text);
        const view = await this.requireStageView(b);
        await this.configureRole(b, view, ctx);
        return { entries: [customMessage(text)], continue: true };
      }
      case "transition_stage": {
        if (isHalted(result.state)) return this.finishResult(b, ctx, result.state);
        const view = await this.requireStageView(b);
        const role = await this.roleSection(b, view);
        const text = msg.extension.transition(
          result.state.key,
          view.stage.title,
          view.agent.title,
          decision.input.reason,
          decision.input.handoff ?? null,
          role,
        );
        await b.workflow.beginAgentTurn(text);
        const running = await this.requireStageView(b);
        await this.configureRole(b, running, ctx);
        return { entries: [customMessage(text)], continue: true };
      }
      case "schedule_recheck":
        ctx.ui.setStatus("teo", msg.extension.waitingUntil(b.key, result.state.wait?.dueAt ?? "?"));
        return { entries: [customMessage(msg.extension.recheckScheduled(decision.input.waitingFor, result.state.wait?.dueAt ?? "?"))], continue: false };
      case "block_task":
      case "cancel_task":
        return this.finishResult(b, ctx, result.state);
      case "ask_human":
        // Цикл ask_human обработан выше до входа сюда.
        return;
    }
  }

  private async answerSupervisorQuestion(b: Binding, ctx: ExtensionContext, request: HumanRequest | null): Promise<boolean> {
    if (!request) throw new Error("решение ask_human без pendingHumanRequest");
    let answer: string | undefined;
    if (request.options?.length) answer = await ctx.ui.select(request.question, request.options);
    else answer = await ctx.ui.editor(request.question, request.context ?? "");
    if (answer === undefined) return false;
    const text = answer.trim();
    if (!text) return false;
    let responseId = "";
    await b.store.tasks.commit(b.key, (s, c) => {
      responseId = c.emit("human.responded", "human", {
        requestId: request.requestId,
        answer: text,
        selectedOption: request.options?.includes(text) ? text : null,
      });
      return {
        ...s,
        status: "active",
        phase: "supervisor_pending",
        pendingHumanRequest: null,
        supervisor: { ...s.supervisor, trigger: { kind: "human_responded", ref: responseId } },
      };
    }, { expectedVersion: (await b.store.tasks.load(b.key)).version });
    return true;
  }

  private async finishResult(b: Binding, ctx: ExtensionContext, state: TaskState): Promise<AgentBeforeSettleEventResult> {
    const text = state.status === "terminal"
      ? msg.extension.terminal(state.key, b.store.stageTitle(state.process, state.stage) ?? state.stage)
      : state.status === "cancelled"
        ? msg.extension.cancelled(state.key, state.statusReason?.message ?? "")
        : msg.extension.blocked(state.key, state.statusReason?.message ?? "");
    await this.closeBinding(b, ctx, "finished", "cli");
    ctx.ui.notify(text, state.status === "terminal" ? "info" : "warning");
    return { entries: [customMessage(text)], continue: false };
  }

  // ---------- внутреннее ----------

  private registerReportTools(): void {
    const result: TeoToolDefinition<typeof reportResultSchema> = {
      name: "report_result",
      description: "Завершить работу текущего этапа отчётом. Supervisor независимо проверит факты.",
      parameters: reportResultSchema,
      execute: async (input) => this.binding?.workflow.executeReport("report_result", input as ReportResultInput)
        ?? { content: "NO_ACTIVE_TASK: сессия не ведёт задачу teo", isError: true },
    };
    const blocker: TeoToolDefinition<typeof reportBlockerSchema> = {
      name: "report_blocker",
      description: "Сообщить, что продолжить текущий этап невозможно. Supervisor решит, что делать.",
      parameters: reportBlockerSchema,
      execute: async (input) => this.binding?.workflow.executeReport("report_blocker", input as ReportBlockerInput)
        ?? { content: "NO_ACTIVE_TASK: сессия не ведёт задачу teo", isError: true },
    };
    const resultTool = toPiTool(result);
    const blockerTool = toPiTool(blocker);
    // Вне активной задачи report_* не должны торчать в обычной сессии Pi.
    resultTool.defaultActive = false;
    blockerTool.defaultActive = false;
    this.pi.registerTool(resultTool);
    this.pi.registerTool(blockerTool);
  }

  private assertFree(): void {
    if (this.binding) throw new UsageError(msg.extension.busy(this.binding.key));
  }

  private async chooseProcess(ctx: ExtensionCommandContext, store: ProjectStore): Promise<string | null> {
    const own = store.processes.filter((p) => p.ok && !p.builtin);
    const goal = store.process(GOAL_PROCESS);
    const options = [...own.map((p) => p.name), ...(goal?.ok ? [GOAL_PROCESS] : [])];
    const [only] = options;
    if (options.length === 1 && only) return only;
    if (options.length === 0) throw store.noProcessesError();
    const label = (name: string) => (name === GOAL_PROCESS ? msg.newTask.goalChoice : name);
    const picked = await ctx.ui.select(msg.newTask.chooseProcess, options.map(label));
    return options.find((name) => label(name) === picked) ?? null;
  }

  private async bind(ctx: ExtensionContext, keyArg: string, opts: { kickoff: boolean; auto?: boolean }): Promise<void> {
    const { ctx: app } = extensionAppContext(ctx.cwd, this.homeDir);
    const { store } = await startCommand(app);
    const key = await store.requireKey(keyArg);
    const before = await store.tasks.readState(key);
    const policy = store.policyOf(before.process);
    if (isFinished(before)) throw new UsageError(msg.extension.finished(key));
    if (isHalted(before)) throw new UsageError(msg.extension.halted(key, before.statusReason?.message ?? before.status));
    const sessionId = ctx.sessionManager.getSessionId();
    if (opts.auto && before.hostSession?.sessionId !== sessionId) return;

    const held = await store.holdLock({ command: "extension", taskKey: key, onLost: () => void this.lost(ctx) });
    try {
      held.lock.signal.throwIfAborted();
      const state = await store.tasks.load(key);
      if (state.hostSession?.sessionId !== sessionId) {
        const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
        await store.tasks.commit(key, (s, c) => {
          if (s.hostSession) c.emit("session.unbound", "cli", { sessionId: s.hostSession.sessionId, reason: "other_session" });
          c.emit("session.bound", "human", { sessionId, sessionFile });
          return { ...s, hostSession: { sessionId, sessionFile, boundAt: c.now } };
        });
      }
    } catch (err) {
      await held.release();
      throw err;
    }
    const workflow = new ExtensionWorkflow({
      key,
      app,
      store,
      lock: held.lock,
      policy,
      ...(this.runtimeFactory ? { runtime: this.runtimeFactory() } : {}),
    });
    this.binding = {
      key,
      sessionId,
      app,
      store,
      lock: held.lock,
      workflow,
      release: held.release,
      saved: { tools: this.pi.getActiveTools(), model: ctx.model, thinking: this.pi.getThinkingLevel() },
      modelAppliedFor: null,
    };
    if (!opts.auto) this.pi.appendEntry<BindingEntry>(BINDING_ENTRY, { key, projectRoot: store.layout.projectRoot });

    const view = await this.stageView(this.binding);
    if (!view) return;
    ctx.ui.setStatus("teo", msg.extension.status(key, view.stage.title, view.agent.title, view.state.supervisor.cycle));
    ctx.ui.notify(opts.auto ? msg.extension.autoResumed(key, view.stage.title) : msg.extension.bound(key, view.stage.title, view.agent.title), "info");
    if (opts.kickoff && view.state.phase === "agent_pending" && view.state.nextAgentInput?.kind === "initial") {
      this.pi.sendMessage(
        { customType: "teo-stage", content: stageKickoff({ stageTitle: view.stage.title, agentTitle: view.agent.title }), display: true },
        { triggerTurn: true },
      );
    }
  }

  private async stageView(b: Binding): Promise<StageView | null> {
    const state = await b.store.tasks.load(b.key);
    if (isHalted(state)) return null;
    const policy = b.store.policyOf(state.process);
    const stage = getStage(policy.spec, state.stage);
    if (stage?.kind !== "work") return null;
    const agent = getAgent(policy.spec, state.currentRun?.stage === state.stage ? state.currentRun.agentId : stage.agent);
    return agent ? { state, policy, stage, agent } : null;
  }

  private async requireStageView(b: Binding): Promise<StageView> {
    const view = await this.stageView(b);
    if (!view) throw new Error("после решения supervisor-а нет рабочего этапа");
    return view;
  }

  private async roleSection(b: Binding, view: StageView): Promise<string> {
    return stageSection({
      task: {
        key: view.state.key,
        title: view.state.title,
        description: await readTaskDescription(b.store.tasks.task(view.state.key).taskMd),
      },
      process: view.state.process,
      spec: view.policy.spec,
      stage: view.stage,
      agent: view.agent,
      handoff: view.state.nextAgentInput?.kind === "initial" ? view.state.nextAgentInput.message : null,
      taskDirDisplay: path.relative(b.store.layout.projectRoot, b.store.tasks.task(view.state.key).dir),
    });
  }

  private async configureRole(b: Binding, view: StageView, ctx: ExtensionContext): Promise<void> {
    const available = new Set(this.pi.getAllTools().map((t) => t.name));
    const wanted = [...agentBuiltinTools(view.agent), ...extensionReportTools()];
    this.pi.setActiveTools([...new Set(wanted)].filter((t) => available.has(t)));
    await this.applyModel(b, view, ctx);
    ctx.ui.setStatus("teo", msg.extension.status(view.state.key, view.stage.title, view.agent.title, view.state.supervisor.cycle));
  }

  /** Модель роли (D38): только если у агента не default; один раз на этап. */
  private async applyModel(b: Binding, view: StageView, ctx: ExtensionContext): Promise<void> {
    const stageKey = `${view.state.stage}:${view.state.stageEntryEventId}`;
    if (b.modelAppliedFor === stageKey) return;
    b.modelAppliedFor = stageKey;
    const ref = parseModelRef(view.agent.model);
    if (!ref || ref.kind === "default") return;
    const model = ctx.modelRegistry.find(ref.provider, ref.modelId);
    if (!model) return ctx.ui.notify(msg.extension.modelMissing(view.agent.model, view.agent.title), "warning");
    if (ctx.model?.provider !== model.provider || ctx.model?.id !== model.id) {
      const changed = await this.pi.setModel(model);
      if (!changed) return ctx.ui.notify(msg.extension.modelUnavailable(view.agent.model, view.agent.title), "warning");
    }
    const thinking = view.agent.thinking ?? ref.thinking;
    if (thinking) this.pi.setThinkingLevel(thinking);
  }

  private async refreshStatus(b: Binding, ctx: ExtensionContext): Promise<void> {
    const view = await this.stageView(b);
    if (view) ctx.ui.setStatus("teo", msg.extension.status(view.state.key, view.stage.title, view.agent.title, view.state.supervisor.cycle));
  }

  private async restore(b: Binding): Promise<void> {
    this.pi.setActiveTools(b.saved.tools);
    if (b.saved.model) await this.pi.setModel(b.saved.model);
    this.pi.setThinkingLevel(b.saved.thinking);
  }

  private async closeBinding(
    b: Binding,
    ctx: ExtensionContext,
    reason: "stop" | "finished",
    actor: "human" | "cli",
  ): Promise<void> {
    b.lock.signal.throwIfAborted();
    await b.store.tasks.commit(b.key, (s, c) => {
      if (!s.hostSession) return s;
      c.emit("session.unbound", actor, { sessionId: b.sessionId, reason });
      return { ...s, hostSession: null };
    });
    this.pi.appendEntry<BindingEntry>(BINDING_ENTRY, { key: null, projectRoot: b.store.layout.projectRoot });
    await this.restore(b).catch(() => undefined);
    if (this.binding === b) this.binding = null;
    try {
      await b.workflow.dispose();
    } finally {
      await b.release();
    }
    ctx.ui.setStatus("teo", undefined);
  }

  /** Lock перехвачен другим процессом: задача больше не наша. */
  private async lost(ctx: ExtensionContext): Promise<void> {
    const b = this.binding;
    if (!b) return;
    this.binding = null;
    await this.restore(b).catch(() => undefined);
    await b.workflow.dispose().catch(() => undefined);
    await b.release().catch(() => undefined);
    ctx.ui.setStatus("teo", undefined);
    ctx.ui.notify(msg.extension.lockLost(b.key), "error");
  }

  /** Закрытие Pi: освободить lock, но сохранить binding в state/session для recovery (D42). */
  async detach(): Promise<void> {
    const b = this.binding;
    this.binding = null;
    if (b) {
      try {
        await b.workflow.dispose();
      } finally {
        await b.release();
      }
    }
  }

  private async guarded<T>(ctx: ExtensionContext, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      ctx.ui.notify(errorText(this.binding?.app ?? extensionAppContext(ctx.cwd, this.homeDir).ctx, err), "error");
      return undefined;
    }
  }
}

function customMessage(content: string): NonNullable<AgentBeforeSettleEventResult["entries"]>[number] {
  return { type: "custom_message", customType: "teo-supervisor", content, display: true };
}

function promptText(event: BeforeAgentStartEvent): string {
  if (event.messageType === "user") return event.prompt;
  const content = event.message.content;
  if (typeof content === "string") return content;
  return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}
