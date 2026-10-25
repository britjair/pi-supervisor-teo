// Определение корня проекта, раздел 6 SDLC_CLI_SPEC.md. Только чтение.

import { realpath } from "node:fs/promises";
import type { Exec } from "../util/exec.js";

export type ProjectRoot = {
  root: string;
  /** git — корень репозитория (`git rev-parse --show-toplevel`), cwd — текущий каталог */
  source: "git" | "cwd";
};

export const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };

export async function detectProjectRoot(cwd: string, exec: Exec): Promise<ProjectRoot> {
  try {
    const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, env: GIT_ENV, timeoutMs: 10_000 });
    const top = r.stdout.trim();
    if (r.code === 0 && top) return { root: await realpath(top), source: "git" };
  } catch {
    // git не установлен или не запустился — работаем от текущего каталога
  }
  return { root: await realpath(cwd), source: "cwd" };
}
