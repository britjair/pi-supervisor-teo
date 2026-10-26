// .teo/index.json — кэш для меню, не источник истины (02-storage.md §8).

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { PHASES, TASK_STATUSES, type Phase, type TaskState } from "../domain/task-state.js";
import type { Clock } from "../util/clock.js";
import { writeFileAtomic } from "./atomic-file.js";

export type IndexEntry = {
  key: string;
  title: string;
  process: string;
  stage: string;
  /** Из Policy на момент записи; null, если этапа нет в Policy */
  stageTitle: string | null;
  status: TaskState["status"];
  phase: Phase;
  /** wait.dueAt при phase = waiting */
  dueAt: string | null;
  updatedAt: string;
  stateVersion: number;
};

export type ProjectIndex = {
  schemaVersion: 1;
  generatedAt: string;
  tasks: IndexEntry[];
};

const indexSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  tasks: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      process: z.string(),
      stage: z.string(),
      stageTitle: z.string().nullable(),
      status: z.enum(TASK_STATUSES),
      phase: z.enum(PHASES),
      dueAt: z.string().nullable(),
      updatedAt: z.string(),
      stateVersion: z.int(),
    }),
  ),
});

export type StageTitleResolver = (processName: string, stageId: string) => string | null;

export function indexEntry(state: TaskState, stageTitle: StageTitleResolver): IndexEntry {
  return {
    key: state.key,
    title: state.title,
    process: state.process,
    stage: state.stage,
    stageTitle: stageTitle(state.process, state.stage),
    status: state.status,
    phase: state.phase,
    dueAt: state.wait?.dueAt ?? null,
    updatedAt: state.updatedAt,
    stateVersion: state.version,
  };
}

const byUpdatedDesc = (a: IndexEntry, b: IndexEntry) => b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key);

export class IndexStore {
  constructor(
    readonly file: string,
    private readonly clock: Clock,
  ) {}

  /** null — файла нет или он не разбирается: его можно перестроить из state-файлов. */
  async read(): Promise<ProjectIndex | null> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    try {
      const parsed = indexSchema.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async write(entries: readonly IndexEntry[]): Promise<ProjectIndex> {
    const index: ProjectIndex = {
      schemaVersion: 1,
      generatedAt: this.clock.now().toISOString(),
      tasks: [...entries].sort(byUpdatedDesc),
    };
    await writeFileAtomic(this.file, JSON.stringify(index, null, 2) + "\n");
    return index;
  }

  /** Заменить запись одной задачи (после commit). */
  async upsert(entry: IndexEntry): Promise<void> {
    const current = (await this.read())?.tasks ?? [];
    await this.write([...current.filter((e) => e.key !== entry.key), entry]);
  }
}

/** Index согласован с state-файлами: те же задачи с теми же версиями. */
export function indexMatches(index: ProjectIndex | null, states: ReadonlyArray<{ key: string; version: number }>): boolean {
  if (!index) return states.length === 0;
  if (index.tasks.length !== states.length) return false;
  const versions = new Map(index.tasks.map((e) => [e.key, e.stateVersion]));
  return states.every((s) => versions.get(s.key) === s.version);
}
