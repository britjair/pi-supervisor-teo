// Действия человека над задачей вне цикла: разблокировка (03-engine.md §11),
// ручное восстановление (05-cli-ui.md §2.1): выбор этапа и принятие новой Policy.

import { getStage, type LoadedPolicy } from "../domain/policy.js";
import { isFinished, type TaskState } from "../domain/task-state.js";
import { UsageError } from "../errors/errors.js";
import type { ProjectStore } from "../state/project-store.js";
import { diffPolicies } from "../policy/policy-diff.js";
import { parsePolicyBytes } from "../policy/policy-loader.js";

/** Причины блокировки, которые снимает только sdlc recover. */
export const RECOVER_ONLY_CODES = ["POLICY_STAGE_MISSING", "STATE_TAMPERED"];

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
