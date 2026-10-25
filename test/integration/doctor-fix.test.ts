// sdlc doctor --fix (05-cli-ui.md §7): каждое исправление хранилища, подтверждения, опасные случаи.

import { existsSync, readFileSync } from "node:fs";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "../../src/agents/runtime.js";
import { runDoctor } from "../../src/commands/doctor.js";
import { GITIGNORE_CONTENT } from "../../src/state/layout.js";
import { LockManager } from "../../src/state/lock-manager.js";
import { projectLayout } from "../../src/state/layout.js";
import { systemClock } from "../../src/util/clock.js";
import { testContext } from "../helpers/context.js";
import { deadPid } from "../helpers/dead-pid.js";
import { validDir } from "../helpers/paths.js";
import { ScriptedHumanIO } from "../helpers/scripted-human-io.js";
import { runCli, sandbox, type Sandbox } from "../helpers/tmp.js";

const POLICY = readFileSync(path.join(validDir, "discover-execute-done.md"));
const piRuntime = {
  probe: async () => ({ sdkVersion: "1.4.0", ok: true, problems: [] }),
  resolveModel: async () => ({ id: "test/model", thinking: null, providedBy: null, handle: null }),
} as unknown as AgentRuntime;

async function project(...keys: string[]): Promise<Sandbox> {
  const sb = await sandbox(POLICY);
  for (const key of keys) {
    const r = await runCli(sb, ["new", key, "--title", `Задача ${key}`, "--description", "d", "--no-run"]);
    expect(r.code, r.stderr).toBe(0);
  }
  return sb;
}

const layoutOf = (sb: Sandbox) => projectLayout(sb.project);
const taskFile = (sb: Sandbox, key: string, name: string) => path.join(layoutOf(sb).tasksDir, key, name);

async function writeLock(sb: Sandbox, fields: { pid: number; hostname: string }): Promise<void> {
  const now = systemClock.now().toISOString();
  await writeFile(
    layoutOf(sb).lock,
    JSON.stringify({ ...fields, processStartedAt: now, taskKey: "T-1", command: "resume", acquiredAt: now, heartbeatAt: now, nonce: "abcdef12" }),
  );
}

async function doctorFix(sb: Sandbox, human: ScriptedHumanIO | null = null) {
  const ctx = testContext(sb, { human });
  const code = await runDoctor(ctx, { fix: true, piRuntime });
  return { code, out: ctx.out() + (human?.printed ?? "") };
}

describe("doctor --fix", () => {
  it("без терминала чинит всё безопасное: lock умершего процесса, .gitignore, *.tmp, журналы, index", async () => {
    const sb = await project("T-1", "T-2");
    const layout = layoutOf(sb);
    const pid = await deadPid();
    await rm(layout.gitignore);
    const orphan = taskFile(sb, "T-1", `.state.json.${pid}.abcdef.tmp`);
    await writeFile(orphan, "{}");
    await appendFile(taskFile(sb, "T-1", "events.jsonl"), '{"id":"01J');
    // Журнал T-2 потерял единственное событие: оно осталось только в outbox state.json
    await writeFile(taskFile(sb, "T-2", "events.jsonl"), "");
    await rm(layout.index);
    await writeLock(sb, { pid, hostname: os.hostname() });

    const { code, out } = await doctorFix(sb);
    expect(out).toContain("Исправления:");
    for (const line of [
      "✓ Снять протухший lock",
      "✓ Создать .sdlc/.gitignore",
      "✓ Удалить осиротевшие временные файлы (1)",
      "✓ Починить журнал T-1: обрезать оборванную запись",
      "✓ Починить журнал T-2: дописать outbox (1)",
      "✓ Перестроить .sdlc/index.json",
    ]) expect(out).toContain(line);
    expect(out).toContain("После исправлений: проблем не найдено.");
    expect(code).toBe(0);

    expect(await readFile(layout.gitignore, "utf8")).toBe(GITIGNORE_CONTENT);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(layout.lock)).toBe(false);
    expect(existsSync(layout.index)).toBe(true);
    expect((await readFile(taskFile(sb, "T-2", "events.jsonl"), "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
    expect(await readFile(taskFile(sb, "T-1", "events.jsonl"), "utf8")).toContain("truncated_event_tail");

    // Повторный запуск: исправлять нечего
    expect((await doctorFix(sb)).out).toContain("Исправлять нечего.");
  });

  it("спрашивает про каждое исправление; отказ ничего не меняет", async () => {
    const sb = await project("T-1");
    const layout = layoutOf(sb);
    await rm(layout.gitignore);
    await rm(layout.index);
    const human = new ScriptedHumanIO([{ confirm: false }, { confirm: true }]);
    const { out } = await doctorFix(sb, human);
    expect(human.remaining).toBe(0);
    expect(out).toContain("– Создать .sdlc/.gitignore — пропущено");
    expect(out).toContain("✓ Перестроить .sdlc/index.json");
    expect(existsSync(layout.gitignore)).toBe(false);
  });

  it("lock другого хоста: без терминала не снимается, в терминале — только по явному «да»", async () => {
    const sb = await project("T-1");
    const layout = layoutOf(sb);
    await rm(layout.index);
    await writeLock(sb, { pid: 12345, hostname: "other-host.local" });

    const auto = await doctorFix(sb);
    expect(auto.out).toContain("– Снять lock другого хоста");
    expect(auto.out).toContain("– Перестроить .sdlc/index.json — lock проекта не снят");
    expect(existsSync(layout.lock)).toBe(true);

    const human = new ScriptedHumanIO([{ confirm: true }, { confirm: true }]);
    const { out, code } = await doctorFix(sb, human);
    expect(human.output.join("\n")).toContain("Это нельзя проверить автоматически.");
    expect(out).toContain("✓ Снять lock другого хоста");
    expect(out).toContain("✓ Перестроить .sdlc/index.json");
    expect(existsSync(layout.lock)).toBe(false);
    expect(code).toBe(0);
  });

  it("живой владелец lock-а: исправления хранилища невозможны", async () => {
    const sb = await project("T-1");
    await rm(layoutOf(sb).index);
    const held = await new LockManager({
      file: layoutOf(sb).lock,
      clock: systemClock,
      hostname: os.hostname(),
      pid: process.pid,
      processStartedAt: systemClock.now().toISOString(),
    }).acquire({ command: "resume", taskKey: "T-1" });
    try {
      const { out } = await doctorFix(sb);
      expect(out).toContain("– Перестроить .sdlc/index.json — Проект занят живым процессом");
      expect(existsSync(layoutOf(sb).index)).toBe(false);
    } finally {
      await held.release();
    }
  });

  it("невалидная Policy: сначала её исправить, exit 2", async () => {
    const sb = await project("T-1");
    await writeFile(sb.policyPath, "без front matter");
    const { code, out } = await doctorFix(sb);
    expect(code).toBe(2);
    expect(out).toContain("Сначала исправьте Policy");
  });
});
