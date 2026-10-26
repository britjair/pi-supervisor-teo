// Применение решения supervisor-а, 03-engine.md §7. Одна транзакция: эффекты решения,
// lastAppliedDecisionId, pendingDecision = null и decision.applied. Падение до записи —
// решение применится при следующем запуске; после — фаза уже другая. Двойного эффекта не бывает.

import path from "node:path";
import type { ControlInputs, Decision } from "../domain/decisions.js";
import { getStage, type PolicySpec } from "../domain/policy.js";
import { haltedState, type HumanRequest, type TaskState } from "../domain/task-state.js";
import type { CommitContext } from "../state/state-store.js";
import type { EngineCore } from "./context.js";

const clip = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function decisionSummary(state: TaskState, d: Decision): string {
  switch (d.action) {
    case "transition_stage":
      return `${state.stage} → ${d.input.to}`;
    case "continue_current_agent":
      return clip(d.input.message);
    case "restart_current_agent":
      return clip(d.input.reason);
    case "ask_human":
      return clip(d.input.question);
    case "schedule_recheck":
      return `через ${d.input.delayMinutes} мин: ${clip(d.input.waitingFor)}`;
    case "block_task":
      return clip(d.input.reason);
    case "cancel_task":
      return clip(d.input.reason);
  }
}

/**
 * Эффекты решения (таблица 03-engine.md §7.2). Чистая функция над state и CommitContext.
 * `attachments` — вложения вопроса с sha256 на момент вопроса.
 */
export function applyEffects(
  state: TaskState,
  d: Decision,
  spec: PolicySpec,
  c: CommitContext,
  attachments: HumanRequest["attachments"] = [],
): TaskState {
  const base: TaskState = {
    ...state,
    pendingDecision: null,
    lastAppliedDecisionId: d.decisionId,
    lastDecision: { decisionId: d.decisionId, action: d.action, summary: decisionSummary(state, d), at: c.now },
  };
  const applied = () => c.emit("decision.applied", "cli", { decisionId: d.decisionId, action: d.action });

  switch (d.action) {
    case "transition_stage": {
      const i: ControlInputs["transition_stage"] = d.input;
      const target = getStage(spec, i.to);
      const transitionedId = c.emit("stage.transitioned", "supervisor", {
        from: state.stage,
        to: i.to,
        reason: i.reason,
        evidenceRefs: i.evidenceRefs ?? [],
        decisionId: d.decisionId,
        handoff: i.handoff ?? null,
        by: "supervisor",
      });
      if (!target) {
        c.emit("task.blocked", "cli", { code: "POLICY_STAGE_MISSING", message: `этапа ${i.to} нет в текущей Policy`, by: "cli" });
        applied();
        return haltedState(base, "blocked", { code: "POLICY_STAGE_MISSING", message: `этапа ${i.to} нет в текущей Policy`, at: c.now });
      }
      if (target.kind === "terminal") {
        c.emit("task.terminal", "cli", { stage: i.to });
        applied();
        return haltedState({ ...base, stage: i.to, stageEnteredAt: c.now, stageEntryEventId: transitionedId }, "terminal", null);
      }
      applied();
      return {
        ...base,
        stage: i.to,
        stageEnteredAt: c.now,
        stageEntryEventId: transitionedId,
        stageCycles: 0,
        stageRechecks: { count: 0, waitedMinutes: 0, firstScheduledAt: null },
        consecutiveRestarts: 0,
        phase: "agent_pending",
        nextAgentInput: { kind: "initial", message: i.handoff?.trim() ? i.handoff : null, decisionId: d.decisionId },
      };
    }
    case "continue_current_agent":
      applied();
      return { ...base, phase: "agent_pending", nextAgentInput: { kind: "continue", message: d.input.message, decisionId: d.decisionId } };
    case "restart_current_agent":
      applied();
      return { ...base, phase: "agent_pending", nextAgentInput: { kind: "restart", message: d.input.message, decisionId: d.decisionId } };
    case "ask_human": {
      const i = d.input;
      const requestId = c.emit("human.requested", "supervisor", (id) => ({
        requestId: id,
        origin: "supervisor",
        runId: null,
        question: i.question,
        options: i.options ?? null,
        attachments,
      }));
      applied();
      return {
        ...base,
        phase: "human_pending",
        status: "waiting_human",
        pendingHumanRequest: {
          requestId,
          origin: "supervisor",
          runId: null,
          question: i.question,
          context: i.context ?? null,
          options: i.options ?? null,
          allowFreeText: i.allowFreeText ?? true,
          attachments,
          requestedAt: c.now,
        },
      };
    }
    case "schedule_recheck": {
      const i = d.input;
      const stage = getStage(spec, state.stage);
      const number = state.stageRechecks.count + 1;
      const dueAt = new Date(new Date(c.now).getTime() + i.delayMinutes * 60_000).toISOString();
      c.emit("wait.scheduled", "supervisor", {
        decisionId: d.decisionId,
        number,
        maxCount: stage?.kind === "work" ? (stage.recheck?.maxCount ?? 0) : 0,
        waitingFor: i.waitingFor,
        delayMinutes: i.delayMinutes,
        dueAt,
      });
      applied();
      return {
        ...base,
        phase: "waiting",
        wait: { decisionId: d.decisionId, number, waitingFor: i.waitingFor, message: i.message, delayMinutes: i.delayMinutes, scheduledAt: c.now, dueAt },
        stageRechecks: { ...state.stageRechecks, count: number, firstScheduledAt: state.stageRechecks.firstScheduledAt ?? c.now },
      };
    }
    case "block_task":
      c.emit("task.blocked", "supervisor", { code: "SUPERVISOR_BLOCKED", message: d.input.reason, by: "supervisor" });
      applied();
      return haltedState(base, "blocked", { code: "SUPERVISOR_BLOCKED", message: `${d.input.reason} — ${d.input.resolutionHint}`, at: c.now });
    case "cancel_task":
      c.emit("task.cancelled", "supervisor", { reason: d.input.reason, humanResponseRef: d.input.humanResponseRef, by: "supervisor" });
      applied();
      return haltedState(base, "cancelled", { code: "CANCELLED_BY_SUPERVISOR", message: d.input.reason, at: c.now });
  }
}

export async function applyDecision(core: EngineCore, state: TaskState, attachmentOf: (p: string) => Promise<{ path: string; sha256: string } | null>): Promise<TaskState> {
  const decision = state.pendingDecision;
  if (!decision) throw new Error("phase=decision_pending без pendingDecision");
  core.faults.check("before-decision-apply");
  const attachments: HumanRequest["attachments"] = [];
  if (decision.action === "ask_human") {
    for (const p of decision.input.attachments ?? []) {
      const a = await attachmentOf(p);
      if (a) attachments.push(a);
    }
  }
  const before = state;
  const next = await core.store.tasks.commit(
    core.key,
    (s, c) => {
      // Идемпотентность: решение уже применено другим процессом — ничего не делать
      if (s.pendingDecision?.decisionId !== decision.decisionId) return s;
      return applyEffects(s, decision, core.policy.spec, c, attachments);
    },
    { expectedVersion: state.version },
  );
  core.reporter.emit({ type: "decision", cycle: decision.cycle, action: decision.action, summary: decisionSummary(before, decision) });
  if (decision.action === "transition_stage") {
    const fromTitle = core.store.stageTitle(before.process, before.stage) ?? before.stage;
    const toTitle = core.store.stageTitle(next.process, next.stage) ?? next.stage;
    core.reporter.emit({
      type: "transition",
      from: before.stage,
      fromTitle,
      to: next.stage,
      toTitle,
      reason: decision.input.reason,
      terminal: next.status === "terminal",
    });
    // Сессия агента прошлого этапа больше не нужна: при session: reuse она откроется снова
    if (before.currentRun) core.pool.close(path.join(core.task().dir, before.currentRun.sessionFile));
  }
  return next;
}
