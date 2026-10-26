// Линейный вывод status, history и строк меню (05-cli-ui.md §3, §6).

import type { TaskEvent } from "../../domain/events.js";
import type { NextAction } from "../../domain/next-action.js";
import type { PolicyHash } from "../../domain/policy.js";
import type { Usage } from "../../domain/runs.js";
import type { TaskState } from "../../domain/task-state.js";
import type { LockInspection } from "../../state/lock-manager.js";
import { formatDateTime, formatWhen } from "../../util/time.js";
import { eventSummary, msg, nextActionText, statusBadge, statusName } from "../messages.js";
import type { Style } from "./style.js";

/** Что нужно представлению от задачи (структурно совместимо с commands/task-view.ts). */
export type TaskViewData = {
  key: string;
  state: TaskState;
  stageTitle: string | null;
  processProblem: "missing" | "invalid" | null;
  live: boolean;
  livePid: number | null;
  next: NextAction;
  lastEvent: { event: TaskEvent; undelivered: boolean } | null;
  runtime: { usage: Usage } | null;
};

export type ViewContext = { now: Date; style: Style };

function table(rows: string[][], gap = "  "): string[] {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, [...c].length)));
  return rows.map((r) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c + " ".repeat((widths[i] ?? 0) - [...c].length)))
      .join(gap)
      .trimEnd(),
  );
}

function labeled(pairs: Array<[string, string]>): string[] {
  const width = Math.max(...pairs.map(([l]) => l.length)) + 1;
  return pairs.map(([l, v]) => `${(l + ":").padEnd(width + 1)}${v}`);
}

export function lockText(lock: LockInspection, now: Date): string {
  if (lock.kind === "none") return msg.lock.free;
  if (lock.kind === "unreadable") return msg.lock.unreadable;
  return msg.lock.statusLine(lock.lock, now, lock.alive);
}

/** teo status KEY */
export function renderStatus(
  v: TaskViewData,
  ctx: ViewContext & { lock: LockInspection; currentPolicyHash: PolicyHash | null },
): string {
  const s = v.state;
  const L = msg.status.labels;
  const run = s.currentRun;
  const pairs: Array<[string, string]> = [
    [L.project, s.projectRoot],
    [L.process, v.processProblem ? msg.status.processProblem(s.process, v.processProblem) : s.process],
    [L.stage, msg.status.stage(v.stageTitle, s.stage, s.stageEnteredAt, s.stageCycles, ctx.now)],
    [L.status, msg.status.status(s.status, s.phase)],
  ];
  if (s.statusReason && (s.status === "blocked" || s.status === "cancelled")) {
    pairs.push([L.reason, `${s.statusReason.message} (${s.statusReason.code})`]);
  }
  pairs.push([
    L.agent,
    run
      ? msg.status.agent(run.agentId, run.attempt, run.runId, run.settleReason ? `${run.status}: ${run.settleReason}` : run.status)
      : msg.status.noAgent,
  ]);
  pairs.push([L.lastEvent, v.lastEvent ? msg.status.event(v.lastEvent.event, ctx.now, v.lastEvent.undelivered) : msg.status.none]);
  pairs.push([
    L.lastDecision,
    s.lastDecision ? msg.status.decision(s.lastDecision.at, s.lastDecision.action, s.lastDecision.summary, ctx.now) : msg.status.none,
  ]);
  pairs.push([L.next, nextActionText(v.next, { key: v.key, now: ctx.now })]);
  pairs.push([
    L.policy,
    ctx.currentPolicyHash === null
      ? msg.status.policyUnavailable(s.policyHash)
      : s.policyHash === ctx.currentPolicyHash
        ? msg.status.policyCurrent(s.policyHash)
        : msg.status.policyDiffers(s.policyHash, ctx.currentPolicyHash),
  ]);
  pairs.push([L.lock, lockText(ctx.lock, ctx.now)]);
  if (v.runtime) {
    const u = v.runtime.usage;
    pairs.push([L.usage, msg.status.usage(u.inputTokens, u.outputTokens, u.costUsd)]);
  }
  return [ctx.style.bold(msg.status.header(v.key, s.title)), ...labeled(pairs)].join("\n") + "\n";
}

/** Этап задачи: название из Policy её процесса или пометка, почему его нет (D41). */
function stageCell(v: TaskViewData): string {
  if (v.processProblem) return msg.menu.processProblem(v.state.process, v.processProblem);
  return v.stageTitle ?? msg.menu.stageMissing(v.state.stage);
}

/** Строки задач для меню и сводки status: ключ, процесс, этап, статус, название. */
export function taskRows(
  views: ReadonlyArray<{ ok: true; view: TaskViewData } | { ok: false; key: string }>,
  ctx: ViewContext,
): string[] {
  const rows = views.map((item) => {
    if (!item.ok) return [msg.menu.corrupted(item.key), "", "", "", ""];
    const v = item.view;
    const badge = statusBadge(v.next, {
      now: ctx.now,
      livePid: v.livePid,
      interrupted: v.state.status === "interrupted",
    });
    return [v.key, v.state.process, stageCell(v), badge, v.state.title];
  });
  return table(rows, "   ");
}

/** teo history без KEY: все задачи проекта, включая завершённые. */
export function renderTaskHistory(views: readonly TaskViewData[], ctx: ViewContext): string {
  const rows = views.map((v) => [
    v.key,
    v.state.process,
    stageCell(v),
    statusName(v.state.status),
    formatWhen(v.state.updatedAt, ctx.now),
    v.state.title,
  ]);
  return [msg.history.tasksTitle(views.length), ...table(rows).map((r) => "  " + r)].join("\n") + "\n";
}

/** teo history KEY: лента событий. */
export function renderEvents(
  key: string,
  events: ReadonlyArray<{ event: TaskEvent; undelivered: boolean }>,
  total: number,
  ctx: ViewContext,
): string {
  const rows = events.map(({ event, undelivered }) => [
    formatDateTime(event.timestamp),
    event.type,
    eventSummary(event) + (undelivered ? ` ${ctx.style.dim(msg.history.undelivered)}` : ""),
  ]);
  return [msg.history.eventsTitle(key, events.length, total), ...table(rows).map((r) => "  " + r)].join("\n") + "\n";
}
