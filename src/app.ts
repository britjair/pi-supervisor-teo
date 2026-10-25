// Composition root: собирает сервисы и общий контекст команд. Решений не принимает.

import os from "node:os";
import type { LoadedPolicy } from "./domain/policy.js";
import { PolicyLoader, defaultPolicyPath } from "./policy/policy-loader.js";
import { detectProjectRoot, type ProjectRoot } from "./project/project-root.js";
import { createStyle, type Style } from "./ui/plain/style.js";
import { systemClock, type Clock } from "./util/clock.js";
import { execFileNoThrow, type Exec } from "./util/exec.js";

export type Output = { write(chunk: string): unknown; isTTY?: boolean };

export type AppContext = {
  cwd: string;
  homeDir: string;
  env: Record<string, string | undefined>;
  stdout: Output;
  stderr: Output;
  interactive: boolean;
  verbose: boolean;
  style: Style;
  clock: Clock;
  exec: Exec;
  nodeVersion: string;
  policyLoader: PolicyLoader;
};

export type AppOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdout: Output;
  stderr: Output;
  stdinIsTTY: boolean;
  color: boolean;
  plain: boolean;
  verbose: boolean;
};

export function createAppContext(o: AppOptions): AppContext {
  // os.homedir() учитывает HOME: так e2e-тесты подменяют ~/.pi/SDLC.md (01-policy.md §1.1)
  const homeDir = os.homedir();
  return {
    cwd: o.cwd ?? process.cwd(),
    homeDir,
    env: o.env ?? process.env,
    stdout: o.stdout,
    stderr: o.stderr,
    interactive: !o.plain && o.stdinIsTTY && o.stdout.isTTY === true,
    verbose: o.verbose,
    style: createStyle(o.color),
    clock: systemClock,
    exec: execFileNoThrow,
    nodeVersion: process.versions.node,
    policyLoader: new PolicyLoader(defaultPolicyPath(homeDir)),
  };
}

export type Preflight = { project: ProjectRoot; policy: LoadedPolicy };

/**
 * Общий старт команд (05-cli-ui.md §1): project root (только чтение), затем preflight Policy.
 * Ошибка Policy бросается как PolicyError (exit 2) до любой записи в .sdlc.
 */
export async function preflight(ctx: AppContext): Promise<Preflight> {
  const project = await detectProjectRoot(ctx.cwd, ctx.exec);
  const policy = await ctx.policyLoader.loadAndValidate();
  return { project, policy };
}
