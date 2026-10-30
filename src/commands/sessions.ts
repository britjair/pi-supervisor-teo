// teo sessions / list: пронумерованный список сессий и задач проекта (docs/05-cli-ui.md).

import { startCommand, type AppContext } from "../app.js";
import { isFinished } from "../domain/task-state.js";
import { ExitCode } from "../errors/errors.js";
import type { ProjectStore } from "../state/project-store.js";
import { msg, statusBadge } from "../ui/messages.js";
import { table } from "../ui/plain/task-views.js";
import { byUpdatedDesc, listViews } from "./task-view.js";

export type FormattedSessionItem = {
  index: number;
  key: string;
  title: string;
  process: string;
  stageTitle: string;
  status: string;
  label: string;
  isFinished: boolean;
};

export async function collectSessionItems(
  store: ProjectStore,
  now: Date,
): Promise<FormattedSessionItem[]> {
  const lock = await store.locks.inspect();
  const views = await listViews(store, lock, now);

  const active = views
    .filter((v) => !v.ok || !isFinished(v.view.state))
    .sort((a, b) => (a.ok && b.ok ? byUpdatedDesc(a.view, b.view) : a.ok ? -1 : 1));
  const finished = views
    .filter((v) => v.ok && isFinished(v.view.state))
    .sort((a, b) => (a.ok && b.ok ? byUpdatedDesc(a.view, b.view) : 0));

  const sorted = [...active, ...finished];

  return sorted.map((v, i) => {
    const num = i + 1;
    if (!v.ok) {
      return {
        index: num,
        key: v.key,
        title: "",
        process: "",
        stageTitle: "",
        status: "corrupted",
        label: `[${num}] ⚠ ${v.key} (ошибка state)`,
        isFinished: false,
      };
    }
    const view = v.view;
    const stage = view.stageTitle ?? view.state.stage;
    const badge = statusBadge(view.next, {
      now,
      livePid: view.livePid,
      interrupted: view.state.status === "interrupted",
    });
    const finishedFlag = isFinished(view.state);
    const label = `[${num}] ${view.key} · ${view.state.process} · ${stage} · ${badge} · ${view.state.title}`;
    return {
      index: num,
      key: view.key,
      title: view.state.title,
      process: view.state.process,
      stageTitle: stage,
      status: view.state.status,
      label,
      isFinished: finishedFlag,
    };
  });
}

export async function runSessions(
  ctx: AppContext,
  opts: { json?: boolean },
): Promise<number> {
  const { store } = await startCommand(ctx);
  const now = ctx.clock.now();
  const items = await collectSessionItems(store, now);

  if (opts.json) {
    ctx.stdout.write(JSON.stringify(items, null, 2) + "\n");
    return ExitCode.ok;
  }

  if (items.length === 0) {
    ctx.stdout.write(msg.menu.noTasks + "\n");
    return ExitCode.ok;
  }

  const rows = items.map((item) => [
    `[${item.index}]`,
    item.key,
    item.process,
    item.stageTitle,
    item.status,
    item.title,
  ]);

  const output = [
    `Сессии teo (${items.length}):`,
    ...table(rows, "   ").map((r) => "  " + r),
    "",
    "Возобновить сессию: teo resume <номер> или teo resume <KEY>",
  ].join("\n") + "\n";

  ctx.stdout.write(output);
  return ExitCode.ok;
}
