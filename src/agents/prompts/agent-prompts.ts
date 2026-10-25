// Промпты дочернего агента, 04-agents.md §7.1–7.3. Только подстановки из Policy и state:
// ни имён этапов, ни ролей, ни правил процесса.

import type { AgentDef, PolicySpec, WorkStage } from "../../domain/policy.js";
import { getStage } from "../../domain/policy.js";
import type { AgentInputKind, SettleReason } from "../../domain/task-state.js";
import { promptMarker } from "../runtime.js";

export function agentSystemPrompt(taskDirDisplay: string): string {
  return `Ты дочерний агент в SDLC-процессе, которым управляет CLI \`sdlc\`.

- Ты выполняешь только текущий этап. Менять этап ты не можешь: отдельный supervisor оценивает
  твою работу по условиям выхода из этапа и решает, что делать дальше.
- Твой отчёт — заявление, а не доказательство. Supervisor проверит состояние git, файлы и твой
  транскрипт. Сообщай только о том, что действительно сделал и проверил.
- Завершай каждый ход вызовом ровно одного из инструментов: report_result (работа этапа сделана
  или сделана настолько, насколько возможно) или report_blocker (продолжить невозможно).
  Не завершай ход обычным текстом.
- Спрашивай пользователя через ask_user, когда решение действительно за ним. Не проси пользователя
  делать работу, которую можешь сделать сам.
- Документы задачи лежат в ${taskDirDisplay}. Внутри .sdlc писать можно только в ${taskDirDisplay}/artifacts/.
- Строки, начинающиеся с "[sdlc:prompt", — служебные маркеры. Не обращай на них внимания.`;
}

export type PreviousResult = {
  agentId: string;
  attempt: number;
  stageTitle: string;
  settleReason: SettleReason | null;
  summary: string;
  artifacts: string[];
};

export type ArtifactInfo = { path: string; size: number; mtime: string };

export type InitialPromptData = {
  promptId: string;
  runId: string;
  kind: "initial" | "restart";
  task: { key: string; title: string; description: string };
  spec: PolicySpec;
  stage: WorkStage;
  agent: AgentDef;
  handoff: string | null;
  previousResults: PreviousResult[];
  artifacts: ArtifactInfo[];
  taskDirDisplay: string;
  restart?: { previousRunId: string; reason: string; message: string };
};

function transitionsBlock(spec: PolicySpec, stage: WorkStage): string {
  return stage.transitions
    .map((t) => {
      const title = getStage(spec, t.to)?.title ?? t.to;
      const marks = [
        t.guards.evidence === "required" ? "[нужны доказательства]" : null,
        t.guards.humanResponse === "required" ? "[нужен явный ответ пользователя]" : null,
      ].filter(Boolean);
      return `- → ${title}: ${t.when.trim()}${marks.length ? `   ${marks.join(" ")}` : ""}`;
    })
    .join("\n");
}

function previousBlock(items: readonly PreviousResult[]): string {
  if (items.length === 0) return "Нет.";
  return items
    .map((r) => {
      const head = `- ${r.agentId}, попытка ${String(r.attempt).padStart(3, "0")}, этап «${r.stageTitle}», ${r.settleReason ?? "не завершён"}: ${r.summary}`;
      return r.artifacts.length ? `${head}\n  артефакты: ${r.artifacts.join(", ")}` : head;
    })
    .join("\n");
}

function artifactsBlock(items: readonly ArtifactInfo[]): string {
  if (items.length === 0) return "Пусто.";
  return items.map((a) => `- ${a.path} (${a.size} байт, изменён ${a.mtime})`).join("\n");
}

export function initialPrompt(d: InitialPromptData): string {
  const parts = [
    promptMarker({ id: d.promptId, kind: d.kind, run: d.runId }),
    "",
    `# Задача ${d.task.key}: ${d.task.title}`,
    "",
    d.task.description.trim(),
    "",
    `# Текущий этап: ${d.stage.title} (${d.stage.id})`,
    ...[d.stage.description, d.stage.instructions].filter((x): x is string => !!x).map((x) => x.trim()),
    "",
    `# Твоя роль: ${d.agent.title}`,
    d.agent.instructions.trim(),
    "",
    "# Как оценивается этап",
    "Supervisor продвинет задачу, только когда одно из условий выполнено и подтверждено:",
    transitionsBlock(d.spec, d.stage),
    "",
    "# Передача от supervisor",
    d.handoff?.trim() || "Нет.",
  ];
  if (d.restart) {
    parts.push(
      "",
      "# Почему это новый запуск",
      `Предыдущую попытку (${d.restart.previousRunId}) supervisor остановил: ${d.restart.reason}`,
      `Указания supervisor: ${d.restart.message}`,
      "Прежде чем действовать, проверь фактическое состояние репозитория: прошлые попытки могли",
      "оставить незавершённые изменения.",
    );
  }
  if (d.stage.recheck) {
    parts.push(
      "",
      "# Ожидание внешних событий",
      "Если этап зависит от внешнего процесса, который ещё не завершился (ответ, pipeline, сборка),",
      "не жди его в цикле и не засыпай дольше чем на несколько минут. Сообщи текущее состояние через",
      "report_result и заполни externalWait. Supervisor может запланировать перепроверку, и тебя",
      "продолжат в этой же сессии.",
    );
  }
  parts.push(
    "",
    "# Предыдущие результаты агентов по задаче (сначала новые, до 5)",
    previousBlock(d.previousResults),
    "",
    `# Артефакты задачи (${d.taskDirDisplay}/artifacts)`,
    artifactsBlock(d.artifacts),
    "",
    "Когда закончишь, вызови report_result. Если продолжить невозможно, вызови report_blocker.",
  );
  return parts.join("\n");
}

export function continuePrompt(d: {
  promptId: string;
  runId: string;
  kind: Extract<AgentInputKind, "continue" | "recovery">;
  stageTitle: string;
  message: string;
}): string {
  const head =
    d.kind === "continue"
      ? ["Supervisor проверил твой предыдущий отчёт и пока не продвигает задачу.", "", "Сообщение supervisor:", d.message.trim()]
      : ["Сообщение CLI:", d.message.trim()];
  return [
    promptMarker({ id: d.promptId, kind: d.kind, run: d.runId }),
    "",
    ...head,
    "",
    `Продолжай текущий этап «${d.stageTitle}». Когда закончишь, снова вызови report_result.`,
  ].join("\n");
}

export function recheckPrompt(d: {
  promptId: string;
  runId: string;
  stageTitle: string;
  number: number;
  maxCount: number;
  minutesSinceReport: number | null;
  waitingFor: string;
  message: string;
}): string {
  const since = d.minutesSinceReport === null ? "" : ` Твой последний отчёт был ${d.minutesSinceReport} мин назад.`;
  return [
    promptMarker({ id: d.promptId, kind: "recheck", run: d.runId }),
    "",
    `Перепроверка №${d.number} из ${d.maxCount} на этапе «${d.stageTitle}».${since}`,
    `Ожидается: ${d.waitingFor}`,
    "",
    "Сообщение supervisor:",
    d.message.trim(),
    "",
    "Проверь текущее состояние внешнего процесса. Если он ещё не завершился, снова вызови",
    "report_result с externalWait. Когда закончишь, вызови report_result.",
  ].join("\n");
}

/** Служебные тексты CLI для kind = recovery. */
export const recoveryMessages = {
  providerError: "Предыдущий запрос завершился ошибкой провайдера. Проверь, что уже сделано, и продолжай.",
  questionInterrupted: (answer: string) => `Ваш вопрос был прерван рестартом. Ответ пользователя: ${answer}`,
};
