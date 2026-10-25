// Policy gate перед agent_pending и supervisor_pending, 03-engine.md §7.3, 01-policy.md §4.
// Ошибка Policy → PolicyError (exit 2), state не меняется: задача продолжится после исправления файла.

import { getStage, type LoadedPolicy } from "../domain/policy.js";
import { haltedState, type TaskState } from "../domain/task-state.js";
import { diffPolicies, type PolicyDiffEntry } from "../policy/policy-diff.js";
import { parsePolicyBytes } from "../policy/policy-loader.js";
import type { EngineCore } from "./context.js";
import type { ExitOutcome } from "./outcome.js";

export type PolicyConfirm = (change: { fromHash: string; toHash: string; diff: PolicyDiffEntry[]; stage: string }) => Promise<boolean>;

/** Diff со снимком старой версии; без снимка — пустой. */
export async function policyDiff(core: EngineCore, fromHash: TaskState["policyHash"], to: LoadedPolicy): Promise<PolicyDiffEntry[]> {
  const old = await core.store.snapshots.read(fromHash).catch(() => null);
  if (old === null) return [];
  try {
    return diffPolicies(parsePolicyBytes(new TextEncoder().encode(old), "snapshot"), to);
  } catch {
    return [];
  }
}

/** Применить новую Policy одной записью state (01-policy.md §4.3). */
export async function applyPolicy(
  core: EngineCore,
  state: TaskState,
  loaded: LoadedPolicy,
  mode: string,
  diff: PolicyDiffEntry[],
): Promise<TaskState> {
  await core.store.snapshots.save(loaded);
  const next = await core.store.tasks.commit(
    core.key,
    (s, c) => {
      const id = c.emit("policy.changed", "cli", { fromHash: s.policyHash, toHash: loaded.hash, mode, diff });
      const base = { ...s, policyHash: loaded.hash, policySchema: loaded.schema };
      // Агент нового этапа сразу после transition запускается уже по новой Policy;
      // иначе supervisor должен увидеть изменение до следующего решения
      if (s.phase === "agent_pending" && s.nextAgentInput?.kind !== "initial") {
        return { ...base, phase: "supervisor_pending", nextAgentInput: null, supervisor: { ...s.supervisor, trigger: { kind: "policy_changed", ref: id } } };
      }
      return base;
    },
    { expectedVersion: state.version },
  );
  core.policy = loaded;
  core.store.setPolicy(loaded);
  core.reporter.emit({ type: "policy.changed", fromHash: state.policyHash, toHash: loaded.hash, mode });
  return next;
}

export async function policyGate(
  core: EngineCore,
  state: TaskState,
  loadPolicy: () => Promise<LoadedPolicy>,
  confirm: PolicyConfirm | null,
): Promise<ExitOutcome | "changed" | null> {
  const loaded = await loadPolicy();
  core.policy = loaded;
  core.store.setPolicy(loaded);
  if (loaded.hash === state.policyHash) return null;

  // Текущий этап исчез или стал терминальным: автоматическое продолжение запрещено во всех режимах
  const stage = getStage(loaded.spec, state.stage);
  if (!stage || stage.kind === "terminal") {
    const message = !stage ? `этапа ${state.stage} нет в новой Policy` : `этап ${state.stage} в новой Policy терминальный`;
    await core.store.tasks.commit(
      core.key,
      (s, c) => {
        c.emit("task.blocked", "cli", { code: "POLICY_STAGE_MISSING", message, by: "cli" });
        return haltedState(s, "blocked", { code: "POLICY_STAGE_MISSING", message, at: c.now });
      },
      { expectedVersion: state.version },
    );
    return { kind: "blocked", code: "POLICY_STAGE_MISSING" };
  }

  const mode = loaded.spec.runtime.policyChangeMode;
  if (mode === "pinned") return { kind: "policy_pinned" };
  const diff = await policyDiff(core, state.policyHash, loaded);
  if (mode === "confirm") {
    if (!confirm) return { kind: "policy_unconfirmed" };
    if (!(await confirm({ fromHash: state.policyHash, toHash: loaded.hash, diff, stage: state.stage }))) return { kind: "policy_declined" };
  }
  await applyPolicy(core, state, loaded, mode, diff);
  return "changed";
}
