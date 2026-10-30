// Интеграционные тесты профилей моделей и fallback при исчерпании лимитов (docs/08-model-profiles.md, D44–D49).

import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAgentRuntime, turn } from "../../src/agents/fake/fake-runtime.js";
import type { TaskEvent } from "../../src/domain/events.js";
import type { TaskState } from "../../src/domain/task-state.js";
import { ExtensionHost } from "../../src/extension/host.js";
import { defaultCooldownTracker } from "../../src/util/model-exhaustion.js";
import { agentStartEvent, fakeCtx, FakePi, settleEvent } from "../helpers/fake-pi.js";
import { validDir } from "../helpers/paths.js";
import { sandbox, type Sandbox } from "../helpers/tmp.js";

const DED = readFileSync(path.join(validDir, "discover-execute-done.md"), "utf8");
const taskDir = (sb: Sandbox, key = "T-1") => path.join(sb.project, ".teo", "tasks", key);
const state = async (sb: Sandbox, key = "T-1") => JSON.parse(await readFile(path.join(taskDir(sb, key), "state.json"), "utf8")) as TaskState;
const events = async (sb: Sandbox, key = "T-1") =>
  (await readFile(path.join(taskDir(sb, key), "events.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as TaskEvent);

function assistant(text: string) {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 1, output: 1, cost: { total: 0 } } };
}

afterEach(() => {
  defaultCooldownTracker.clear();
  vi.useRealTimers();
});

describe("Model Profiles & Fallback (D44–D49)", () => {
  it("supervisor при ошибке лимита автоматически переключается на запасную модель из models.md", async () => {
    const sb = await sandbox(DED, { process: "dev" });

    // Создаём ~/.pi/teo/models.md с цепочкой fallback для supervisor
    const modelsMd = `---
schema: teo/v1
roles:
  supervisor:
    - openai-codex/gpt-5.5
    - anthropic/claude-opus-5-5
---
`;
    await writeFile(path.join(sb.home, ".pi", "teo", "models.md"), modelsMd);

    const runtime = new FakeAgentRuntime().script(
      "sessions/supervisor.jsonl",
      // Ход 1 на первой модели: исчерпание лимита
      turn.error("Codex error: The usage limit has been reached"),
      // Ход 2 на запасной модели: успешное решение
      turn.tool("transition_stage", {
        expectedStateVersion: "$expectedStateVersion",
        to: "execute",
        reason: "план подтверждён резервным supervisor-ом",
        evidenceRefs: ["artifact:plan.md"],
      }),
    );

    const pi = new FakePi();
    const host = new ExtensionHost(pi.api, sb.home, () => runtime);
    host.register();
    const ctx = fakeCtx(pi, { cwd: sb.project, ui: { answers: ["dev", "Описание", "Задача"] } });

    await host.start(ctx, "T-1");
    await pi.emit("before_agent_start", agentStartEvent("Начни"), ctx);

    try {
      await writeFile(path.join(taskDir(sb), "artifacts", "plan.md"), "План\n");
      await pi.callTool("report_result", { summary: "План готов", evidence: [{ kind: "artifact", value: "plan.md" }] });

      const boundary = await pi.emit("agent_before_settle", settleEvent([assistant("План готов")]), ctx) as { continue?: boolean };
      expect(boundary, JSON.stringify(ctx.fakeUi.notes)).toBeDefined();
      expect(boundary.continue).toBe(true);

      const afterState = await state(sb);
      expect(afterState).toMatchObject({ stage: "execute", status: "active", phase: "agent_running" });

      // Проверяем, что первая модель в cooldown
      expect(defaultCooldownTracker.isExhausted("openai-codex", "gpt-5.5")).toBe(true);

      const journal = await events(sb);
      const exhausted = journal.find((e) => e.type === "model.exhausted");
      const fallback = journal.find((e) => e.type === "model.fallback");

      expect(exhausted?.payload).toMatchObject({
        provider: "openai-codex",
        modelId: "gpt-5.5",
        reason: "Codex error: The usage limit has been reached",
      });
      expect(fallback?.payload).toMatchObject({
        role: "supervisor",
        fromModel: "openai-codex/gpt-5.5",
        toModel: "anthropic/claude-opus-5-5",
      });
    } finally {
      await host.detach();
    }
  });

  it("когда ВСЕ модели supervisor-а исчерпаны, задача переходит в waiting без блокировки", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));

    const sb = await sandbox(DED, { process: "dev" });
    const modelsMd = `---
schema: teo/v1
roles:
  supervisor:
    - openai-codex/gpt-5.5
---
`;
    await writeFile(path.join(sb.home, ".pi", "teo", "models.md"), modelsMd);

    const runtime = new FakeAgentRuntime().script(
      "sessions/supervisor.jsonl",
      // Единственная модель упирается в лимит с указанием времени
      turn.error("Rate limit reached. Please try again in 5 minutes."),
      // После сброса лимита успешно принимает решение
      turn.tool("transition_stage", {
        expectedStateVersion: "$expectedStateVersion",
        to: "execute",
        reason: "проверка выполнена после сброса лимита",
        evidenceRefs: ["artifact:plan.md"],
      }),
    );

    const pi = new FakePi();
    const host = new ExtensionHost(pi.api, sb.home, () => runtime);
    host.register();
    const ctx = fakeCtx(pi, { cwd: sb.project, ui: { answers: ["dev", "Описание", "Задача"] } });

    await host.start(ctx, "T-1");
    await pi.emit("before_agent_start", agentStartEvent("Начни"), ctx);

    try {
      await writeFile(path.join(taskDir(sb), "artifacts", "plan.md"), "План\n");
      await pi.callTool("report_result", { summary: "План готов", evidence: [{ kind: "artifact", value: "plan.md" }] });

      const boundary = await pi.emit("agent_before_settle", settleEvent([assistant("План готов")]), ctx) as { continue?: boolean };
      expect(boundary.continue).toBe(false);

      // Задача НЕ заблокирована! Она в фазе waiting
      const waitingState = await state(sb);
      expect(waitingState.status).toBe("active");
      expect(waitingState.phase).toBe("waiting");
      expect(waitingState.wait?.waitingFor).toContain("лимит");
      expect(waitingState.wait?.targetPhase).toBe("supervisor_pending");

      // В статусе отображается обратный отсчёт
      expect(ctx.fakeUi.status.get("teo")).toContain("лимит моделей исчерпан");
      expect(ctx.fakeUi.status.get("teo")).toContain("5 мин 00 сек");

      // Продвигаем время на 5 минут: лимит сбрасывается и таймер автоматически перезапускает проверку
      const internal = host as unknown as { binding: { waitTimer: unknown }; fireWaitTimer: (b: unknown, c: unknown) => Promise<void> };
      vi.setSystemTime(new Date("2026-03-01T12:05:00.000Z"));
      await internal.fireWaitTimer(internal.binding, ctx);

      const afterWaitState = await state(sb);
      expect(afterWaitState.stage).toBe("execute");
      expect(afterWaitState.phase).toBe("agent_pending");
      await pi.emit("before_agent_start", agentStartEvent("Выполняю"), ctx);
      expect((await state(sb)).phase).toBe("agent_running");
    } finally {
      await host.detach();
    }
  });

  it("в режиме расширения applyModel выбирает модель роли из models.md через pi.setModel", async () => {
    const sb = await sandbox(DED, { process: "dev" });
    const modelsMd = `---
schema: teo/v1
roles:
  explorer:
    - anthropic/claude-sonnet-5-5
---
`;
    await writeFile(path.join(sb.home, ".pi", "teo", "models.md"), modelsMd);

    const runtime = new FakeAgentRuntime();
    const pi = new FakePi();
    const host = new ExtensionHost(pi.api, sb.home, () => runtime);
    host.register();

    const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" };
    const ctx = fakeCtx(pi, {
      cwd: sb.project,
      models: [sonnet],
      ui: { answers: ["dev", "Описание", "Задача"] },
    });

    await host.start(ctx, "T-1");
    await pi.emit("before_agent_start", agentStartEvent("Старт"), ctx);

    try {
      expect(pi.setModelCalls).toContainEqual(expect.objectContaining({ provider: "anthropic", id: "claude-sonnet-5-5" }));
      expect(pi.model).toMatchObject({ provider: "anthropic", id: "claude-sonnet-5-5" });
    } finally {
      await host.detach();
    }
  });
});
