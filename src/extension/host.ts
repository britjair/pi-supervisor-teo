// ExtensionHost (docs/07-extension-mode.md §4.3–4.4): задача teo в пользовательской сессии Pi.
// X2: binding, роль/tools/model, lock, журнал чата. X3: logical agent runs и supervisor.
// X4: userSession:new, recheck-таймеры, pause/resume и recovery оборванных фаз.

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
  SessionShutdownEvent,
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
  /** Таймер schedule_recheck живёт только пока открыта привязанная Pi-сессия. */
  waitTimer: ReturnType<typeof setTimeout> | null;
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
    this.pi.on("session_shutdown", (e) => this.onSessionShutdown(e));
    this.pi.on("before_agent_start", (e, ctx) => this.guarded(ctx, () => this.onBeforeAgentStart(e, ctx)));
    this.pi.on("agent_before_settle", (e, ctx) => this.guarded(ctx, () => this.onBeforeSettle(e, ctx)));
    this.pi.on("input", (e, ctx) => this.guarded(ctx, () => this.onInput(e, ctx)));
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

  /** /teo resume KEY: продолжить существующую задачу или снять явную паузу. */
  async resume(ctx: ExtensionCommandContext, keyArg: string | undefined): Promise<void> {
    if (!keyArg) throw new UsageError(msg.extension.resumeUsage);
    if (this.binding?.key.toUpperCase() === keyArg.toUpperCase()) {
      const state = await this.binding.store.tasks.load(this.binding.key);
      if (state.hostSession?.paused) return this.resumePaused(this.binding, ctx);
      return ctx.ui.notify(msg.extension.alreadyBound(this.binding.key), "info");
    }
    this.assertFree();
    const b = await this.bind(ctx, keyArg, { kickoff: false });
    if (b) await this.resumeBoundWorkflow(b, ctx, true);
  }

  /** /teo pause: оставить binding и lock, но временно вернуть обычный режим Pi. */
  async pause(ctx: ExtensionContext): Promise<void> {
    const b = this.binding;
    if (!b) return ctx.ui.notify(msg.extension.notBound, "info");
    const state = await b.store.tasks.load(b.key);
    if (state.hostSession?.paused) return ctx.ui.notify(msg.extension.alreadyPaused(b.key), "info");
    await b.store.tasks.commit(b.key, (s, c) => {
      c.emit("supervision.paused", "human", { sessionId: b.sessionId });
      return { ...s, hostSession: s.hostSession ? { ...s.hostSession, paused: true } : null };
    }, { expectedVersion: state.version });
    this.clearWaitTimer(b);
    await this.restoreUserEnvironment(b);
    b.modelAppliedFor = null;
    ctx.ui.setStatus("teo", msg.extension.statusPaused(b.key));
    ctx.ui.notify(msg.extension.paused(b.key), "info");
  }

  /** /teo recover KEY: явный вход в тот же recovery-путь, что и session_start. */
  async recover(ctx: ExtensionCommandContext, keyArg: string | undefined): Promise<void> {
    if (!keyArg) throw new UsageError(msg.extension.recoverUsage);
    if (!this.binding) {
      const b = await this.bind(ctx, keyArg, { kickoff: false });
      if (b) await this.resumeBoundWorkflow(b, ctx, true);
      return;
    }
    if (this.binding.key.toUpperCase() !== keyArg.toUpperCase()) this.assertFree();
    const state = await this.binding.store.tasks.load(this.binding.key);
    if (state.hostSession?.paused) await this.resumePaused(this.binding, ctx);
    else await this.resumeBoundWorkflow(this.binding, ctx, true);
  }

  /** /teo next: создать новую пользовательскую Pi-сессию для текущего этапа. */
  async next(ctx: ExtensionCommandContext): Promise<void> {
    const b = this.binding;
    if (!b) return ctx.ui.notify(msg.extension.notBound, "info");
    const state = await b.store.tasks.load(b.key);
    if (!state.hostSession?.awaitingNextSession) throw new UsageError(msg.extension.nextNotRequired(b.key));
    const view = await this.requireStageView(b);
    const kickoff = stageKickoff({ stageTitle: view.stage.title, agentTitle: view.agent.title });
    const nextStatus = msg.extension.status(b.key, view.stage.title, view.agent.title, view.state.supervisor.cycle);
    const parentSession = ctx.sessionManager.getSessionFile() ?? undefined;
    const result = await ctx.newSession({
      ...(parentSession ? { parentSession } : {}),
      setup: async (manager) => {
        const nextSessionId = manager.getSessionId();
        const current = await b.store.tasks.load(b.key);
        await b.store.tasks.commit(b.key, (s) => ({
          ...s,
          hostSession: s.hostSession ? { ...s.hostSession, nextSessionId } : null,
        }), { expectedVersion: current.version });
        manager.appendCustomEntry(BINDING_ENTRY, { key: b.key, projectRoot: ctx.cwd } satisfies BindingEntry);
      },
      withSession: async (replacementCtx) => {
        // После замены исходный ProjectStore уже stale: все данные готовим до ctx.newSession().
        replacementCtx.ui.setStatus("teo", nextStatus);
        await replacementCtx.sendMessage({ customType: "teo-role-kickoff", content: kickoff, display: true }, { triggerTurn: true });
      },
    });
    if (result.cancelled) {
      const current = await b.store.tasks.load(b.key);
      if (current.hostSession?.nextSessionId) {
        await b.store.tasks.commit(b.key, (s) => ({
          ...s,
          hostSession: s.hostSession ? { ...s.hostSession, nextSessionId: null } : null,
        }), { expectedVersion: current.version });
      }
      ctx.ui.notify(msg.extension.nextCancelled, "info");
    }
  }

  /** /teo stop: отвязать задачу от сессии и вернуть пользователю его инструменты и модель. */
  async stop(ctx: ExtensionContext): Promise<void> {
    const b = this.binding;
    if (!b) return ctx.ui.notify(msg.extension.notBound, "info");
    await this.closeBinding(b, ctx, "stop", "human");
    ctx.ui.notify(msg.extension.stopped(b.key), "info");
  }

  // ---------- события Pi ----------

  /** Перезапуск/замена Pi-сессии: binding и незавершённая фаза восстанавливаются автоматически. */
  private async onSessionStart(ctx: ExtensionContext): Promise<void> {
    if (this.binding) return;
    const entry = ctx.sessionManager
      .getEntries()
      .filter((e): e is typeof e & { type: "custom"; customType: string; data?: unknown } => e.type === "custom" && "customType" in e && e.customType === BINDING_ENTRY)
      .at(-1);
    const data = entry?.data as BindingEntry | undefined;
    if (!data?.key || path.resolve(data.projectRoot) !== path.resolve(ctx.cwd)) return;
    try {
      const b = await this.bind(ctx, data.key, { kickoff: false, auto: true });
      if (b) await this.resumeBoundWorkflow(b, ctx, true);
    } catch (err) {
      ctx.ui.notify(msg.extension.autoResumeFailed(data.key, err instanceof Error ? err.message : String(err)), "warning");
    }
  }

  private async onSessionShutdown(event: SessionShutdownEvent): Promise<void> {
    const b = this.binding;
    if (!b) return;
    try {
      const state = await b.store.tasks.load(b.key);
      if (!state.hostSession?.paused && state.phase === "agent_running") {
        await b.workflow.interruptActiveRun(`pi:${event.reason}`);
      }
    } catch {
      // Shutdown обязан освободить lock даже при повреждённом state.
    } finally {
      await this.detach();
    }
  }

  /** Начало host agent run: роль в system section, state → agent_running, tools/model этапа. */
  private async onBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<void> {
    const b = this.binding;
    if (!b) return;
    const pending = await this.stageView(b);
    if (!pending || pending.state.hostSession?.paused || pending.state.hostSession?.awaitingNextSession) return;
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
    if (current.hostSession?.paused) {
      await b.workflow.settleOnly(event);
      return;
    }
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
  private async onInput(event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult | void> {
    const b = this.binding;
    const text = event.text.trim();
    if (!b || event.source === "extension" || !text || text.startsWith("/")) return;
    b.lock.signal.throwIfAborted();
    const state = await b.store.tasks.load(b.key);
    if (state.phase === "waiting" && !state.hostSession?.paused) {
      this.clearWaitTimer(b);
      await b.workflow.waitingHumanMessage(text);
      await this.resumeBoundWorkflow(b, ctx, true);
      return { action: "handled" };
    }
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
        if (view.stage.userSession === "new") {
          await this.requestNextSession(b, ctx, view);
          return { entries: [customMessage(msg.extension.nextRequired(view.stage.title))], continue: false };
        }
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
        await this.scheduleWaitTimer(b, ctx);
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
    if (request.context?.trim()) ctx.ui.notify(request.context.trim(), "info");
    if (request.options?.length) answer = await ctx.ui.select(request.question, request.options);
    else answer = await ctx.ui.editor(request.question, "");
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

  private async bind(ctx: ExtensionContext, keyArg: string, opts: { kickoff: boolean; auto?: boolean }): Promise<Binding | null> {
    const { ctx: app } = extensionAppContext(ctx.cwd, this.homeDir);
    const { store } = await startCommand(app);
    const key = await store.requireKey(keyArg);
    const before = await store.tasks.readState(key);
    const policy = store.policyOf(before.process);
    if (isFinished(before)) throw new UsageError(msg.extension.finished(key));
    if (isHalted(before)) throw new UsageError(msg.extension.halted(key, before.statusReason?.message ?? before.status));
    const sessionId = ctx.sessionManager.getSessionId();
    if (opts.auto && before.hostSession?.sessionId !== sessionId && before.hostSession?.nextSessionId !== sessionId) return null;

    const held = await store.holdLock({ command: "extension", taskKey: key, onLost: () => void this.lost(ctx) });
    try {
      held.lock.signal.throwIfAborted();
      const state = await store.tasks.load(key);
      if (state.hostSession?.sessionId !== sessionId) {
        const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
        await store.tasks.commit(key, (s, c) => {
          if (s.hostSession) c.emit("session.unbound", "cli", { sessionId: s.hostSession.sessionId, reason: "other_session" });
          c.emit("session.bound", "human", { sessionId, sessionFile });
          return { ...s, hostSession: { sessionId, sessionFile, boundAt: c.now, paused: false, awaitingNextSession: false, nextSessionId: null } };
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
      waitTimer: null,
    };
    if (!opts.auto) this.pi.appendEntry<BindingEntry>(BINDING_ENTRY, { key, projectRoot: store.layout.projectRoot });

    const view = await this.stageView(this.binding);
    if (!view) return this.binding;
    if (view.state.hostSession?.paused) {
      ctx.ui.setStatus("teo", msg.extension.statusPaused(key));
      return this.binding;
    }
    ctx.ui.setStatus("teo", msg.extension.status(key, view.stage.title, view.agent.title, view.state.supervisor.cycle));
    ctx.ui.notify(opts.auto ? msg.extension.autoResumed(key, view.stage.title) : msg.extension.bound(key, view.stage.title, view.agent.title), "info");
    if (view.state.phase === "waiting") await this.scheduleWaitTimer(this.binding, ctx);
    if (opts.kickoff && view.state.phase === "agent_pending" && !view.state.hostSession?.awaitingNextSession) {
      this.pi.sendMessage(
        { customType: "teo-stage", content: stageKickoff({ stageTitle: view.stage.title, agentTitle: view.agent.title }), display: true },
        { triggerTurn: true },
      );
    }
    return this.binding;
  }

  private async resumePaused(b: Binding, ctx: ExtensionContext): Promise<void> {
    const state = await b.store.tasks.load(b.key);
    await b.store.tasks.commit(b.key, (s, c) => {
      c.emit("supervision.resumed", "human", { sessionId: b.sessionId });
      return { ...s, hostSession: s.hostSession ? { ...s.hostSession, paused: false } : null };
    }, { expectedVersion: state.version });
    ctx.ui.notify(msg.extension.resumed(b.key), "info");
    await this.resumeBoundWorkflow(b, ctx, true);
  }

  /** Продолжение workflow вне settle-boundary: session_start, /teo resume, таймер recheck. */
  private async resumeBoundWorkflow(b: Binding, ctx: ExtensionContext, kickoff: boolean): Promise<void> {
    let state = await b.workflow.recoverOnBind();
    if (state.hostSession?.paused) {
      ctx.ui.setStatus("teo", msg.extension.statusPaused(b.key));
      return;
    }
    if (isHalted(state)) {
      await this.finishResult(b, ctx, state);
      return;
    }
    if (state.hostSession?.awaitingNextSession) {
      const view = await this.requireStageView(b);
      await this.requestNextSession(b, ctx, view, false);
      return;
    }
    if (state.phase === "waiting") {
      await this.scheduleWaitTimer(b, ctx);
      ctx.ui.setStatus("teo", msg.extension.waitingUntil(b.key, state.wait?.dueAt ?? "?"));
      return;
    }
    if (state.phase === "human_pending") {
      const answered = await this.answerSupervisorQuestion(b, ctx, state.pendingHumanRequest);
      if (!answered) {
        ctx.ui.setStatus("teo", msg.extension.waitingHuman(b.key));
        return;
      }
      state = await b.store.tasks.load(b.key);
    }
    if (state.phase === "supervisor_pending" || state.phase === "decision_pending") {
      let result = await b.workflow.superviseAndApply();
      while (result.decision?.action === "ask_human") {
        const answered = await this.answerSupervisorQuestion(b, ctx, result.state.pendingHumanRequest);
        if (!answered) {
          ctx.ui.setStatus("teo", msg.extension.waitingHuman(b.key));
          return;
        }
        result = await b.workflow.superviseAndApply();
      }
      await this.applyOutsideBoundary(b, ctx, result);
      return;
    }
    if (kickoff && state.phase === "agent_pending") {
      const view = await this.requireStageView(b);
      ctx.ui.setStatus("teo", msg.extension.status(b.key, view.stage.title, view.agent.title, view.state.supervisor.cycle));
      this.pi.sendMessage(
        { customType: "teo-stage", content: stageKickoff({ stageTitle: view.stage.title, agentTitle: view.agent.title }), display: true },
        { triggerTurn: true },
      );
    }
  }

  private async applyOutsideBoundary(b: Binding, ctx: ExtensionContext, result: SupervisorResult): Promise<void> {
    const decision = result.decision;
    if (!decision) {
      if (isHalted(result.state)) await this.finishResult(b, ctx, result.state);
      else await this.refreshStatus(b, ctx);
      return;
    }
    switch (decision.action) {
      case "continue_current_agent":
        this.pi.sendMessage({ customType: "teo-supervisor", content: msg.extension.continueAgent(decision.input.message), display: true }, { triggerTurn: true });
        return;
      case "restart_current_agent":
        this.pi.sendMessage({ customType: "teo-supervisor", content: msg.extension.restartAgent(decision.input.reason, decision.input.message), display: true }, { triggerTurn: true });
        return;
      case "transition_stage": {
        if (isHalted(result.state)) {
          await this.finishResult(b, ctx, result.state);
          return;
        }
        const view = await this.requireStageView(b);
        if (view.stage.userSession === "new") {
          await this.requestNextSession(b, ctx, view);
          return;
        }
        const role = await this.roleSection(b, view);
        this.pi.sendMessage({
          customType: "teo-transition",
          content: msg.extension.transition(b.key, view.stage.title, view.agent.title, decision.input.reason, decision.input.handoff ?? null, role),
          display: true,
        }, { triggerTurn: true });
        return;
      }
      case "schedule_recheck":
        await this.scheduleWaitTimer(b, ctx);
        ctx.ui.setStatus("teo", msg.extension.waitingUntil(b.key, result.state.wait?.dueAt ?? "?"));
        return;
      case "block_task":
      case "cancel_task":
        await this.finishResult(b, ctx, result.state);
        return;
      case "ask_human":
        return;
    }
  }

  private async requestNextSession(b: Binding, ctx: ExtensionContext, view: StageView, emit = true): Promise<void> {
    if (emit && !view.state.hostSession?.awaitingNextSession) {
      await b.store.tasks.commit(b.key, (s, c) => {
        c.emit("session.next_requested", "cli", { sessionId: b.sessionId, stage: s.stage });
        return { ...s, hostSession: s.hostSession ? { ...s.hostSession, awaitingNextSession: true, nextSessionId: null } : null };
      }, { expectedVersion: view.state.version });
    }
    await this.restoreUserEnvironment(b);
    b.modelAppliedFor = null;
    ctx.ui.setStatus("teo", msg.extension.statusNext(b.key, view.stage.title));
    ctx.ui.setEditorText("/teo next");
    ctx.ui.notify(msg.extension.nextRequired(view.stage.title), "info");
  }

  private async scheduleWaitTimer(b: Binding, ctx: ExtensionContext): Promise<void> {
    this.clearWaitTimer(b);
    try {
      const state = await b.store.tasks.load(b.key);
      if (this.binding !== b || state.phase !== "waiting" || !state.wait || state.hostSession?.paused) return;
      const delay = Math.max(0, Math.min(2_147_483_647, new Date(state.wait.dueAt).getTime() - b.app.clock.now().getTime()));
      b.waitTimer = setTimeout(() => this.fireWaitTimer(b, ctx).catch((err) => ctx.ui.notify(errorText(b.app, err), "warning")), delay);
    } catch (err) {
      ctx.ui.notify(errorText(b.app, err), "warning");
    }
  }

  private async fireWaitTimer(b: Binding, ctx: ExtensionContext): Promise<void> {
    if (this.binding !== b) return;
    b.waitTimer = null;
    const state = await b.store.tasks.load(b.key);
    if (state.phase !== "waiting" || !state.wait || state.hostSession?.paused) return;
    if (b.app.clock.now().getTime() < new Date(state.wait.dueAt).getTime()) {
      await this.scheduleWaitTimer(b, ctx);
      return;
    }
    if (!ctx.isIdle()) {
      b.waitTimer = setTimeout(() => this.fireWaitTimer(b, ctx).catch((err) => ctx.ui.notify(errorText(b.app, err), "warning")), 1000);
      return;
    }
    const { waitingFor, message } = state.wait;
    await b.workflow.finishWaiting();
    this.pi.sendMessage({ customType: "teo-recheck", content: msg.extension.recheckDue(waitingFor, message), display: true }, { triggerTurn: true });
  }

  private clearWaitTimer(b: Binding): void {
    if (b.waitTimer) clearTimeout(b.waitTimer);
    b.waitTimer = null;
  }

  private async restoreUserEnvironment(b: Binding): Promise<void> {
    this.pi.setActiveTools(b.saved.tools);
    if (b.saved.model) await this.pi.setModel(b.saved.model).catch(() => false);
    if (b.saved.thinking) this.pi.setThinkingLevel(b.saved.thinking);
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
    this.clearWaitTimer(b);
    const before = await b.store.tasks.load(b.key);
    if (before.phase === "agent_running") await b.workflow.interruptActiveRun("teo:stop");
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
    this.clearWaitTimer(b);
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
      this.clearWaitTimer(b);
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
