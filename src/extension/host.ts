// ExtensionHost (docs/07-extension-mode.md §4.3, этап X2): задача teo в пользовательской сессии Pi.
// - привязка задачи к сессии: state.hostSession + запись "teo-binding" в сессии, lock проекта у процесса Pi;
// - на каждом ходу: роль этапа в системном промпте, инструменты агента по Policy, модель роли (D38), guard;
// - сообщения пользователя — в журнал задачи как human.responded { channel: "chat" } (D40, D43).
// Проверка supervisor-ом в конце хода — этап X3.

import path from "node:path";
import type {
  BeforeAgentStartEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext, InputEvent, InputEventResult,
  ToolCallEvent, ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { stageKickoff, stageSection } from "../agents/prompts/extension-prompts.js";
import { guardToolCall } from "../agents/guard.js";
import { agentBuiltinTools } from "../agents/session-spec.js";
import type { AppContext } from "../app.js";
import { startCommand } from "../app.js";
import { goalTitle, createTask, keyError, titleError } from "../commands/new.js";
import { getAgent, getStage, parseModelRef, type AgentDef, type LoadedPolicy, type WorkStage } from "../domain/policy.js";
import { isFinished, isHalted, type TaskState } from "../domain/task-state.js";
import { UsageError } from "../errors/errors.js";
import { GOAL_PROCESS } from "../policy/process-catalog.js";
import type { HeldLock } from "../state/lock-manager.js";
import type { ProjectStore } from "../state/project-store.js";
import { readTaskDescription } from "../workflow/agent-step.js";
import { msg } from "../ui/messages.js";
import { errorText, extensionAppContext } from "./run-command.js";

/** Запись сессии Pi с привязкой: key = null — задача отвязана командой /teo stop. */
export const BINDING_ENTRY = "teo-binding";
export type BindingEntry = { key: string | null; projectRoot: string };

/** Часть ExtensionAPI, которой пользуется хост (фейк в тестах реализует только её). */
export type HostPi = Pick<
  ExtensionAPI,
  "on" | "appendEntry" | "sendMessage" | "getActiveTools" | "setActiveTools" | "getAllTools" | "setModel" | "getThinkingLevel" | "setThinkingLevel"
>;

type Model = NonNullable<ExtensionContext["model"]>;
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

type Binding = {
  key: string;
  sessionId: string;
  app: AppContext;
  store: ProjectStore;
  lock: HeldLock;
  release: () => Promise<void>;
  /** Что было у пользователя до привязки: вернуть при /teo stop */
  saved: { tools: string[]; model: Model | undefined; thinking: ThinkingLevel };
  /** Этап, для которого уже применена модель роли (D38): не переключать на каждом ходу */
  modelAppliedFor: string | null;
};

type StageView = { state: TaskState; policy: LoadedPolicy; stage: WorkStage; agent: AgentDef };

export class ExtensionHost {
  private binding: Binding | null = null;

  constructor(
    private readonly pi: HostPi,
    /** Только для embedding/tests; обычное расширение берёт home пользователя процесса Pi. */
    private readonly homeDir?: string,
  ) {}

  get boundKey(): string | null {
    return this.binding?.key ?? null;
  }

  register(): void {
    this.pi.on("session_start", (_e, ctx) => this.guarded(ctx, () => this.onSessionStart(ctx)));
    this.pi.on("session_shutdown", () => this.detach());
    this.pi.on("before_agent_start", (e, ctx) => this.guarded(ctx, () => this.onBeforeAgentStart(e, ctx)));
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
    const sessionId = b.sessionId;
    b.lock.signal.throwIfAborted();
    await b.store.tasks.commit(b.key, (s, c) => {
      c.emit("session.unbound", "human", { sessionId, reason: "stop" });
      return { ...s, hostSession: null };
    });
    this.pi.appendEntry<BindingEntry>(BINDING_ENTRY, { key: null, projectRoot: b.store.layout.projectRoot });
    await this.restore(b);
    await this.detach();
    ctx.ui.setStatus("teo", undefined);
    ctx.ui.notify(msg.extension.stopped(b.key), "info");
  }

  // ---------- события Pi ----------

  /** Перезапуск Pi с привязанной сессией: задача продолжается сама (D42). */
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

  private async onBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<void> {
    const b = this.binding;
    if (!b) return;
    const view = await this.stageView(b);
    if (!view) return;
    const { state, policy, stage, agent } = view;
    event.systemPromptOptions.sections["teo_stage"] = stageSection({
      task: { key: state.key, title: state.title, description: await readTaskDescription(b.store.tasks.task(state.key).taskMd) },
      process: state.process,
      spec: policy.spec,
      stage,
      agent,
      handoff: state.nextAgentInput?.kind === "initial" ? state.nextAgentInput.message : null,
      taskDirDisplay: path.relative(b.store.layout.projectRoot, b.store.tasks.task(state.key).dir),
    });
    // Инструменты агента по Policy — из тех, что зарегистрированы в этой сессии
    const available = new Set(this.pi.getAllTools().map((t) => t.name));
    this.pi.setActiveTools(agentBuiltinTools(agent).filter((t) => available.has(t)));
    await this.applyModel(b, view, ctx);
    ctx.ui.setStatus("teo", msg.extension.status(state.key, stage.title, agent.title, state.supervisor.cycle));
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

  /** Guard роли этапа: внутри .teo — только artifacts задачи (04-agents.md §3). */
  private async onToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | void> {
    const b = this.binding;
    if (!b) return;
    const t = b.store.tasks.task(b.key);
    const verdict = await guardToolCall(
      { role: "agent", projectRoot: b.store.layout.projectRoot, taskDir: t.dir, writableInsideTeo: [t.artifactsDir], readableRoots: [b.store.layout.projectRoot], isReported: () => false },
      event.toolName,
      event.input,
      ctx.cwd,
    );
    return verdict.allow ? undefined : { block: true, reason: verdict.reason, terminate: verdict.terminate };
  }

  // ---------- внутреннее ----------

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
    store.policyOf(before.process);
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
    this.binding = {
      key,
      sessionId,
      app,
      store,
      lock: held.lock,
      release: held.release,
      saved: { tools: this.pi.getActiveTools(), model: ctx.model, thinking: this.pi.getThinkingLevel() },
      modelAppliedFor: null,
    };
    if (!opts.auto) this.pi.appendEntry<BindingEntry>(BINDING_ENTRY, { key, projectRoot: store.layout.projectRoot });

    const view = await this.stageView(this.binding);
    if (!view) return;
    ctx.ui.setStatus("teo", msg.extension.status(key, view.stage.title, view.agent.title, view.state.supervisor.cycle));
    ctx.ui.notify(opts.auto ? msg.extension.autoResumed(key, view.stage.title) : msg.extension.bound(key, view.stage.title, view.agent.title), "info");
    // Роль этапа начинает сама: только при входе в этап, а не при продолжении начатого
    if (opts.kickoff && view.state.phase === "agent_pending" && view.state.nextAgentInput?.kind === "initial") {
      this.pi.sendMessage(
        { customType: "teo-stage", content: stageKickoff({ stageTitle: view.stage.title, agentTitle: view.agent.title }), display: true },
        { triggerTurn: true },
      );
    }
  }

  /** Этап и роль задачи по Policy её процесса. null — роль сейчас не применяется (задача остановлена). */
  private async stageView(b: Binding): Promise<StageView | null> {
    const state = await b.store.tasks.load(b.key);
    if (isHalted(state)) return null;
    const policy = b.store.policyOf(state.process);
    const stage = getStage(policy.spec, state.stage);
    if (stage?.kind !== "work") return null;
    const agent = getAgent(policy.spec, state.currentRun?.stage === state.stage ? state.currentRun.agentId : stage.agent);
    return agent ? { state, policy, stage, agent } : null;
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

  private async restore(b: Binding): Promise<void> {
    this.pi.setActiveTools(b.saved.tools);
    if (b.saved.model) await this.pi.setModel(b.saved.model);
    this.pi.setThinkingLevel(b.saved.thinking);
  }

  /** Lock перехвачен другим процессом (02-storage.md §10.3): задача больше не наша. */
  private async lost(ctx: ExtensionContext): Promise<void> {
    const b = this.binding;
    if (!b) return;
    this.binding = null;
    await this.restore(b).catch(() => undefined);
    ctx.ui.setStatus("teo", undefined);
    ctx.ui.notify(msg.extension.lockLost(b.key), "error");
  }

  /** Освободить lock, не отвязывая задачу: закрытие Pi — прерывание, а не остановка (D42). */
  async detach(): Promise<void> {
    const b = this.binding;
    this.binding = null;
    await b?.release();
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
