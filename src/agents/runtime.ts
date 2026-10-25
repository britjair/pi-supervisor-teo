// Контракт среды исполнения агентов, 04-agents.md §2. Бизнес-логика работает только с ним;
// реализации — PiAgentRuntime (M4, src/agents/pi/) и FakeAgentRuntime (src/agents/fake/).

import type { z } from "zod";
import type { ThinkingLevel } from "../domain/policy.js";
import type { Usage } from "../domain/runs.js";

export type ModelRef = { ref: string; thinking: ThinkingLevel | null; extensions: boolean };

export type ResolvedModel = {
  /** provider/modelId, как его назвал Pi */
  id: string;
  thinking: ThinkingLevel | null;
  /** Кто предоставляет модель: встроенный провайдер или пакет расширения (для doctor) */
  providedBy: string | null;
  /** Объект модели среды исполнения; бизнес-логика его не разбирает */
  handle: unknown;
};

export class ModelUnavailableError extends Error {
  override name = "ModelUnavailableError";
}

export type ToolResult = {
  /** Текст, который увидит модель (на русском) */
  content: string;
  isError?: boolean;
  /** Завершить ход после текущей пачки tools (Pi: если terminate вернули все tools пачки) */
  terminate?: boolean;
};

export type ToolCallContext = { toolCallId: string; signal: AbortSignal };

/** Свой tool sdlc, независимый от типов Pi. Параметры — zod, Pi получает JSON Schema. */
export type SdlcToolDefinition<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  parameters: S;
  execute(input: z.infer<S>, ctx: ToolCallContext): Promise<ToolResult>;
};

export type GuardConfig = {
  role: "agent" | "supervisor";
  projectRoot: string;
  taskDir: string;
  /** Для агента: внутри .sdlc писать можно только сюда */
  writableInsideSdlc: string[];
  /** Для supervisor: читать можно только внутри этих каталогов */
  readableRoots: string[];
  /** Агент уже отчитался в этом prompt-цикле */
  isReported: () => boolean;
};

export type SessionSpec = {
  /** Абсолютный путь .jsonl */
  file: string;
  cwd: string;
  role: "agent" | "supervisor";
  model: ResolvedModel;
  systemPromptAppend: string;
  /** Итоговый allowlist встроенных tools Pi */
  builtinTools: string[];
  customTools: SdlcToolDefinition[];
  piResources: { contextFiles: boolean; extensions: boolean; skills: boolean };
  guard: GuardConfig;
};

export type RunOutcome =
  | { kind: "completed"; lastAssistantText: string | null; usage: Usage }
  | { kind: "terminated_by_tool"; toolName: string; usage: Usage }
  | { kind: "aborted"; usage: Usage }
  | { kind: "error"; message: string; usage: Usage };

export type ToolCallSummary = { toolCallId: string; toolName: string; argsPreview: string };

export type SessionFileInfo = {
  exists: boolean;
  valid: boolean;
  parseError: string | null;
  /** Из маркеров [sdlc:prompt id=…] */
  promptIds: string[];
  lastEntry:
    | { kind: "assistant"; stopReason: string; text: string | null; danglingToolCalls: ToolCallSummary[] }
    | { kind: "user" | "toolResult" | "other" }
    | null;
  messageCount: number;
};

/** Сжатая лента сессии для read_agent_transcript. */
export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool_call"; toolCallId: string; toolName: string; argsPreview: string }
  | { kind: "tool_result"; toolCallId: string; toolName: string; ok: boolean; preview: string };

export type RuntimeEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool.started"; toolCallId: string; toolName: string; argsPreview: string }
  | { type: "tool.finished"; toolCallId: string; toolName: string; ok: boolean }
  | { type: "retry"; attempt: number; reason: string }
  | { type: "compaction"; phase: "start" | "end" }
  | { type: "usage"; usage: Usage }
  | { type: "settled" };

export interface AgentSessionHandle {
  readonly sessionFile: string;
  readonly role: "agent" | "supervisor";
  /** Отправить prompt и дождаться конца хода. Ошибка модели — outcome, а не исключение. */
  run(prompt: string, opts: { signal: AbortSignal }): Promise<RunOutcome>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (e: RuntimeEvent) => void): () => void;
  dispose(): void;
}

export type RuntimeProbeResult = {
  sdkVersion: string | null;
  ok: boolean;
  problems: string[];
};

export interface AgentRuntime {
  resolveModel(ref: ModelRef): Promise<ResolvedModel>;
  openSession(spec: SessionSpec): Promise<AgentSessionHandle>;
  inspectSessionFile(file: string): Promise<SessionFileInfo>;
  readTranscript(file: string, opts: { tail: number }): Promise<TranscriptEntry[]>;
  probe(): Promise<RuntimeProbeResult>;
  dispose(): Promise<void>;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: null };

/** Маркер в начале каждого prompt (03-engine.md §5.2). */
export function promptMarker(fields: Record<string, string | number>): string {
  return `[sdlc:prompt ${Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")}]`;
}

const MARKER_RE = /\[sdlc:prompt id=([0-9A-HJKMNP-TV-Z]{26})\b/g;

export function promptIdsIn(text: string): string[] {
  return [...text.matchAll(MARKER_RE)].map((m) => m[1] ?? "");
}
