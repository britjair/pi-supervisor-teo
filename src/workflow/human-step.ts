// Фаза human_pending: вопрос supervisor-а человеку, 03-engine.md §6.
// Без терминала вопрос ждёт следующего интерактивного запуска (exit 5); повторный показ —
// тот же requestId без нового human.requested (§6.2).

import type { TaskState } from "../domain/task-state.js";
import type { EngineCore } from "./context.js";
import type { ExitOutcome } from "./outcome.js";

export async function askHumanStep(core: EngineCore, state: TaskState): Promise<ExitOutcome | void> {
  const request = state.pendingHumanRequest;
  if (!request) throw new Error("phase=human_pending без pendingHumanRequest");
  if (!core.human) {
    core.reporter.emit({ type: "info", text: `Вопрос от supervisor ждёт ответа: ${request.question}` });
    return { kind: "waiting_human" };
  }
  const stageTitle = core.store.stageTitle(state.stage) ?? state.stage;
  const answer = await core.ask({
    header: `Вопрос от supervisor · ${core.key} · ${stageTitle}`,
    question: request.question,
    context: request.context,
    options: request.options,
    allowFreeText: request.allowFreeText,
    attachments: request.attachments,
  });
  await core.store.tasks.commit(
    core.key,
    (s, c) => {
      const responseId = c.emit("human.responded", "human", {
        requestId: request.requestId,
        answer: answer.answer,
        selectedOption: answer.selectedOption,
      });
      return {
        ...s,
        phase: "supervisor_pending",
        status: "active",
        pendingHumanRequest: null,
        supervisor: { ...s.supervisor, trigger: { kind: "human_responded", ref: responseId } },
      };
    },
    { expectedVersion: state.version },
  );
}
