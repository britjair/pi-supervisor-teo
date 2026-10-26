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

/** Ветка и чистота рабочего дерева для формы создания задачи; null — не git или git недоступен. */
export async function gitSummary(root: string, exec: Exec): Promise<{ branch: string; clean: boolean } | null> {
  try {
    const opts = { cwd: root, env: GIT_ENV, timeoutMs: 10_000 };
    const [branch, status] = await Promise.all([
      exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], opts),
      exec("git", ["status", "--porcelain", "--", ".", ":(exclude).teo"], opts),
    ]);
    if (branch.code !== 0 || status.code !== 0) {
      // Репозиторий без коммитов: HEAD ещё не указывает на ветку
      const sym = await exec("git", ["symbolic-ref", "--short", "HEAD"], opts);
      if (sym.code !== 0 || status.code !== 0) return null;
      return { branch: sym.stdout.trim(), clean: status.stdout.trim() === "" };
    }
    return { branch: branch.stdout.trim(), clean: status.stdout.trim() === "" };
  } catch {
    return null;
  }
}
