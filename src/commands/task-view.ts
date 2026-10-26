// Данные задачи для status, history и меню: state + Policy + lock + runtime.json.
// Только чтение.

import { getStage } from "../domain/policy.js";
import type { TaskEvent } from "../domain/events.js";
import { nextAction, type NextAction } from "../domain/next-action.js";
import type { TaskState } from "../domain/task-state.js";
import type { LockInspection } from "../state/lock-manager.js";
import type { ProjectStore, TaskListing } from "../state/project-store.js";
import { readRuntimeInfo, type RuntimeInfo } from "../state/runtime-info.js";
import type { TaskSnapshot } from "../state/state-store.js";

export type TaskView = {
  key: string;
  state: TaskState;
  /** null — этапа задачи нет в текущей Policy её процесса */
  stageTitle: string | null;
  /** Процесс задачи: missing — файла нет, invalid — Policy с ошибками (D41) */
  processProblem: "missing" | "invalid" | null;
  /** Задачу сейчас ведёт живой процесс */
  live: boolean;
  livePid: number | null;
  next: NextAction;
  lastEvent: { event: TaskEvent; undelivered: boolean } | null;
  runtime: RuntimeInfo | null;
  snapshot: TaskSnapshot;
};

export type ListedView = { key: string; ok: true; view: TaskView } | { key: string; ok: false; error: Error };

export async function taskView(store: ProjectStore, snapshot: TaskSnapshot, lock: LockInspection, now: Date): Promise<TaskView> {
  const { state } = snapshot;
  const entry = store.process(state.process);
  const stage = entry?.ok ? getStage(entry.policy.spec, state.stage) : undefined;
  const holder = lock.kind === "held" && lock.alive !== false && lock.lock.taskKey === state.key ? lock.lock : null;
  const lastUndelivered = snapshot.undelivered.at(-1);
  const lastRecent = snapshot.recent.at(-1);
  return {
    key: state.key,
    state,
    stageTitle: stage?.title ?? null,
    processProblem: !entry ? "missing" : entry.ok ? null : "invalid",
    live: holder !== null,
    livePid: holder?.pid ?? null,
    next: nextAction(state, { stageAgent: stage?.kind === "work" ? stage.agent : null, now, live: holder !== null }),
    lastEvent: lastUndelivered
      ? { event: lastUndelivered, undelivered: true }
      : lastRecent
        ? { event: lastRecent, undelivered: false }
        : null,
    runtime: holder ? await readRuntimeInfo(store.tasks.task(state.key).runtime) : null,
    snapshot,
  };
}

export async function listViews(store: ProjectStore, lock: LockInspection, now: Date): Promise<ListedView[]> {
  const listings: TaskListing[] = await store.listTasks();
  const out: ListedView[] = [];
  for (const l of listings) {
    out.push(l.ok ? { key: l.key, ok: true, view: await taskView(store, l.snapshot, lock, now) } : { key: l.key, ok: false, error: l.error });
  }
  return out;
}

export const byUpdatedDesc = (a: TaskView, b: TaskView) =>
  b.state.updatedAt.localeCompare(a.state.updatedAt) || a.key.localeCompare(b.key);
