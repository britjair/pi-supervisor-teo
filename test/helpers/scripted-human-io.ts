// HumanIO для тестов: очередь ожидаемых вопросов и ответов. Неожиданный вопрос — ошибка теста.

import type { Choice, HumanIO, Validate } from "../../src/ui/human-io.js";

export type Step =
  /** Выбрать вариант, label которого содержит строку */
  | { select: string }
  | { input: string }
  | { multiline: string }
  | { confirm: boolean };

export class ScriptedHumanIO implements HumanIO {
  readonly output: string[] = [];
  /** Тексты ошибок валидации, показанные пользователю */
  readonly rejected: string[] = [];
  private readonly steps: Step[];

  constructor(steps: Step[]) {
    this.steps = [...steps];
  }

  get printed(): string {
    return this.output.join("\n");
  }

  get remaining(): number {
    return this.steps.length;
  }

  private next(kind: string, question: string): Step {
    const step = this.steps.shift();
    if (!step) throw new Error(`Неожиданный вопрос (${kind}): ${question}\n--- вывод ---\n${this.printed}`);
    if (!(kind in step)) throw new Error(`Ожидался шаг ${JSON.stringify(step)}, а задан вопрос ${kind}: ${question}`);
    return step;
  }

  async select<T>(title: string, choices: ReadonlyArray<Choice<T>>): Promise<T> {
    this.output.push(title, ...choices.map((c) => `  - ${c.label}`));
    const step = this.next("select", title) as { select: string };
    const found = choices.find((c) => c.label.includes(step.select));
    if (!found) throw new Error(`Нет варианта «${step.select}» в «${title}»: ${choices.map((c) => c.label).join(" | ")}`);
    return found.value;
  }

  private answer(value: string, validate: Validate | undefined, label: string): string {
    const problem = validate?.(value) ?? null;
    if (problem) {
      this.rejected.push(problem);
      throw new Error(`Ответ «${value}» на «${label}» отклонён: ${problem}`);
    }
    return value;
  }

  async input(label: string, opts: { initial?: string; validate?: Validate } = {}): Promise<string> {
    this.output.push(`${label}:`);
    const step = this.next("input", label) as { input: string };
    const value = step.input === "" && opts.initial !== undefined ? opts.initial : step.input;
    return this.answer(value, opts.validate, label);
  }

  async multiline(label: string, opts: { validate?: Validate } = {}): Promise<string> {
    this.output.push(`${label}:`);
    const step = this.next("multiline", label) as { multiline: string };
    return this.answer(step.multiline.trim(), opts.validate, label);
  }

  async confirm(question: string): Promise<boolean> {
    this.output.push(question);
    return (this.next("confirm", question) as { confirm: boolean }).confirm;
  }

  print(text: string): void {
    this.output.push(text);
  }

  close(): void {}
}
