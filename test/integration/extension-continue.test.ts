// /teo continue: досрочный возврат цикла управления из ожидания, паузы и pending-фаз.

import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAgentRuntime, turn } from "../../src/agents/fake/fake-runtime.js";
import type { TaskEvent } from "../../src/domain/events.js";
import type { TaskState } from "../../src/domain/task-state.js";
import { ExtensionHost } from "../../src/extension/host.js";
import { msg } from "../../src/ui/messages.js";
import { defaultCooldownTracker } from "../../src/util/model-exhaustion.js";
import { resetUnusableSupervisorModels } from "../../src/workflow/supervisor-step.js";
import { agentStartEvent, fakeCtx, FakePi, settleEvent } from "../helpers/fake-pi.js";
import { validDir } from "../helpers/paths.js";
import { sandbox, type Sandbox } from "../helpers/tmp.js";

const DED = readFileSync(path.join(validDir, "discover-execute-done.md"), "utf8");
const RECHECK = DED.replace("      agent: explorer\n", "      agent: explorer\n      recheck: {}\n");
const taskDir = (sb: Sandbox) => path.join(sb.project, ".teo", "tasks", "T-1");
const state = async (sb: Sandbox) => JSON.parse(await readFile(path.join(taskDir(sb), "state.json"), "utf8")) as TaskState;
const events = async (sb: Sandbox) =>
  (await readFile(path.join(taskDir(sb), "events.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as TaskEvent);

function assistant(text: string) {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 1, output: 1, cost: { total: 0 } } };
}

/** Сколько запросов реально ушло в сессию supervisor-а: сессия кешируется, если модель та же. */
const supervisorPrompts = (runtime: FakeAgentRuntime) =>
  runtime.prompts.filter((p) => p.file.endsWith("sessions/supervisor.jsonl")).length;

async function setup(policy: string, runtime: FakeAgentRuntime, answers: Array<string | undefined> = []) {
  const sb = await sandbox(policy, { process: "dev" });
  const pi = new FakePi();
  const host = new ExtensionHost(pi.api, sb.home, () => runtime);
  host.register();
  const ctx = fakeCtx(pi, { cwd: sb.project, ui: { answers: ["dev", "Описание", "Задача", ...answers] } });
  await host.start(ctx, "T-1");
  await pi.emit("before_agent_start", agentStartEvent("Начни"), ctx);
  return { sb, pi, host, ctx };
}

/** Цепочка supervisor-а из одной модели: лимит упирается в неё же. */
async function singleSupervisorModel(sb: Sandbox, model: string): Promise<void> {
  await writeFile(
    path.join(sb.home, ".pi", "teo", "models.md"),
    `---\nschema: teo/v1\nroles:\n  supervisor:\n    - ${model}\n---\n`,
  );
}

afterEach(() => {
  defaultCooldownTracker.clear();
  resetUnusableSupervisorModels();
  vi.useRealTimers();
});

describe("/teo continue", () => {
  it("в справке и без привязанной задачи команда понятна", async () => {
    expect(msg.extension.help).toContain("/teo continue");
    const pi = new FakePi();
    const sb = await sandbox(DED, { process: "dev" });
    const host = new ExtensionHost(pi.api, sb.home, () => new FakeAgentRuntime());
    host.register();
    const ctx = fakeCtx(pi, { cwd: sb.project });
    await host.continueNow(ctx);
    expect(ctx.fakeUi.notes).toEqual([{ type: "info", message: msg.extension.notBound }]);
  });

  it("обычное ожидание прерывается досрочно и роль этапа сразу получает recheck-задание", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T10:00:00.000Z"));
    const runtime = new FakeAgentRuntime().script(
      "sessions/supervisor.jsonl",
      turn.tool("schedule_recheck", {
        expectedStateVersion: "$expectedStateVersion",
        delayMinutes: 30,
        waitingFor: "approve ревьюера в MR",
        message: "Проверь approve и комментарии в MR",
      }),
    );
    const { sb, pi, host, ctx } = await setup(RECHECK, runtime);
    try {
      await pi.emit("agent_before_settle", settleEvent([assistant("Пока не готово")]), ctx);
      expect(await state(sb)).toMatchObject({ phase: "waiting", wait: { waitingFor: "approve ревьюера в MR" } });

      // Пользователь увидел approve раньше таймера
      vi.setSystemTime(new Date("2026-01-02T10:05:00.000Z"));
      await host.continueNow(ctx);

      expect(await state(sb), JSON.stringify(ctx.fakeUi.notes)).toMatchObject({
        phase: "agent_pending",
        wait: null,
        nextAgentInput: { kind: "recheck" },
      });
      expect(pi.sent.at(-1)?.message.customType).toBe("teo-recheck");
      expect(pi.sent.at(-1)?.message.content).toContain("Проверь approve и комментарии в MR");
      expect((host as unknown as { binding: { waitTimer: unknown } }).binding.waitTimer).toBeNull();

      const journal = await events(sb);
      expect(journal.find((e) => e.type === "wait.finished")?.payload).toMatchObject({ reason: "skipped_by_human", waitedMinutes: 5 });
      expect(journal.find((e) => e.type === "supervision.continued")?.payload).toMatchObject({ fromPhase: "waiting", mode: "recheck" });
    } finally {
      await host.detach();
    }
  });

  it("ожидание лимита: принудительная проверка cooldown-модели снимает cooldown при успехе", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));
    const runtime = new FakeAgentRuntime().script(
      "sessions/supervisor.jsonl",
      turn.error("Codex error: The usage limit has been reached"),
      turn.tool("transition_stage", {
        expectedStateVersion: "$expectedStateVersion",
        to: "execute",
        reason: "лимит уже снят, факты проверены",
        evidenceRefs: ["artifact:plan.md"],
      }),
    );
    const sb0 = await sandbox(DED, { process: "dev" });
    await singleSupervisorModel(sb0, "openai-codex/gpt-5.6-sol");
    const pi = new FakePi();
    const host = new ExtensionHost(pi.api, sb0.home, () => runtime);
    host.register();
    const ctx = fakeCtx(pi, { cwd: sb0.project, ui: { answers: ["dev", "Описание", "Задача"] } });
    await host.start(ctx, "T-1");
    await pi.emit("before_agent_start", agentStartEvent("Начни"), ctx);
    try {
      await writeFile(path.join(taskDir(sb0), "artifacts", "plan.md"), "План\n");
      await pi.callTool("report_result", { summary: "План готов", evidence: [{ kind: "artifact", value: "plan.md" }] });
      await pi.emit("agent_before_settle", settleEvent([assistant("План готов")]), ctx);

      const waiting = await state(sb0);
      expect(waiting).toMatchObject({ phase: "waiting", wait: { targetPhase: "supervisor_pending" } });
      expect(defaultCooldownTracker.isExhausted("openai-codex", "gpt-5.6-sol")).toBe(true);
      // Штатная проба ещё далеко: без /teo continue запрос бы не ушёл
      const record = defaultCooldownTracker.activeRecord("openai-codex", "gpt-5.6-sol");
      expect(record && defaultCooldownTracker.canProbe(record)).toBe(false);

      await host.continueNow(ctx);

      expect((await state(sb0)).stage, JSON.stringify(ctx.fakeUi.notes)).toBe("execute");
      expect(defaultCooldownTracker.isExhausted("openai-codex", "gpt-5.6-sol")).toBe(false);
      // Принудительный запрос действительно ушёл в модель, которая была в cooldown
      expect(supervisorPrompts(runtime)).toBe(2);

      const journal = await events(sb0);
      expect(journal.find((e) => e.type === "supervision.continued")?.payload).toMatchObject({ fromPhase: "waiting", mode: "forced_model_probe" });
      const checks = journal.filter((e) => e.type === "supervisor.models_checked").at(-1)?.payload.checks;
      expect(checks).toMatchObject([{ status: "canary", resolvedModel: "openai-codex/gpt-5.6-sol", reason: "принудительная проверка по /teo continue" }]);
    } finally {
      await host.detach();
    }
  });

  it("если лимит ещё держится, принудительная проверка обновляет cooldown и не повторяется сама", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));
    const runtime = new FakeAgentRuntime().script(
      "sessions/supervisor.jsonl",
      turn.error("Codex error: The usage limit has been reached"),
      turn.error("Codex error: The usage limit has been reached"),
    );
    const sb0 = await sandbox(DED, { process: "dev" });
    await singleSupervisorModel(sb0, "openai-codex/gpt-5.6-sol");
    const pi = new FakePi();
    const host = new ExtensionHost(pi.api, sb0.home, () => runtime);
    host.register();
    const ctx = fakeCtx(pi, { cwd: sb0.project, ui: { answers: ["dev", "Описание", "Задача"] } });
    await host.start(ctx, "T-1");
    await pi.emit("before_agent_start", agentStartEvent("Начни"), ctx);
    try {
      await writeFile(path.join(taskDir(sb0), "artifacts", "plan.md"), "План\n");
      await pi.callTool("report_result", { summary: "План готов", evidence: [{ kind: "artifact", value: "plan.md" }] });
      await pi.emit("agent_before_settle", settleEvent([assistant("План готов")]), ctx);

      await host.continueNow(ctx);

      // Задача снова ждёт, не заблокирована, и лишних запросов не было
      expect(await state(sb0)).toMatchObject({ status: "active", phase: "waiting", wait: { targetPhase: "supervisor_pending" } });
      expect(defaultCooldownTracker.isExhausted("openai-codex", "gpt-5.6-sol")).toBe(true);
      // Ровно одна принудительная проба: флаг потребляется, цикл не долбится в лимит
      expect(supervisorPrompts(runtime)).toBe(2);
      expect((await events(sb0)).filter((e) => e.type === "model.exhausted")).toHaveLength(2);
    } finally {
      await host.detach();
    }
  });

  it("на паузе команда снимает паузу и продолжает ожидавшую перепроверку", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T10:00:00.000Z"));
    const runtime = new FakeAgentRuntime().script(
      "sessions/supervisor.jsonl",
      turn.tool("schedule_recheck", {
        expectedStateVersion: "$expectedStateVersion",
        delayMinutes: 30,
        waitingFor: "ответ QA в треде",
        message: "Проверь тред фича-тестинга",
      }),
    );
    const { sb, pi, host, ctx } = await setup(RECHECK, runtime);
    try {
      await pi.emit("agent_before_settle", settleEvent([assistant("Ждём QA")]), ctx);
      expect(await state(sb)).toMatchObject({ phase: "waiting" });
      await host.pause(ctx);
      expect(await state(sb)).toMatchObject({ phase: "waiting", hostSession: { paused: true } });

      await host.continueNow(ctx);

      expect(await state(sb), JSON.stringify(ctx.fakeUi.notes)).toMatchObject({
        phase: "agent_pending",
        wait: null,
        hostSession: { paused: false },
        nextAgentInput: { kind: "recheck" },
      });
      expect(pi.sent.at(-1)?.message.content).toContain("Проверь тред фича-тестинга");
      expect((await events(sb)).map((e) => e.type)).toEqual(
        expect.arrayContaining(["supervision.paused", "supervision.resumed", "supervision.continued"]),
      );
    } finally {
      await host.detach();
    }
  });

  it("на паузе в supervisor_pending команда продолжает проверку supervisor-а", async () => {
    const runtime = new FakeAgentRuntime().script(
      "sessions/supervisor.jsonl",
      turn.tool("continue_current_agent", { expectedStateVersion: "$expectedStateVersion", message: "Продолжай после паузы" }),
    );
    const { sb, pi, host, ctx } = await setup(DED, runtime);
    try {
      await host.pause(ctx);
      await pi.emit("agent_before_settle", settleEvent([assistant("Черновик")]), ctx);
      expect(await state(sb)).toMatchObject({ phase: "supervisor_pending", hostSession: { paused: true } });

      await host.continueNow(ctx);

      expect(await state(sb), JSON.stringify(ctx.fakeUi.notes)).toMatchObject({ phase: "agent_pending", hostSession: { paused: false } });
      expect(pi.sent.at(-1)?.message.content).toContain("Продолжай после паузы");
      expect((await events(sb)).find((e) => e.type === "supervision.continued")?.payload).toMatchObject({
        fromPhase: "supervisor_pending",
        mode: "resume",
      });
    } finally {
      await host.detach();
    }
  });

  it("вопрос supervisor-а команда не подменяет", async () => {
    const runtime = new FakeAgentRuntime().script(
      "sessions/supervisor.jsonl",
      turn.tool("ask_human", {
        expectedStateVersion: "$expectedStateVersion",
        question: "Утверждаете план?",
        options: ["Да", "Нет"],
        allowFreeText: true,
      }),
    );
    // Ответов в очереди нет: вопрос остаётся открытым
    const { sb, pi, host, ctx } = await setup(DED, runtime);
    try {
      await pi.emit("agent_before_settle", settleEvent([assistant("План готов")]), ctx);
      expect(await state(sb)).toMatchObject({ phase: "human_pending" });
      const cyclesBefore = (await events(sb)).filter((e) => e.type === "supervisor.started").length;

      await host.continueNow(ctx);

      expect(await state(sb)).toMatchObject({ phase: "human_pending" });
      expect((await events(sb)).filter((e) => e.type === "supervisor.started")).toHaveLength(cyclesBefore);
      expect((await events(sb)).some((e) => e.type === "supervision.continued")).toBe(false);
      expect(ctx.fakeUi.notes.at(-1)).toEqual({ type: "info", message: msg.extension.continueNeedsAnswer("T-1") });
    } finally {
      await host.detach();
    }
  });

  it("идущий ход агента команда не прерывает", async () => {
    const runtime = new FakeAgentRuntime();
    const { sb, host, ctx } = await setup(DED, runtime);
    try {
      expect(await state(sb)).toMatchObject({ phase: "agent_running" });

      await host.continueNow(ctx);

      expect(await state(sb)).toMatchObject({ phase: "agent_running" });
      expect((await events(sb)).some((e) => e.type === "supervision.continued")).toBe(false);
      expect(ctx.fakeUi.notes.at(-1)).toEqual({ type: "info", message: msg.extension.continueBusyAgent("T-1") });
    } finally {
      await host.detach();
    }
  });
});
