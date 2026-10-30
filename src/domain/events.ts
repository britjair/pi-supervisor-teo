// Журнал событий events.jsonl, 02-storage.md §6. Только типы.

import type { ControlAction } from "./decisions.js";
import type { Phase, SettleReason, SupervisorTrigger, TaskStatus } from "./task-state.js";

export type EventActor = "cli" | "supervisor" | "agent" | "human";

/** Payload каждого типа события, 02-storage.md §6.2. */
export type EventPayloads = {
  "task.created": { title: string; process: string; stage: string; policyHash: string; projectRoot: string };
  "task.resumed": { fromStatus: TaskStatus; phase: Phase; pid: number };
  "task.cancelled": { reason: string; humanResponseRef: string | null; by: "supervisor" | "human" };
  "task.blocked": { code: string; message: string; by: "supervisor" | "cli" };
  "task.unblocked": { note: string; by: "human" };
  "task.terminal": { stage: string };
  "policy.changed": { fromHash: string; toHash: string; mode: string; diff: unknown[] };
  "agent.started": { runId: string; agentId: string; attempt: number; sessionFile: string; sessionMode: string; stage: string };
  "agent.prompted": { runId: string; promptId: string; kind: string };
  "agent.output": { runId: string; text: string };
  "agent.reported": { runId: string; kind: "result" | "blocker"; summary: string };
  "agent.settled": { runId: string; reason: SettleReason };
  "agent.failed": { runId: string; reason: string; error: string; retrying?: boolean };
  "agent.continued": { runId: string; decisionId: string | null };
  "agent.restarted": { previousRunId: string; runId: string; decisionId: string | null; consecutiveRestarts: number };
  "supervisor.started": { cycle: number; trigger: SupervisorTrigger | null };
  "supervisor.decision": { decisionId: string; cycle: number; action: ControlAction; input: unknown };
  "supervisor.decision_rejected": { cycle: number; action: string; code: string; message: string };
  "supervisor.protocol_error": { cycle: number; retriesUsed: number };
  "supervisor.note": { cycle: number; text: string };
  "decision.applied": { decisionId: string; action: ControlAction };
  "human.requested": {
    requestId: string;
    origin: "supervisor" | "agent";
    runId: string | null;
    question: string;
    options: string[] | null;
    attachments: Array<{ path: string; sha256: string }>;
  };
  /**
   * requestId = null — сообщение по инициативе человека. channel = "chat" — сообщение в чате сессии Pi
   * в режиме расширения (D40): проходит redaction (D43). Без channel — ответ в диалоге, пишется дословно.
   */
  "human.responded": { requestId: string | null; answer: string; selectedOption: string | null; channel?: "chat" };
  "session.bound": { sessionId: string; sessionFile: string | null };
  "session.unbound": { sessionId: string; reason: "stop" | "finished" | "lock_lost" | "other_session" };
  "session.next_requested": { sessionId: string; stage: string };
  "supervision.paused": { sessionId: string };
  "supervision.resumed": { sessionId: string };
  "stage.transitioned": {
    from: string;
    to: string;
    reason: string;
    evidenceRefs: string[];
    decisionId: string | null;
    handoff: string | null;
    by?: "supervisor" | "human";
  };
  "wait.scheduled": {
    decisionId: string;
    number: number;
    maxCount: number;
    waitingFor: string;
    delayMinutes: number;
    dueAt: string;
  };
  "wait.finished": {
    decisionId: string;
    reason: "due" | "skipped_by_human" | "human_message";
    waitedMinutes: number;
    responseRef: string | null;
  };
  "runtime.interrupted": { signal: string | null; phase: Phase; runId: string | null };
  "runtime.recovered": { phase: Phase; action: string; details: Record<string, unknown> };
};

export type EventType = keyof EventPayloads;

/** События, которые пишутся без изменения state — напрямую в журнал, минуя outbox. */
export const DIRECT_EVENT_TYPES: readonly EventType[] = [
  "task.resumed",
  "agent.output",
  "supervisor.decision_rejected",
  "supervisor.note",
];

export type TaskEvent<T extends EventType = EventType> = {
  [K in T]: {
    /** Монотонный ULID */
    id: string;
    timestamp: string;
    taskKey: string;
    type: K;
    /** Версия state, с которой событие записано */
    stateVersion: number;
    actor: EventActor;
    payload: EventPayloads[K];
  };
}[T];

/** Событие до записи: id, время, ключ и версию проставляет хранилище. */
export type EventDraft<T extends EventType = EventType> = {
  [K in T]: { type: K; actor: EventActor; payload: EventPayloads[K] };
}[T];

export function draft<K extends EventType>(type: K, actor: EventActor, payload: EventPayloads[K]): EventDraft<K> {
  return { type, actor, payload } as EventDraft<K>;
}
