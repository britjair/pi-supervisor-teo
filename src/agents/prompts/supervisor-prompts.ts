// Промпты supervisor-а, 04-agents.md §7.4–7.5. Структура этапов и переходов — только из Policy.

import type { AgentReport } from "../../domain/runs.js";
import type { PolicySpec, WorkStage } from "../../domain/policy.js";
import { getStage } from "../../domain/policy.js";
import { CONTROL_ACTIONS } from "../../domain/decisions.js";
import type { SettleReason } from "../../domain/task-state.js";
import { promptMarker } from "../runtime.js";

export function supervisorSystemPrompt(d: { instructions: string; body: string }): string {
  return `Ты supervisor процесса, которым управляет CLI \`teo\`. Политика процесса ниже — единственный
источник правды об этапах, переходах и правилах.

- Отчёты дочерних агентов — заявления. Прежде чем на них опираться, проверь их инструментами
  инспекции. Текстовый отчёт сам по себе никогда не доказывает коммит, прохождение тестов,
  выкладку или согласие пользователя.
- Ты ничего не запускаешь сам. Если для проверки нужен запуск (тесты, сборка, запрос к внешней
  системе), поручи его агенту этапа через continue_current_agent и проверь результат по его
  транскрипту (read_agent_transcript).
- Согласие и ответы пользователя подтверждаются только событиями human.responded
  (ссылки human:<eventId>).
- Каждый цикл оценки завершается ровно одним вызовом управляющего инструмента:
  ${CONTROL_ACTIONS.join(", ")}.
- Если этап ждёт внешнего события, которое ещё не произошло, используй schedule_recheck, а не проси
  пользователя следить за ним. Он доступен только на этапах, где в промпте цикла указан бюджет
  перепроверок.
- Возможны только переходы, перечисленные в промпте цикла. Используй указанный там
  expectedStateVersion.
- Конкретная обратная связь через continue_current_agent предпочтительнее перезапуска.
- Строки, начинающиеся с "[teo:prompt", — служебные маркеры. Не обращай на них внимания.

## Инструкции политики
${d.instructions.trim()}

## Правила политики (Markdown-часть SDLC.md)
${d.body.trim() || "Нет."}`;
}

export type TriggerData =
  | {
      kind: "agent_settled" | "recheck_settled";
      agentId: string;
      attempt: number;
      runId: string;
      settleReason: SettleReason | null;
      report: AgentReport | null;
      lastAssistantText: string | null;
      error: string | null;
      recheck?: { number: number; waitedMinutes: number; waitingFor: string };
    }
  | { kind: "human_responded"; requestId: string | null; question: string | null; answer: string; eventId: string }
  | { kind: "unblocked"; note: string; eventId: string }
  | { kind: "recovered"; agentId: string | null; runId: string | null; danglingTools: string[]; lastEntry: string }
  | { kind: "policy_changed"; fromHash: string | null }
  | { kind: "reevaluate" }
  | { kind: "none" };

export type EvaluationPromptData = {
  promptId: string;
  cycle: number;
  key: string;
  title: string;
  version: number;
  now: Date;
  policyHash: string;
  policyRaw: string | null;
  spec: PolicySpec;
  stage: WorkStage;
  stageEnteredAt: string;
  stageCycles: number;
  consecutiveRestarts: number;
  maxRestarts: number;
  rechecks: { count: number; waitedMinutes: number } | null;
  trigger: TriggerData;
  recentEvents: string[];
};

const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const pad = (n: number) => String(n).padStart(2, "0");

/** 2026-10-25 13:05 (UTC+03:00), суббота — локальное время процесса. */
export function localNow(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}), ${WEEKDAYS[d.getDay()]}`;
}

export function renderReport(report: AgentReport | null, lastText: string | null): string {
  if (!report) return `Структурированного отчёта нет. Последний текст ассистента: ${lastText?.trim() ? lastText.trim() : "(пусто)"}`;
  const lines: string[] = [];
  if (report.kind === "result") {
    const r = report.data;
    lines.push(`Итог: ${r.summary}`);
    if (r.evidence?.length) lines.push("Доказательства:", ...r.evidence.map((e) => `- ${e.kind}: ${e.value}${e.description ? ` — ${e.description}` : ""}`));
    if (r.artifacts?.length) lines.push("Артефакты:", ...r.artifacts.map((a) => `- ${a.kind}: ${a.pathOrUrl}${a.description ? ` — ${a.description}` : ""}`));
    if (r.notes?.length) lines.push("Заметки:", ...r.notes.map((n) => `- ${n}`));
    if (r.externalWait) {
      lines.push(
        `Ожидание внешнего события: ${r.externalWait.waitingFor}${r.externalWait.checkAgainInMinutes ? ` (агент предлагает проверить через ${r.externalWait.checkAgainInMinutes} мин)` : ""}`,
      );
    }
  } else {
    const b = report.data;
    lines.push(`Блокер: ${b.summary}`, `Подробности: ${b.details}`, `Нужен человек: ${b.requiresHuman ? "да" : "нет"}`);
    if (b.suggestedQuestion) lines.push(`Предлагаемый вопрос: ${b.suggestedQuestion}`);
  }
  return lines.join("\n");
}

function triggerBlock(t: TriggerData): string[] {
  switch (t.kind) {
    case "agent_settled":
    case "recheck_settled": {
      const head =
        t.kind === "recheck_settled" && t.recheck
          ? `Агент ${t.agentId} выполнил перепроверку после ожидания ${t.recheck.waitedMinutes} мин (перепроверка №${t.recheck.number}). Ожидается: ${t.recheck.waitingFor}`
          : `Агент ${t.agentId} (попытка ${String(t.attempt).padStart(3, "0")}, run ${t.runId}) завершил работу: ${t.settleReason ?? "?"}.`;
      return [
        head,
        ...(t.error ? [`Ошибка: ${t.error}`] : []),
        "## Отчёт агента (заявление, не доказательство)",
        renderReport(t.report, t.lastAssistantText),
      ];
    }
    case "human_responded":
      return t.requestId
        ? [`Пользователь ответил на вопрос ${t.requestId}: «${t.question ?? ""}»`, `Ответ: ${t.answer}  (ссылка human:${t.eventId})`]
        : [`Пользователь написал сообщение: ${t.answer}  (ссылка human:${t.eventId})`];
    case "unblocked":
      return [`Пользователь разблокировал задачу. Комментарий: ${t.note}  (ссылка human:${t.eventId})`];
    case "recovered":
      return [
        `Процесс CLI остановился посреди хода агента${t.agentId ? ` ${t.agentId}` : ""}${t.runId ? ` (run ${t.runId})` : ""}.`,
        t.danglingTools.length
          ? `Незавершённый вызов инструмента: ${t.danglingTools.join("; ")}.`
          : `Последняя запись сессии: ${t.lastEntry}.`,
        "Внешние побочные эффекты могли произойти, а могли и нет. Прежде чем решать, проверь фактическое состояние.",
      ];
    case "policy_changed":
      return [`Политика изменилась${t.fromHash ? ` (была ${t.fromHash})` : ""}. Проверь, как это влияет на текущий этап.`];
    case "reevaluate":
      return ["Предыдущий цикл оценки был прерван остановкой CLI. Оцени состояние заново."];
    case "none":
      return ["Оцени текущее состояние задачи."];
  }
}

export function evaluationPrompt(d: EvaluationPromptData): string {
  const changed = d.policyRaw !== null;
  const lines = [
    promptMarker({ id: d.promptId, kind: "evaluate", cycle: d.cycle }),
    "",
    `# Цикл ${d.cycle} · задача ${d.key}: ${d.title}`,
    `expectedStateVersion: ${d.version}`,
    `Сейчас: ${localNow(d.now)}`,
    `Политика: ${d.policyHash} ${changed ? "(изменилась с прошлого цикла — полный текст ниже)" : "(без изменений, см. read_policy)"}`,
    "",
    `# Текущий этап: ${d.stage.title} (${d.stage.id})`,
    `Вход в этап: ${d.stageEnteredAt}; циклов на этапе: ${d.stageCycles}; перезапусков подряд: ${d.consecutiveRestarts}/${d.maxRestarts}`,
    d.stage.recheck && d.rechecks
      ? `Перепроверки: использовано ${d.rechecks.count} из ${d.stage.recheck.maxCount}, всего ждали ${d.rechecks.waitedMinutes} мин; допустимая задержка ${d.stage.recheck.minMinutes}..${d.stage.recheck.maxMinutes} мин`
      : "Перепроверки на этом этапе недоступны",
    ...(d.stage.instructions ? [d.stage.instructions.trim()] : []),
    "",
    "# Допустимые переходы",
    ...d.stage.transitions.flatMap((t, i) => {
      const target = getStage(d.spec, t.to);
      return [
        `${i + 1}. → ${t.to} «${target?.title ?? t.to}»${target?.kind === "terminal" ? " [терминальный]" : ""}`,
        `   условие: ${t.when.trim()}`,
        `   guards: доказательства ${t.guards.evidence === "required" ? "обязательны" : "необязательны"}, ответ пользователя ${t.guards.humanResponse === "required" ? "обязателен" : "необязателен"}`,
      ];
    }),
    "",
    `# Причина цикла: ${d.trigger.kind}`,
    ...triggerBlock(d.trigger),
    "",
    "# Последние события",
    ...(d.recentEvents.length ? d.recentEvents : ["Нет."]),
  ];
  if (changed) lines.push("", "# Полный текст политики (SDLC.md)", d.policyRaw ?? "");
  lines.push("", "Проверь факты и заверши цикл ровно одним вызовом управляющего инструмента.");
  return lines.join("\n");
}

export function protocolRetryPrompt(d: { promptId: string; cycle: number; version: number }): string {
  return [
    promptMarker({ id: d.promptId, kind: "protocol_retry", cycle: d.cycle }),
    "Ты завершил ход без вызова управляющего инструмента. Цикл должен завершиться ровно одним из:",
    `${CONTROL_ACTIONS.join(", ")}. Текущий expectedStateVersion: ${d.version}.`,
  ].join("\n");
}

export function providerRetryPrompt(d: { promptId: string; cycle: number; version: number }): string {
  return [
    promptMarker({ id: d.promptId, kind: "provider_retry", cycle: d.cycle }),
    "Предыдущий запрос завершился ошибкой провайдера. Продолжи оценку.",
    `Текущий expectedStateVersion: ${d.version}.`,
  ].join("\n");
}
