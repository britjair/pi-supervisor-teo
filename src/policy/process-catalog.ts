// Каталог процессов ~/.pi/teo/<процесс>.md (docs/07-extension-mode.md §3, D32).
// Имя процесса — имя файла без .md. Каждый файл — отдельная Policy со своим preflight.
// Встроенные процессы пакета (processes/*.md, сейчас — режим цели, D35) доступны всегда;
// пользовательский файл с тем же именем их заменяет.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROCESS_NAME_RE, type LoadedPolicy } from "../domain/policy.js";
import { PolicyError } from "../errors/errors.js";
import { loadPolicyFile } from "./policy-loader.js";

export { PROCESS_NAME_RE };
const EXT = ".md";

/** Встроенный процесс режима цели: `teo new --goal` (D35). */
export const GOAL_PROCESS = "goal";

export type ProcessEntry =
  | { name: string; path: string; builtin: boolean; ok: true; policy: LoadedPolicy }
  | { name: string; path: string; builtin: boolean; ok: false; error: PolicyError };

export function defaultProcessesDir(homeDir: string): string {
  return path.join(homeDir, ".pi", "teo");
}

/**
 * Каталог processes/ пакета. Модуль лежит в src/policy/ (тесты) или собран в dist/cli.js,
 * поэтому ищем вверх ближайший каталог с package.json и processes/.
 */
export function builtinProcessesDir(from: string = fileURLToPath(import.meta.url)): string | null {
  for (let dir = path.dirname(from); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "processes"))) return path.join(dir, "processes");
    if (path.dirname(dir) === dir) return null;
  }
}

async function mdNames(dir: string | null): Promise<string[]> {
  if (!dir) return [];
  try {
    return (await readdir(dir)).filter((e) => e.endsWith(EXT) && !e.startsWith(".")).sort();
  } catch {
    return [];
  }
}

export class ProcessCatalog {
  constructor(
    readonly dir: string,
    readonly builtinDir: string | null = builtinProcessesDir(),
  ) {}

  pathOf(name: string): string {
    return path.join(this.dir, `${name}${EXT}`);
  }

  /** Пользовательские файлы *.md: имена процессов и файлы с недопустимым именем (их показывает doctor). */
  async scan(): Promise<{ names: string[]; badNames: string[] }> {
    const md = await mdNames(this.dir);
    const names = md.map((e) => e.slice(0, -EXT.length));
    return { names: names.filter((n) => PROCESS_NAME_RE.test(n)), badNames: md.filter((_, i) => !PROCESS_NAME_RE.test(names[i] ?? "")) };
  }

  private async builtinNames(): Promise<string[]> {
    return (await mdNames(this.builtinDir)).map((e) => e.slice(0, -EXT.length)).filter((n) => PROCESS_NAME_RE.test(n));
  }

  /** Файл процесса: пользовательский, иначе встроенный. null — процесса нет. */
  private async resolve(name: string): Promise<{ path: string; builtin: boolean } | null> {
    if (existsSync(this.pathOf(name))) return { path: this.pathOf(name), builtin: false };
    if (this.builtinDir && (await this.builtinNames()).includes(name)) return { path: path.join(this.builtinDir, `${name}${EXT}`), builtin: true };
    return null;
  }

  /** Полный preflight процесса. Файл перечитывается при каждом вызове: кэша нет. */
  async load(name: string): Promise<LoadedPolicy> {
    return loadPolicyFile((await this.resolve(name))?.path ?? this.pathOf(name));
  }

  /** Пользовательские процессы, затем встроенные, которые не заменены пользовательскими. */
  async loadAll(): Promise<ProcessEntry[]> {
    const user = (await this.scan()).names;
    const builtin = (await this.builtinNames()).filter((n) => !user.includes(n));
    const out: ProcessEntry[] = [];
    for (const [name, isBuiltin] of [...user.map((n) => [n, false] as const), ...builtin.map((n) => [n, true] as const)]) {
      const file = isBuiltin && this.builtinDir ? path.join(this.builtinDir, `${name}${EXT}`) : this.pathOf(name);
      try {
        out.push({ name, path: file, builtin: isBuiltin, ok: true, policy: await loadPolicyFile(file) });
      } catch (err) {
        if (!(err instanceof PolicyError)) throw err;
        out.push({ name, path: file, builtin: isBuiltin, ok: false, error: err });
      }
    }
    return out;
  }

  noProcessesError(): PolicyError {
    return new PolicyError("POLICY_NO_PROCESSES", this.dir, []);
  }
}
