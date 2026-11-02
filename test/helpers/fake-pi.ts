// Фейк ExtensionAPI и контекстов Pi для integration-тестов ExtensionHost: только то, чем пользуется хост.

import type { ExtensionCommandContext, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostPi } from "../../src/extension/host.js";

export type FakeModel = { provider: string; id: string };
export type Note = { message: string; type: string };

export const ALL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search"];

export class FakePi {
  readonly handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  readonly tools = new Map<string, ToolDefinition>();
  readonly entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
  readonly sent: Array<{ message: { customType: string; content: unknown }; options: unknown }> = [];
  activeTools = ["read", "bash", "edit", "write", "web_search"];
  model: FakeModel | undefined = { provider: "user", id: "own-model" };
  thinking = "medium";
  readonly setModelCalls: FakeModel[] = [];
  setModelResult = true;

  readonly api: HostPi = {
    on: ((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return () => undefined;
    }) as HostPi["on"],
    registerTool: ((tool: ToolDefinition) => void this.tools.set(tool.name, tool)) as HostPi["registerTool"],
    appendEntry: ((customType: string, data?: unknown) => void this.entries.push({ type: "custom", customType, data })) as HostPi["appendEntry"],
    sendMessage: ((message: { customType: string; content: unknown }, options?: unknown) => void this.sent.push({ message, options })) as HostPi["sendMessage"],
    getActiveTools: () => [...this.activeTools],
    setActiveTools: (names: string[]) => {
      this.activeTools = names.filter((n) => ALL_TOOLS.includes(n) || this.tools.has(n));
    },
    getAllTools: (() => [...ALL_TOOLS, ...this.tools.keys()].map((name) => ({ name }))) as unknown as HostPi["getAllTools"],
    setModel: (async (model: FakeModel) => {
      this.setModelCalls.push(model);
      if (this.setModelResult) this.model = model;
      return this.setModelResult;
    }) as unknown as HostPi["setModel"],
    getThinkingLevel: (() => this.thinking) as HostPi["getThinkingLevel"],
    setThinkingLevel: ((level: string) => void (this.thinking = level)) as HostPi["setThinkingLevel"],
  };

  /** Выполнить зарегистрированный tool так, как его вызывает Pi. */
  async callTool(name: string, input: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`tool ${name} не зарегистрирован`);
    return tool.execute(`call-${name}`, input, new AbortController().signal, () => undefined, {} as never);
  }

  /** Вызвать обработчики события по порядку, как Pi; результат последнего непустого. */
  async emit(event: string, payload: unknown, ctx: unknown): Promise<unknown> {
    let result: unknown;
    for (const h of this.handlers.get(event) ?? []) {
      const r = await h(payload, ctx);
      if (r !== undefined) result = r;
    }
    return result;
  }
}

export type FakeUi = {
  notes: Note[];
  status: Map<string, string | undefined>;
  statusUpdates: Array<{ key: string; text: string | undefined }>;
  /** Ответы диалогов по порядку вызова */
  answers: Array<string | undefined>;
  editorText: string;
  editors: Array<{ title: string; prefill: string | undefined }>;
};

/** Контекст команды Pi: cwd, сессия, UI с заготовленными ответами, реестр моделей. */
export function fakeCtx(
  pi: FakePi,
  opts: {
    cwd: string;
    sessionId?: string;
    sessionFile?: string;
    ui?: Partial<FakeUi>;
    models?: FakeModel[];
    idle?: boolean;
    newSession?: ExtensionCommandContext["newSession"];
  },
): ExtensionCommandContext & { fakeUi: FakeUi } {
  const ui: FakeUi = { notes: [], status: new Map(), statusUpdates: [], answers: [], editorText: "", editors: [], ...opts.ui };
  const next = async () => ui.answers.shift();
  const ctx = {
    cwd: opts.cwd,
    hasUI: true,
    mode: "tui",
    get model() {
      return pi.model;
    },
    modelRegistry: { find: (provider: string, id: string) => (opts.models ?? []).find((m) => m.provider === provider && m.id === id) },
    isIdle: () => opts.idle ?? true,
    sessionManager: {
      getSessionId: () => opts.sessionId ?? "session-1",
      getSessionFile: () => opts.sessionFile ?? "/tmp/pi-sessions/session-1.jsonl",
      getEntries: () => pi.entries,
    },
    ui: {
      notify: (message: string, type = "info") => void ui.notes.push({ message, type }),
      setStatus: (key: string, text: string | undefined) => {
        ui.status.set(key, text);
        ui.statusUpdates.push({ key, text });
      },
      select: next,
      input: next,
      editor: async (title: string, prefill?: string) => {
        ui.editors.push({ title, prefill });
        return next();
      },
      confirm: async () => {
        const answer = await next();
        return answer === undefined ? false : ["true", "yes", "да", "y"].includes(answer.toLowerCase());
      },
      setEditorText: (text: string) => void (ui.editorText = text),
    },
    newSession: opts.newSession ?? (async () => ({ cancelled: true })),
    sendMessage: async (message: { customType: string; content: unknown }, options?: unknown) => {
      pi.sent.push({ message, options });
    },
    fakeUi: ui,
  };
  return ctx as unknown as ExtensionCommandContext & { fakeUi: FakeUi };
}

export type FakeAgentStartEvent = {
  type: "before_agent_start";
  messageType: "user";
  prompt: string;
  systemPrompt: string;
  systemPromptOptions: { sections: Record<string, string> };
};

export function agentStartEvent(prompt = "Продолжай работу этапа"): FakeAgentStartEvent {
  return { type: "before_agent_start", messageType: "user", prompt, systemPrompt: "", systemPromptOptions: { sections: {} } };
}

export function settleEvent(messages: unknown[], outcome: "completed" | "aborted" | "error" = "completed") {
  return {
    type: "agent_before_settle",
    entries: [],
    continue: false,
    outcome,
    context: { contextEntries: [], contextMessages: [], llmMessages: messages, pendingMessages: [], canContinue: false },
  } as const;
}

export type { ExtensionContext };
