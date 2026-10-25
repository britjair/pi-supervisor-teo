// sdlc doctor --fix (05-cli-ui.md §7): исправления хранилища по одному с подтверждением.
// Lock берётся напрямую, без автоматического обслуживания withLock: каждое исправление делается
// только с согласия человека. Без терминала выполняются исправления, не требующие явного решения.

import { readFile } from "node:fs/promises";
import type { AppContext } from "../app.js";
import { writeFileAtomic } from "../state/atomic-file.js";
import { indexMatches } from "../state/index-store.js";
import { GITIGNORE_CONTENT } from "../state/layout.js";
import type { HeldLock } from "../state/lock-manager.js";
import type { ProjectStore } from "../state/project-store.js";
import { undeliveredOutbox } from "../state/state-store.js";
import { TaskCorruptedError } from "../errors/errors.js";
import type { HumanIO } from "../ui/human-io.js";
import { msg } from "../ui/messages.js";
import { lockText } from "../ui/plain/task-views.js";
import { onCleanup } from "../util/cleanup.js";

export type PlannedFix = {
  id: string;
  title: string;
  /** Опасное исправление: только по явному «да» человека, без терминала не выполняется */
  explicit: boolean;
  apply(): Promise<void>;
};

export type FixPlan = {
  /** Снятие lock-а: выполняется первым, без него остальные исправления невозможны */
  lockFix: PlannedFix | null;
  /** Почему исправления хранилища невозможны (проект занят живым процессом) */
  blocker: string | null;
  fixes: PlannedFix[];
};

export type FixResult = { title: string; outcome: "applied" | "skipped" | "failed"; error?: string };

export async function planFixes(ctx: AppContext, store: ProjectStore): Promise<FixPlan> {
  const F = msg.doctor.fix;
  const now = ctx.clock.now();
  const layout = store.layout;
  let lockFix: PlannedFix | null = null;
  let blocker: string | null = null;

  const lock = await store.locks.inspect();
  if (lock.kind === "held" && lock.alive === false) {
    lockFix = { id: "lock", title: F.lockDead(lockText(lock, now)), explicit: false, apply: () => forceRemove(store, lock) };
  } else if (lock.kind === "held" && lock.alive === null) {
    lockFix = { id: "lock", title: F.lockForeign(lockText(lock, now)), explicit: true, apply: () => forceRemove(store, lock) };
  } else if (lock.kind === "unreadable" && lock.stale) {
    lockFix = { id: "lock", title: F.lockUnreadable, explicit: false, apply: () => forceRemove(store, lock) };
  } else if (lock.kind !== "none") {
    blocker = F.busy(lockText(lock, now));
  }

  const fixes: PlannedFix[] = [];
  if ((await readFile(layout.gitignore, "utf8").catch(() => null)) !== GITIGNORE_CONTENT) {
    fixes.push({ id: "gitignore", title: F.gitignore, explicit: false, apply: () => writeFileAtomic(layout.gitignore, GITIGNORE_CONTENT) });
  }
  const orphans = await store.findOrphans();
  if (orphans.length > 0) {
    fixes.push({ id: "orphans", title: F.orphans(orphans.length), explicit: false, apply: async () => void (await store.removeOrphans()) });
  }
  const listings = await store.listTasks();
  for (const l of listings) {
    if (!l.ok) continue;
    const key = l.key;
    try {
      const { events, broken } = await store.tasks.journal(key).readAll();
      const undelivered = undeliveredOutbox(l.snapshot.state, events).length;
      if (broken || undelivered > 0) {
        // Загрузка под lock-ом обрезает оборванный хвост и дописывает outbox (02-storage.md §6.4, §7.3)
        fixes.push({ id: `journal:${key}`, title: F.journal(key, broken !== null, undelivered), explicit: false, apply: async () => void (await store.tasks.load(key)) });
      }
    } catch (err) {
      // Битая строка в середине журнала автоматически не чинится
      if (!(err instanceof TaskCorruptedError)) throw err;
    }
  }
  const valid = listings.flatMap((l) => (l.ok ? [l.snapshot.state] : []));
  if (!indexMatches(await store.index.read(), valid)) {
    fixes.push({ id: "index", title: F.index, explicit: false, apply: async () => void (await store.syncIndex()) });
  }
  return { lockFix, blocker, fixes };
}

async function forceRemove(store: ProjectStore, lock: Parameters<ProjectStore["locks"]["forceRemove"]>[0]): Promise<void> {
  if (!(await store.locks.forceRemove(lock))) throw new Error(msg.doctor.fix.lockChanged);
}

async function decide(human: HumanIO | null, fix: PlannedFix): Promise<boolean> {
  if (!human) return !fix.explicit;
  return human.confirm(msg.doctor.fix.ask(fix.title, fix.explicit), !fix.explicit);
}

async function attempt(fix: PlannedFix): Promise<FixResult> {
  try {
    await fix.apply();
    return { title: fix.title, outcome: "applied" };
  } catch (err) {
    return { title: fix.title, outcome: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runFixes(store: ProjectStore, plan: FixPlan, human: HumanIO | null): Promise<FixResult[]> {
  const results: FixResult[] = [];
  const skip = (fix: PlannedFix, error?: string) => results.push({ title: fix.title, outcome: "skipped", ...(error ? { error } : {}) });

  if (plan.blocker) {
    for (const fix of plan.fixes) skip(fix, plan.blocker);
    return results;
  }
  if (plan.lockFix) {
    const result = (await decide(human, plan.lockFix)) ? await attempt(plan.lockFix) : null;
    if (result) results.push(result);
    else skip(plan.lockFix);
    if (result?.outcome !== "applied") {
      for (const fix of plan.fixes) skip(fix, msg.doctor.fix.needsLock);
      return results;
    }
  }

  const chosen: PlannedFix[] = [];
  for (const fix of plan.fixes) {
    if (await decide(human, fix)) chosen.push(fix);
    else skip(fix);
  }
  if (chosen.length === 0) return results;

  let lock: HeldLock;
  try {
    lock = await store.locks.acquire({ command: "doctor", taskKey: null });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    for (const fix of chosen) skip(fix, reason);
    return results;
  }
  const unregister = onCleanup(() => lock.release());
  try {
    for (const fix of chosen) {
      lock.signal.throwIfAborted();
      results.push(await attempt(fix));
    }
  } finally {
    unregister();
    await lock.release();
  }
  return results;
}

export function renderFixes(ctx: AppContext, plan: FixPlan, results: readonly FixResult[]): string {
  const s = ctx.style;
  const F = msg.doctor.fix;
  if (results.length === 0) return F.nothing + "\n";
  const lines = [s.bold(F.title)];
  for (const r of results) {
    if (r.outcome === "applied") lines.push(`${s.green("✓")} ${r.title}`);
    else if (r.outcome === "failed") lines.push(`${s.red("✗")} ${r.title}: ${r.error ?? ""}`);
    else lines.push(`${s.dim("–")} ${s.dim(`${r.title} — ${r.error ?? F.declined}`)}`);
  }
  if (plan.blocker) lines.push("", s.yellow(plan.blocker));
  return lines.join("\n") + "\n";
}
