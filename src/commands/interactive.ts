// teo без аргументов: меню (05-cli-ui.md §3). HumanIO выбирает Ink или plain.
// Меню только читает; lock берётся, когда выбрано mutating-действие.

import { startCommand, type AppContext } from "../app.js";
import { isFinished } from "../domain/task-state.js";
import { ExitCode, TeoError, UserAbortError } from "../errors/errors.js";
import type { ProjectStore } from "../state/project-store.js";
import type { Choice, HumanIO } from "../ui/human-io.js";
import { msg, nextActionText } from "../ui/messages.js";
import { renderError } from "../ui/plain/errors.js";
import { taskRows } from "../ui/plain/task-views.js";
import { formatWhen } from "../util/time.js";
import { tildify } from "../util/strings.js";
import { cancelTask } from "./cancel.js";
import { eventsText } from "./history.js";
import { createTask, createdText, newTaskForm } from "./new.js";
import { executeTask } from "./run-task.js";
import { statusText, summaryText } from "./status.js";
import { byUpdatedDesc, listViews, taskView, type TaskView } from "./task-view.js";

const MENU_EVENTS = 20;

type TaskExecutor = (ctx: AppContext, store: ProjectStore, key: string) => Promise<number>;

type MenuChoice = { kind: "create" } | { kind: "task"; key: string } | { kind: "corrupted"; key: string } | { kind: "finished" } | { kind: "exit" };

function header(ctx: AppContext, store: ProjectStore): string {
  const processes = store.processes.map((p) =>
    p.ok ? msg.menu.processOk(p.name, Object.keys(p.policy.spec.workflow.stages).length) : msg.menu.processBroken(p.name),
  );
  return [
    ctx.style.bold(msg.menu.title),
    msg.menu.project(store.layout.projectRoot),
    msg.menu.processes(processes),
    msg.processesDir(tildify(ctx.processes.dir, ctx.homeDir)),
    "",
  ].join("\n");
}

/** Ошибка действия в меню: показать и вернуться в меню. Ctrl+C и непредвиденные ошибки — наружу. */
async function guarded(ctx: AppContext, human: HumanIO, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    if (err instanceof UserAbortError || !(err instanceof TeoError)) throw err;
    human.print("\n" + renderError(err, { homeDir: ctx.homeDir, style: ctx.style, now: ctx.clock.now(), verbose: ctx.verbose }));
  }
}

async function createFlow(ctx: AppContext, human: HumanIO, store: ProjectStore, execute: TaskExecutor): Promise<number | null> {
  const input = await newTaskForm(ctx, human, store, {});
  if (!input) return null;
  const state = await createTask(store, input);
  human.print(createdText(store, state).split("\n")[0] + "\n");
  return execute(ctx, store, state.key);
}

function resumeText(ctx: AppContext, v: TaskView): string {
  const now = ctx.clock.now();
  const last = v.lastEvent ? `${formatWhen(v.lastEvent.event.timestamp, now)} ${v.lastEvent.event.type}` : msg.status.none;
  return [
    ctx.style.bold(msg.resume.title(v.key, v.state.title)),
    "",
    msg.resume.stage(v.stageTitle ?? msg.menu.stageMissing(v.state.stage)),
    msg.resume.lastEvent(last),
    msg.resume.next(nextActionText(v.next, { key: v.key, now })),
    "",
  ].join("\n");
}

async function taskMenu(ctx: AppContext, human: HumanIO, store: ProjectStore, key: string, execute: TaskExecutor): Promise<number | null> {
  for (;;) {
    const now = ctx.clock.now();
    const view = await taskView(store, await store.tasks.read(key), await store.locks.inspect(), now);
    const finished = isFinished(view.state);
    type Action = "resume" | "status" | "history" | "cancel" | "back";
    const choices: Array<Choice<Action>> = [
      ...(finished ? [] : [{ label: msg.menu.taskActions.resume, value: "resume" as const }]),
      { label: msg.menu.taskActions.status, value: "status" },
      { label: msg.menu.taskActions.history, value: "history" },
      ...(finished ? [] : [{ label: msg.menu.taskActions.cancel, value: "cancel" as const }]),
      { label: msg.menu.back, value: "back", key: "q" },
    ];
    const title = `${key} · ${view.stageTitle ?? view.state.stage} · ${nextActionText(view.next, { key, now })}`;
    const action = await human.select(title, choices);
    switch (action) {
      case "back":
        return null;
      case "resume":
        human.print("\n" + resumeText(ctx, view));
        return execute(ctx, store, key);
      case "status":
        human.print("\n" + (await statusText(ctx, store, key)));
        break;
      case "history":
        human.print("\n" + (await eventsText(ctx, store, key, MENU_EVENTS)));
        break;
      case "cancel": {
        let done = false;
        await guarded(ctx, human, async () => {
          done = await cancelTask(store, key, { human });
          human.print((done ? msg.cancel.done(key) : msg.cancel.declined) + "\n");
        });
        if (done) return null;
        break;
      }
    }
  }
}

async function finishedMenu(ctx: AppContext, human: HumanIO, store: ProjectStore, views: TaskView[], execute: TaskExecutor): Promise<number | null> {
  const rows = taskRows(views.map((view) => ({ ok: true as const, view })), { now: ctx.clock.now(), style: ctx.style });
  const key = await human.select<string | null>(msg.menu.finishedTitle, [
    ...views.map((v, i) => ({ label: rows[i] ?? v.key, value: v.key })),
    { label: msg.menu.back, value: null, key: "q" },
  ]);
  return key ? taskMenu(ctx, human, store, key, execute) : null;
}

export async function runInteractive(ctx: AppContext, deps: { execute?: TaskExecutor } = {}): Promise<number> {
  const execute = deps.execute ?? executeTask;
  const { store } = await startCommand(ctx);
  const human = ctx.human;
  if (!human) {
    // Без терминала меню недоступно: список задач и подсказка (05-cli-ui.md §5)
    const now = ctx.clock.now();
    ctx.stdout.write(header(ctx, store) + "\n" + summaryText(ctx, await listViews(store, await store.locks.inspect(), now), now));
    ctx.stdout.write("\n" + msg.menu.nonInteractiveHint + "\n");
    return ExitCode.ok;
  }

  for (let first = true; ; first = false) {
    const now = ctx.clock.now();
    const views = await listViews(store, await store.locks.inspect(), now);
    const ok = views.flatMap((v) => (v.ok ? [v.view] : [])).sort(byUpdatedDesc);
    const active = ok.filter((v) => !isFinished(v.state));
    const finished = ok.filter((v) => isFinished(v.state));
    const corrupted = views.filter((v) => !v.ok).map((v) => v.key);

    human.print(header(ctx, store));
    // Незавершённых задач нет — сразу форма создания (05-cli-ui.md §3)
    if (first && active.length === 0 && corrupted.length === 0) {
      let result: number | null = null;
      await guarded(ctx, human, async () => { result = await createFlow(ctx, human, store, execute); });
      if (result !== null) return result;
      continue;
    }

    const rows = taskRows(
      [...active.map((view) => ({ ok: true as const, view })), ...corrupted.map((key) => ({ ok: false as const, key }))],
      { now, style: ctx.style },
    );
    const choices: Array<Choice<MenuChoice>> = [
      { label: msg.menu.create, value: { kind: "create" } },
      ...active.map((v, i) => ({ label: rows[i] ?? v.key, value: { kind: "task" as const, key: v.key } })),
      ...corrupted.map((key, i) => ({ label: rows[active.length + i] ?? key, value: { kind: "corrupted" as const, key } })),
      ...(finished.length > 0 ? [{ label: msg.menu.finished(finished.length), value: { kind: "finished" as const } }] : []),
      { label: msg.menu.exit, value: { kind: "exit" }, key: "q" },
    ];
    const choice = await human.select(msg.menu.question, choices);
    switch (choice.kind) {
      case "exit":
        return ExitCode.ok;
      case "create": {
        let result: number | null = null;
        await guarded(ctx, human, async () => { result = await createFlow(ctx, human, store, execute); });
        if (result !== null) return result;
        break;
      }
      case "task": {
        let result: number | null = null;
        await guarded(ctx, human, async () => { result = await taskMenu(ctx, human, store, choice.key, execute); });
        if (result !== null) return result;
        break;
      }
      case "corrupted":
        human.print(msg.menu.corruptedHint(choice.key) + "\n");
        break;
      case "finished": {
        let result: number | null = null;
        await guarded(ctx, human, async () => { result = await finishedMenu(ctx, human, store, finished, execute); });
        if (result !== null) return result;
        break;
      }
    }
  }
}
