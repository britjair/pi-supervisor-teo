// Запись одного agent run: runs/<runId>.json, 02-storage.md §5. Только типы.

import type { AgentInput, AgentInputKind, SettleReason } from "./task-state.js";

export type ReportResultInput = {
  summary: string;
  evidence?: Array<{ kind: string; value: string; description?: string }>;
  artifacts?: Array<{ kind: string; pathOrUrl: string; description?: string }>;
  notes?: string[];
  externalWait?: { waitingFor: string; checkAgainInMinutes?: number };
};

export type ReportBlockerInput = {
  summary: string;
  details: string;
  requiresHuman: boolean;
  suggestedQuestion?: string;
};

export type AgentReport =
  | { kind: "result"; at: string; data: ReportResultInput }
  | { kind: "blocker"; at: string; data: ReportBlockerInput };

export type Usage = { inputTokens: number; outputTokens: number; costUsd: number | null };

export type AgentRunRecord = {
  runId: string;
  agentId: string;
  attempt: number;
  stage: string;
  sessionFile: string;
  sessionMode: "fresh" | "reuse" | "restart";
  input: AgentInput;
  prompts: Array<{ promptId: string; kind: AgentInputKind; sentAt: string }>;
  report: AgentReport | null;
  /** Отчёты прошлых prompt-циклов (continue, recheck) */
  reportsHistory: AgentReport[];
  settleReason: SettleReason | null;
  error: string | null;
  /** Хвост последнего ответа (≤ 4 KB) для unstructured_settle */
  lastAssistantText: string | null;
  toolStats: Record<string, { calls: number; errors: number }>;
  usage: Usage | null;
  startedAt: string | null;
  finishedAt: string | null;
};
