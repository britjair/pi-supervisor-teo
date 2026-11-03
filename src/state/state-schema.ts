// Проверка формы state.json и строк events.jsonl при загрузке.
// Типы описаны в domain/; здесь — их зеркало на zod, совпадение проверяется компилятором (ниже).

import { z } from "zod";
import { CONTROL_ACTIONS, type Decision } from "../domain/decisions.js";
import { PROCESS_NAME_RE, type PolicyHash } from "../domain/policy.js";
import type { TaskEvent } from "../domain/events.js";
import {
  AGENT_INPUT_KINDS,
  PHASES,
  SETTLE_REASONS,
  TASK_STATE_SCHEMA_VERSION,
  TASK_STATUSES,
  TRIGGER_KINDS,
  type TaskState,
} from "../domain/task-state.js";

const iso = z.string().min(1);
const id = z.string().min(1);

const agentRunRef = z.object({
  runId: id,
  agentId: id,
  attempt: z.int().min(1),
  stage: id,
  sessionFile: id,
  sessionMode: z.enum(["fresh", "reuse", "restart"]),
  status: z.enum(["pending", "running", "settled", "failed"]),
  settleReason: z.enum(SETTLE_REASONS).nullable(),
  promptsSent: z.array(id),
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
});

const decision = z.object({
  decisionId: id,
  cycle: z.int().min(0),
  action: z.enum(CONTROL_ACTIONS),
  input: z.record(z.string(), z.unknown()),
  decidedAt: iso,
});

export const taskEventSchema = z.object({
  id: id,
  timestamp: iso,
  taskKey: id,
  type: id,
  stateVersion: z.int().min(0),
  actor: z.enum(["cli", "supervisor", "agent", "human"]),
  payload: z.record(z.string(), z.unknown()),
});

export const taskStateSchema = z.object({
  schemaVersion: z.literal(TASK_STATE_SCHEMA_VERSION),
  key: id,
  title: z.string(),
  projectRoot: z.string(),
  workspacePath: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
  version: z.int().min(1),
  process: z.string().regex(PROCESS_NAME_RE),
  policyHash: z.custom<PolicyHash>((v) => typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v), "ожидается sha256:<hex>"),
  policySchema: z.literal("teo/v1"),
  stage: id,
  stageEnteredAt: iso,
  stageEntryEventId: id,
  stageCycles: z.int().min(0),
  stageRechecks: z.object({
    count: z.int().min(0),
    waitedMinutes: z.number().min(0),
    firstScheduledAt: iso.nullable(),
  }),
  status: z.enum(TASK_STATUSES),
  statusReason: z.object({ code: id, message: z.string(), at: iso }).nullable(),
  phase: z.enum(PHASES),
  currentRun: agentRunRef.nullable(),
  agentRunCounters: z.record(z.string(), z.int().min(0)),
  consecutiveRestarts: z.int().min(0),
  nextAgentInput: z
    .object({ kind: z.enum(AGENT_INPUT_KINDS), message: z.string().nullable(), decisionId: id.nullable() })
    .nullable(),
  wait: z
    .object({
      kind: z.enum(["policy_recheck", "supervisor_model_cooldown", "agent_model_cooldown"]).optional(),
      modelCooldown: z.object({ role: id, provider: id, modelId: id }).nullable().optional(),
      decisionId: id,
      number: z.int().min(1),
      waitingFor: z.string(),
      message: z.string(),
      delayMinutes: z.number().min(0),
      scheduledAt: iso,
      dueAt: iso,
      targetPhase: z.enum(["agent_pending", "supervisor_pending"]).nullable().default(null),
      /** Ожидание лимита: dueAt — названный провайдером срок сброса, а не следующая проба */
      resetKnown: z.boolean().default(true),
    })
    .nullable(),
  supervisor: z.object({
    sessionFile: id,
    cycle: z.int().min(0),
    trigger: z.object({ kind: z.enum(TRIGGER_KINDS), ref: z.string().nullable() }).nullable(),
    lastPolicyHashShown: z.string().nullable(),
  }),
  // Поле появилось на X2: в state-файлах прежних версий его нет
  hostSession: z.object({
    sessionId: id,
    sessionFile: z.string().nullable(),
    boundAt: iso,
    paused: z.boolean().default(false),
    awaitingNextSession: z.boolean().default(false),
    nextSessionId: id.nullable().default(null),
  }).nullable().default(null),
  pendingDecision: decision.nullable(),
  lastAppliedDecisionId: id.nullable(),
  lastDecision: z.object({ decisionId: id, action: id, summary: z.string(), at: iso }).nullable(),
  pendingHumanRequest: z
    .object({
      requestId: id,
      origin: z.enum(["supervisor", "agent"]),
      runId: id.nullable(),
      question: z.string(),
      context: z.string().nullable(),
      options: z.array(z.string()).nullable(),
      allowFreeText: z.boolean(),
      attachments: z.array(z.object({ path: z.string(), sha256: z.string() })),
      requestedAt: iso,
    })
    .nullable(),
  lastEventId: id,
  outbox: z.array(taskEventSchema),
});

// Схема и тип должны описывать одно и то же: расхождение — ошибка компиляции.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Loose<T> = Omit<T, "pendingDecision" | "outbox"> & { pendingDecision: unknown; outbox: unknown };
const _stateMatches: Same<Loose<z.infer<typeof taskStateSchema>>, Loose<TaskState>> = true;
const _decisionKeys: Same<keyof z.infer<typeof decision>, keyof Decision> = true;
const _eventKeys: Same<keyof z.infer<typeof taskEventSchema>, keyof TaskEvent> = true;
void [_stateMatches, _decisionKeys, _eventKeys];

export function describeZodIssues(error: z.ZodError, limit = 5): string {
  const issues = error.issues.slice(0, limit).map((i) => `${i.path.join(".") || "(корень)"}: ${i.message}`);
  const more = error.issues.length > limit ? `; и ещё ${error.issues.length - limit}` : "";
  return issues.join("; ") + more;
}
