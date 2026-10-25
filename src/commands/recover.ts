// sdlc recover <KEY> [--set-stage S] [--accept-policy] (05-cli-ui.md §2.1).
// Показывает state и последние события и предлагает только допустимые для ситуации действия.

import path from "node:path";
import { inspectPiSessionFile } from "../agents/pi/session-inspector.js";
import { startCommand, type AppContext } from "../app.js";
import { getStage, type LoadedPolicy } from "../domain/policy.js";
import { isFinished, type TaskState } from "../domain/task-state.js";
import { ExitCode, TaskCorruptedError, UsageError } from "../errors/errors.js";
import type { ProjectStore } from "../state/project-store.js";
import type { TamperedCopy } from "../state/state-store.js";
import type { Choice, HumanIO } from "../ui/human-io.js";
import { msg } from "../ui/messages.js";
import {
  RECOVER_ONLY_CODES,
  SESSION_CHOICE_LABELS,
  SESSION_CORRUPTED_PREFIX,
  acceptPolicy,
  readStateCopy,
  replaceTamperedState,
  resolveCorruptedSession,
  setStage,
  stateDiff,
  unblockTask,
  type SessionChoice,
} from "../workflow/manual.js";
import { eventsText } from "./history.js";
import { statusText } from "./status.js";

export type RecoverOptions = { setStage?: string; acceptPolicy?: boolean };

const RECENT_EVENTS = 8;
const DIFF_LINES = 20;
const DIFF_VALUE = 120;

export type TamperedInfo = {
  copy: TamperedCopy;
  /** Изменённая копия, если она проходит схему и инварианты */
  tampered: TaskState | null;
  tamperedError: string | null;
  before: TaskState | null;
};

export type RecoverSituation = {
  state: TaskState;
  policy: LoadedPolicy;
  tampered: TamperedInfo | null;
  /** Причина, если файл сессии текущего run-а повреждён (03-engine.md §8.4) */
  corruptedSession: string | null;
};

export type RecoverAction =
  | { kind: "set_stage" }
  | { kind: "accept_policy" }
  | { kind: "accept_tampered" }
  | { kind: "restore_before_tamper" }
  | { kind: "session"; choice: SessionChoice }
  | { kind: "unblock" }
  | { kind: "exit" };

/** Допустимые действия (таблица 05-cli-ui.md §2.1). Чистая функция. */
export function recoverActions(sit: RecoverSituation): RecoverAction[] {
  const { state, policy } = sit;
  if (isFinished(state)) return [{ kind: "exit" }];
  const out: RecoverAction[] = [];
  const code = state.status === "blocked" ? (state.statusReason?.code ?? "") : "";
  if (code === "STATE_TAMPERED" && sit.tampered) {
    if (sit.tampered.before) out.push({ kind: "restore_before_tamper" });
    if (sit.tampered.tampered) out.push({ kind: "accept_tampered" });
  }
  if (sit.corruptedSession !== null) {
    out.push({ kind: "session", choice: "restart" }, { kind: "session", choice: "supervisor" });
    if (state.status !== "blocked") out.push({ kind: "session", choice: "block" });
  }
  const stage = getStage(policy.spec, state.stage);
  if (state.policyHash !== policy.hash && stage?.kind === "work" && code !== "STATE_TAMPERED") out.push({ kind: "accept_policy" });
  out.push({ kind: "set_stage" });
  if (code && !RECOVER_ONLY_CODES.includes(code) && code !== "SESSION_CORRUPTED") out.push({ kind: "unblock" });
  out.push({ kind: "exit" });
  return out;
}

async function tamperedInfo(store: ProjectStore, state: TaskState): Promise<TamperedInfo | null> {
  if (state.status !== "blocked" || state.statusReason?.code !== "STATE_TAMPERED") return null;
  const [copy] = await store.tasks.tamperedCopies(state.key);
  if (!copy) return null;
  let tampered: TaskState | null = null;
  let tamperedError: string | null = null;
  try {
    tampered = await readStateCopy(state.key, copy.tampered);
  } catch (err) {
    if (!(err instanceof TaskCorruptedError)) throw err;
    tamperedError = err.reason;
  }
  const before = copy.before ? await readStateCopy(state.key, copy.before).catch(() => null) : null;
  return { copy, tampered, tamperedError, before };
}

async function corruptedSession(store: ProjectStore, state: TaskState): Promise<string | null> {
  if (state.status === "blocked" && state.statusReason?.code === "SESSION_CORRUPTED") {
    const m = state.statusReason.message;
    return m.startsWith(SESSION_CORRUPTED_PREFIX) ? m.slice(SESSION_CORRUPTED_PREFIX.length) : m;
  }
  if (state.phase !== "agent_running" || !state.currentRun) return null;
  const info = await inspectPiSessionFile(path.join(store.tasks.task(state.key).dir, state.currentRun.sessionFile));
  return info.valid ? null : (info.parseError ?? "файл сессии не разбирается");
}

export async function recoverSituation(store: ProjectStore, key: string): Promise<RecoverSituation> {
  const state = await store.tasks.load(key);
  return { state, policy: store.policy, tampered: await tamperedInfo(store, state), corruptedSession: await corruptedSession(store, state) };
}

function actionLabel(a: RecoverAction, sit: RecoverSituation): string {
  const short = (h: string) => `sha256:${h.slice(0, 4)}…${h.slice(-2)}`;
  switch (a.kind) {
    case "set_stage": return msg.recover.setStage;
    case "accept_policy": return msg.recover.acceptPolicy(short(sit.state.policyHash), short(sit.policy.hash));
    case "accept_tampered": return msg.recover.acceptTampered;
    case "restore_before_tamper": return msg.recover.restoreBeforeTamper;
    case "session": return SESSION_CHOICE_LABELS[a.choice];
    case "unblock": return msg.recover.unblock;
    case "exit": return msg.recover.exit;
  }
}

const clip = (s: string) => (s.length > DIFF_VALUE ? s.slice(0, DIFF_VALUE - 1) + "…" : s);

/** Что поменялось в изменённой копии (показывается до выбора действия). */
export function tamperedText(info: TamperedInfo, current: TaskState): string[] {
  const name = path.basename(info.copy.tampered);
  if (!info.tampered) return [msg.recover.tamperedInvalid(name, info.tamperedError ?? "")];
  const changes = stateDiff(info.before ?? current, info.tampered);
  const lines = [msg.recover.tamperedTitle(name)];
  if (changes.length === 0) lines.push(msg.recover.tamperedNoDiff);
  for (const c of changes.slice(0, DIFF_LINES)) lines.push(`  ${c.field}: ${clip(c.before)} → ${clip(c.after)}`);
  if (changes.length > DIFF_LINES) lines.push(msg.recover.tamperedMore(changes.length - DIFF_LINES));
  if (!info.before) lines.push(msg.recover.tamperedNoBefore);
  return lines;
}

async function chooseStage(human: HumanIO, sit: RecoverSituation): Promise<string> {
  const stages = Object.values(sit.policy.spec.workflow.stages).filter((s) => s.kind === "work");
  const choices: Array<Choice<string>> = stages.map((s) => ({
    label: `${s.title} (${s.id})${s.id === sit.state.stage ? ` ${msg.recover.currentStage}` : ""}`,
    value: s.id,
  }));
  return human.select(msg.recover.chooseStage, choices);
}

/** Выполнить действие. null — пользователь вышел или передумал. */
async function apply(store: ProjectStore, human: HumanIO, sit: RecoverSituation, a: RecoverAction): Promise<string | null> {
  const key = sit.state.key;
  const label = actionLabel(a, sit);
  switch (a.kind) {
    case "exit":
      return null;
    case "set_stage": {
      const stageId = await chooseStage(human, sit);
      const next = await setStage(store, key, stageId, sit.policy);
      return msg.recover.done.setStage(key, store.stageTitle(next.stage) ?? next.stage);
    }
    case "accept_policy":
      await acceptPolicy(store, key, sit.policy);
      return msg.recover.done.acceptPolicy(key);
    case "accept_tampered":
      if (!sit.tampered?.tampered || !(await human.confirm(msg.recover.confirmTampered, false))) return null;
      await replaceTamperedState(store, key, sit.tampered.copy.tampered, "accept_tampered", label);
      return msg.recover.done.acceptTampered(key);
    case "restore_before_tamper":
      if (!sit.tampered?.copy.before) return null;
      await replaceTamperedState(store, key, sit.tampered.copy.before, "restore_before_tamper", label);
      return msg.recover.done.restoreBeforeTamper(key);
    case "session":
      await resolveCorruptedSession(store, key, a.choice, sit.corruptedSession ?? "");
      return msg.recover.done.session(key, label);
    case "unblock": {
      const note = await human.multiline(msg.recover.unblockNote, { validate: (t) => (t.trim() ? null : msg.recover.unblockNoteEmpty) });
      await unblockTask(store, key, note.trim());
      return msg.recover.done.unblock(key);
    }
  }
}

function nonInteractiveHints(key: string, sit: RecoverSituation, actions: RecoverAction[]): string[] {
  const hints = [msg.recover.hintSetStage(key)];
  if (actions.some((a) => a.kind === "accept_policy")) hints.push(msg.recover.hintAcceptPolicy(key));
  if (sit.tampered || sit.corruptedSession !== null) hints.push(msg.recover.hintTerminal(key));
  return hints;
}

export async function runRecover(ctx: AppContext, keyArg: string, opts: RecoverOptions): Promise<number> {
  const { store } = await startCommand(ctx);
  const key = await store.requireKey(keyArg);
  const out = (text: string) => (ctx.human ? ctx.human.print(text) : ctx.stdout.write(text + "\n"));

  return store.withLock({ command: "recover", taskKey: key }, async (lock) => {
    // Флаги — то же без меню (05-cli-ui.md §2.1); --set-stage уже включает принятие текущей Policy
    if (opts.setStage !== undefined) {
      const next = await setStage(store, key, opts.setStage, store.policy);
      out(msg.recover.done.setStage(key, store.stageTitle(next.stage) ?? next.stage) + "\n" + msg.recover.next(key));
      return ExitCode.ok;
    }
    if (opts.acceptPolicy) {
      await acceptPolicy(store, key, store.policy);
      out(msg.recover.done.acceptPolicy(key) + "\n" + msg.recover.next(key));
      return ExitCode.ok;
    }

    const sit = await recoverSituation(store, key);
    if (isFinished(sit.state)) {
      out(msg.recover.finished(key));
      return ExitCode.ok;
    }
    const actions = recoverActions(sit);
    const human = ctx.human;
    if (!human) throw new UsageError(msg.recover.nonInteractive(key, nonInteractiveHints(key, sit, actions)));

    human.print(ctx.style.bold(msg.recover.title(key, sit.state.title)) + "\n");
    human.print(await statusText(ctx, store, key));
    human.print(await eventsText(ctx, store, key, RECENT_EVENTS));
    if (sit.state.status === "blocked" && sit.state.statusReason?.code === "POLICY_STAGE_MISSING") {
      human.print(ctx.style.yellow(msg.recover.policyStageMissing(sit.state.stage)));
    }
    if (sit.tampered) human.print(tamperedText(sit.tampered, sit.state).join("\n"));
    else if (sit.state.statusReason?.code === "STATE_TAMPERED") human.print(ctx.style.yellow(msg.recover.tamperedNoCopies));
    if (sit.corruptedSession !== null) {
      human.print(ctx.style.yellow(msg.recover.sessionCorrupted(sit.state.currentRun?.sessionFile ?? "", sit.corruptedSession)));
    }

    const choice = await human.select(
      msg.recover.question,
      actions.map((a) => ({ label: actionLabel(a, sit), value: a, ...(a.kind === "exit" ? { key: "q" } : {}) })),
    );
    lock.signal.throwIfAborted();
    const done = await apply(store, human, sit, choice);
    if (done) human.print(done + "\n" + msg.recover.next(key));
    return ExitCode.ok;
  });
}
