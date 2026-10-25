import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { cliPath } from "./paths.js";

const created: string[] = [];

/** Временный каталог, удаляется после теста. */
export async function tmpDir(prefix = "sdlc-test-"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

export type Sandbox = { root: string; home: string; project: string; policyPath: string };

/** HOME и проект во временном каталоге. Policy кладётся в HOME/.pi/SDLC.md, если передана. */
export async function sandbox(policy?: string | Uint8Array, opts: { git?: boolean } = {}): Promise<Sandbox> {
  const root = await tmpDir();
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  await mkdir(path.join(home, ".pi"), { recursive: true });
  await mkdir(project, { recursive: true });
  const policyPath = path.join(home, ".pi", "SDLC.md");
  if (policy !== undefined) await writeFile(policyPath, policy);
  if (opts.git !== false) await run("git", ["init", "-q"], project);
  return { root, home, project, policyPath };
}

export type RunResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

function run(
  file: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
  input?: string,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      const signal = (error as { signal?: NodeJS.Signals } | null)?.signal ?? null;
      const code = error ? (typeof error.code === "number" ? error.code : signal ? null : 1) : 0;
      resolve({ code, signal, stdout, stderr });
    });
    // Процесс может завершиться, не прочитав stdin
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input ?? "");
  });
}

/** Запуск собранного CLI: `node dist/cli.js …` с подменённым HOME. TZ=UTC — время в выводе детерминировано. */
export function runCli(sb: Sandbox, args: string[], opts: { env?: Record<string, string>; input?: string } = {}): Promise<RunResult> {
  return run(process.execPath, [cliPath, ...args], sb.project, { HOME: sb.home, NO_COLOR: "1", TZ: "UTC", ...opts.env }, opts.input);
}

export { run as runProcess };
