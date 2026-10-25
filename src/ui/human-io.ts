// Диалог с человеком, независимый от способа отображения (06-implementation.md §2.1).
// Реализации: plain (readline, этот этап), Ink (M5), ScriptedHumanIO в тестах.

export type Choice<T> = {
  label: string;
  value: T;
  /** Дополнительная клавиша выбора, например «q» для выхода */
  key?: string;
};

export type Validate = (value: string) => string | null;

export interface HumanIO {
  /** Выбор одного варианта. */
  select<T>(title: string, choices: ReadonlyArray<Choice<T>>): Promise<T>;
  /** Однострочный ввод. `validate` возвращает текст ошибки — тогда вопрос задаётся снова. */
  input(label: string, opts?: { initial?: string; validate?: Validate }): Promise<string>;
  /** Многострочный ввод. */
  multiline(label: string, opts?: { validate?: Validate }): Promise<string>;
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  /** Вывести текст (с переводом строки в конце). */
  print(text: string): void;
  close(): void;
}
