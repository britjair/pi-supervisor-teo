// X3: host turn → settle → отдельный supervisor → решение применяется в той же пользовательской сессии.

import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentRuntime, turn, type FakeTurnContext } from "../../src/agents/fake/fake-runtime.js";
import type { TaskEvent } from "../../src/domain/events.js";
import type { TaskState } from "../../src/domain/task-state.js";
import { ExtensionHost } from "../../src/extension/host.js";
import { agentStartEvent, fakeCtx, FakePi, settleEvent } from "../helpers/fake-pi.js";
import { repoRoot, validDir } from "../helpers/paths.js";
import { sandbox, type Sandbox } from "../helpers/tmp.js";

const DED = readFileSync(path.join(validDir, "discover-execute-done.md"), "utf8");
const CAR = readFileSync(path.join(repoRoot, "examples", "processes", "car-selection.md"), "utf8");
const taskDir = (sb: Sandbox, key = "T-1") => path.join(sb.project, ".teo", "tasks", key);
const state = async (sb: Sandbox, key = "T-1") => JSON.parse(await readFile(path.join(taskDir(sb, key), "state.json"), "utf8")) as TaskState;
const events = async (sb: Sandbox, key = "T-1") =>
  (await readFile(path.join(taskDir(sb, key), "events.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as TaskEvent);

function assistant(text: string) {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 1, output: 1, cost: { total: 0 } } };
}
function user(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}

async function startWithRuntime(policy: string, processName: string, runtime: FakeAgentRuntime) {
  const sb = await sandbox(policy, { process: processName });
  const pi = new FakePi();
  const host = new ExtensionHost(pi.api, sb.home, () => runtime);
  host.register();
  const ctx = fakeCtx(pi, { cwd: sb.project, ui: { answers: [processName, "Описание", "Задача"] } });
  await host.start(ctx, "T-1");
  await pi.emit("before_agent_start", agentStartEvent("Начни первый этап"), ctx);
  return { sb, pi, host, ctx };
}

describe("ExtensionHost X3: supervisor в конце хода", () => {
  it("report_result → transition_stage: новая роль начинает сама в той же сессии; второй переход завершает задачу", async () => {
    const runtime = new FakeAgentRuntime().script(
      "sessions/supervisor.jsonl",
      turn.tool("transition_stage", {
        expectedStateVersion: "$expectedStateVersion",
        to: "execute",
        reason: "план подтверждён artifact",
        evidenceRefs: ["artifact:notes-plan.md"],
        handoff: "Выполни план",
      }),
      turn.tool("transition_stage", {
        expectedStateVersion: "$expectedStateVersion",
        to: "done",
        reason: "результат подтверждён файлом",
        evidenceRefs: ["file:NOTES.md"],
      }),
    );
    const { sb, pi, host, ctx } = await startWithRuntime(DED, "dev", runtime);
    const messages: unknown[] = [user("Начни первый этап")];
    try {
      await writeFile(path.join(taskDir(sb), "artifacts", "notes-plan.md"), "Создать NOTES.md\n");
      expect(await pi.callTool("report_result", { summary: "План готов", evidence: [{ kind: "artifact", value: "notes-plan.md" }] }))
        .toMatchObject({ terminate: true });
      messages.push(assistant("План готов"));
      const first = await pi.emit("agent_before_settle", settleEvent(messages), ctx) as { continue?: boolean; entries?: Array<{ content?: unknown }> };
      expect(first.continue).toBe(true);
      expect(String(first.entries?.[0]?.content)).toContain("Переход к этапу «Выполнение»");
      expect(String(first.entries?.[0]?.content)).toContain("предыдущая роль завершена");
      const afterFirst = await state(sb);
      expect(afterFirst).toMatchObject({ stage: "execute", phase: "agent_running", status: "active" });
      expect(afterFirst.currentRun?.agentId).toBe("executor");
      expect(pi.activeTools).toContain("report_result");

      await writeFile(path.join(sb.project, "NOTES.md"), "готово\n");
      expect(await pi.callTool("report_result", { summary: "NOTES.md создан", artifacts: [{ kind: "file", pathOrUrl: "NOTES.md" }] }))
        .toMatchObject({ terminate: true });
      messages.push(user("служебное продолжение этапа"), assistant("NOTES.md создан"));
      const second = await pi.emit("agent_before_settle", settleEvent(messages), ctx) as { continue?: boolean; entries?: Array<{ content?: unknown }> };
      expect(second.continue).toBe(false);
      expect(String(second.entries?.[0]?.content)).toContain("Задача T-1 завершена");
      expect(await state(sb)).toMatchObject({ stage: "done", status: "terminal", phase: "halted", hostSession: null });
      expect(host.boundKey).toBeNull();

      const journal = await events(sb);
      expect(journal.filter((e) => e.type === "supervisor.started")).toHaveLength(2);
      expect(journal.filter((e) => e.type === "supervisor.decision")).toHaveLength(2);
      expect(journal.filter((e) => e.type === "decision.applied")).toHaveLength(2);
      expect(journal.filter((e) => e.type === "stage.transitioned")).toHaveLength(2);
      expect(journal.at(-1)).toMatchObject({ type: "session.unbound", payload: { reason: "finished" } });
    } finally {
      await host.detach();
    }
  });

  it("continue и restart продолжают ту же Pi-сессию, но restart создаёт новый logical run", async () => {
    const runtime = new FakeAgentRuntime().script(
      "sessions/supervisor.jsonl",
      turn.tool("continue_current_agent", {
        expectedStateVersion: "$expectedStateVersion",
        message: "Добавь конкретный план",
      }),
      turn.tool("restart_current_agent", {
        expectedStateVersion: "$expectedStateVersion",
        reason: "неверный подход",
        message: "Начни анализ заново",
      }),
      turn.tool("block_task", {
        expectedStateVersion: "$expectedStateVersion",
        reason: "тест завершён",
        resolutionHint: "не требуется",
      }),
    );
    const { sb, pi, host, ctx } = await startWithRuntime(DED, "dev", runtime);
    const messages: unknown[] = [user("Начни"), assistant("Первый ответ")];
    try {
      const initialRun = (await state(sb)).currentRun?.runId;
      const continued = await pi.emit("agent_before_settle", settleEvent(messages), ctx) as { continue?: boolean; entries?: Array<{ content?: unknown }> };
      expect(continued.continue).toBe(true);
      expect(String(continued.entries?.[0]?.content)).toContain("Добавь конкретный план");
      expect((await state(sb)).currentRun?.runId).toBe(initialRun);

      messages.push(assistant("Второй ответ"));
      const restarted = await pi.emit("agent_before_settle", settleEvent(messages), ctx) as { continue?: boolean; entries?: Array<{ content?: unknown }> };
      expect(restarted.continue).toBe(true);
      expect(String(restarted.entries?.[0]?.content)).toContain("Начни анализ заново");
      const afterRestart = await state(sb);
      expect(afterRestart.currentRun?.runId).not.toBe(initialRun);
      expect(afterRestart.currentRun).toMatchObject({ attempt: 2, sessionMode: "restart", status: "running" });

      messages.push(assistant("Третий ответ"));
      const blocked = await pi.emit("agent_before_settle", settleEvent(messages), ctx) as { continue?: boolean };
      expect(blocked.continue).toBe(false);
      expect(await state(sb)).toMatchObject({ status: "blocked", phase: "halted", hostSession: null });
      expect(host.boundKey).toBeNull();
    } finally {
      await host.detach();
    }
  });

  it("ask_human открывает нативный select, ответ дословно идёт в следующий supervisor-цикл", async () => {
    const runtime = new FakeAgentRuntime().script(
      "sessions/supervisor.jsonl",
      turn.tool("ask_human", {
        expectedStateVersion: "$expectedStateVersion",
        question: "План подходит?",
        options: ["Да", "Нет"],
        allowFreeText: false,
      }),
      turn.tool("transition_stage", (c: FakeTurnContext) => ({
        expectedStateVersion: c.expectedStateVersion,
        to: "execute",
        reason: "пользователь подтвердил план",
        evidenceRefs: ["artifact:notes-plan.md", c.lastHumanRef],
      })),
    );
    const { sb, pi, host, ctx } = await startWithRuntime(DED, "dev", runtime);
    ctx.fakeUi.answers.push("Да");
    try {
      await writeFile(path.join(taskDir(sb), "artifacts", "notes-plan.md"), "План\n");
      await pi.callTool("report_result", { summary: "План готов" });
      const result = await pi.emit("agent_before_settle", settleEvent([user("Начни"), assistant("План готов")]), ctx) as { continue?: boolean };
      expect(result.continue).toBe(true);
      expect(await state(sb)).toMatchObject({ stage: "execute", phase: "agent_running", pendingHumanRequest: null });
      const journal = await events(sb);
      const requested = journal.find((e) => e.type === "human.requested");
      const responded = journal.find((e) => e.type === "human.responded" && e.payload.requestId !== null);
      expect(requested?.payload).toMatchObject({ question: "План подходит?", options: ["Да", "Нет"] });
      expect(responded?.payload).toEqual({ requestId: requested?.id, answer: "Да", selectedOption: "Да" });
      expect(journal.filter((e) => e.type === "supervisor.started")).toHaveLength(2);
    } finally {
      await host.detach();
    }
  });

  it("сценарий подбора автомобиля проходит четыре роли в одной Pi-сессии до «Заказ оформлен»", async () => {
    const humanRefs: string[] = [];
    const runtime = new FakeAgentRuntime().script(
      "sessions/supervisor.jsonl",
      turn.tool("transition_stage", (c: FakeTurnContext) => ({
        expectedStateVersion: c.expectedStateVersion,
        to: "brand_selection",
        reason: "тип двигателя выбран",
        evidenceRefs: ["artifact:fuel.md", humanRefs[0]],
      })),
      turn.tool("transition_stage", (c: FakeTurnContext) => ({
        expectedStateVersion: c.expectedStateVersion,
        to: "dealer_selection",
        reason: "марка подтверждена",
        evidenceRefs: ["artifact:brand.md", humanRefs[1]],
      })),
      turn.tool("transition_stage", (c: FakeTurnContext) => ({
        expectedStateVersion: c.expectedStateVersion,
        to: "order_summary",
        reason: "салон подтверждён",
        evidenceRefs: ["artifact:dealer.md", humanRefs[2]],
      })),
      turn.tool("transition_stage", {
        expectedStateVersion: "$expectedStateVersion",
        to: "order_placed",
        reason: "сводка готова",
        evidenceRefs: ["artifact:order-summary.md"],
      }),
    );
    const { sb, pi, host, ctx } = await startWithRuntime(CAR, "car-selection", runtime);
    const messages: unknown[] = [user("Начни подбор")];
    const steps = [
      { answer: "Выбираю электро", file: "fuel.md", body: "Тип: электро\nПричины: домашняя зарядка\n", summary: "Тип выбран", stage: "brand_selection" },
      { answer: "Выбираю Tesla Model 3", file: "brand.md", body: "Марка: Tesla\nМодель: Model 3\n", summary: "Модель выбрана", stage: "dealer_selection" },
      { answer: "Москва, подтверждаю салон Tesla", file: "dealer.md", body: "Город: Москва\nСалон: Tesla Москва\nМарка: Tesla\nМодель: Model 3\n", summary: "Салон выбран", stage: "order_summary" },
      { answer: "Составь сводку", file: "order-summary.md", body: "Электро; Tesla Model 3; Москва; Tesla Москва\n", summary: "Сводка готова", stage: "order_placed" },
    ];
    try {
      for (const [i, step] of steps.entries()) {
        await pi.emit("input", { type: "input", text: step.answer, source: "interactive" }, ctx);
        const human = (await events(sb)).filter((e) => e.type === "human.responded").at(-1);
        if (human) humanRefs.push(`human:${human.id}`);
        messages.push(user(step.answer));
        await writeFile(path.join(taskDir(sb), "artifacts", step.file), step.body);
        await pi.callTool("report_result", { summary: step.summary, artifacts: [{ kind: "artifact", pathOrUrl: `.teo/tasks/T-1/artifacts/${step.file}` }] });
        messages.push(assistant(step.summary));
        const boundary = await pi.emit("agent_before_settle", settleEvent(messages), ctx) as { continue?: boolean };
        const current = await state(sb);
        const recent = (await events(sb)).slice(-8).map((e) => `${e.type}:${JSON.stringify(e.payload)}`).join(" | ");
        expect(current.stage, `phase=${current.phase}; status=${current.status}; recent=${recent}; notes=${JSON.stringify(ctx.fakeUi.notes.slice(-3))}`).toBe(step.stage);
        expect(boundary.continue).toBe(i < steps.length - 1);
      }
      expect(await state(sb)).toMatchObject({ stage: "order_placed", status: "terminal", hostSession: null });
      expect(host.boundKey).toBeNull();
      const journal = await events(sb);
      expect(journal.filter((e) => e.type === "stage.transitioned")).toHaveLength(4);
      expect(new Set(journal.filter((e) => e.type === "session.bound").map((e) => e.payload.sessionId))).toEqual(new Set(["session-1"]));
    } finally {
      await host.detach();
    }
  });
});
