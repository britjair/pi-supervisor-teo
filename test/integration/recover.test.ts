// teo recover (05-cli-ui.md §2.1): каждая ситуация таблицы и флаги без меню.

import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeCrash, turn } from "../../src/agents/fake/fake-runtime.js";
import { recoverActions, runRecover, type RecoverSituation } from "../../src/commands/recover.js";
import type { TaskState } from "../../src/domain/task-state.js";
import { parsePolicyBytes } from "../../src/policy/policy-loader.js";
import { testContext } from "../helpers/context.js";
import { DED, Harness } from "../helpers/engine.js";
import { ScriptedHumanIO } from "../helpers/scripted-human-io.js";
import { runCli, sandbox } from "../helpers/tmp.js";

const EV = "$expectedStateVersion";
const sv = (action: string, args: Record<string, unknown> = {}) => turn.tool(action, { expectedStateVersion: EV, ...args });
const report = (summary = "готово") => turn.tool("report_result", { summary });
const EXPLORER = "sessions/explorer-001.jsonl";
const SUPERVISOR = "sessions/supervisor.jsonl";
const block = () => sv("block_task", { reason: "стоп", resolutionHint: "-" });

/** Агент подменил state.json через bash → задача blocked/STATE_TAMPERED. */
async function tampered(): Promise<Harness> {
  const h = await Harness.create();
  await h.createTask();
  h.fake.script(
    EXPLORER,
    turn.effect(async () => {
      const file = path.join(h.taskDir(), "state.json");
      const s = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      await writeFile(file, JSON.stringify({ ...s, stage: "done" }, null, 2));
    }),
    report("сам себе перевёл этап"),
    turn.end(),
  );
  expect(await h.run()).toEqual({ kind: "blocked", code: "STATE_TAMPERED" });
  return h;
}

const recover = (h: Harness, human: ScriptedHumanIO | null, opts = {}) => {
  const ctx = testContext(h.sb, { human, clock: h.clock });
  return { ctx, result: runRecover(ctx, "T-1", opts) };
};

describe("recover: подмена state", () => {
  it("показывает diff и восстанавливает state, записанный teo до подмены", async () => {
    const h = await tampered();
    const human = new ScriptedHumanIO([{ select: "Восстановить state" }]);
    expect(await recover(h, human).result).toBe(0);
    expect(human.printed).toMatch(/state\.json\.tampered-.* относительно последнего state/);
    expect(human.printed).toContain('stage: "discover" → "done"');
    expect(human.printed).toContain("Следующий шаг: teo resume T-1");

    const s = await h.state();
    expect(s).toMatchObject({ stage: "discover", status: "active", phase: "agent_running", statusReason: null });
    const events = await h.events();
    expect(events.find((e) => e.type === "runtime.recovered")?.payload).toMatchObject({ action: "restore_before_tamper" });
    expect(events.map((e) => e.type).slice(-3)).toEqual(["human.responded", "runtime.recovered", "task.unblocked"]);

    // Дальше обычное recovery по §8.3: ход агента завершился без отчёта → supervisor
    h.fake.script(SUPERVISOR, block());
    expect(await h.run()).toEqual({ kind: "blocked", code: "SUPERVISOR_BLOCKED" });
    expect(h.promptsTo(SUPERVISOR)[0]).toContain("завершил работу: unstructured_settle");
  });

  it("принимает изменённый файл как есть только после подтверждения", async () => {
    const h = await tampered();
    expect(await recover(h, new ScriptedHumanIO([{ select: "Принять изменённый" }, { confirm: false }])).result).toBe(0);
    expect((await h.state()).statusReason?.code).toBe("STATE_TAMPERED");

    expect(await recover(h, new ScriptedHumanIO([{ select: "Принять изменённый" }, { confirm: true }])).result).toBe(0);
    const s = await h.state();
    expect(s).toMatchObject({ stage: "done", status: "active", phase: "agent_running" });
    expect((await h.events()).at(-2)?.payload).toMatchObject({ action: "accept_tampered" });
  });

  it("без терминала объясняет, что подмену разбирают интерактивно", async () => {
    const h = await tampered();
    await expect(recover(h, null).result).rejects.toThrow(/в терминале — подмена state/);
    expect((await h.state()).statusReason?.code).toBe("STATE_TAMPERED");
  });
});

describe("recover: повреждённая сессия агента", () => {
  it("передаёт прерванный run supervisor-у", async () => {
    const h = await Harness.create();
    await h.createTask();
    h.fake.script(EXPLORER, turn.crash());
    await expect(h.run()).rejects.toBeInstanceOf(FakeCrash);
    await appendFile(path.join(h.taskDir(), EXPLORER), "{битая строка\n");

    const human = new ScriptedHumanIO([{ select: "Передать supervisor" }]);
    expect(await recover(h, human).result).toBe(0);
    expect(human.printed).toMatch(/Файл сессии sessions\/explorer-001\.jsonl повреждён/);
    const s = await h.state();
    expect(s).toMatchObject({ phase: "supervisor_pending", supervisor: { trigger: { kind: "recovered" } } });
    expect(s.currentRun).toMatchObject({ status: "failed", settleReason: "interrupted" });

    h.fake.script(SUPERVISOR, block());
    expect(await h.run()).toEqual({ kind: "blocked", code: "SUPERVISOR_BLOCKED" });
  });

  it("заблокированная SESSION_CORRUPTED задача перезапускается с новой сессией", async () => {
    const h = await Harness.create();
    await h.createTask();
    h.fake.script(EXPLORER, turn.crash());
    await expect(h.run()).rejects.toBeInstanceOf(FakeCrash);
    await appendFile(path.join(h.taskDir(), EXPLORER), "{битая строка\n");
    await h.run("T-1", { human: new ScriptedHumanIO([{ select: "Заблокировать" }]) });
    expect((await h.state()).statusReason?.code).toBe("SESSION_CORRUPTED");

    const human = new ScriptedHumanIO([{ select: "Перезапустить агента" }]);
    expect(await recover(h, human).result).toBe(0);
    expect(human.output).not.toContain("  - Заблокировать задачу");
    expect(human.printed).toContain("Файл сессии sessions/explorer-001.jsonl повреждён: строка 2: невалидный JSON");
    expect(await h.state()).toMatchObject({ status: "active", phase: "agent_pending", nextAgentInput: { kind: "restart" } });

    h.fake.script("sessions/explorer-002.jsonl", report()).script(SUPERVISOR, block());
    expect(await h.run()).toEqual({ kind: "blocked", code: "SUPERVISOR_BLOCKED" });
    expect((await h.state()).currentRun?.sessionFile).toBe("sessions/explorer-002.jsonl");
  });
});

describe("recover: этап и Policy", () => {
  it("меню: этап удалён из Policy → выбор этапа новой Policy", async () => {
    const h = await Harness.create();
    await h.createTask();
    h.fake.script(EXPLORER, report()).script(SUPERVISOR, sv("ask_human", { question: "Ок?", options: ["Да", "Нет"] }));
    expect(await h.run()).toEqual({ kind: "waiting_human" });
    await h.setPolicy(h.policyText.replaceAll("discover", "explore"));
    expect(await h.run("T-1", { human: new ScriptedHumanIO([{ select: "Да" }]) })).toEqual({ kind: "blocked", code: "POLICY_STAGE_MISSING" });

    const human = new ScriptedHumanIO([{ select: "Перевести задачу на этап" }, { select: "(explore)" }]);
    expect(await recover(h, human).result).toBe(0);
    expect(human.printed).toContain("Этапа «discover» нет в текущей Policy");
    expect(human.printed).toContain("teo recover T-1");
    // Принять Policy нельзя: в ней нет текущего этапа
    expect(human.printed).not.toContain("Принять текущую Policy");
    expect(await h.state()).toMatchObject({ stage: "explore", status: "active", phase: "agent_pending" });
  });

  it("флаги --accept-policy и --set-stage через CLI; без флагов и терминала — подсказка", async () => {
    const policy = await readFile(DED, "utf8");
    const sb = await sandbox(policy);
    expect((await runCli(sb, ["new", "T-1", "--title", "t", "--description", "d", "--no-run"])).code).toBe(0);

    const hint = await runCli(sb, ["recover", "T-1"]);
    expect(hint.code).toBe(1);
    expect(hint.stderr).toContain("teo recover T-1 --set-stage <этап>");
    expect(hint.stderr).not.toContain("--accept-policy");

    await writeFile(sb.policyPath, policy + "\nНовое правило.\n");
    const newHash = parsePolicyBytes(Buffer.from(policy + "\nНовое правило.\n"), sb.policyPath).hash;
    const accepted = await runCli(sb, ["recover", "T-1", "--accept-policy"]);
    expect(accepted.stdout).toContain("✓ Задача T-1 идёт по текущей Policy.");
    expect(accepted.code).toBe(0);
    const stateFile = path.join(sb.project, ".teo", "tasks", "T-1", "state.json");
    expect((JSON.parse(await readFile(stateFile, "utf8")) as TaskState).policyHash).toBe(newHash);

    const moved = await runCli(sb, ["recover", "t-1", "--set-stage", "execute"]);
    expect(moved.code).toBe(0);
    expect(moved.stdout).toContain("✓ Задача T-1 переведена на этап");
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toMatchObject({ stage: "execute", phase: "agent_pending" });

    const bad = await runCli(sb, ["recover", "T-1", "--set-stage", "done"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("не найден среди нетерминальных этапов");
  });
});

describe("recoverActions", () => {
  const base = async () => {
    const h = await Harness.create();
    const state = await h.createTask();
    return { state, policy: await h.loadPolicy() };
  };
  const kinds = (sit: RecoverSituation) => recoverActions(sit).map((a) => (a.kind === "session" ? `session:${a.choice}` : a.kind));

  it("предлагает только допустимые действия", async () => {
    const { state, policy } = await base();
    const plain = { state, policy, tampered: null, corruptedSession: null };
    expect(kinds(plain)).toEqual(["set_stage", "exit"]);
    expect(kinds({ ...plain, state: { ...state, policyHash: "sha256:old" } })).toEqual(["accept_policy", "set_stage", "exit"]);
    expect(kinds({ ...plain, corruptedSession: "line 3" })).toEqual(["session:restart", "session:supervisor", "session:block", "set_stage", "exit"]);
    const blocked: TaskState = { ...state, status: "blocked", phase: "halted", nextAgentInput: null, statusReason: { code: "SUPERVISOR_BLOCKED", message: "m", at: state.createdAt } };
    expect(kinds({ ...plain, state: blocked })).toEqual(["set_stage", "unblock", "exit"]);
    expect(kinds({ ...plain, state: { ...blocked, status: "cancelled" } })).toEqual(["exit"]);
  });
});
