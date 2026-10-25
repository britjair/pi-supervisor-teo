// Техническая валидация управляющих решений supervisor-а, 03-engine.md §5.4.
// Смысл условий `when` CLI не проверяет. Ввод-вывод — только через resolvers.

import { z } from "zod";
import { resolveEvidenceRef, type EvidenceContext } from "../agents/evidence-refs.js";
import type { ControlAction, ControlInputs } from "../domain/decisions.js";
import type { TaskEvent } from "../domain/events.js";
import { getStage, type PolicySpec, type WorkStage } from "../domain/policy.js";
import type { TaskState } from "../domain/task-state.js";

export type DecisionError = { code: string; message: string };

const nonEmpty = z.string().refine((s) => s.trim().length > 0, "строка не может быть пустой");
const version = z.int().describe("expectedStateVersion из промпта цикла");

export const controlSchemas = {
  transition_stage: z.object({
    expectedStateVersion: version,
    to: nonEmpty.describe("id этапа из списка допустимых переходов"),
    reason: nonEmpty.describe("Почему условие перехода выполнено, со ссылкой на проверенные факты"),
    evidenceRefs: z.array(nonEmpty).optional().describe("git:<sha>, file:<путь>[@sha256], artifact:<путь>, human:<eventId>, event:<id>, run:<runId>, url:<url>, note:<текст>"),
    handoff: z.string().optional().describe("Указания агенту следующего этапа"),
  }),
  continue_current_agent: z.object({ expectedStateVersion: version, message: nonEmpty.describe("Конкретное замечание агенту") }),
  restart_current_agent: z.object({ expectedStateVersion: version, reason: nonEmpty, message: nonEmpty }),
  ask_human: z.object({
    expectedStateVersion: version,
    question: nonEmpty,
    context: z.string().optional(),
    options: z.array(nonEmpty).optional(),
    allowFreeText: z.boolean().optional(),
    attachments: z.array(nonEmpty).optional().describe("Пути файлов внутри проекта или каталога задачи"),
  }),
  schedule_recheck: z.object({
    expectedStateVersion: version,
    delayMinutes: z.number().positive(),
    waitingFor: nonEmpty.describe("Какое внешнее событие ожидается"),
    message: nonEmpty.describe("Поручение агенту этапа на момент перепроверки"),
    evidenceRefs: z.array(nonEmpty).optional(),
  }),
  block_task: z.object({ expectedStateVersion: version, reason: nonEmpty, resolutionHint: nonEmpty.describe("Что нужно починить") }),
  cancel_task: z.object({ expectedStateVersion: version, reason: nonEmpty, humanResponseRef: nonEmpty.describe("human:<eventId> свежего ответа пользователя") }),
} satisfies { [A in ControlAction]: z.ZodType };

export type ValidatorResolvers = {
  evidence: EvidenceContext;
  sessionExists: (sessionFile: string) => Promise<boolean>;
  /** Вложение вопроса: файл внутри проекта или каталога задачи */
  attachment: (p: string) => Promise<{ path: string; sha256: string } | null>;
  events: () => Promise<TaskEvent[]>;
};

export type ValidationResult<A extends ControlAction> =
  | { ok: true; input: ControlInputs[A]; attachments: Array<{ path: string; sha256: string }> }
  | { ok: false; errors: DecisionError[] };

const err = (code: string, message: string): DecisionError => ({ code, message });

function continuableRun(state: TaskState, stage: WorkStage): DecisionError | null {
  const run = state.currentRun;
  if (!run || run.agentId !== stage.agent || run.stage !== state.stage || run.runId <= state.stageEntryEventId) {
    return err(
      "NO_CONTINUABLE_RUN",
      `продолжать нечего: на текущем входе в этап агент ${stage.agent} ещё не запускался` +
        (run && run.agentId !== stage.agent ? ` (последний run — агента ${run.agentId})` : "") +
        ". Используй restart_current_agent.",
    );
  }
  return null;
}

async function checkRefs(refs: readonly string[], r: ValidatorResolvers, errors: DecisionError[]): Promise<TaskEvent[]> {
  const humanEvents: TaskEvent[] = [];
  for (const ref of refs) {
    const res = await resolveEvidenceRef(ref, r.evidence);
    if (!res.ok) errors.push(err("EVIDENCE_UNRESOLVED", res.message));
    else if (res.ref.scheme === "human" && res.event) humanEvents.push(res.event);
  }
  return humanEvents;
}

export async function validateDecision<A extends ControlAction>(
  action: A,
  raw: unknown,
  state: TaskState,
  spec: PolicySpec,
  limits: { maxConsecutiveRestarts: number },
  r: ValidatorResolvers,
): Promise<ValidationResult<A>> {
  const parsed = (controlSchemas[action] as z.ZodType).safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => err("INVALID_INPUT", `${i.path.join(".") || "параметры"}: ${i.message}`)),
    };
  }
  const input = parsed.data as ControlInputs[A];
  const errors: DecisionError[] = [];
  if (input.expectedStateVersion !== state.version) {
    errors.push(err("STALE_STATE_VERSION", `expectedStateVersion ${input.expectedStateVersion} устарел: текущая версия ${state.version}`));
  }
  if (state.pendingDecision) errors.push(err("DECISION_PENDING", `решение ${state.pendingDecision.decisionId} ещё не применено`));
  const stage = getStage(spec, state.stage);
  if (!stage || stage.kind !== "work") {
    errors.push(err("UNKNOWN_STAGE", `текущий этап ${state.stage} отсутствует в Policy или терминальный`));
    return { ok: false, errors };
  }
  const attachments: Array<{ path: string; sha256: string }> = [];

  switch (action) {
    case "transition_stage": {
      const i = input as ControlInputs["transition_stage"];
      const target = getStage(spec, i.to);
      const transition = stage.transitions.find((t) => t.to === i.to);
      if (!target) {
        errors.push(err("UNKNOWN_STAGE", `этапа ${i.to} нет в Policy. Допустимые переходы: ${stage.transitions.map((t) => t.to).join(", ")}`));
      } else if (!transition) {
        errors.push(err("TRANSITION_NOT_DECLARED", `переход ${state.stage} → ${i.to} не объявлен. Допустимые: ${stage.transitions.map((t) => t.to).join(", ")}`));
      }
      const refs = i.evidenceRefs ?? [];
      const humans = await checkRefs(refs, r, errors);
      if (transition?.guards.evidence === "required" && refs.length === 0) {
        errors.push(err("GUARD_EVIDENCE_REQUIRED", `переход в ${i.to} требует evidenceRefs: ссылок на проверенные факты`));
      }
      if (transition?.guards.humanResponse === "required" && !humans.some((e) => e.id > state.stageEntryEventId)) {
        errors.push(
          err(
            "GUARD_HUMAN_RESPONSE_REQUIRED",
            `переход в ${i.to} требует ссылку human:<eventId> на ответ пользователя, полученный на текущем входе в этап. Если ответа нет — спроси через ask_human`,
          ),
        );
      }
      break;
    }
    case "continue_current_agent": {
      const problem = continuableRun(state, stage);
      if (problem) errors.push(problem);
      else if (state.currentRun && !(await r.sessionExists(state.currentRun.sessionFile))) {
        errors.push(err("SESSION_MISSING", `файл сессии ${state.currentRun.sessionFile} не найден. Используй restart_current_agent`));
      }
      break;
    }
    case "restart_current_agent":
      if (state.consecutiveRestarts >= limits.maxConsecutiveRestarts) {
        errors.push(
          err("RESTART_LIMIT_REACHED", `исчерпан лимит перезапусков подряд (${limits.maxConsecutiveRestarts}). Выбери ask_human или block_task`),
        );
      }
      break;
    case "ask_human": {
      const i = input as ControlInputs["ask_human"];
      if (i.options && (i.options.length < 2 || i.options.length > 10)) errors.push(err("INVALID_INPUT", "options: от 2 до 10 вариантов"));
      for (const p of i.attachments ?? []) {
        const a = await r.attachment(p);
        if (!a) errors.push(err("ATTACHMENT_INVALID", `вложение ${p}: нет такого файла внутри проекта или каталога задачи`));
        else attachments.push(a);
      }
      break;
    }
    case "schedule_recheck": {
      const i = input as ControlInputs["schedule_recheck"];
      const rc = stage.recheck;
      if (!rc) {
        errors.push(err("RECHECK_NOT_ALLOWED", `на этапе ${stage.id} отложенная перепроверка не разрешена Policy`));
      } else {
        if (i.delayMinutes < rc.minMinutes || i.delayMinutes > rc.maxMinutes) {
          errors.push(err("RECHECK_DELAY_OUT_OF_RANGE", `delayMinutes ${i.delayMinutes} вне диапазона ${rc.minMinutes}..${rc.maxMinutes}`));
        }
        if (state.stageRechecks.count >= rc.maxCount) {
          errors.push(err("RECHECK_LIMIT_REACHED", `использованы все ${rc.maxCount} перепроверок этапа. Выбери ask_human или block_task`));
        }
      }
      const problem = continuableRun(state, stage);
      if (problem) errors.push(problem);
      else if (state.currentRun && !(await r.sessionExists(state.currentRun.sessionFile))) {
        errors.push(err("SESSION_MISSING", `файл сессии ${state.currentRun.sessionFile} не найден`));
      }
      await checkRefs(i.evidenceRefs ?? [], r, errors);
      break;
    }
    case "block_task":
      break;
    case "cancel_task": {
      const i = input as ControlInputs["cancel_task"];
      const id = /^human:(.+)$/.exec(i.humanResponseRef)?.[1];
      const latest = (await r.events()).filter((e) => e.type === "human.responded").at(-1);
      if (!id || !latest || latest.id !== id || latest.id <= state.stageEntryEventId) {
        errors.push(
          err(
            "CANCEL_NOT_CONFIRMED_BY_HUMAN",
            "отмена возможна только по свежему явному решению пользователя: humanResponseRef должен ссылаться на последний human.responded текущего входа в этап. Спроси через ask_human",
          ),
        );
      }
      break;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, input, attachments };
}
