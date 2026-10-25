// Текст ошибки для человека (05-cli-ui.md §9). Используют cli.ts и меню.

import { LockConflictError, PolicyError, SdlcError } from "../../errors/errors.js";
import { lockConflictText, msg } from "../messages.js";
import { renderPolicyError } from "./policy-report.js";
import type { Style } from "./style.js";

export function renderError(err: unknown, ctx: { homeDir: string; style: Style; now: Date; verbose: boolean }): string {
  if (err instanceof PolicyError) return renderPolicyError(err, { homeDir: ctx.homeDir, style: ctx.style });
  if (err instanceof LockConflictError) return lockConflictText(err.holder, ctx.now) + "\n";
  if (err instanceof SdlcError) return err.message + "\n";
  const message = err instanceof Error ? err.message : String(err);
  const detail = ctx.verbose && err instanceof Error && err.stack ? err.stack : msg.verboseHint;
  return `${msg.unexpectedError(message)}\n${detail}\n`;
}
