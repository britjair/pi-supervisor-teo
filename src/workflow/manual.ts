// Действия человека над задачей вне цикла: разблокировка (03-engine.md §11),
// ручное восстановление (05-cli-ui.md §2.1): выбор этапа, принятие новой Policy,
// разбор подмены state и повреждённой сессии агента.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { getStage, type LoadedPolicy } from "../domain/policy.js";
import { RECOVER_ONLY_CODES, haltedState, isFinished, type TaskState } from "../domain/task-state.js";
import { UsageError } from "../errors/errors.js";
import type { ProjectStore } from "../state/project-store.js";
import { parseTaskState, type CommitContext } from "../state/state-store.js";
import { diffPolicies } from "../policy/policy-diff.js";
import { parsePolicyBytes } from "../policy/policy-loader.js";

export { RECOVER_ONLY_CODES } from "../domain/task-state.js";

export async function unblockTask(store: ProjectStore, key: string, note: string): Promise<TaskState> {
  const state = await store.tasks.load(key);
  if (state.status !== "blocked") throw new UsageError(`Задача ${key} не заблокирована.`);
  const code = state.statusReason?.code ?? "";
  if (RECOVER_ONLY_CODES.includes(code)) throw new UsageError(`Задачу ${key} (${code}) можно восстановить только командой: sdlc recover ${key}`);
  return store.tasks.commit(
    key,
    (s, c) => {
      const id = c.emit("human.responded", "human", { requestId: null, answer: note, selectedOption: null });
      c.emit("task.unblocked", "human", { note, by: "human" });
      return {
        ...s,
        status: "active",
        statusReason: null,
        phase: "supervisor_pending",
        supervisor: { ...s.supervisor, trigger: { kind: "unblocked", ref: id } },
      };
    },
    { expectedVersion: state.version },
  );
}

/** Записать policy.changed { mode: "manual" } в ту же транзакцию, если hash отличается. */
async function manualPolicyDiff(store: ProjectStore, state: TaskState, policy: LoadedPolicy) {
  if (state.policyHash === policy.hash) return null;
  await store.snapshots.save(policy);
  const old = await store.snapshots.read(state.policyHash).catch(() => null);
  let diff: unknown[] = [];
  if (old !== null) {
    try {
      diff = diffPolicies(parsePolicyBytes(new TextEncoder().encode(old), "snapshot"), policy);
    } catch {
      diff = [];
    }
  }
  return diff;
}

export async function setStage(store: ProjectStore, key: string, stageId: string, policy: LoadedPolicy): Promise<TaskState> {
  const state = await store.tasks.load(key);
  if (isFinished(state)) throw new UsageError(`Задача ${key} уже завершена.`);
  const stage = getStage(policy.spec, stageId);
  if (!stage || stage.kind !== "work") {
    const known = Object.values(policy.spec.workflow.stages).filter((s) => s.kind === "work").map((s) => s.id);
    throw new UsageError(`Этап «${stageId}» не найден среди нетерминальных этапов Policy: ${known.join(", ")}`);
  }
  const diff = await manualPolicyDiff(store, state, policy);
  return store.tasks.commit(
    key,
    (s, c) => {
      if (diff) c.emit("policy.changed", "human", { fromHash: s.policyHash, toHash: policy.hash, mode: "manual", diff });
      const id = c.emit("stage.transitioned", "human", {
        from: s.stage,
        to: stageId,
        reason: "manual recovery",
        evidenceRefs: [],
        decisionId: null,
        handoff: null,
        by: "human",
      });
      return {
        ...s,
        policyHash: policy.hash,
        policySchema: policy.schema,
        status: "active",
        statusReason: null,
        stage: stageId,
        stageEnteredAt: c.now,
        stageEntryEventId: id,
        stageCycles: 0,
        stageRechecks: { count: 0, waitedMinutes: 0, firstScheduledAt: null },
        consecutiveRestarts: 0,
        phase: "agent_pending",
        nextAgentInput: { kind: "initial", message: null, decisionId: null },
        wait: null,
        pendingDecision: null,
        pendingHumanRequest: null,
      };
    },
    { expectedVersion: state.version },
  );
}

/** Принять текущую Policy (режим pinned или после разбора). Этап задачи должен в ней существовать. */
export async function acceptPolicy(store: ProjectStore, key: string, policy: LoadedPolicy): Promise<TaskState> {
  const state = await store.tasks.load(key);
  if (state.policyHash === policy.hash) throw new UsageError(`Задача ${key} уже идёт по текущей Policy.`);
  const stage = getStage(policy.spec, state.stage);
  if (!stage || stage.kind === "terminal") {
    throw new UsageError(`Этапа «${state.stage}» нет в текущей Policy. Выберите этап: sdlc recover ${key} --set-stage <этап>`);
  }
  const diff = (await manualPolicyDiff(store, state, policy)) ?? [];
  return store.tasks.commit(
    key,
    (s, c) => {
      const id = c.emit("policy.changed", "human", { fromHash: s.policyHash, toHash: policy.hash, mode: "manual", diff });
      const base = { ...s, policyHash: policy.hash, policySchema: policy.schema };
      if (s.status === "blocked" && s.statusReason?.code === "POLICY_STAGE_MISSING") {
        return { ...base, status: "active", statusReason: null, phase: "supervisor_pending", supervisor: { ...s.supervisor, trigger: { kind: "policy_changed", ref: id } } };
      }
      if (s.phase === "agent_pending" && s.nextAgentInput?.kind !== "initial") {
        return { ...base, phase: "supervisor_pending", nextAgentInput: null, supervisor: { ...s.supervisor, trigger: { kind: "policy_changed", ref: id } } };
      }
      return base;
    },
    { expectedVersion: state.version },
  );
}

/** Поля, которые проставляет хранилище при каждой записи: в diff и при замене state не участвуют. */
const STORE_FIELDS = new Set(["version", "updatedAt", "outbox", "lastEventId"]);

export type StateFieldChange = { field: string; before: string; after: string };

/** Отличия двух state по полям верхнего уровня (для показа перед «принять как есть»). */
export function stateDiff(before: TaskState, after: TaskState): StateFieldChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !STORE_FIELDS.has(k));
  const show = (v: unknown) => (v === undefined ? "—" : JSON.stringify(v));
  return keys
    .map((field) => ({ field, before: show((before as Record<string, unknown>)[field]), after: show((after as Record<string, unknown>)[field]) }))
    .filter((c) => c.before !== c.after);
}

/** Копия state.json из каталога задачи, прошедшая схему и инварианты. */
export async function readStateCopy(key: string, file: string): Promise<TaskState> {
  return parseTaskState(key, file, await readFile(file));
}

/**
 * STATE_TAMPERED → заменить state содержимым копии: изменённого файла («принять как есть»)
 * или последнего state, записанного sdlc до подмены («восстановить»). Выбор человека — в журнал.
 */
export async function replaceTamperedState(
  store: ProjectStore,
  key: string,
  file: string,
  mode: "accept_tampered" | "restore_before_tamper",
  label: string,
): Promise<TaskState> {
  const state = await store.tasks.load(key);
  if (state.status !== "blocked" || state.statusReason?.code !== "STATE_TAMPERED") {
    throw new UsageError(`Задача ${key} не заблокирована из-за подмены state.`);
  }
  const copy = await readStateCopy(key, file);
  return store.tasks.commit(
    key,
    (s, c) => {
      c.emit("human.responded", "human", { requestId: null, answer: label, selectedOption: label });
      c.emit("runtime.recovered", "cli", { phase: s.phase, action: mode, details: { file: path.basename(file), fromVersion: copy.version } });
      c.emit("task.unblocked", "human", { note: label, by: "human" });
      return { ...copy };
    },
    { expectedVersion: state.version },
  );
}

export type SessionChoice = "restart" | "supervisor" | "block";

/** statusReason.message блокировки SESSION_CORRUPTED = префикс + причина. */
export const SESSION_CORRUPTED_PREFIX = "файл сессии повреждён: ";

export const SESSION_CHOICE_LABELS: Record<SessionChoice, string> = {
  restart: "Перезапустить агента этапа с новой сессией (restart)",
  supervisor: "Передать supervisor для решения",
  block: "Заблокировать задачу",
};

/** Неоднозначный run с повреждённым файлом сессии (03-engine.md §8.4): эффект выбора человека. */
export function sessionChoiceMutator(choice: SessionChoice, reason: string): (s: TaskState, c: CommitContext) => TaskState {
  return (s, c) => {
    const label = SESSION_CHOICE_LABELS[choice];
    c.emit("human.responded", "human", { requestId: null, answer: label, selectedOption: label });
    c.emit("runtime.recovered", "cli", { phase: s.phase, action: `ambiguous_${choice}`, details: { reason } });
    if (choice === "block") {
      c.emit("task.blocked", "cli", { code: "SESSION_CORRUPTED", message: reason, by: "cli" });
      return haltedState(s, "blocked", { code: "SESSION_CORRUPTED", message: `${SESSION_CORRUPTED_PREFIX}${reason}`, at: c.now });
    }
    const base = { ...s, status: "active" as const, statusReason: null, pendingHumanRequest: null };
    if (choice === "restart") {
      return {
        ...base,
        phase: "agent_pending",
        nextAgentInput: { kind: "restart", message: "Файл сессии предыдущей попытки повреждён. Начни этап заново.", decisionId: null },
      };
    }
    return {
      ...base,
      phase: "supervisor_pending",
      nextAgentInput: null,
      currentRun: s.currentRun ? { ...s.currentRun, status: "failed", settleReason: "interrupted" } : null,
      supervisor: { ...s.supervisor, trigger: { kind: "recovered", ref: s.currentRun?.runId ?? null } },
    };
  };
}

export async function resolveCorruptedSession(store: ProjectStore, key: string, choice: SessionChoice, reason: string): Promise<TaskState> {
  const state = await store.tasks.load(key);
  if (!state.currentRun) throw new UsageError(`У задачи ${key} нет запуска агента, который можно восстановить.`);
  return store.tasks.commit(key, sessionChoiceMutator(choice, reason), { expectedVersion: state.version });
}
