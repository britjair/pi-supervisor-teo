// ExtensionHost на фейковом ExtensionAPI (X2): привязка задачи к сессии Pi, роль этапа, guard, журнал сообщений.

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BINDING_ENTRY, ExtensionHost } from "../../src/extension/host.js";
import type { TaskEvent } from "../../src/domain/events.js";
import type { TaskState } from "../../src/domain/task-state.js";
import { GOAL_PROCESS } from "../../src/policy/process-catalog.js";
import { agentStartEvent, fakeCtx, FakePi } from "../helpers/fake-pi.js";
import { validDir } from "../helpers/paths.js";
import { runCli, sandbox, type Sandbox } from "../helpers/tmp.js";

const DED = readFileSync(path.join(validDir, "discover-execute-done.md"), "utf8");

const taskDir = (sb: Sandbox, key: string) => path.join(sb.project, ".teo", "tasks", key);
const state = async (sb: Sandbox, key: string) => JSON.parse(await readFile(path.join(taskDir(sb, key), "state.json"), "utf8")) as TaskState;
const events = async (sb: Sandbox, key: string) =>
  (await readFile(path.join(taskDir(sb, key), "events.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as TaskEvent);
const lockFile = (sb: Sandbox) => path.join(sb.project, ".teo", "project.lock.json");

/** Песочница с процессом dev, сессия Pi с хостом teo и задача T-1, созданная через /teo start. */
async function started(policy = DED) {
  const sb = await sandbox(policy, { process: "dev" });
  const pi = new FakePi();
  const host = new ExtensionHost(pi.api, sb.home);
  host.register();
  const ctx = fakeCtx(pi, { cwd: sb.project, ui: { answers: ["dev", "Создай NOTES.md со строкой hello", "Заметки"] } });
  await host.start(ctx, "T-1");
  return { sb, pi, host, ctx };
}

describe("ExtensionHost: привязка задачи к сессии", () => {
  it("/teo start: задача создана, привязана к сессии, lock у процесса Pi, роль этапа начинает сама", async () => {
    const { sb, pi, host, ctx } = await started();
    try {
      expect(host.boundKey).toBe("T-1");
      const s = await state(sb, "T-1");
      expect(s).toMatchObject({ process: "dev", title: "Заметки", stage: "discover", hostSession: { sessionId: "session-1", sessionFile: "/tmp/pi-sessions/session-1.jsonl" } });
      expect((await events(sb, "T-1")).map((e) => e.type)).toContain("session.bound");
      expect(JSON.parse(await readFile(lockFile(sb), "utf8"))).toMatchObject({ pid: process.pid, command: "extension", taskKey: "T-1" });
      expect(pi.entries).toEqual([{ type: "custom", customType: BINDING_ENTRY, data: { key: "T-1", projectRoot: sb.project } }]);
      expect(pi.sent).toEqual([
        { message: expect.objectContaining({ customType: "teo-stage", content: expect.stringContaining("Начался этап «Изучение задачи». Роль — «Исследователь»") }), options: { triggerTurn: true } },
      ]);
      expect(ctx.fakeUi.status.get("teo")).toBe("teo: T-1 · Изучение задачи · Исследователь · цикл 0");

      // Пока сессия ведёт задачу, другой процесс проект не меняет
      expect((await runCli(sb, ["resume", "T-1", "--plain"])).code).toBe(3);
      expect((await runCli(sb, ["status", "T-1"])).code).toBe(0);
    } finally {
      await host.detach();
    }
  });

  it("каждый ход: роль этапа в системном промпте и инструменты агента по Policy", async () => {
    const { pi, host, ctx } = await started();
    try {
      const event = agentStartEvent();
      await pi.emit("before_agent_start", event, ctx);
      const section = event.systemPromptOptions.sections["teo_stage"] ?? "";
      expect(section).toContain("Твоя роль на этом этапе — «Исследователь»");
      expect(section).toContain("# Задача\nСоздай NOTES.md со строкой hello");
      expect(section).toContain("# Текущий этап: Изучение задачи (discover)");
      expect(section).toContain("- → Выполнение:");
      expect(section).toContain("Внутри .teo писать можно только в .teo/tasks/T-1/artifacts/");
      // DEFAULT_AGENT_TOOLS из зарегистрированных; инструмент вне Policy выключен
      expect(pi.activeTools).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls", "report_result", "report_blocker"]);
      // Модель default — модель пользователя не трогаем (D38)
      expect(pi.setModelCalls).toEqual([]);
    } finally {
      await host.detach();
    }
  });

  it("сообщения пользователя — в журнал как chat со скрытием секретов; команды и сообщения расширения — нет", async () => {
    const { sb, pi, host, ctx } = await started();
    try {
      const secret = "ghp" + "_" + "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xYz123";
      expect(await pi.emit("input", { type: "input", text: `Да, план подходит. Токен ${secret}`, source: "interactive" }, ctx)).toEqual({ action: "continue" });
      await pi.emit("input", { type: "input", text: "/teo status", source: "interactive" }, ctx);
      await pi.emit("input", { type: "input", text: "служебное", source: "extension" }, ctx);
      const chat = (await events(sb, "T-1")).filter((e) => e.type === "human.responded");
      expect(chat).toHaveLength(1);
      expect(chat[0]?.payload).toEqual({ requestId: null, answer: "Да, план подходит. Токен [REDACTED]", selectedOption: null, channel: "chat" });
    } finally {
      await host.detach();
    }
  });

  it("guard: внутри .teo запись только в artifacts задачи", async () => {
    const { sb, pi, host, ctx } = await started();
    try {
      const write = (p: string) => pi.emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: "1", input: { path: p, content: "x" } }, ctx);
      expect(await write(path.join(taskDir(sb, "T-1"), "state.json"))).toMatchObject({ block: true, reason: expect.stringContaining("запрещена") });
      expect(await write(".teo/tasks/T-1/artifacts/plan.md")).toBeUndefined();
      expect(await write("NOTES.md")).toBeUndefined();
    } finally {
      await host.detach();
    }
  });

  it("/teo stop: задача отвязана, инструменты и модель пользователя вернулись, lock свободен", async () => {
    const { sb, pi, host, ctx } = await started();
    await pi.emit("before_agent_start", agentStartEvent(), ctx);
    await host.stop(ctx);
    expect(host.boundKey).toBeNull();
    expect((await state(sb, "T-1")).hostSession).toBeNull();
    expect((await events(sb, "T-1")).at(-1)).toMatchObject({ type: "session.unbound", payload: { reason: "stop" } });
    expect(pi.activeTools).toEqual(["read", "bash", "edit", "write", "web_search"]);
    expect(existsSync(lockFile(sb))).toBe(false);
    expect(pi.entries.at(-1)).toMatchObject({ customType: BINDING_ENTRY, data: { key: null } });
    expect(ctx.fakeUi.status.get("teo")).toBeUndefined();
    // Без привязки хост ничего не делает
    const event = agentStartEvent();
    await pi.emit("before_agent_start", event, ctx);
    expect(event.systemPromptOptions.sections).toEqual({});
    expect((await runCli(sb, ["new", "T-2", "--title", "t", "--description", "d", "--no-run"])).code).toBe(0);
  });

  it("перезапуск Pi: та же сессия продолжает задачу сама (D42), другая — нет", async () => {
    const { sb, pi, host } = await started();
    await host.detach(); // Pi закрыт: lock освобождён, привязка в state и в сессии осталась
    expect((await state(sb, "T-1")).hostSession?.sessionId).toBe("session-1");

    const restarted = new ExtensionHost(pi.api, sb.home);
    pi.handlers.clear();
    restarted.register();
    const same = fakeCtx(pi, { cwd: sb.project, sessionId: "session-1" });
    await pi.emit("session_start", { type: "session_start", reason: "resume" }, same);
    try {
      expect(restarted.boundKey).toBe("T-1");
      expect(same.fakeUi.notes.at(-1)?.message).toContain("сессия снова ведёт задачу T-1");
    } finally {
      await restarted.detach();
    }

    const other = new ExtensionHost(pi.api, sb.home);
    pi.handlers.clear();
    other.register();
    await pi.emit("session_start", { type: "session_start", reason: "fork" }, fakeCtx(pi, { cwd: sb.project, sessionId: "session-2" }));
    expect(other.boundKey).toBeNull();
  });

  it("/teo resume из другой сессии перепривязывает задачу; занятая сессия не берёт вторую задачу", async () => {
    const { sb, host } = await started();
    await host.detach();
    const pi2 = new FakePi();
    const host2 = new ExtensionHost(pi2.api, sb.home);
    host2.register();
    const ctx2 = fakeCtx(pi2, { cwd: sb.project, sessionId: "session-2" });
    await host2.resume(ctx2, "t-1");
    try {
      expect((await state(sb, "T-1")).hostSession?.sessionId).toBe("session-2");
      const types = (await events(sb, "T-1")).map((e) => e.type);
      expect(types.slice(-2)).toEqual(["session.unbound", "session.bound"]);
      // Новая пользовательская сессия должна сама продолжить роль, а не ждать сообщения человека
      expect(pi2.sent).toEqual([
        { message: expect.objectContaining({ customType: "teo-stage", content: expect.stringContaining("Начался этап «Изучение задачи»") }), options: { triggerTurn: true } },
      ]);
      await expect(host2.goal(ctx2, "ещё цель")).rejects.toThrow(/уже ведёт задачу T-1/);
    } finally {
      await host2.detach();
    }
  });

  it("модель роли (D38): включается один раз на этап, если у агента не default", async () => {
    const policy = DED.replace("    title: Исследователь\n    model: default", "    title: Исследователь\n    model: lab/explorer-1:high");
    const sb = await sandbox(policy, { process: "dev" });
    const pi = new FakePi();
    const host = new ExtensionHost(pi.api, sb.home);
    host.register();
    const ctx = fakeCtx(pi, { cwd: sb.project, models: [{ provider: "lab", id: "explorer-1" }], ui: { answers: ["dev", "d", "t"] } });
    await host.start(ctx, "T-1");
    try {
      await pi.emit("before_agent_start", agentStartEvent(), ctx);
      await pi.emit("before_agent_start", agentStartEvent(), ctx);
      expect(pi.setModelCalls).toEqual([{ provider: "lab", id: "explorer-1" }]);
      expect(pi.thinking).toBe("high");
      await host.stop(ctx);
      expect(pi.model).toEqual({ provider: "user", id: "own-model" });
      expect(pi.thinking).toBe("medium");
    } finally {
      await host.detach();
    }
  });

  it("модель роли не найдена в Pi: предупреждение, модель пользователя остаётся", async () => {
    const policy = DED.replace("    title: Исследователь\n    model: default", "    title: Исследователь\n    model: lab/missing");
    const sb = await sandbox(policy, { process: "dev" });
    const pi = new FakePi();
    const host = new ExtensionHost(pi.api, sb.home);
    host.register();
    const ctx = fakeCtx(pi, { cwd: sb.project, ui: { answers: ["dev", "d", "t"] } });
    await host.start(ctx, "T-1");
    try {
      await pi.emit("before_agent_start", agentStartEvent(), ctx);
      expect(pi.setModelCalls).toEqual([]);
      expect(ctx.fakeUi.notes).toContainEqual({ type: "warning", message: expect.stringContaining("модель lab/missing роли «Исследователь» не найдена") });
    } finally {
      await host.detach();
    }
  });

  it("модель роли есть, но провайдер не авторизован: предупреждение, thinking не меняется", async () => {
    const policy = DED.replace("    title: Исследователь\n    model: default", "    title: Исследователь\n    model: lab/private:high");
    const sb = await sandbox(policy, { process: "dev" });
    const pi = new FakePi();
    pi.setModelResult = false;
    const host = new ExtensionHost(pi.api, sb.home);
    host.register();
    const ctx = fakeCtx(pi, { cwd: sb.project, models: [{ provider: "lab", id: "private" }], ui: { answers: ["dev", "d", "t"] } });
    await host.start(ctx, "T-1");
    try {
      await pi.emit("before_agent_start", agentStartEvent(), ctx);
      expect(pi.model).toEqual({ provider: "user", id: "own-model" });
      expect(pi.thinking).toBe("medium");
      expect(ctx.fakeUi.notes).toContainEqual({ type: "warning", message: expect.stringContaining("недоступна без авторизации") });
    } finally {
      await host.detach();
    }
  });

  it("/teo goal: задача GOAL-N по встроенному процессу цели, роль стартует сама", async () => {
    const sb = await sandbox(DED, { process: "dev" });
    const pi = new FakePi();
    const host = new ExtensionHost(pi.api, sb.home);
    host.register();
    const ctx = fakeCtx(pi, { cwd: sb.project });
    await host.goal(ctx, "Собери отчёт по продажам\nза октябрь");
    try {
      expect(host.boundKey).toBe("GOAL-1");
      expect(await state(sb, "GOAL-1")).toMatchObject({ process: GOAL_PROCESS, title: "Собери отчёт по продажам", stage: "pursuit" });
      expect(pi.sent[0]?.message.content).toContain("Роль — «Исполнитель цели»");
    } finally {
      await host.detach();
    }
  });

  it("завершённую задачу привязать нельзя", async () => {
    const sb = await sandbox(DED, { process: "dev" });
    await runCli(sb, ["new", "T-1", "--title", "t", "--description", "d", "--no-run"]);
    await runCli(sb, ["cancel", "T-1", "--reason", "не нужна"]);
    const pi = new FakePi();
    const host = new ExtensionHost(pi.api, sb.home);
    await expect(host.resume(fakeCtx(pi, { cwd: sb.project }), "T-1")).rejects.toThrow(/завершена/);
    expect(existsSync(lockFile(sb))).toBe(false);
  });
});
