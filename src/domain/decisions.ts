// Решения supervisor-а, 03-engine.md §5, 04-agents.md §5.3. Только типы.

export const CONTROL_ACTIONS = [
  "transition_stage",
  "continue_current_agent",
  "restart_current_agent",
  "ask_human",
  "schedule_recheck",
  "block_task",
  "cancel_task",
] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export type TransitionStageInput = {
  expectedStateVersion: number;
  to: string;
  reason: string;
  evidenceRefs?: string[];
  handoff?: string;
};
export type ContinueAgentInput = { expectedStateVersion: number; message: string };
export type RestartAgentInput = { expectedStateVersion: number; reason: string; message: string };
export type AskHumanInput = {
  expectedStateVersion: number;
  question: string;
  context?: string;
  options?: string[];
  allowFreeText?: boolean;
  attachments?: string[];
};
export type BlockTaskInput = { expectedStateVersion: number; reason: string; resolutionHint: string };
export type CancelTaskInput = { expectedStateVersion: number; reason: string; humanResponseRef: string };
export type ScheduleRecheckInput = {
  expectedStateVersion: number;
  delayMinutes: number;
  waitingFor: string;
  message: string;
  evidenceRefs?: string[];
};

export type ControlInputs = {
  transition_stage: TransitionStageInput;
  continue_current_agent: ContinueAgentInput;
  restart_current_agent: RestartAgentInput;
  ask_human: AskHumanInput;
  schedule_recheck: ScheduleRecheckInput;
  block_task: BlockTaskInput;
  cancel_task: CancelTaskInput;
};

/** Принятое, но ещё не применённое решение (state.pendingDecision). */
export type Decision = {
  [A in ControlAction]: {
    decisionId: string;
    cycle: number;
    action: A;
    input: ControlInputs[A];
    decidedAt: string;
  };
}[ControlAction];
