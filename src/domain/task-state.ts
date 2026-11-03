// state.json, 02-storage.md §3. Типы, инварианты и чистые функции над state.

import type { PolicyHash, PolicySchemaId } from "./policy.js";
import type { Decision } from "./decisions.js";
import type { TaskEvent } from "./events.js";

export const TASK_STATE_SCHEMA_VERSION = 1;

export const PHASES = [
  "agent_pending",
  "agent_running",
  "supervisor_pending",
  "supervisor_running",
  "decision_pending",
  "human_pending",
  "waiting",
  "halted",
] as const;
export type Phase = (typeof PHASES)[number];

export const TASK_STATUSES = ["active", "waiting_human", "interrupted", "blocked", "terminal", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Статусы остановленной задачи: при них phase = halted. */
export const HALTED_STATUSES: readonly TaskStatus[] = ["terminal", "cancelled", "blocked"];
/** Причины блокировки, которые снимает только teo recover (05-cli-ui.md §2.1). */
export const RECOVER_ONLY_CODES: readonly string[] = ["POLICY_STAGE_MISSING", "STATE_TAMPERED"];
/** Блокировки, после которых подсказка ведёт в teo recover: там есть подходящие действия. */
export const RECOVER_HINT_CODES: readonly string[] = [...RECOVER_ONLY_CODES, "SESSION_CORRUPTED"];

/** Задача завершена и в меню попадает в «Показать завершённые». */
export const FINISHED_STATUSES: readonly TaskStatus[] = ["terminal", "cancelled"];

export const SETTLE_REASONS = [
  "reported_result",
  "reported_blocker",
  "unstructured_settle",
  "aborted",
  "timeout",
  "runtime_error",
  "interrupted",
] as const;
export type SettleReason = (typeof SETTLE_REASONS)[number];

export const AGENT_INPUT_KINDS = ["initial", "continue", "restart", "recovery", "recheck"] as const;
export type AgentInputKind = (typeof AGENT_INPUT_KINDS)[number];

export type AgentInput = {
  kind: AgentInputKind;
  /** Текст supervisor (continue/restart/recheck), handoff (initial) или служебный текст recovery */
  message: string | null;
  decisionId: string | null;
};

export type AgentRunRef = {
  runId: string;
  agentId: string;
  /** NNN из имени файла сессии: порядковый номер запуска агента в задаче */
  attempt: number;
  stage: string;
  /** Относительно каталога задачи */
  sessionFile: string;
  sessionMode: "fresh" | "reuse" | "restart";
  status: "pending" | "running" | "settled" | "failed";
  settleReason: SettleReason | null;
  promptsSent: string[];
  startedAt: string | null;
  finishedAt: string | null;
};

export const TRIGGER_KINDS = [
  "agent_settled",
  "recheck_settled",
  "human_responded",
  "policy_changed",
  "unblocked",
  "recovered",
  "reevaluate",
] as const;
export type SupervisorTriggerKind = (typeof TRIGGER_KINDS)[number];

export type SupervisorTrigger = {
  kind: SupervisorTriggerKind;
  /** runId или eventId */
  ref: string | null;
};

export type WaitState = {
  /** Отсутствует в старых state: такой wait трактуется по targetPhase. */
  kind?: "policy_recheck" | "supervisor_model_cooldown" | "agent_model_cooldown" | undefined;
  /** Для agent_model_cooldown — конкретная модель для canary после таймера. */
  modelCooldown?: {
    role: string;
    provider: string;
    modelId: string;
  } | null | undefined;
  decisionId: string;
  number: number;
  waitingFor: string;
  message: string;
  delayMinutes: number;
  scheduledAt: string;
  dueAt: string;
  targetPhase: "agent_pending" | "supervisor_pending" | null;
  /** Ожидание лимита: dueAt — названный провайдером срок сброса, а не следующая проба */
  resetKnown: boolean;
};

export type HumanRequest = {
  /** = eventId события human.requested */
  requestId: string;
  origin: "supervisor" | "agent";
  runId: string | null;
  question: string;
  context: string | null;
  options: string[] | null;
  allowFreeText: boolean;
  attachments: Array<{ path: string; sha256: string }>;
  requestedAt: string;
};

export type StatusReason = { code: string; message: string; at: string };

/** Сессия Pi, в которой задача ведётся в режиме расширения (docs/07-extension-mode.md §4.3). */
export type HostSession = {
  sessionId: string;
  /** null — сессия Pi в памяти, без файла */
  sessionFile: string | null;
  boundAt: string;
  /** /teo pause: роль и supervisor временно не вмешиваются, lock остаётся у Pi. */
  paused: boolean;
  /** Текущий этап требует новую пользовательскую сессию; продолжение — только /teo next. */
  awaitingNextSession: boolean;
  /** ID уже созданной через /teo next сессии; защищает от rebind старой session entry. */
  nextSessionId: string | null;
};

export type TaskState = {
  schemaVersion: typeof TASK_STATE_SCHEMA_VERSION;

  key: string;
  title: string;
  projectRoot: string;
  /** Задел под worktree; в MVP всегда null → используется projectRoot */
  workspacePath: string | null;
  createdAt: string;
  updatedAt: string;

  /** +1 на каждую запись */
  version: number;

  /** Процесс задачи: ~/.pi/teo/<process>.md (D32) */
  process: string;
  policyHash: PolicyHash;
  policySchema: PolicySchemaId;

  stage: string;
  stageEnteredAt: string;
  stageEntryEventId: string;
  stageCycles: number;
  stageRechecks: { count: number; waitedMinutes: number; firstScheduledAt: string | null };

  status: TaskStatus;
  statusReason: StatusReason | null;

  phase: Phase;

  currentRun: AgentRunRef | null;
  agentRunCounters: Record<string, number>;
  consecutiveRestarts: number;
  nextAgentInput: AgentInput | null;

  wait: WaitState | null;

  supervisor: {
    sessionFile: string;
    cycle: number;
    trigger: SupervisorTrigger | null;
    lastPolicyHashShown: string | null;
  };

  pendingDecision: Decision | null;
  lastAppliedDecisionId: string | null;
  lastDecision: { decisionId: string; action: string; summary: string; at: string } | null;

  pendingHumanRequest: HumanRequest | null;

  /** Режим расширения: задача привязана к сессии Pi пользователя. null — ведётся CLI или не ведётся */
  hostSession: HostSession | null;

  lastEventId: string;
  /** События, созданные последней записью state (transactional outbox, 02-storage.md §7.3) */
  outbox: TaskEvent[];
};

export const SUPERVISOR_SESSION_FILE = "sessions/supervisor.jsonl";

export function isHalted(state: Pick<TaskState, "status">): boolean {
  return HALTED_STATUSES.includes(state.status);
}

export function isFinished(state: Pick<TaskState, "status">): boolean {
  return FINISHED_STATUSES.includes(state.status);
}

/** Путь внутри каталога задачи: относительный, без выхода наверх. */
function staysInside(relative: string): boolean {
  if (relative === "" || relative.startsWith("/") || relative.includes("\\") || /^[A-Za-z]:/.test(relative)) {
    return false;
  }
  return !relative.split("/").some((part) => part === "..");
}

/**
 * Инварианты 02-storage.md §3.2. Возвращает описания нарушений (пусто — state корректен).
 * `dirName` — имя каталога задачи, с которым должен совпадать key.
 */
export function checkInvariants(s: TaskState, dirName: string): string[] {
  const out: string[] = [];
  const check = (ok: boolean, text: string) => {
    if (!ok) out.push(text);
  };
  const halted = HALTED_STATUSES.includes(s.status);

  check(halted === (s.phase === "halted"), `status=${s.status} несовместим с phase=${s.phase}`);
  check(
    (s.status === "waiting_human") === (s.pendingHumanRequest !== null),
    "status=waiting_human должен быть тогда и только тогда, когда есть pendingHumanRequest",
  );
  if (s.phase === "human_pending") {
    check(s.status === "waiting_human", "phase=human_pending требует status=waiting_human");
    check(s.pendingHumanRequest?.origin === "supervisor", "phase=human_pending требует вопрос от supervisor");
  }
  if (s.status === "waiting_human" && s.phase !== "human_pending") {
    check(s.phase === "agent_running", "вопрос человеку вне human_pending возможен только при phase=agent_running");
    check(s.pendingHumanRequest?.origin === "agent", "вопрос человеку при phase=agent_running должен быть от агента");
  }
  check(
    (s.phase === "decision_pending") === (s.pendingDecision !== null),
    "phase=decision_pending должна быть тогда и только тогда, когда есть pendingDecision",
  );
  if (s.phase === "agent_pending") check(s.nextAgentInput !== null, "phase=agent_pending требует nextAgentInput");
  if (s.phase === "agent_running") check(s.currentRun !== null, "phase=agent_running требует currentRun");
  check((s.phase === "waiting") === (s.wait !== null), "phase=waiting должна быть тогда и только тогда, когда есть wait");
  if (s.phase === "waiting") {
    check(s.status === "active" || s.status === "interrupted", "phase=waiting требует status active или interrupted");
    check(s.currentRun !== null, "phase=waiting требует currentRun");
  }
  if (s.currentRun) {
    check(staysInside(s.currentRun.sessionFile), `currentRun.sessionFile выходит за каталог задачи: ${s.currentRun.sessionFile}`);
  }
  check(staysInside(s.supervisor.sessionFile), `supervisor.sessionFile выходит за каталог задачи: ${s.supervisor.sessionFile}`);
  check(s.key === dirName, `key «${s.key}» не совпадает с именем каталога «${dirName}»`);
  return out;
}

/**
 * Остановить задачу: status ∈ {blocked, cancelled, terminal}, phase = halted.
 * Сбрасывает всё, что по инвариантам существует только в нетерминальных фазах.
 */
export function haltedState(
  s: TaskState,
  status: "blocked" | "cancelled" | "terminal",
  reason: StatusReason | null,
): TaskState {
  return {
    ...s,
    status,
    statusReason: reason,
    phase: "halted",
    nextAgentInput: null,
    wait: null,
    pendingDecision: null,
    pendingHumanRequest: null,
  };
}
