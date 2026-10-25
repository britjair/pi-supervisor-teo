// Единственная реализация AgentRuntime, зависящая от Pi SDK 1.4.0.
import path from "node:path";
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, resolveCliModel,
  SessionManager, SettingsManager, VERSION, type AgentSession, type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { ModelUnavailableError, ZERO_USAGE, type AgentRuntime, type AgentSessionHandle, type ModelRef, type ResolvedModel, type RunOutcome, type RuntimeEvent, type RuntimeProbeResult, type SessionSpec } from "../runtime.js";
import { createGuardExtension } from "./pi-guard-extension.js";
import { mapPiEvent } from "./pi-event-mapper.js";
import { inspectPiSessionFile, readPiTranscript } from "./session-inspector.js";
import { toPiTool } from "./pi-tool-adapter.js";
import { redactString } from "../../util/redact.js";

class PiHandle implements AgentSessionHandle {
  readonly sessionFile: string;
  readonly role: "agent" | "supervisor";
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly unsubscribe: () => void;
  private terminatedBy: string | null = null;

  constructor(private readonly session: AgentSession, spec: SessionSpec) {
    this.sessionFile = spec.file;
    this.role = spec.role;
    this.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "tool_execution_end" && event.result?.terminate === true) this.terminatedBy = event.toolName;
      const mapped = mapPiEvent(event);
      if (mapped) for (const listener of this.listeners) listener(mapped);
    });
  }

  async run(prompt: string, opts: { signal: AbortSignal }): Promise<RunOutcome> {
    this.terminatedBy = null;
    const before = this.session.messages.length;
    const onAbort = () => { void this.session.abort().catch(() => undefined); };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
    let failure: string | null = null;
    try {
      if (!opts.signal.aborted) await this.session.prompt(prompt, { expandPromptTemplates: false });
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
    }
    const assistant = this.session.messages.slice(before).filter((m) => m.role === "assistant");
    const last = assistant.at(-1);
    const usage = assistant.reduce((sum, m) => ({
      inputTokens: sum.inputTokens + m.usage.input,
      outputTokens: sum.outputTokens + m.usage.output,
      costUsd: (sum.costUsd ?? 0) + m.usage.cost.total,
    }), { ...ZERO_USAGE });
    if (opts.signal.aborted || last?.stopReason === "aborted") return { kind: "aborted", usage };
    if (failure || last?.stopReason === "error") return { kind: "error", message: failure ?? last?.errorMessage ?? "ошибка провайдера", usage };
    if (this.terminatedBy) return { kind: "terminated_by_tool", toolName: this.terminatedBy, usage };
    const text = last?.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") ?? null;
    return { kind: "completed", lastAssistantText: text, usage };
  }

  async steer(text: string): Promise<void> { await this.session.steer(text); }
  async abort(): Promise<void> { await this.session.abort(); }
  subscribe(listener: (e: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
    this.session.dispose();
  }
}

export class PiAgentRuntime implements AgentRuntime {
  private modelRuntime: ModelRuntime | null = null;
  private extensionsLoaded = false;
  private readonly agentDir: string;
  private readonly cwd: string;

  constructor(options: { agentDir?: string; cwd?: string } = {}) {
    this.agentDir = options.agentDir ?? getAgentDir();
    this.cwd = options.cwd ?? process.cwd();
  }

  private async models(): Promise<ModelRuntime> {
    this.modelRuntime ??= await ModelRuntime.create({
      authPath: path.join(this.agentDir, "auth.json"),
      modelsPath: path.join(this.agentDir, "models.json"),
      modelsStorePath: path.join(this.agentDir, "models-store.json"),
    });
    return this.modelRuntime;
  }

  /** Модель расширения появляется в ModelRuntime только после загрузки ресурсов и bindExtensions. */
  private async loadExtensionProviders(): Promise<void> {
    if (this.extensionsLoaded) return;
    this.extensionsLoaded = true;
    const settings = SettingsManager.create(this.cwd, this.agentDir);
    const loader = new DefaultResourceLoader({ cwd: this.cwd, agentDir: this.agentDir, settingsManager: settings, noContextFiles: true, noSkills: true });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: this.cwd, agentDir: this.agentDir, modelRuntime: await this.models(),
      settingsManager: settings, sessionManager: SessionManager.inMemory(this.cwd),
      resourceLoader: loader, tools: [],
    });
    try { await session.bindExtensions({ mode: "print" }); }
    finally { session.dispose(); }
  }

  async resolveModel(ref: ModelRef): Promise<ResolvedModel> {
    const runtime = await this.models();
    const settings = SettingsManager.create(this.cwd, this.agentDir);
    let model;
    let thinking = ref.thinking ?? settings.getDefaultThinkingLevel() ?? "off";
    if (ref.ref === "default") {
      const provider = settings.getDefaultProvider();
      const id = settings.getDefaultModel();
      model = provider && id ? runtime.getModel(provider, id) : undefined;
      model ??= (await runtime.getAvailable())[0];
      if (model && !ref.thinking) thinking = settings.getModelThinkingLevel(model.provider, model.id) ?? thinking;
    } else {
      const resolved = resolveCliModel({ cliModel: ref.ref, modelRuntime: runtime });
      model = resolved.model;
      thinking = ref.thinking ?? resolved.thinkingLevel ?? thinking;
    }
    if ((!model || !runtime.hasConfiguredAuth(model.provider)) && ref.extensions && !this.extensionsLoaded) {
      try { await this.loadExtensionProviders(); }
      catch (err) { throw new ModelUnavailableError(`Не удалось загрузить провайдеры из расширений Pi: ${redactString(err instanceof Error ? err.message : String(err))}`); }
      if (ref.ref === "default") {
        const provider = settings.getDefaultProvider();
        const id = settings.getDefaultModel();
        model = provider && id ? runtime.getModel(provider, id) : undefined;
        model ??= (await runtime.getAvailable())[0];
      } else {
        model = resolveCliModel({ cliModel: ref.ref, modelRuntime: runtime }).model;
      }
    }
    if (!model) throw new ModelUnavailableError("Нет доступной модели. Проверьте авторизацию и настройки Pi.");
    if (!runtime.hasConfiguredAuth(model.provider)) throw new ModelUnavailableError(`Провайдер модели ${model.provider}/${model.id} не авторизован.`);
    return { id: `${model.provider}/${model.id}`, thinking, providedBy: null, handle: model };
  }

  async openSession(spec: SessionSpec): Promise<AgentSessionHandle> {
    const settings = SettingsManager.create(spec.cwd, this.agentDir);
    const loader = new DefaultResourceLoader({
      cwd: spec.cwd,
      agentDir: this.agentDir,
      settingsManager: settings,
      appendSystemPrompt: [spec.systemPromptAppend],
      noContextFiles: !spec.piResources.contextFiles,
      noExtensions: !spec.piResources.extensions,
      noSkills: !spec.piResources.skills,
      extensionFactories: [{ name: "sdlc-guard", factory: createGuardExtension(spec.guard, spec.cwd) }],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: spec.cwd,
      agentDir: this.agentDir,
      modelRuntime: await this.models(),
      model: spec.model.handle as NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>["model"]>,
      ...(spec.model.thinking ? { thinkingLevel: spec.model.thinking } : {}),
      tools: [...spec.builtinTools, ...spec.customTools.map((t) => t.name)],
      customTools: spec.customTools.map(toPiTool),
      sessionManager: SessionManager.open(spec.file, path.dirname(spec.file), spec.cwd),
      settingsManager: settings,
      resourceLoader: loader,
    });
    // SDK без UI: inline guard и другие расширения получают session_start.
    await session.bindExtensions({ mode: "print" });
    return new PiHandle(session, spec);
  }

  inspectSessionFile = inspectPiSessionFile;
  readTranscript = readPiTranscript;

  async probe(): Promise<RuntimeProbeResult> {
    const problems: string[] = [];
    try {
      const runtime = await this.models();
      const settings = SettingsManager.inMemory();
      const session = (await createAgentSession({
        cwd: this.cwd, agentDir: this.agentDir, modelRuntime: runtime,
        sessionManager: SessionManager.inMemory(this.cwd), settingsManager: settings, tools: [],
        resourceLoader: new DefaultResourceLoader({ cwd: this.cwd, agentDir: this.agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noContextFiles: true }),
      })).session;
      session.dispose();
    } catch (err) {
      problems.push(`Не удалось создать пробную сессию Pi: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { sdkVersion: VERSION, ok: problems.length === 0, problems };
  }

  async dispose(): Promise<void> { this.modelRuntime = null; }
}
