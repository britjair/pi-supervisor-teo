// Вопрос человеку (03-engine.md §6.3). Ответ попадает в журнал как доказательство,
// поэтому свободный ответ подтверждается перед отправкой.

import type { HumanAnswer, HumanIO, QuestionView } from "../human-io.js";
import type { Style } from "./style.js";

const FREE_TEXT = "\u0000free-text";

export function renderQuestion(q: QuestionView, style: Style): string {
  const body = [q.question.trim()];
  if (q.context?.trim()) body.push("", `Контекст: ${q.context.trim()}`);
  if (q.attachments.length) {
    body.push("", "Вложения:", ...q.attachments.map((a) => `  ${a.path} (sha256:${a.sha256.slice(0, 8)}…)`));
  }
  const width = Math.min(100, Math.max(q.header.length + 4, ...body.map((l) => [...l].length + 4)));
  const top = `╭─ ${q.header} ${"─".repeat(Math.max(0, width - [...q.header].length - 4))}╮`;
  const lines = body.map((l) => `│ ${l}`);
  return [style.bold(top), ...lines, `╰${"─".repeat(width - 1)}╯`].join("\n");
}

export async function askQuestion(human: HumanIO, q: QuestionView, style: Style): Promise<HumanAnswer> {
  human.print("\n" + renderQuestion(q, style));
  human.print(style.dim("Ответ сохраняется в журнал задачи дословно."));
  for (;;) {
    let choice: string = FREE_TEXT;
    if (q.options?.length) {
      choice = await human.select<string>("Ваш ответ:", [
        ...q.options.map((o) => ({ label: o, value: o })),
        ...(q.allowFreeText ? [{ label: "Свой ответ…", value: FREE_TEXT }] : []),
      ]);
    }
    if (choice !== FREE_TEXT) return { answer: choice, selectedOption: choice };
    const text = await human.multiline("Ответ", { validate: (v) => (v ? null : "Ответ не может быть пустым.") });
    human.print(style.dim("─".repeat(20)) + "\n" + text + "\n" + style.dim("─".repeat(20)));
    if (await human.confirm("Отправить ответ?", true)) return { answer: text, selectedOption: null };
  }
}
