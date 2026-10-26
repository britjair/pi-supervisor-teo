// .teo/debug.log (02-storage.md §1): debug-лог последнего процесса, ротация — 1 файл, ≤ 5 MB.
// Каталог .teo лог не создаёт: строки копятся в памяти, пока его не создаст mutating-команда.

import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { redactString } from "./redact.js";

export const DEBUG_LOG_MAX_BYTES = 5 * 1024 * 1024;
const BUFFER_LINES = 500;

export class DebugLog {
  private file: string | null = null;
  private buffer: string[] = [];
  private rotated = false;

  constructor(private readonly now: () => Date) {}

  /** Файл лога проекта. Пишется, только когда каталог .teo существует. */
  attach(file: string): void {
    this.file = file;
    this.flush();
  }

  /** Путь, если лог уже пишется на диск. */
  get path(): string | null {
    return this.file && existsSync(path.dirname(this.file)) ? this.file : null;
  }

  write(message: string): void {
    const line = `${this.now().toISOString()} [${process.pid}] ${redactString(message)}`;
    this.buffer.push(line);
    if (this.buffer.length > BUFFER_LINES) this.buffer.shift();
    this.flush();
  }

  private flush(): void {
    const file = this.path;
    if (!file || this.buffer.length === 0) return;
    try {
      this.rotate(file);
      appendFileSync(file, this.buffer.join("\n") + "\n", { mode: 0o600 });
      this.buffer = [];
    } catch {
      // Отладочный лог не должен ломать команду
    }
  }

  private rotate(file: string): void {
    const size = (() => {
      try {
        return statSync(file).size;
      } catch {
        return 0;
      }
    })();
    // Новый процесс начинает свой лог; прошлый остаётся одной копией (.1). Внутри процесса — по размеру.
    if (!this.rotated || size > DEBUG_LOG_MAX_BYTES) {
      if (size > 0) renameSync(file, `${file}.1`);
      this.rotated = true;
    }
  }
}
