// runs/<runId>.json — полная запись agent run (02-storage.md §5). State хранит только ссылку.

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isValid } from "ulid";
import type { AgentRunRecord } from "../domain/runs.js";
import { TaskCorruptedError } from "../errors/errors.js";
import { writeFileAtomic } from "./atomic-file.js";
import type { TaskLayout } from "./layout.js";

export class RunStore {
  constructor(private readonly task: TaskLayout) {}

  /** runId — ULID: это исключает выход пути за каталог runs/. */
  pathFor(runId: string): string {
    if (!isValid(runId)) throw new Error(`Некорректный runId: ${runId}`);
    return path.join(this.task.runsDir, `${runId}.json`);
  }

  async read(runId: string): Promise<AgentRunRecord | null> {
    const file = this.pathFor(runId);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    try {
      const record = JSON.parse(text) as AgentRunRecord;
      if (record.runId !== runId) throw new Error("runId в файле не совпадает с именем");
      return record;
    } catch (err) {
      throw new TaskCorruptedError(this.task.key, file, `запись run не разбирается (${(err as Error).message})`);
    }
  }

  async write(record: AgentRunRecord): Promise<void> {
    await mkdir(this.task.runsDir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.pathFor(record.runId), JSON.stringify(record, null, 2) + "\n");
  }
}
