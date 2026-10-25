// Сценарий 17 (06-implementation.md §4.2): изменение Policy между запусками.

import { describe, expect, it } from "vitest";
import { turn } from "../../src/agents/fake/fake-runtime.js";
import { parsePolicyBytes } from "../../src/policy/policy-loader.js";
import { InjectedFault, throwingAtOccurrence } from "../../src/util/fault.js";
import { acceptPolicy, setStage, unblockTask } from "../../src/workflow/manual.js";
import { Harness } from "../helpers/engine.js";
import { ScriptedHumanIO } from "../helpers/scripted-human-io.js";

const EV = "$expectedStateVersion";
const sv = (action: string, args: Record<string, unknown> = {}) => turn.tool(action, { expectedStateVersion: EV, ...args });
const EXPLORER = "sessions/explorer-001.jsonl";
const SUPERVISOR = "sessions/supervisor.jsonl";
const report = (summary = "готово") => turn.tool("report_result", { summary });
const block = () => sv("block_task", { reason: "стоп", resolutionHint: "-" });

/** Задача остановилась на вопросе supervisor-а (без терминала): дальше будет supervisor_pending. */
async function atHumanQuestion(): Promise<Harness> {
  const h = await Harness.create();
  await h.createTask();
  h.fake.script(EXPLORER, report()).script(SUPERVISOR, sv("ask_human", { question: "Ок?", options: ["Да", "Нет"] }));
  expect(await h.run()).toEqual({ kind: "waiting_human" });
  return h;
}

const withMode = (text: string, mode: string) => text.replace("policyChangeMode: latest", `policyChangeMode: ${mode}`) + "\nНовое правило процесса.\n";

describe("изменение Policy", () => {
  it("confirm: да → policy.changed, supervisor видит полный текст новой Policy", async () => {
    const h = await atHumanQuestion();
    const oldHash = (await h.state()).policyHash;
    await h.setPolicy(withMode(h.policyText, "confirm"));
    const asked: unknown[] = [];
    h.fake.script(SUPERVISOR, block());
    const outcome = await h.run("T-1", {
      human: new ScriptedHumanIO([{ select: "Да" }]),
      confirmPolicy: async (change) => (asked.push(change), true),
    });
    expect(outcome).toMatchObject({ kind: "blocked" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ fromHash: oldHash, stage: "discover" });
    expect((asked[0] as { diff: Array<{ kind: string }> }).diff.map((d) => d.kind)).toEqual(["runtime_changed", "body_changed"]);
    const s = await h.state();
    expect(s.policyHash).not.toBe(oldHash);
    const changed = (await h.events()).find((e) => e.type === "policy.changed");
    expect(changed?.payload).toMatchObject({ fromHash: oldHash, toHash: s.policyHash, mode: "confirm" });
    const prompt = h.promptsTo(SUPERVISOR)[1] ?? "";
    expect(prompt).toContain("(изменилась с прошлого цикла — полный текст ниже)");
    expect(prompt).toContain("Новое правило процесса.");
  });

  it("confirm: нет → выход без изменений; без терминала → exit 5", async () => {
    const h = await atHumanQuestion();
    await h.setPolicy(withMode(h.policyText, "confirm"));
    // Ответ на вопрос supervisor-а сохраняется, а дальше gate спрашивает про Policy
    expect(await h.run("T-1", { human: new ScriptedHumanIO([{ select: "Да" }]), confirmPolicy: async () => false })).toEqual({
      kind: "policy_declined",
    });
    const s = await h.state();
    expect(s.phase).toBe("supervisor_pending");
    expect(await h.types()).not.toContain("policy.changed");
    expect(await h.run("T-1")).toEqual({ kind: "policy_unconfirmed" });
    expect((await h.state()).version).toBe(s.version);
  });

  it("latest: применяется автоматически; при agent_pending (continue) задача уходит supervisor-у", async () => {
    const h = await Harness.create();
    await h.createTask();
    h.fake.script(EXPLORER, report()).script(SUPERVISOR, sv("continue_current_agent", { message: "ещё" }));
    // Процесс упал при старте агента после решения continue; Policy изменили до следующего запуска
    const err = await h.run("T-1", { faults: throwingAtOccurrence("before-agent-prompt", 2) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InjectedFault);
    expect(await h.state()).toMatchObject({ phase: "agent_running" });
    await h.setPolicy(h.policyText + "\nДобавлено.\n");
    h.fake.script(SUPERVISOR, block());
    await h.run();
    const events = await h.events();
    const changed = events.find((e) => e.type === "policy.changed");
    expect(changed?.payload).toMatchObject({ mode: "latest" });
    expect(h.promptsTo(SUPERVISOR)[1]).toContain("# Причина цикла: policy_changed");
    expect(h.promptsTo(EXPLORER)).toHaveLength(1);
  });

  it("pinned: отказ (exit 5) → recover --accept-policy → продолжение", async () => {
    const h = await atHumanQuestion();
    await h.setPolicy(withMode(h.policyText, "pinned"));
    expect(await h.run("T-1", { human: new ScriptedHumanIO([{ select: "Да" }]) })).toEqual({ kind: "policy_pinned" });
    const policy = parsePolicyBytes(Buffer.from(h.policyText), h.sb.policyPath);
    await h.store.withLock({ command: "recover", taskKey: "T-1" }, () => acceptPolicy(h.store, "T-1", policy));
    expect((await h.events()).find((e) => e.type === "policy.changed")?.payload).toMatchObject({ mode: "manual" });
    h.fake.script(SUPERVISOR, block());
    expect(await h.run()).toMatchObject({ kind: "blocked", code: "SUPERVISOR_BLOCKED" });
  });

  it("текущий этап удалён → blocked POLICY_STAGE_MISSING → recover --set-stage → агент нового этапа", async () => {
    const h = await atHumanQuestion();
    const renamed = h.policyText.replaceAll("discover", "explore");
    await h.setPolicy(renamed);
    expect(await h.run("T-1", { human: new ScriptedHumanIO([{ select: "Да" }]) })).toEqual({ kind: "blocked", code: "POLICY_STAGE_MISSING" });
    const blocked = await h.state();
    expect(blocked.statusReason?.code).toBe("POLICY_STAGE_MISSING");
    // Разблокировка обычным resume запрещена
    await expect(h.store.withLock({ command: "resume", taskKey: "T-1" }, () => unblockTask(h.store, "T-1", "почему"))).rejects.toThrow(/sdlc recover/);
    const policy = parsePolicyBytes(Buffer.from(renamed), h.sb.policyPath);
    await expect(setStage(h.store, "T-1", "nope", policy)).rejects.toThrow(/не найден/);
    await h.store.withLock({ command: "recover", taskKey: "T-1" }, () => setStage(h.store, "T-1", "explore", policy));
    const s = await h.state();
    expect(s).toMatchObject({ stage: "explore", status: "active", phase: "agent_pending", policyHash: policy.hash });
    const types = await h.types();
    expect(types.slice(-2)).toEqual(["policy.changed", "stage.transitioned"]);
    h.fake.script("sessions/explorer-002.jsonl", report()).script(SUPERVISOR, block());
    await h.run();
    expect(h.promptsTo("explorer-002.jsonl")[0]).toContain("# Текущий этап: Изучение задачи (explore)");
  });

  it("невалидная Policy посреди работы → PolicyError, state не меняется; после исправления — продолжение", async () => {
    const h = await Harness.create();
    await h.createTask();
    const good = h.policyText;
    const { writeFile } = await import("node:fs/promises");
    h.fake.script(EXPLORER, turn.effect(() => writeFile(h.sb.policyPath, "---\nschema: sdlc/v1\n---\n")), report());
    await expect(h.run()).rejects.toMatchObject({ name: "PolicyError", exitCode: 2 });
    const after = await h.state();
    expect(after.phase).toBe("supervisor_pending");
    expect(await h.types()).not.toContain("supervisor.started");
    await h.setPolicy(good);
    h.fake.script(SUPERVISOR, block());
    expect(await h.run()).toMatchObject({ kind: "blocked", code: "SUPERVISOR_BLOCKED" });
  });

  it("разблокировка: комментарий человека уходит supervisor-у", async () => {
    const h = await Harness.create();
    await h.createTask();
    h.fake.script(EXPLORER, report()).script(SUPERVISOR, sv("block_task", { reason: "нет доступа к CI", resolutionHint: "дать доступ" }));
    expect(await h.run()).toMatchObject({ kind: "blocked" });
    await h.store.withLock({ command: "resume", taskKey: "T-1" }, () => unblockTask(h.store, "T-1", "Доступ выдан"));
    h.fake.script(SUPERVISOR, block());
    await h.run();
    const prompt = h.promptsTo(SUPERVISOR)[1] ?? "";
    expect(prompt).toContain("# Причина цикла: unblocked");
    expect(prompt).toContain("Комментарий: Доступ выдан");
    expect(await h.types()).toContain("task.unblocked");
  });
});

