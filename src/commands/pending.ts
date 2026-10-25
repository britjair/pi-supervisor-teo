// Команды, которые появятся на следующих этапах. Preflight они выполняют уже сейчас:
// любая команда с невалидной Policy завершается с кодом 2 и не создаёт .sdlc.

import { preflight, type AppContext } from "../app.js";
import { UsageError } from "../errors/errors.js";
import { msg } from "../ui/messages.js";

export async function runPendingCommand(ctx: AppContext, name: string): Promise<number> {
  await preflight(ctx);
  throw new UsageError(msg.notImplemented(name));
}
