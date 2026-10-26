// teo cancel <KEY> [--reason R] (05-cli-ui.md §2). Отмена задачи человеком.
// Причина пишется в журнал как human.responded: это след явного решения пользователя.

import { startCommand, type AppContext } from "../app.js";
import { haltedState, isFinished } from "../domain/task-state.js";
import { ExitCode, LockConflictError, UsageError } from "../errors/errors.js";
import { holderOf } from "../state/lock-manager.js";
import type { ProjectStore } from "../state/project-store.js";
import type { HumanIO } from "../ui/human-io.js";
import { msg } from "../ui/messages.js";

/** Результат: true — задача отменена, false — пользователь передумал. */
export async function cancelTask(
  store: ProjectStore,
  key: string,
  opts: { reason?: string | undefined; human: HumanIO | null },
): Promise<boolean> {
  const { state } = await store.tasks.read(key);
  if (isFinished(state)) throw new UsageError(msg.cancel.alreadyFinished(key, state.status));

  let reason = opts.reason?.trim() ?? "";
  if (opts.human) {
    const lock = await store.locks.inspect();
    if (lock.kind !== "none" && !lock.stale) throw new LockConflictError(msg.lock.conflictTitle, holderOf(lock));
    if (!reason) {
      reason = await opts.human.input(msg.cancel.reason, { validate: (r) => (r ? null : msg.cancel.reasonEmpty) });
    }
    opts.human.print(msg.cancel.journalNote);
    if (!(await opts.human.confirm(msg.cancel.confirm(key, state.title), false))) return false;
  } else if (!reason) {
    throw new UsageError(msg.cancel.reasonRequired);
  }

  await store.withLock({ command: "cancel", taskKey: key }, async (lock) => {
    // Загрузка под lock-ом доставляет недописанный outbox и чинит хвост журнала
    const current = await store.tasks.load(key);
    if (isFinished(current)) throw new UsageError(msg.cancel.alreadyFinished(key, current.status));
    lock.signal.throwIfAborted();
    await store.tasks.commit(
      key,
      (s, c) => {
        const responseId = c.emit("human.responded", "human", { requestId: null, answer: reason, selectedOption: null });
        c.emit("task.cancelled", "human", { reason, humanResponseRef: `human:${responseId}`, by: "human" });
        return haltedState(s, "cancelled", { code: "CANCELLED_BY_HUMAN", message: reason, at: c.now });
      },
      { expectedVersion: current.version },
    );
  });
  return true;
}

export async function runCancel(ctx: AppContext, keyArg: string, opts: { reason?: string }): Promise<number> {
  const { store } = await startCommand(ctx);
  const key = await store.requireKey(keyArg);
  const cancelled = await cancelTask(store, key, { reason: opts.reason, human: ctx.human });
  ctx.stdout.write((cancelled ? msg.cancel.done(key) : msg.cancel.declined) + "\n");
  return ExitCode.ok;
}
