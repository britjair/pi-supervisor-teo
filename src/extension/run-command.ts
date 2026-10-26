// Команды CLI внутри расширения Pi: тот же код, что у `teo`, без терминала.
// Вывод собирается в строку и показывается средствами Pi (ctx.ui), а не печатается в stdout.

import { PassThrough, Writable } from "node:stream";
import { createAppContext, type AppContext } from "../app.js";
import { TeoError } from "../errors/errors.js";
import { renderError } from "../ui/plain/errors.js";

export type CommandResult = { ok: boolean; text: string };

export class Capture extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _enc: BufferEncoding, done: (err?: Error | null) => void): void {
    this.text += chunk.toString();
    done();
  }
}

/** Контекст команд в каталоге сессии Pi: без терминала, вывод — в память. */
export function extensionAppContext(cwd: string, homeDir?: string): { ctx: AppContext; stdout: Capture; stderr: Capture } {
  const stdout = new Capture();
  const stderr = new Capture();
  const ctx = createAppContext({ cwd, ...(homeDir ? { homeDir } : {}), stdin: new PassThrough(), stdout, stderr, color: false, plain: true, verbose: false });
  return { ctx, stdout, stderr };
}

/** Текст ошибки команды для показа в Pi. */
export function errorText(ctx: AppContext, err: unknown): string {
  if (!(err instanceof TeoError)) ctx.debugLog.write(`непредвиденная ошибка расширения: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  return renderError(err, { homeDir: ctx.homeDir, style: ctx.style, now: ctx.clock.now(), verbose: false, debugLogPath: ctx.debugLog.path }).trimEnd();
}

/** Выполнить команду CLI в каталоге сессии Pi. Без TTY: команды, которым нужен человек, требуют флагов. */
export async function runCaptured(cwd: string, fn: (ctx: AppContext) => Promise<number>): Promise<CommandResult> {
  const { ctx, stdout, stderr } = extensionAppContext(cwd);
  try {
    const code = await fn(ctx);
    return { ok: code === 0, text: (stdout.text + stderr.text).trimEnd() };
  } catch (err) {
    return { ok: false, text: (stdout.text + errorText(ctx, err)).trimEnd() };
  }
}
