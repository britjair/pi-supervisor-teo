// Построчное чтение для линейного интерфейса.
// В терминале readline работает в raw-режиме: Ctrl+D закрывает только текущий readline-интерфейс,
// поэтому для следующего вопроса создаётся новый. Ctrl+C приходит событием SIGINT.

import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export type LineResult = { kind: "line"; text: string } | { kind: "eof" } | { kind: "sigint" };

export class LineReader {
  private rl: Interface | null = null;
  private readonly queue: LineResult[] = [];
  private waiter: ((r: LineResult) => void) | null = null;
  private ended = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly terminal: boolean,
  ) {}

  private push(r: LineResult): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(r);
    } else {
      this.queue.push(r);
    }
  }

  private ensure(): Interface | null {
    if (this.rl || this.ended) return this.rl;
    const rl = createInterface({ input: this.input, output: this.output, terminal: this.terminal });
    let interrupted = false;
    rl.on("line", (text) => this.push({ kind: "line", text }));
    rl.on("SIGINT", () => {
      interrupted = true;
      this.output.write("\n");
      this.push({ kind: "sigint" });
      rl.close();
    });
    rl.on("close", () => {
      if (this.rl === rl) this.rl = null;
      // Без терминала close означает конец входного потока
      if (!this.terminal) this.ended = true;
      if (!interrupted) this.push({ kind: "eof" });
    });
    this.rl = rl;
    return rl;
  }

  read(prompt: string): Promise<LineResult> {
    const queued = this.queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    const rl = this.ensure();
    if (!rl) return Promise.resolve({ kind: "eof" });
    rl.setPrompt(prompt);
    rl.prompt();
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  close(): void {
    this.ended = true;
    this.rl?.close();
    this.rl = null;
  }
}
