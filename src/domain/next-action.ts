// Следующее действие по фазе и триггеру (05-cli-ui.md §6). Вычисляется из state, а не из текста модели.
// Текст для человека строит ui/messages.ts.

import type { ControlAction } from "./decisions.js";
import type { AgentInputKind, SupervisorTriggerKind, TaskState } from "./task-state.js";

export type NextAction =
  | { kind: "start_agent"; agentId: string | null; inputKind: AgentInputKind }
  | { kind: "agent_running"; agentId: string | null; live: boolean }
  | { kind: "supervisor_evaluate"; trigger: SupervisorTriggerKind | null; agentId: string | null }
  | { kind: "supervisor_running"; live: boolean }
  | { kind: "apply_decision"; action: ControlAction | null }
  | { kind: "waiting_human"; question: string; fromAgent: boolean }
  | { kind: "waiting_recheck"; dueAt: string; waitingFor: string; overdue: boolean; live: boolean }
  | { kind: "terminal" }
  | { kind: "cancelled" }
  | { kind: "blocked"; code: string | null; reason: string | null };

export type NextActionContext = {
  /** Агент текущего этапа по Policy; null — этапа нет в Policy или он терминальный */
  stageAgent: string | null;
  now: Date;
  /** Задачу прямо сейчас ведёт живой процесс (lock с этой задачей) */
  live: boolean;
};

export function nextAction(s: TaskState, ctx: NextActionContext): NextAction {
  const runAgent = s.currentRun?.agentId ?? null;
  switch (s.phase) {
    case "agent_pending": {
      const inputKind = s.nextAgentInput?.kind ?? "initial";
      const agentId = inputKind === "initial" || inputKind === "restart" ? (ctx.stageAgent ?? runAgent) : runAgent;
      return { kind: "start_agent", agentId, inputKind };
    }
    case "agent_running":
      if (s.pendingHumanRequest?.origin === "agent") {
        return { kind: "waiting_human", question: s.pendingHumanRequest.question, fromAgent: true };
      }
      return { kind: "agent_running", agentId: runAgent, live: ctx.live };
    case "supervisor_pending":
      return { kind: "supervisor_evaluate", trigger: s.supervisor.trigger?.kind ?? null, agentId: runAgent };
    case "supervisor_running":
      return { kind: "supervisor_running", live: ctx.live };
    case "decision_pending":
      return { kind: "apply_decision", action: s.pendingDecision?.action ?? null };
    case "human_pending":
      return { kind: "waiting_human", question: s.pendingHumanRequest?.question ?? "", fromAgent: false };
    case "waiting": {
      const dueAt = s.wait?.dueAt ?? s.updatedAt;
      return {
        kind: "waiting_recheck",
        dueAt,
        waitingFor: s.wait?.waitingFor ?? "",
        overdue: new Date(dueAt).getTime() <= ctx.now.getTime(),
        live: ctx.live,
      };
    }
    case "halted":
      if (s.status === "terminal") return { kind: "terminal" };
      if (s.status === "cancelled") return { kind: "cancelled" };
      return { kind: "blocked", code: s.statusReason?.code ?? null, reason: s.statusReason?.message ?? null };
  }
}
