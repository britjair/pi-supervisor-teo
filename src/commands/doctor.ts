// teo doctor, 05-cli-ui.md §7: окружение, Policy, Pi SDK и модели, project root, хранилище .teo.
// Без --fix ничего не меняет; исправления — doctor-fix.ts.

import { constants } from "node:fs";
import { PiAgentRuntime } from "../agents/pi/pi-agent-runtime.js";
import type { AgentRuntime } from "../agents/runtime.js";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { openProject, type AppContext } from "../app.js";
import { agentList, type LoadedPolicy } from "../domain/policy.js";
import { ExitCode, PolicyError } from "../errors/errors.js";
import { detectProjectRoot } from "../project/project-root.js";
import { GITIGNORE_CONTENT } from "../state/layout.js";
import { holderOf } from "../state/lock-manager.js";
import { indexMatches } from "../state/index-store.js";
import type { ProjectStore } from "../state/project-store.js";
import { undeliveredOutbox } from "../state/state-store.js";
import { TaskCorruptedError } from "../errors/errors.js";
import { msg } from "../ui/messages.js";
import { issueLines, policyProblemLines } from "../ui/plain/policy-report.js";
import { lockText } from "../ui/plain/task-views.js";
import { tildify } from "../util/strings.js";
import { planFixes, renderFixes, runFixes } from "./doctor-fix.js";

export type CheckLevel = "ok" | "info" | "warning" | "error" | "skipped";

export type DoctorCheck = {
  id: string;
  level: CheckLevel;
  title: string;
  details: string[];
  /** Сколько проблем в проверке, если больше одной (предупреждения Policy). */
  count?: number;
};

export const MIN_NODE_VERSION = "22.19.0";

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** Какие modelRef используются и кем: «default (analyst, developer, supervisor)». */
function modelUsage(policy: LoadedPolicy): string {
  const users = new Map<string, string[]>();
  const add = (ref: string, who: string) => users.set(ref, [...(users.get(ref) ?? []), who]);
  for (const agent of agentList(policy.spec)) add(agent.thinking ? `${agent.model} [${agent.thinking}]` : agent.model, agent.id);
  const sv = policy.spec.supervisor;
  add(sv.thinking ? `${sv.model} [${sv.thinking}]` : sv.model, "supervisor");
  return [...users].map(([ref, who]) => msg.doctor.modelsUsage(ref, who)).join("; ");
}

export async function collectDoctorChecks(
  ctx: AppContext,
  runtime?: AgentRuntime,
): Promise<{ checks: DoctorCheck[]; policyValid: boolean; store: ProjectStore; teoExists: boolean }> {
  const checks: DoctorCheck[] = [];
  const s = ctx.style;

  // Node.js
  checks.push({
    id: "node",
    level: compareVersions(ctx.nodeVersion, MIN_NODE_VERSION) >= 0 ? "ok" : "error",
    title: msg.doctor.node(ctx.nodeVersion, MIN_NODE_VERSION),
    details: [],
  });

  // Policy
  const display = tildify(ctx.policyLoader.path, ctx.homeDir);
  let policy: LoadedPolicy | null = null;
  try {
    policy = await ctx.policyLoader.loadAndValidate();
    checks.push({
      id: "policy",
      level: "ok",
      title: msg.doctor.policyOk(
        display,
        policy.hash,
        Object.keys(policy.spec.workflow.stages).length,
        Object.keys(policy.spec.agents).length,
      ),
      details: [],
    });
    if (policy.warnings.length > 0) {
      checks.push({
        id: "policy.warnings",
        level: "warning",
        title: msg.doctor.policyWarnings(policy.warnings.length),
        count: policy.warnings.length,
        details: policy.warnings.flatMap((w) => issueLines(w, "warning", s, "")),
      });
    }
    checks.push({ id: "policy.models", level: "info", title: msg.doctor.models(modelUsage(policy)), details: [] });
  } catch (err) {
    if (!(err instanceof PolicyError)) throw err;
    checks.push({
      id: "policy",
      level: "error",
      title: msg.doctor.policyFailed(display),
      details: policyProblemLines(err, s, ""),
    });
  }

  if (policy) {
    const pi = runtime ?? new PiAgentRuntime({ agentDir: ctx.env["PI_CODING_AGENT_DIR"] ?? path.join(ctx.homeDir, ".pi", "agent"), cwd: ctx.cwd });
    try {
      const probe = await pi.probe();
      checks.push({ id: "pi", level: probe.ok ? "ok" : "error", title: probe.ok ? msg.doctor.piSdk(probe.sdkVersion ?? "?") : msg.doctor.piSdkError, details: probe.problems });
      if (probe.sdkVersion) {
        const installed = await ctx.exec("pi", ["--version"], { cwd: ctx.cwd, timeoutMs: 5_000 }).catch(() => null);
        const cli = installed?.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
        if (cli && cli !== probe.sdkVersion) checks.push({ id: "pi.version", level: "warning", title: msg.doctor.piVersionMismatch(probe.sdkVersion, cli), details: [] });
        else if (!cli) checks.push({ id: "pi.version", level: "info", title: msg.doctor.piCliMissing, details: [] });
      }
      const refs = [...new Set([...agentList(policy.spec).map((a) => [a.model, a.thinking, a.piResources.extensions] as const), [policy.spec.supervisor.model, policy.spec.supervisor.thinking, policy.spec.supervisor.piResources.extensions] as const].map((r) => JSON.stringify(r)))];
      for (const encoded of refs) {
        const [ref, thinking, extensions] = JSON.parse(encoded) as [string, typeof policy.spec.supervisor.thinking, typeof policy.spec.supervisor.piResources.extensions];
        try {
          const found = await pi.resolveModel({ ref, thinking, extensions: extensions === "inherit" });
          checks.push({ id: "pi.model", level: "ok", title: msg.doctor.piModelOk(ref, found.id), details: [] });
        } catch (err) {
          checks.push({ id: "pi.model", level: "error", title: msg.doctor.piModelError(ref), details: [err instanceof Error ? err.message : String(err)] });
        }
      }
    } catch (err) {
      checks.push({ id: "pi", level: "error", title: msg.doctor.piSdkError, details: [err instanceof Error ? err.message : String(err)] });
    } finally {
      if (!runtime) await pi.dispose();
    }
  }

  // Project root
  const project = await detectProjectRoot(ctx.cwd, ctx.exec);
  checks.push({ id: "project.root", level: "ok", title: msg.doctor.projectRoot(project.root, project.source), details: [] });
  try {
    await access(project.root, constants.R_OK | constants.W_OK);
    checks.push({ id: "project.access", level: "ok", title: msg.doctor.projectAccess, details: [] });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    checks.push({ id: "project.access", level: "error", title: msg.doctor.projectAccessFailed(code), details: [] });
  }

  // Хранилище: только если .teo уже есть, doctor его не создаёт
  const store = openProject(ctx, { project, policy });
  const teoExists = await store.teoExists();
  if (teoExists) {
    checks.push(...(await storageChecks(ctx, store)));
  } else {
    checks.push({ id: "storage", level: "info", title: msg.doctor.teoAbsent, details: [] });
  }

  return { checks, policyValid: policy !== null, store, teoExists };
}

/** Свежий heartbeat живого владельца: проект просто занят, это не проблема. */
const LIVE_HEARTBEAT_MS = 30_000;

async function storageChecks(ctx: AppContext, store: ProjectStore): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const now = ctx.clock.now();
  const S = msg.storage;
  const layout = store.layout;

  const gitignore = await readFile(layout.gitignore, "utf8").catch(() => null);
  out.push(
    gitignore === GITIGNORE_CONTENT
      ? { id: "storage.gitignore", level: "ok", title: S.gitignoreOk, details: [] }
      : { id: "storage.gitignore", level: "info", title: S.gitignoreMissing, details: [] },
  );

  const lock = await store.locks.inspect();
  const lockLine = lockText(lock, now);
  if (lock.kind === "none") {
    out.push({ id: "storage.lock", level: "ok", title: S.lockFree, details: [] });
  } else if (lock.kind === "unreadable") {
    out.push({ id: "storage.lock", level: "warning", title: S.lockUnreadable, details: [] });
  } else if (lock.alive === null) {
    out.push({ id: "storage.lock", level: "warning", title: S.lockForeign(lockLine), details: [] });
  } else if (!lock.alive) {
    out.push({ id: "storage.lock", level: "warning", title: S.lockDead(lockLine), details: [] });
  } else {
    const age = now.getTime() - new Date(holderOf(lock)?.heartbeatAt ?? 0).getTime();
    out.push(
      age <= LIVE_HEARTBEAT_MS
        ? { id: "storage.lock", level: "info", title: S.lockLive(lockLine), details: [] }
        : { id: "storage.lock", level: "warning", title: S.lockStaleHeartbeat(lockLine), details: [] },
    );
  }

  // Задачи: state.json и инварианты
  const listings = await store.listTasks();
  const valid = listings.flatMap((l) => (l.ok ? [l.snapshot.state] : []));
  const corrupted = listings.flatMap((l) => (l.ok ? [] : [l.error]));
  if (corrupted.length > 0) {
    out.push({
      id: "storage.tasks",
      level: "error",
      title: S.taskCorrupted(corrupted.length),
      details: corrupted.flatMap((e) => e.message.split("\n")),
      count: corrupted.length,
    });
  }
  out.push({
    id: "storage.tasks.ok",
    level: valid.length > 0 || corrupted.length > 0 ? "ok" : "info",
    title: valid.length > 0 || corrupted.length > 0 ? S.tasksOk(valid.length) : S.tasksNone,
    details: [],
  });

  // Журналы: целостность и доставка outbox
  const journalErrors: string[] = [];
  const journalWarnings: string[] = [];
  for (const state of valid) {
    try {
      const { events, broken } = await store.tasks.journal(state.key).readAll();
      if (broken) journalWarnings.push(S.journalBrokenTail(state.key, broken.bytes.length));
      const undelivered = undeliveredOutbox(state, events);
      if (undelivered.length > 0) journalWarnings.push(S.journalUndelivered(state.key, undelivered.length));
    } catch (err) {
      if (!(err instanceof TaskCorruptedError)) throw err;
      journalErrors.push(S.journalCorrupted(state.key, err.line));
    }
  }
  if (journalErrors.length > 0) {
    out.push({ id: "storage.events.corrupted", level: "error", title: S.journalProblems(journalErrors.length), details: journalErrors, count: journalErrors.length });
  }
  if (journalWarnings.length > 0) {
    out.push({ id: "storage.events", level: "warning", title: S.journalProblems(journalWarnings.length), details: journalWarnings, count: journalWarnings.length });
  }
  if (valid.length > 0 && journalErrors.length + journalWarnings.length === 0) {
    out.push({ id: "storage.events", level: "ok", title: S.journalOk, details: [] });
  }

  // Ссылки state на файлы: run всегда, сессия — когда run уже завершился (файл появляется с первым сообщением)
  const missing: string[] = [];
  const exists = (p: string) => stat(p).then(() => true, () => false);
  for (const state of valid) {
    const run = state.currentRun;
    if (!run) continue;
    const t = store.tasks.task(state.key);
    const runFile = path.join(t.runsDir, `${run.runId}.json`);
    if (!(await exists(runFile))) missing.push(S.refMissing(state.key, path.relative(t.dir, runFile)));
    if ((run.status === "settled" || run.status === "failed") && !(await exists(path.join(t.dir, run.sessionFile)))) {
      missing.push(S.refMissing(state.key, run.sessionFile));
    }
  }
  if (missing.length > 0) {
    out.push({ id: "storage.refs", level: "warning", title: S.refsMissing(missing.length), details: missing, count: missing.length });
  } else if (valid.some((s) => s.currentRun)) {
    out.push({ id: "storage.refs", level: "ok", title: S.refsOk, details: [] });
  }

  out.push(
    indexMatches(await store.index.read(), valid)
      ? { id: "storage.index", level: "ok", title: S.indexOk, details: [] }
      : { id: "storage.index", level: "warning", title: S.indexStale, details: [] },
  );

  const orphans = await store.findOrphans();
  out.push(
    orphans.length === 0
      ? { id: "storage.orphans", level: "ok", title: S.orphansNone, details: [] }
      : {
          id: "storage.orphans",
          level: "info",
          title: S.orphans(orphans.length),
          details: orphans.map((p) => path.relative(layout.teoDir, p)),
        },
  );
  return out;
}

export function renderDoctor(ctx: AppContext, checks: readonly DoctorCheck[]): string {
  const s = ctx.style;
  const mark: Record<CheckLevel, string> = {
    ok: s.green("✓"),
    info: s.dim("·"),
    warning: s.yellow("!"),
    error: s.red("✗"),
    skipped: s.dim("–"),
  };
  const lines = [s.bold(msg.doctor.title), ""];
  for (const c of checks) {
    const title = c.level === "skipped" ? s.dim(c.title) : c.title;
    lines.push(`${mark[c.level]} ${title}`);
    for (const d of c.details) lines.push(d ? `    ${d}` : "");
  }
  lines.push("", summaryLine(checks));
  return lines.join("\n") + "\n";
}

function exitCode(policyValid: boolean, checks: readonly DoctorCheck[]): number {
  if (!policyValid) return ExitCode.config;
  return checks.some((c) => c.level === "error") ? ExitCode.runtime : ExitCode.ok;
}

function summaryLine(checks: readonly DoctorCheck[]): string {
  const errors = checks.filter((c) => c.level === "error").length;
  const warnings = checks.filter((c) => c.level === "warning").reduce((n, c) => n + (c.count ?? 1), 0);
  return msg.doctor.summary(errors, warnings);
}

export async function runDoctor(ctx: AppContext, opts: { fix: boolean; piRuntime?: AgentRuntime }): Promise<number> {
  const first = await collectDoctorChecks(ctx, opts.piRuntime);
  ctx.stdout.write(renderDoctor(ctx, first.checks));
  if (!opts.fix) return exitCode(first.policyValid, first.checks);

  const out = (text: string) => (ctx.human ? ctx.human.print(text) : ctx.stdout.write(text));
  out("\n");
  // Исправления хранилища — только с валидной Policy: по ней строятся названия этапов в index.json
  if (!first.policyValid) {
    out(ctx.style.yellow(msg.doctor.fix.policyFirst) + "\n");
    return ExitCode.config;
  }
  if (!first.teoExists) {
    out(msg.doctor.fix.nothing + "\n");
    return exitCode(first.policyValid, first.checks);
  }
  const plan = await planFixes(ctx, first.store);
  const results = await runFixes(first.store, plan, ctx.human);
  out(renderFixes(ctx, plan, results));
  if (!results.some((r) => r.outcome === "applied")) return exitCode(first.policyValid, first.checks);

  const after = await collectDoctorChecks(ctx, opts.piRuntime);
  out("\n" + msg.doctor.fix.after(summaryLine(after.checks)) + "\n");
  return exitCode(after.policyValid, after.checks);
}
