// Composition root: собирает сервисы и общий контекст команд. Решений не принимает.

import os from "node:os";
import type { Readable, Writable } from "node:stream";
import type { LoadedPolicy } from "./domain/policy.js";
import { PolicyLoader, defaultPolicyPath } from "./policy/policy-loader.js";
import { detectProjectRoot, type ProjectRoot } from "./project/project-root.js";
import { ProjectStore } from "./state/project-store.js";
import type { HumanIO } from "./ui/human-io.js";
import { createInteractiveHumanIO } from "./ui/interactive-human-io.js";
import { createStyle, type Style } from "./ui/plain/style.js";
import { systemClock, type Clock } from "./util/clock.js";
import { execFileNoThrow, type Exec } from "./util/exec.js";
import { faultsFromEnv, type FaultInjector } from "./util/fault.js";
import { DebugLog } from "./util/debug-log.js";
import { createIdGenerator, type IdGenerator } from "./util/ids.js";

export type Output = { write(chunk: string): unknown; isTTY?: boolean };

export type ProcessInfo = { pid: number; hostname: string; startedAt: string };

export type AppContext = {
  cwd: string;
  homeDir: string;
  env: Record<string, string | undefined>;
  stdin: Readable;
  stdout: Output;
  stderr: Output;
  /** Терминал на входе и выходе: можно задавать вопросы; --plain выбирает линейный HumanIO. */
  interactive: boolean;
  /** null без терминала: команды, которым нужен ответ человека, требуют флагов */
  human: HumanIO | null;
  verbose: boolean;
  style: Style;
  clock: Clock;
  ids: IdGenerator;
  faults: FaultInjector;
  exec: Exec;
  process: ProcessInfo;
  nodeVersion: string;
  policyLoader: PolicyLoader;
  /** .teo/debug.log: пишется всегда, в stderr — только с --verbose */
  debugLog: DebugLog;
  log(message: string): void;
};

export type AppOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable & { isTTY?: boolean };
  color: boolean;
  plain: boolean;
  verbose: boolean;
};

export function createAppContext(o: AppOptions): AppContext {
  // os.homedir() учитывает HOME: так e2e-тесты подменяют ~/.pi/SDLC.md (01-policy.md §1.1)
  const homeDir = os.homedir();
  const env = o.env ?? process.env;
  const style = createStyle(o.color);
  const interactive = o.stdin.isTTY === true && o.stdout.isTTY === true;
  const clock = systemClock;
  const debugLog = new DebugLog(() => clock.now());
  return {
    cwd: o.cwd ?? process.cwd(),
    homeDir,
    env,
    stdin: o.stdin,
    stdout: o.stdout,
    stderr: o.stderr,
    interactive,
    human: interactive ? createInteractiveHumanIO(o.stdin, o.stdout, o.stderr, clock, style, o.plain) : null,
    verbose: o.verbose,
    style,
    clock,
    ids: createIdGenerator(clock),
    faults: faultsFromEnv(env["TEO_FAULT"]),
    exec: execFileNoThrow,
    process: { pid: process.pid, hostname: os.hostname(), startedAt: clock.now().toISOString() },
    nodeVersion: process.versions.node,
    policyLoader: new PolicyLoader(defaultPolicyPath(homeDir)),
    debugLog,
    log: (message) => {
      debugLog.write(message);
      if (o.verbose) o.stderr.write(style.dim(`[teo] ${message}`) + "\n");
    },
  };
}

export type Preflight = { project: ProjectRoot; policy: LoadedPolicy };

/**
 * Общий старт команд (05-cli-ui.md §1): project root (только чтение), затем preflight Policy.
 * Ошибка Policy бросается как PolicyError (exit 2) до любой записи в .teo.
 */
export async function preflight(ctx: AppContext): Promise<Preflight> {
  const project = await detectProjectRoot(ctx.cwd, ctx.exec);
  const policy = await ctx.policyLoader.loadAndValidate();
  return { project, policy };
}

/** Хранилище проекта. Ничего не создаёт: .teo появляется при первой mutating-операции. */
export function openProject(ctx: AppContext, pf: { project: ProjectRoot; policy: LoadedPolicy | null }): ProjectStore {
  const store = new ProjectStore({
    projectRoot: pf.project.root,
    policy: pf.policy,
    clock: ctx.clock,
    ids: ctx.ids,
    faults: ctx.faults,
    hostname: ctx.process.hostname,
    pid: ctx.process.pid,
    processStartedAt: ctx.process.startedAt,
    log: ctx.log,
  });
  ctx.debugLog.attach(store.layout.debugLog);
  return store;
}

/** preflight + хранилище проекта: начало любой команды, кроме doctor. */
export async function startCommand(ctx: AppContext): Promise<Preflight & { store: ProjectStore }> {
  const pf = await preflight(ctx);
  return { ...pf, store: openProject(ctx, pf) };
}
