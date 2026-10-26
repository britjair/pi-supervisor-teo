// teo status [KEY] [--json] (05-cli-ui.md §6). Без lock-а, ничего не пишет.

import { startCommand, type AppContext } from "../app.js";
import { isFinished } from "../domain/task-state.js";
import { ExitCode } from "../errors/errors.js";
import type { ProjectStore } from "../state/project-store.js";
import { msg, nextActionText } from "../ui/messages.js";
import { renderStatus, taskRows } from "../ui/plain/task-views.js";
import { byUpdatedDesc, listViews, taskView, type ListedView, type TaskView } from "./task-view.js";

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

function nextActionJson(v: TaskView, now: Date) {
  return { ...v.next, text: nextActionText(v.next, { key: v.key, now }) };
}

/** Сводка по незавершённым задачам: строки как в меню. Используется и меню без терминала. */
export function summaryText(ctx: AppContext, views: readonly ListedView[], now: Date): string {
  const active = views
    .filter((v) => !v.ok || !isFinished(v.view.state))
    .sort((a, b) => (a.ok && b.ok ? byUpdatedDesc(a.view, b.view) : a.ok ? -1 : 1));
  const finished = views.filter((v) => v.ok && isFinished(v.view.state)).length;
  if (views.length === 0) return msg.menu.noTasks + "\n";
  const rows = taskRows(
    active.map((v) => (v.ok ? { ok: true as const, view: v.view } : { ok: false as const, key: v.key })),
    { now, style: ctx.style },
  );
  const lines = [msg.status.summaryTitle(active.length), ...rows.map((r) => "  " + r)];
  if (finished > 0) lines.push("", msg.status.finishedCount(finished));
  return lines.join("\n") + "\n";
}

export async function statusText(ctx: AppContext, store: ProjectStore, key: string): Promise<string> {
  const now = ctx.clock.now();
  const lock = await store.locks.inspect();
  const view = await taskView(store, await store.tasks.read(key), lock, now);
  return renderStatus(view, { now, style: ctx.style, lock, currentPolicyHash: store.policy.hash });
}

export async function runStatus(ctx: AppContext, keyArg: string | undefined, opts: { json?: boolean }): Promise<number> {
  const { store } = await startCommand(ctx);
  const now = ctx.clock.now();
  const lock = await store.locks.inspect();

  if (keyArg !== undefined) {
    const key = await store.requireKey(keyArg);
    const view = await taskView(store, await store.tasks.read(key), lock, now);
    ctx.stdout.write(
      opts.json
        ? json({
            state: view.state,
            runtime: view.runtime,
            lock,
            policy: { currentHash: store.policy.hash, matches: view.state.policyHash === store.policy.hash },
            nextAction: nextActionJson(view, now),
          })
        : renderStatus(view, { now, style: ctx.style, lock, currentPolicyHash: store.policy.hash }),
    );
    return ExitCode.ok;
  }

  const views = await listViews(store, lock, now);
  if (opts.json) {
    ctx.stdout.write(
      json({
        tasks: views.map((v) =>
          v.ok
            ? { key: v.key, ok: true, state: v.view.state, nextAction: nextActionJson(v.view, now) }
            : { key: v.key, ok: false, error: v.error.message },
        ),
        lock,
        policy: { currentHash: store.policy.hash },
      }),
    );
  } else {
    ctx.stdout.write(summaryText(ctx, views, now));
  }
  return ExitCode.ok;
}
