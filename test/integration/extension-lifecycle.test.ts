// X4: новые пользовательские сессии, пауза, recheck-таймер и recovery после закрытия Pi.

import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAgentRuntime, turn } from "../../src/agents/fake/fake-runtime.js";
import type { TaskEvent } from "../../src/domain/events.js";
import type { TaskState } from "../../src/domain/task-state.js";
import { ExtensionHost } from "../../src/extension/host.js";
import { agentStartEvent, fakeCtx, FakePi, settleEvent } from "../helpers/fake-pi.js";
import { validDir } from "../helpers/paths.js";
import { sandbox, type Sandbox } from "../helpers/tmp.js";

const DED = readFileSync(path.join(validDir, "discover-execute-done.md"), "utf8");
const NEW_SESSION = DED.replace("      title: Выполнение\n", "      title: Выполнение\n      userSession: new\n");
const taskDir = (sb: Sandbox) => path.join(sb.project, ".teo", "tasks", "T-1");
const state = async (sb: Sandbox) => JSON.parse(await readFile(path.join(taskDir(sb), "state.json"), "utf8")) as TaskState;
const events = async (sb: Sandbox) =>
  (await readFile(path.join(taskDir(sb), "events.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as TaskEvent);

function assistant(text: string) {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 1, output: 1, cost: { total: 0 } } };
}

async function setup(policy: string, runtime: FakeAgentRuntime, ctxOptions: Parameters<typeof fakeCtx>[1] = { cwd: "" }) {
  const sb = await sandbox(policy, { process: "dev" });
  const pi = new FakePi();
  const host = new ExtensionHost(pi.api, sb.home, () => runtime);
  host.register();
  const ctx = fakeCtx(pi, {
    ...ctxOptions,
    cwd: sb.project,
    ui: { answers: ["dev", "Описание", "Задача"], ...ctxOptions.ui },
  });
  await host.start(ctx, "T-1");
  await pi.emit("before_agent_start", agentStartEvent("Начни"), ctx);
  return { sb, pi, host, ctx };
}

afterEach(() => vi.useRealTimers());

describe("ExtensionHost X4: lifecycle", () => {
  it("userSession:new подставляет /teo next и переносит binding в дочернюю Pi-сессию", async () => {
    const runtime = new FakeAgentRuntime().script(
      "sessions/supervisor.jsonl",
      turn.tool("transition_stage", {
        expectedStateVersion: "$expectedStateVersion",
        to: "execute",
        reason: "пора выполнять",
        evidenceRefs: ["artifact:plan.md"],
        handoff: "Выполни план",
      }),
    );
    let replacement: ReturnType<typeof fakeCtx> | undefined;
    const env = {} as { host: ExtensionHost; pi: FakePi; sb: Sandbox };
    const newSession: ExtensionCommandContext["newSession"] = async (options = {}) => {
      const manager = {
        getSessionId: () => "session-2",
        getSessionFile: () => "/tmp/pi-sessions/session-2.jsonl",
        appendCustomEntry: (customType: string, data?: unknown) => void env.pi.entries.push({ type: "custom", customType, data }),
      };
      await options.setup?.(manager as never);
      await env.pi.emit("session_shutdown", { type: "session_shutdown", reason: "new", targetSessionFile: manager.getSessionFile() }, ctx);
      replacement = fakeCtx(env.pi, { cwd: env.sb.project, sessionId: "session-2", sessionFile: manager.getSessionFile() });
      expect(env.host.boundKey).toBeNull();
      await env.pi.emit("session_start", { type: "session_start" }, replacement);
      expect(env.host.boundKey, JSON.stringify(replacement.fakeUi.notes)).toBe("T-1");
      expect((env.host as unknown as { binding: { sessionId: string } }).binding.sessionId).toBe("session-2");
      expect(await state(env.sb)).toMatchObject({ hostSession: { sessionId: "session-2", awaitingNextSession: false } });
      await options.withSession?.(replacement as never);
      return { cancelled: false };
    };
    const prepared = await setup(NEW_SESSION, runtime, { cwd: "", newSession });
    Object.assign(env, prepared);
    const { sb, pi, host, ctx } = prepared;
    try {
      await writeFile(path.join(taskDir(sb), "artifacts", "plan.md"), "План\n");
      await pi.callTool("report_result", { summary: "Анализ завершён", evidence: [{ kind: "artifact", value: "plan.md" }] });
      const boundary = await pi.emit("agent_before_settle", settleEvent([assistant("Анализ завершён")]), ctx) as { continue?: boolean } | undefined;
      expect(boundary, JSON.stringify(ctx.fakeUi.notes)).toBeDefined();
      expect(boundary?.continue).toBe(false);
      expect(ctx.fakeUi.editorText).toBe("/teo next");
      expect(await state(sb)).toMatchObject({ stage: "execute", phase: "agent_pending", hostSession: { sessionId: "session-1", awaitingNextSession: true } });

      await host.next(ctx);
      expect(replacement).toBeDefined();
      expect(host.boundKey).toBe("T-1");
      expect(await state(sb)).toMatchObject({ hostSession: { sessionId: "session-2", awaitingNextSession: false, nextSessionId: null } });
      expect(pi.sent.at(-1)?.message.content).toContain("этап «Выполнение»");
      await pi.emit("before_agent_start", agentStartEvent("Новая сессия"), replacement);
      expect(await state(sb)).toMatchObject({ stage: "execute", phase: "agent_running" });
      const journal = await events(sb);
      expect(journal.some((e) => e.type === "session.next_requested")).toBe(true);
      expect(journal.filter((e) => e.type === "session.bound").map((e) => e.payload.sessionId)).toEqual(["session-1", "session-2"]);
    } finally {
      await host.detach();
    }
  });

  it("/teo pause пропускает supervisor, возвращает окружение пользователя и /teo resume продолжает pending-проверку", async () => {
    const runtime = new FakeAgentRuntime().script(
      "sessions/supervisor.jsonl",
      turn.tool("continue_current_agent", { expectedStateVersion: "$expectedStateVersion", message: "Продолжай после паузы" }),
    );
    const { sb, pi, host, ctx } = await setup(DED, runtime);
    try {
      await host.pause(ctx);
      expect(pi.activeTools).toEqual(["read", "bash", "edit", "write", "web_search"]);
      await pi.emit("agent_before_settle", settleEvent([assistant("Черновик")]), ctx);
      expect(await state(sb)).toMatchObject({ phase: "supervisor_pending", hostSession: { paused: true } });
      expect((await events(sb)).filter((e) => e.type === "supervisor.started")).toHaveLength(0);

      await host.resume(ctx, "T-1");
      expect(await state(sb)).toMatchObject({ phase: "agent_pending", hostSession: { paused: false } });
      expect(pi.sent.at(-1)?.message.content).toContain("Продолжай после паузы");
      expect((await events(sb)).map((e) => e.type)).toEqual(expect.arrayContaining(["supervision.paused", "supervision.resumed", "supervisor.started"]));
    } finally {
      await host.detach();
    }
  });

  it("schedule_recheck в срок сам запускает новый ход, если сессия свободна", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T10:00:00.000Z"));
    const runtime = new FakeAgentRuntime().script(
      "sessions/supervisor.jsonl",
      turn.tool("schedule_recheck", {
        expectedStateVersion: "$expectedStateVersion",
        delayMinutes: 1,
        waitingFor: "результат внешней проверки",
        message: "Проверь статус ещё раз",
      }),
    );
    const policy = DED.replace("      agent: explorer\n", "      agent: explorer\n      recheck: {}\n");
    const { sb, pi, host, ctx } = await setup(policy, runtime);
    try {
      await pi.emit("agent_before_settle", settleEvent([assistant("Пока не готово")]), ctx);
      expect(await state(sb)).toMatchObject({ phase: "waiting", wait: { waitingFor: "результат внешней проверки" } });
      const internal = host as unknown as { binding: { waitTimer: unknown }; fireWaitTimer: (b: unknown, c: unknown) => Promise<void> };
      expect(internal.binding.waitTimer).not.toBeNull();
      vi.setSystemTime(new Date("2026-01-02T10:01:00.000Z"));
      await internal.fireWaitTimer(internal.binding, ctx);
      expect(await state(sb), JSON.stringify(ctx.fakeUi.notes)).toMatchObject({ phase: "agent_pending", wait: null, nextAgentInput: { kind: "recheck" } });
      expect(pi.sent.at(-1)?.message.content).toContain("Срок ожидания закончился");
      expect(pi.sent.at(-1)?.message.content).toContain("Проверь статус ещё раз");
    } finally {
      await host.detach();
    }
  });

  it("hard-crash state agent_running восстанавливается при следующем session_start", async () => {
    const runtime = new FakeAgentRuntime().script(
      "sessions/supervisor.jsonl",
      turn.tool("restart_current_agent", {
        expectedStateVersion: "$expectedStateVersion",
        reason: "транскрипт оборванного хода недоступен",
        message: "Продолжи оборванный ход",
      }),
    );
    const { sb, pi, host, ctx } = await setup(DED, runtime);
    try {
      // Имитация смерти процесса: shutdown-hook не успел записать interrupted, binding в state остался.
      await host.detach();
      expect(await state(sb)).toMatchObject({ status: "active", phase: "agent_running" });
      await pi.emit("session_start", { type: "session_start" }, ctx);
      expect(await state(sb)).toMatchObject({ status: "active", phase: "agent_pending", currentRun: { settleReason: "interrupted" } });
      expect(pi.sent.at(-1)?.message.content).toContain("Продолжи оборванный ход");
      const journal = await events(sb);
      expect(journal.map((e) => e.type)).toEqual(expect.arrayContaining(["runtime.interrupted", "runtime.recovered"]));
    } finally {
      await host.detach();
    }
  });

  it("закрытие Pi во время agent run помечает interrupted, а session_start запускает recovery supervisor-а", async () => {
    const runtime = new FakeAgentRuntime().script(
      "sessions/supervisor.jsonl",
      turn.tool("restart_current_agent", {
        expectedStateVersion: "$expectedStateVersion",
        reason: "ход оборван",
        message: "Повтори работу после восстановления",
      }),
    );
    const { sb, pi, host, ctx } = await setup(DED, runtime);
    try {
      await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
      expect(host.boundKey).toBeNull();
      expect(await state(sb)).toMatchObject({ status: "interrupted", phase: "supervisor_pending", currentRun: { settleReason: "interrupted" } });

      await pi.emit("session_start", { type: "session_start" }, ctx);
      expect(host.boundKey).toBe("T-1");
      expect(await state(sb)).toMatchObject({ status: "active", phase: "agent_pending" });
      expect(pi.sent.at(-1)?.message.content).toContain("Повтори работу после восстановления");
      const journal = await events(sb);
      expect(journal.map((e) => e.type)).toEqual(expect.arrayContaining(["runtime.interrupted", "runtime.recovered"]));
    } finally {
      await host.detach();
    }
  });
});
