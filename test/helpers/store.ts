// ProjectStore на временном каталоге с FakeClock, без процесса CLI.

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePolicyBytes } from "../../src/policy/policy-loader.js";
import { createTask } from "../../src/commands/new.js";
import { ProjectStore } from "../../src/state/project-store.js";
import type { FaultInjector } from "../../src/util/fault.js";
import { createIdGenerator } from "../../src/util/ids.js";
import { FakeClock } from "./fake-clock.js";
import { validDir } from "./paths.js";
import { tmpDir } from "./tmp.js";

export const testPolicy = () => {
  const file = path.join(validDir, "discover-execute-done.md");
  return parsePolicyBytes(readFileSync(file), file);
};

export async function testStore(
  opts: { root?: string; clock?: FakeClock; faults?: FaultInjector; pid?: number; isAlive?: (pid: number) => boolean } = {},
) {
  const root = opts.root ?? (await tmpDir("teo-store-"));
  const clock = opts.clock ?? new FakeClock();
  const store = new ProjectStore({
    projectRoot: root,
    policy: testPolicy(),
    clock,
    ids: createIdGenerator(clock),
    ...(opts.faults ? { faults: opts.faults } : {}),
    hostname: os.hostname(),
    pid: opts.pid ?? process.pid,
    processStartedAt: clock.now().toISOString(),
    ...(opts.isAlive ? { isAlive: opts.isAlive } : {}),
  });
  return { root, clock, store };
}

export async function newTask(store: ProjectStore, key: string, title = `Задача ${key}`) {
  return createTask(store, { key, title, description: `Описание ${key}` });
}
