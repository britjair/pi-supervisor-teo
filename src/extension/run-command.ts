// Команды CLI внутри расширения Pi: тот же код, что у `teo`, без терминала.
// Вывод собирается в строку и показывается средствами Pi (ctx.ui), а не печатается в stdout.

import { PassThrough, Writable } from "node:stream";
import { createAppContext, type AppContext } from "../app.js";
import { TeoError } from "../errors/errors.js";
import { renderError } from "../ui/plain/errors.js";

export type CommandResult = { ok: boolean; text: string };

class Capture extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _enc: BufferEncoding, done: (err?: Error | null) => void): void {
    this.text += chunk.toString();
    done();
  }
}

/** Выполнить команду CLI в каталоге сессии Pi. Без TTY: команды, которым нужен человек, требуют флагов. */
export async function runCaptured(cwd: string, fn: (ctx: AppContext) => Promise<number>): Promise<CommandResult> {
  const stdout = new Capture();
  const stderr = new Capture();
  const ctx = createAppContext({ cwd, stdin: new PassThrough(), stdout, stderr, color: false, plain: true, verbose: false });
  try {
    const code = await fn(ctx);
    return { ok: code === 0, text: (stdout.text + stderr.text).trimEnd() };
  } catch (err) {
    if (!(err instanceof TeoError)) ctx.debugLog.write(`непредвиденная ошибка расширения: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    const text = renderError(err, { homeDir: ctx.homeDir, style: ctx.style, now: ctx.clock.now(), verbose: false, debugLogPath: ctx.debugLog.path });
    return { ok: false, text: (stdout.text + text).trimEnd() };
  }
}
