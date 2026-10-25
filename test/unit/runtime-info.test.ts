import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeInfoWriter, readRuntimeInfo } from "../../src/state/runtime-info.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { tmpDir } from "../helpers/tmp.js";

const fields = (activity: string, phase: "agent_running" | "supervisor_running" = "agent_running") => ({
  phase,
  actor: "agent" as const,
  agentId: "worker",
  attempt: 1,
  activity,
  currentTool: null,
  usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
});

describe("RuntimeInfoWriter", () => {
  it("не чаще раза в интервал; смена фазы — сразу; remove удаляет файл", async () => {
    const file = path.join(await tmpDir(), "runtime.json");
    const clock = new FakeClock();
    const w = new RuntimeInfoWriter(file, clock, { pid: 1, hostname: "h", startedAt: clock.now().toISOString() }, 50);
    await w.update(fields("первое"));
    expect((await readRuntimeInfo(file))?.activity).toBe("первое");
    await w.update(fields("второе"));
    expect((await readRuntimeInfo(file))?.activity).toBe("первое");
    await w.update(fields("смена фазы", "supervisor_running"));
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ activity: "смена фазы", phase: "supervisor_running" });
    clock.advance(100);
    await w.update(fields("после интервала", "supervisor_running"));
    expect((await readRuntimeInfo(file))?.activity).toBe("после интервала");
    await w.remove();
    expect(await readRuntimeInfo(file)).toBeNull();
  });
});
