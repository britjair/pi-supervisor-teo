// Фаза waiting: отложенная перепроверка, 03-engine.md §12.3. Модели в ожидании не вызываются.
// Срок хранится в state и сверяется с настенными часами на каждом тике (сон ноутбука не страшен).

import { getStage } from "../domain/policy.js";
import type { TaskState } from "../domain/task-state.js";
import type { EngineCore } from "./context.js";
import type { ExitOutcome } from "./outcome.js";

export type WaitAction = { kind: "tick" } | { kind: "check_now" } | { kind: "message"; text: string } | { kind: "quit" };

/** Источник действий человека во время ожидания. Без терминала — только тики. */
export interface WaitControl {
  next(ms: number, signal: AbortSignal): Promise<WaitAction>;
}

export function tickingWaitControl(sleep: (ms: number) => Promise<void>): WaitControl {
  return {
    async next(ms) {
      await sleep(ms);
      return { kind: "tick" };
    },
  };
}

export const WAIT_TICK_MS = 15_000;
export const WAIT_NOTICE_MS = 10 * 60_000;

const minutesBetween = (fromIso: string, to: Date) => Math.max(0, Math.round((to.getTime() - new Date(fromIso).getTime()) / 60_000));

export async function finishWait(core: EngineCore, state: TaskState, reason: "due" | "skipped_by_human"): Promise<void> {
  const wait = state.wait;
  if (!wait) return;
  await core.store.tasks.commit(
    core.key,
    (s, c) => {
      const waited = minutesBetween(wait.scheduledAt, new Date(c.now));
      c.emit("wait.finished", "cli", { decisionId: wait.decisionId, reason, waitedMinutes: waited, responseRef: null });
      return {
        ...s,
        status: "active",
        phase: "agent_pending",
        nextAgentInput: { kind: "recheck", message: wait.message, decisionId: wait.decisionId },
        stageRechecks: { ...s.stageRechecks, waitedMinutes: s.stageRechecks.waitedMinutes + waited },
        wait: null,
      };
    },
    { expectedVersion: state.version },
  );
}

/** Сообщение человека во время ожидания уходит supervisor-у (03-engine.md §12.3). */
export async function waitHumanMessage(core: EngineCore, state: TaskState, text: string, channel?: "chat"): Promise<void> {
  const wait = state.wait;
  if (!wait) return;
  await core.store.tasks.commit(
    core.key,
    (s, c) => {
      const waited = minutesBetween(wait.scheduledAt, new Date(c.now));
      const responseId = c.emit("human.responded", "human", { requestId: null, answer: text, selectedOption: null, ...(channel ? { channel } : {}) });
      c.emit("wait.finished", "cli", { decisionId: wait.decisionId, reason: "human_message", waitedMinutes: waited, responseRef: `human:${responseId}` });
      return {
        ...s,
        status: "active",
        phase: "supervisor_pending",
        wait: null,
        supervisor: { ...s.supervisor, trigger: { kind: "human_responded", ref: responseId } },
        stageRechecks: { ...s.stageRechecks, waitedMinutes: s.stageRechecks.waitedMinutes + waited },
      };
    },
    { expectedVersion: state.version },
  );
}

export async function awaitWait(core: EngineCore, state: TaskState, consumeCheckNow: () => boolean): Promise<ExitOutcome | void> {
  const wait = state.wait;
  if (!wait) throw new Error("phase=waiting без wait");
  if (consumeCheckNow()) return finishWait(core, state, "skipped_by_human");

  const due = new Date(wait.dueAt).getTime();
  const stage = getStage(core.policy.spec, state.stage);
  const maxCount = stage?.kind === "work" ? (stage.recheck?.maxCount ?? 0) : 0;
  if (core.clock.now().getTime() < due) {
    core.reporter.emit({ type: "waiting", dueAt: wait.dueAt, minutes: wait.delayMinutes, number: wait.number, maxCount, waitingFor: wait.waitingFor });
  }
  let lastNotice = core.clock.now().getTime();
  for (;;) {
    const now = core.clock.now().getTime();
    if (now >= due) return finishWait(core, state, "due");
    if (core.options.noWait) return { kind: "waiting_recheck", dueAt: wait.dueAt };
    if (now - lastNotice >= WAIT_NOTICE_MS) {
      core.reporter.emit({ type: "waiting.tick", minutesLeft: Math.ceil((due - now) / 60_000) });
      lastNotice = now;
    }
    const action = await core.waitControl.next(Math.min(WAIT_TICK_MS, due - now), core.signal);
    switch (action.kind) {
      case "tick":
        continue;
      case "check_now":
        return finishWait(core, state, "skipped_by_human");
      case "message":
        return waitHumanMessage(core, state, action.text);
      case "quit":
        return { kind: "waiting_recheck", dueAt: wait.dueAt };
    }
  }
}
