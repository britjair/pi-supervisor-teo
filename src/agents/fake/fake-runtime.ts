// FakeAgentRuntime, 04-agents.md §2.4: детерминированная «модель» по сценарию.
// Шаги вызывают настоящие execute зарегистрированных tools, поэтому тестируются валидация,
// terminate и запись state. Файл сессии — собственный JSONL с маркерами prompt-ов,
// чтобы recovery проверял ту же логику inspectSessionFile.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { InjectedFault } from "../../util/fault.js";
import { argsPreview } from "../../util/redact.js";
import { guardToolCall } from "../guard.js";
import {
  ZERO_USAGE,
  promptIdsIn,
  type AgentRuntime,
  type AgentSessionHandle,
  type ModelRef,
  type ResolvedModel,
  type RunOutcome,
  type RuntimeEvent,
  type SessionFileInfo,
  type SessionSpec,
  type ToolResult,
  type TranscriptEntry,
} from "../runtime.js";
import { ModelUnavailableError } from "../runtime.js";

export type FakeTurnContext = {
  /** Последний prompt этого хода */
  prompt: string;
  /** expectedStateVersion из последнего prompt-а supervisor-а */
  expectedStateVersion: number | null;
  /** Последняя ссылка human:<eventId> из prompt-а */
  lastHumanRef: string | null;
  lastToolResult: ToolResult | null;
  cwd: string;
  sessionFile: string;
};

type Args = unknown | ((c: FakeTurnContext) => unknown);

export type FakeStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: Args }
  /** Несколько tools одной пачкой: ход завершится, только если terminate вернули все */
  | { kind: "tools"; calls: Array<{ name: string; args: Args }> }
  /** Ход завершён обычным текстом */
  | { kind: "end"; text: string | null }
  /** Процесс «умер» посреди хода: исключение вылетает из run() */
  | { kind: "crash"; message: string }
  /** Процесс умер во время выполнения tool: вызов записан, результата нет */
  | { kind: "crashInTool"; name: string; args: Args }
  /** Ход не завершается, пока его не прервут */
  | { kind: "hang" }
  /** Ошибка провайдера после ретраев Pi */
  | { kind: "error"; message: string }
  /** Побочный эффект «агента» (аналог bash) */
  | { kind: "effect"; fn: (c: FakeTurnContext) => Promise<void> | void };

export const turn = {
  text: (text: string): FakeStep => ({ kind: "text", text }),
  tool: (name: string, args: Args = {}): FakeStep => ({ kind: "tool", name, args }),
  tools: (...calls: Array<[string, Args]>): FakeStep => ({ kind: "tools", calls: calls.map(([name, args]) => ({ name, args })) }),
  end: (text: string | null = null): FakeStep => ({ kind: "end", text }),
  crash: (message = "процесс teo убит"): FakeStep => ({ kind: "crash", message }),
  crashInTool: (name: string, args: Args = {}): FakeStep => ({ kind: "crashInTool", name, args }),
  hang: (): FakeStep => ({ kind: "hang" }),
  error: (message = "provider overloaded"): FakeStep => ({ kind: "error", message }),
  effect: (fn: (c: FakeTurnContext) => Promise<void> | void): FakeStep => ({ kind: "effect", fn }),
};

/** «Смерть процесса» внутри хода. Движок её не перехватывает. */
export class FakeCrash extends Error {
  override name = "FakeCrash";
}

/** Сценарий исчерпан: тест не описал очередной ход. */
export class FakeScriptExhausted extends Error {
  override name = "FakeScriptExhausted";
}

type Entry =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string | null; toolCalls: Array<{ id: string; name: string; args: unknown }>; stopReason: string; errorMessage?: string }
  | { type: "toolResult"; toolCallId: string; toolName: string; ok: boolean; content: string };

const ULID_RE = "[0-9A-HJKMNP-TV-Z]{26}";

function resolvePlaceholders(value: unknown, c: FakeTurnContext): unknown {
  if (typeof value === "string") {
    if (value === "$expectedStateVersion") return c.expectedStateVersion;
    if (value === "$lastHumanRef") return c.lastHumanRef;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolvePlaceholders(v, c));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolvePlaceholders(v, c)]));
  }
  return value;
}

export type FakeRuntimeOptions = {
  /** Модели, которые «не разрешаются» */
  unavailableModels?: string[];
};

export class FakeAgentRuntime implements AgentRuntime {
  private readonly scripts = new Map<string, FakeStep[]>();
  private readonly responders = new Map<string, (c: FakeTurnContext) => FakeStep[]>();
  /** Все отправленные prompt-ы по порядку: для проверок в тестах */
  readonly prompts: Array<{ file: string; role: "agent" | "supervisor"; prompt: string }> = [];
  readonly opened: SessionSpec[] = [];
  private toolCallCounter = 0;

  constructor(
    scripts: Record<string, FakeStep[]> = {},
    private readonly options: FakeRuntimeOptions = {},
  ) {
    for (const [k, v] of Object.entries(scripts)) this.script(k, ...v);
  }

  /** Добавить шаги сессии. Ключ — окончание пути файла сессии, например «sessions/explorer-001.jsonl». */
  script(fileSuffix: string, ...steps: FakeStep[]): this {
    this.scripts.set(fileSuffix, [...(this.scripts.get(fileSuffix) ?? []), ...steps]);
    return this;
  }

  /** Реактивная «модель»: шаги хода строятся по prompt-у, когда заранее заданных шагов нет. */
  respond(fileSuffix: string, fn: (c: FakeTurnContext) => FakeStep[]): this {
    this.responders.set(fileSuffix, fn);
    return this;
  }

  responderFor(file: string): ((c: FakeTurnContext) => FakeStep[]) | null {
    for (const [key, fn] of this.responders) if (file === key || file.endsWith("/" + key)) return fn;
    return null;
  }

  remaining(fileSuffix: string): number {
    return this.scripts.get(fileSuffix)?.length ?? 0;
  }

  stepsFor(file: string): FakeStep[] {
    let best: string | null = null;
    for (const key of this.scripts.keys()) {
      if ((file === key || file.endsWith("/" + key)) && (best === null || key.length > best.length)) best = key;
    }
    if (best === null) {
      const steps: FakeStep[] = [];
      this.scripts.set(file, steps);
      return steps;
    }
    return this.scripts.get(best) ?? [];
  }

  nextToolCallId(): string {
    return `call_${++this.toolCallCounter}`;
  }

  async resolveModel(ref: ModelRef): Promise<ResolvedModel> {
    if (this.options.unavailableModels?.includes(ref.ref)) {
      throw new ModelUnavailableError(`Модель ${ref.ref} не найдена`);
    }
    return { id: ref.ref === "default" ? "fake/default" : ref.ref, thinking: ref.thinking, providedBy: "fake", handle: null };
  }

  async openSession(spec: SessionSpec): Promise<AgentSessionHandle> {
    this.opened.push(spec);
    await mkdir(path.dirname(spec.file), { recursive: true });
    return new FakeSession(this, spec);
  }

  async inspectSessionFile(file: string): Promise<SessionFileInfo> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return { exists: false, valid: true, parseError: null, promptIds: [], lastEntry: null, messageCount: 0 };
    }
    const entries: Entry[] = [];
    const lines = text.split("\n").filter((l) => l !== "");
    for (let i = 0; i < lines.length; i++) {
      try {
        entries.push(JSON.parse(lines[i] ?? "") as Entry);
      } catch {
        return { exists: true, valid: false, parseError: `строка ${i + 1}: невалидный JSON`, promptIds: [], lastEntry: null, messageCount: 0 };
      }
    }
    const promptIds = entries.flatMap((e) => (e.type === "user" ? promptIdsIn(e.text) : []));
    const last = entries.at(-1);
    let lastEntry: SessionFileInfo["lastEntry"] = null;
    if (last?.type === "assistant") {
      lastEntry = {
        kind: "assistant",
        stopReason: last.stopReason,
        text: last.text,
        danglingToolCalls: last.toolCalls.map((c) => ({ toolCallId: c.id, toolName: c.name, argsPreview: argsPreview(c.args) })),
      };
    } else if (last) {
      lastEntry = { kind: last.type };
    }
    return { exists: true, valid: true, parseError: null, promptIds, lastEntry, messageCount: entries.length };
  }

  async readTranscript(file: string, opts: { tail: number }): Promise<TranscriptEntry[]> {
    const text = await readFile(file, "utf8").catch(() => "");
    const out: TranscriptEntry[] = [];
    for (const line of text.split("\n").filter(Boolean)) {
      const e = JSON.parse(line) as Entry;
      if (e.type === "user") out.push({ kind: "user", text: e.text });
      else if (e.type === "assistant") {
        if (e.text) out.push({ kind: "assistant", text: e.text });
        for (const c of e.toolCalls) out.push({ kind: "tool_call", toolCallId: c.id, toolName: c.name, argsPreview: argsPreview(c.args) });
      } else {
        out.push({ kind: "tool_result", toolCallId: e.toolCallId, toolName: e.toolName, ok: e.ok, preview: argsPreview(e.content) });
      }
    }
    return out.slice(-opts.tail);
  }

  async probe() {
    return { sdkVersion: null, ok: true, problems: [] };
  }

  async dispose(): Promise<void> {}
}

class FakeSession implements AgentSessionHandle {
  readonly sessionFile: string;
  readonly role: "agent" | "supervisor";
  private readonly listeners = new Set<(e: RuntimeEvent) => void>();
  private abortController: AbortController | null = null;

  constructor(
    private readonly runtime: FakeAgentRuntime,
    private readonly spec: SessionSpec,
  ) {
    this.sessionFile = spec.file;
    this.role = spec.role;
  }

  private emit(e: RuntimeEvent): void {
    for (const l of this.listeners) l(e);
  }

  private async write(entry: Entry): Promise<void> {
    await appendFile(this.spec.file, JSON.stringify(entry) + "\n");
  }

  async run(prompt: string, opts: { signal: AbortSignal }): Promise<RunOutcome> {
    const local = new AbortController();
    this.abortController = local;
    const onAbort = () => local.abort();
    opts.signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.loop(prompt, local.signal);
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
      this.abortController = null;
    }
  }

  private async loop(prompt: string, signal: AbortSignal): Promise<RunOutcome> {
    this.runtime.prompts.push({ file: this.spec.file, role: this.role, prompt });
    // Pi пишет user-сообщение на диск сразу (04-agents.md §1)
    await this.write({ type: "user", text: prompt });
    const steps = this.runtime.stepsFor(this.spec.file);
    const versions = [...prompt.matchAll(/expectedStateVersion: (\d+)/g)];
    const humans = [...prompt.matchAll(new RegExp(`human:(${ULID_RE})`, "g"))];
    const c: FakeTurnContext = {
      prompt,
      expectedStateVersion: versions.length ? Number(versions.at(-1)?.[1]) : null,
      lastHumanRef: humans.length ? `human:${humans.at(-1)?.[1]}` : null,
      lastToolResult: null,
      cwd: this.spec.cwd,
      sessionFile: this.spec.file,
    };
    if (steps.length === 0) {
      const responder = this.runtime.responderFor(this.spec.file);
      if (responder) steps.push(...responder(c));
    }
    if (steps.length === 0) {
      throw new FakeScriptExhausted(`Сценарий сессии ${this.spec.file} исчерпан, а пришёл prompt:\n${prompt.slice(0, 500)}`);
    }
    let text = "";
    for (;;) {
      if (signal.aborted) return this.aborted(text);
      const step = steps.shift();
      if (!step) {
        await this.write({ type: "assistant", text: text || null, toolCalls: [], stopReason: "stop" });
        this.emit({ type: "settled" });
        return { kind: "completed", lastAssistantText: text || null, usage: ZERO_USAGE };
      }
      switch (step.kind) {
        case "text":
          text += (text ? "\n" : "") + step.text;
          this.emit({ type: "text", delta: step.text });
          break;
        case "end": {
          const final = step.text ?? (text || null);
          await this.write({ type: "assistant", text: final, toolCalls: [], stopReason: "stop" });
          this.emit({ type: "settled" });
          return { kind: "completed", lastAssistantText: final, usage: ZERO_USAGE };
        }
        case "crash":
          throw new FakeCrash(step.message);
        case "crashInTool": {
          const args = resolvePlaceholders(typeof step.args === "function" ? (step.args as (x: FakeTurnContext) => unknown)(c) : step.args, c);
          await this.write({ type: "assistant", text: text || null, toolCalls: [{ id: this.runtime.nextToolCallId(), name: step.name, args }], stopReason: "toolUse" });
          throw new FakeCrash(`процесс убит во время ${step.name}`);
        }
        case "hang":
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return this.aborted(text);
        case "error":
          await this.write({ type: "assistant", text: null, toolCalls: [], stopReason: "error", errorMessage: step.message });
          return { kind: "error", message: step.message, usage: ZERO_USAGE };
        case "effect":
          await step.fn(c);
          break;
        case "tool":
        case "tools": {
          const calls = (step.kind === "tool" ? [{ name: step.name, args: step.args }] : step.calls).map((call) => ({
            id: this.runtime.nextToolCallId(),
            name: call.name,
            args: resolvePlaceholders(typeof call.args === "function" ? (call.args as (x: FakeTurnContext) => unknown)(c) : call.args, c),
          }));
          await this.write({ type: "assistant", text: text || null, toolCalls: calls, stopReason: "toolUse" });
          text = "";
          let allTerminate = true;
          for (const call of calls) {
            const result = await this.callTool(call.id, call.name, call.args, signal);
            c.lastToolResult = result;
            if (!result.terminate) allTerminate = false;
          }
          if (allTerminate) {
            this.emit({ type: "settled" });
            return { kind: "terminated_by_tool", toolName: calls.at(-1)?.name ?? "", usage: ZERO_USAGE };
          }
          break;
        }
      }
    }
  }

  private async aborted(text: string): Promise<RunOutcome> {
    await this.write({ type: "assistant", text: text || null, toolCalls: [], stopReason: "aborted" });
    return { kind: "aborted", usage: ZERO_USAGE };
  }

  private async callTool(id: string, name: string, args: unknown, signal: AbortSignal): Promise<ToolResult> {
    this.emit({ type: "tool.started", toolCallId: id, toolName: name, argsPreview: argsPreview(args) });
    let result: ToolResult;
    const verdict = await guardToolCall(this.spec.guard, name, args, this.spec.cwd);
    if (!verdict.allow) {
      result = { content: verdict.reason, isError: true, terminate: verdict.terminate };
    } else {
      result = await this.execute(name, args, id, signal);
    }
    await this.write({ type: "toolResult", toolCallId: id, toolName: name, ok: !result.isError, content: result.content });
    this.emit({ type: "tool.finished", toolCallId: id, toolName: name, ok: !result.isError });
    return result;
  }

  private async execute(name: string, args: unknown, id: string, signal: AbortSignal): Promise<ToolResult> {
    const custom = this.spec.customTools.find((t) => t.name === name);
    if (custom) {
      const parsed = custom.parameters.safeParse(args);
      if (!parsed.success) return { content: `Неверные параметры: ${parsed.error.message}`, isError: true };
      try {
        return await custom.execute(parsed.data, { toolCallId: id, signal });
      } catch (err) {
        // Сбой процесса, а не ошибка tool: пусть вылетит из run()
        if (err instanceof InjectedFault || err instanceof FakeCrash) throw err;
        return { content: `Ошибка: ${(err as Error).message}`, isError: true };
      }
    }
    if (!this.spec.builtinTools.includes(name)) return { content: `Инструмент ${name} недоступен`, isError: true };
    const a = (args ?? {}) as { path?: string; content?: string };
    if (name === "write" && a.path) {
      const target = path.resolve(this.spec.cwd, a.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, a.content ?? "");
      return { content: `Записано ${a.path}` };
    }
    if (name === "read" && a.path) {
      try {
        return { content: await readFile(path.resolve(this.spec.cwd, a.path), "utf8") };
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
    }
    return { content: "ok" };
  }

  async steer(): Promise<void> {}

  async abort(): Promise<void> {
    this.abortController?.abort();
  }

  subscribe(listener: (e: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

/** Декларативный сценарий из JSON (переменная TEO_FAKE_RUNTIME): только шаги без функций. */
export async function loadFakeScenario(file: string): Promise<FakeAgentRuntime> {
  const data = JSON.parse(await readFile(file, "utf8")) as {
    sessions: Record<string, Array<Exclude<FakeStep, { kind: "effect" }>>>;
    unavailableModels?: string[];
  };
  return new FakeAgentRuntime(data.sessions, { unavailableModels: data.unavailableModels ?? [] });
}
