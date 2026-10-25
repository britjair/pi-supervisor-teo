// sdlc history [KEY] [--all] [--json] [--limit N] (05-cli-ui.md §2).
// Без KEY — все задачи проекта, включая завершённые; с KEY — журнал событий задачи.

import { startCommand, type AppContext } from "../app.js";
import type { TaskEvent } from "../domain/events.js";
import { ExitCode, UsageError } from "../errors/errors.js";
import type { ProjectStore } from "../state/project-store.js";
import { undeliveredOutbox } from "../state/state-store.js";
import { msg } from "../ui/messages.js";
import { renderEvents, renderTaskHistory } from "../ui/plain/task-views.js";
import { byUpdatedDesc, listViews } from "./task-view.js";

export const DEFAULT_EVENT_LIMIT = 50;

export type HistoryOptions = { all?: boolean; json?: boolean; limit?: string };

/** События журнала и недоставленного outbox, по порядку. Невалидная строка в середине — TaskCorruptedError. */
export async function taskEvents(store: ProjectStore, key: string): Promise<Array<{ event: TaskEvent; undelivered: boolean }>> {
  const { events } = await store.tasks.journal(key).readAll();
  const state = await store.tasks.readState(key);
  return [
    ...events.map((event) => ({ event, undelivered: false })),
    ...undeliveredOutbox(state, events).map((event) => ({ event, undelivered: true })),
  ];
}

export async function eventsText(ctx: AppContext, store: ProjectStore, key: string, limit: number | null): Promise<string> {
  const all = await taskEvents(store, key);
  const shown = limit === null ? all : all.slice(-limit);
  return renderEvents(key, shown, all.length, { now: ctx.clock.now(), style: ctx.style });
}

function parseLimit(opts: HistoryOptions): number | null {
  if (opts.all) return null;
  if (opts.limit === undefined) return DEFAULT_EVENT_LIMIT;
  const n = Number(opts.limit);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(msg.history.badLimit(opts.limit));
  return n;
}

export async function runHistory(ctx: AppContext, keyArg: string | undefined, opts: HistoryOptions): Promise<number> {
  const { store } = await startCommand(ctx);
  const limit = parseLimit(opts);

  if (keyArg !== undefined) {
    const key = await store.requireKey(keyArg);
    if (opts.json) {
      const all = await taskEvents(store, key);
      const shown = limit === null ? all : all.slice(-limit);
      ctx.stdout.write(JSON.stringify(shown.map((e) => ({ ...e.event, undelivered: e.undelivered })), null, 2) + "\n");
    } else {
      ctx.stdout.write(await eventsText(ctx, store, key, limit));
    }
    return ExitCode.ok;
  }

  const now = ctx.clock.now();
  const views = await listViews(store, await store.locks.inspect(), now);
  const ok = views.flatMap((v) => (v.ok ? [v.view] : [])).sort(byUpdatedDesc);
  const broken = views.filter((v) => !v.ok);
  if (opts.json) {
    ctx.stdout.write(
      JSON.stringify(
        [
          ...ok.map((v) => ({ key: v.key, ok: true, title: v.state.title, stage: v.state.stage, stageTitle: v.stageTitle, status: v.state.status, updatedAt: v.state.updatedAt })),
          ...broken.map((v) => ({ key: v.key, ok: false, error: v.ok ? null : v.error.message })),
        ],
        null,
        2,
      ) + "\n",
    );
    return ExitCode.ok;
  }
  let out = ok.length + broken.length === 0 ? msg.menu.noTasks + "\n" : renderTaskHistory(ok, { now, style: ctx.style });
  for (const b of broken) out += `  ${msg.menu.corrupted(b.key)}\n`;
  ctx.stdout.write(out);
  return ExitCode.ok;
}
