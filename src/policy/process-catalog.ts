// Каталог процессов ~/.pi/teo/<процесс>.md (docs/07-extension-mode.md §3, D32).
// Имя процесса — имя файла без .md. Каждый файл — отдельная Policy со своим preflight.

import { readdir } from "node:fs/promises";
import path from "node:path";
import { PROCESS_NAME_RE, type LoadedPolicy } from "../domain/policy.js";
import { PolicyError } from "../errors/errors.js";
import { loadPolicyFile } from "./policy-loader.js";

export { PROCESS_NAME_RE };
const EXT = ".md";

export type ProcessEntry =
  | { name: string; path: string; ok: true; policy: LoadedPolicy }
  | { name: string; path: string; ok: false; error: PolicyError };

export function defaultProcessesDir(homeDir: string): string {
  return path.join(homeDir, ".pi", "teo");
}

export class ProcessCatalog {
  constructor(readonly dir: string) {}

  pathOf(name: string): string {
    return path.join(this.dir, `${name}${EXT}`);
  }

  /** Файлы *.md каталога: имена процессов и файлы с недопустимым именем (их показывает doctor). */
  async scan(): Promise<{ names: string[]; badNames: string[] }> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return { names: [], badNames: [] };
    }
    const md = entries.filter((e) => e.endsWith(EXT) && !e.startsWith(".")).sort();
    const names = md.map((e) => e.slice(0, -EXT.length));
    return { names: names.filter((n) => PROCESS_NAME_RE.test(n)), badNames: md.filter((_, i) => !PROCESS_NAME_RE.test(names[i] ?? "")) };
  }

  /** Полный preflight процесса. Файл перечитывается при каждом вызове: кэша нет. */
  async load(name: string): Promise<LoadedPolicy> {
    return loadPolicyFile(this.pathOf(name));
  }

  async loadAll(): Promise<ProcessEntry[]> {
    const out: ProcessEntry[] = [];
    for (const name of (await this.scan()).names) {
      const file = this.pathOf(name);
      try {
        out.push({ name, path: file, ok: true, policy: await this.load(name) });
      } catch (err) {
        if (!(err instanceof PolicyError)) throw err;
        out.push({ name, path: file, ok: false, error: err });
      }
    }
    return out;
  }

  noProcessesError(): PolicyError {
    return new PolicyError("POLICY_NO_PROCESSES", this.dir, []);
  }
}
