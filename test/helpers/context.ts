// AppContext для in-process тестов команд: вывод в память, подменяемые часы и HumanIO.

import os from "node:os";
import { PassThrough } from "node:stream";
import type { AppContext } from "../../src/app.js";
import { ProcessCatalog } from "../../src/policy/process-catalog.js";
import type { HumanIO } from "../../src/ui/human-io.js";
import { createStyle } from "../../src/ui/plain/style.js";
import type { Clock } from "../../src/util/clock.js";
import { execFileNoThrow } from "../../src/util/exec.js";
import { noFaults, type FaultInjector } from "../../src/util/fault.js";
import { DebugLog } from "../../src/util/debug-log.js";
import { createIdGenerator } from "../../src/util/ids.js";
import { FakeClock } from "./fake-clock.js";
import type { Sandbox } from "./tmp.js";

export type TestContext = AppContext & { out: () => string; err: () => string };

export function testContext(
  sb: Sandbox,
  opts: { clock?: Clock; human?: HumanIO | null; faults?: FaultInjector; nodeVersion?: string; color?: boolean } = {},
): TestContext {
  let out = "";
  let err = "";
  const clock = opts.clock ?? new FakeClock();
  const human = opts.human ?? null;
  return {
    cwd: sb.project,
    homeDir: sb.home,
    env: {},
    stdin: new PassThrough(),
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    interactive: human !== null,
    human,
    verbose: false,
    style: createStyle(opts.color ?? false),
    clock,
    ids: createIdGenerator(clock),
    faults: opts.faults ?? noFaults,
    exec: execFileNoThrow,
    process: { pid: process.pid, hostname: os.hostname(), startedAt: clock.now().toISOString() },
    nodeVersion: opts.nodeVersion ?? process.versions.node,
    processes: new ProcessCatalog(sb.processesDir),
    debugLog: new DebugLog(() => clock.now()),
    log: () => undefined,
    out: () => out,
    err: () => err,
  };
}
