// HumanIO для линейного интерфейса: нумерованные варианты и ввод строк через readline.

import type { Readable, Writable } from "node:stream";
import { UserAbortError } from "../../errors/errors.js";
import type { Choice, HumanIO, Validate } from "../human-io.js";
import { msg } from "../messages.js";
import { LineReader, type LineResult } from "./line-reader.js";
import type { Style } from "./style.js";

export class PlainHumanIO implements HumanIO {
  private readonly reader: LineReader;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly style: Style,
    terminal: boolean,
  ) {
    this.reader = new LineReader(input, output, terminal);
  }

  private async line(prompt: string): Promise<string> {
    const r: LineResult = await this.reader.read(prompt);
    if (r.kind === "line") return r.text;
    throw new UserAbortError(r.kind === "sigint" ? msg.input.interrupted : msg.input.closed);
  }

  print(text: string): void {
    this.output.write(text.endsWith("\n") ? text : text + "\n");
  }

  async select<T>(title: string, choices: ReadonlyArray<Choice<T>>): Promise<T> {
    const width = String(choices.length).length;
    const lines = [title, ""];
    choices.forEach((c, i) => {
      const extra = c.key ? this.style.dim(` [${c.key}]`) : "";
      lines.push(`  ${String(i + 1).padStart(width)}) ${c.label}${extra}`);
    });
    this.print(lines.join("\n"));
    for (;;) {
      const answer = (await this.line(msg.input.choicePrompt(choices.length))).trim();
      const byKey = choices.find((c) => c.key !== undefined && c.key.toLowerCase() === answer.toLowerCase());
      if (byKey) return byKey.value;
      const n = Number(answer);
      const chosen = Number.isInteger(n) ? choices[n - 1] : undefined;
      if (chosen) return chosen.value;
      this.print(this.style.yellow(msg.input.badChoice(choices.length)));
    }
  }

  async input(label: string, opts: { initial?: string; validate?: Validate } = {}): Promise<string> {
    const hint = opts.initial ? this.style.dim(` [${opts.initial}]`) : "";
    for (;;) {
      const raw = (await this.line(`${label}${hint}: `)).trim();
      const value = raw === "" && opts.initial !== undefined ? opts.initial : raw;
      const problem = opts.validate?.(value) ?? null;
      if (!problem) return value;
      this.print(this.style.yellow(`  ${problem}`));
    }
  }

  async multiline(label: string, opts: { validate?: Validate } = {}): Promise<string> {
    for (;;) {
      this.print(`${label} ${this.style.dim(msg.input.multilineHint)}`);
      const lines: string[] = [];
      for (;;) {
        const r = await this.reader.read("> ");
        if (r.kind === "sigint") throw new UserAbortError(msg.input.interrupted);
        if (r.kind === "eof") break;
        // Пустая строка после текста завершает ввод (03-engine.md §6.3)
        if (r.text.trim() === "" && lines.some((l) => l.trim() !== "")) break;
        lines.push(r.text);
      }
      const value = lines.join("\n").trim();
      const problem = opts.validate?.(value) ?? null;
      if (!problem) return value;
      this.print(this.style.yellow(`  ${problem}`));
    }
  }

  async confirm(question: string, defaultValue: boolean): Promise<boolean> {
    for (;;) {
      const answer = (await this.line(`${question} ${msg.input.yesNo(defaultValue)} `)).trim().toLowerCase();
      if (answer === "") return defaultValue;
      if (["y", "yes", "д", "да"].includes(answer)) return true;
      if (["n", "no", "н", "нет"].includes(answer)) return false;
      this.print(this.style.yellow(msg.input.badYesNo));
    }
  }

  close(): void {
    this.reader.close();
  }
}
