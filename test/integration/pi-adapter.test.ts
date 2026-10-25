// Проверки реального SDK без сетевых запросов и без доступа к пользовательскому ~/.pi.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { PiAgentRuntime } from "../../src/agents/pi/pi-agent-runtime.js";
import { toPiTool } from "../../src/agents/pi/pi-tool-adapter.js";
import type { SessionSpec } from "../../src/agents/runtime.js";
import { tmpDir } from "../helpers/tmp.js";

it("адаптер TypeBox вызывает Zod-контракт и передаёт terminate/error в Pi", async () => {
  const tool = toPiTool({
    name: "report_result", description: "Записать результат", parameters: z.object({ summary: z.string().min(2) }),
    execute: async ({ summary }) => ({ content: `Записано: ${summary}`, terminate: true }),
  });
  expect(tool.parameters).toMatchObject({ type: "object", properties: { summary: { type: "string" } } });
  const execute = (input: object) => tool.execute("tool-call-1", input, new AbortController().signal, undefined, {} as never);
  expect(await execute({ summary: "ok" })).toMatchObject({ terminate: true, content: [{ type: "text", text: "Записано: ok" }] });
  expect(await execute({ summary: "x" })).toMatchObject({ isError: true });
});

describe("Pi SDK", () => {
  it("открывает сессию по явному пути с точным allowlist и inline guard без обращения к модели", async () => {
    const root = await tmpDir();
    const agentDir = path.join(root, "pi-agent");
    const sessions = path.join(root, "sessions");
    await mkdir(agentDir);
    await mkdir(sessions);
    const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const model = modelRuntime.getModels()[0];
    expect(model).toBeDefined();
    const runtime = new PiAgentRuntime({ agentDir, cwd: root });
    const file = path.join(sessions, "agent-001.jsonl");
    const spec: SessionSpec = {
      file, cwd: root, role: "agent", model: { id: `${model?.provider}/${model?.id}`, thinking: "off", providedBy: null, handle: model },
      systemPromptAppend: "Работай только с задачей.", builtinTools: ["read"],
      customTools: [{ name: "report_result", description: "Отчёт", parameters: z.object({ summary: z.string() }), execute: async () => ({ content: "готово", terminate: true }) }],
      piResources: { contextFiles: false, extensions: false, skills: false },
      guard: { role: "agent", projectRoot: root, taskDir: root, writableInsideSdlc: [root], readableRoots: [root], isReported: () => false },
    };
    const handle = await runtime.openSession(spec);
    expect(handle.sessionFile).toBe(file);
    expect(handle.role).toBe("agent");
    handle.dispose();
    await runtime.dispose();
    // Первое user-сообщение ещё не отправлено: SDK пока не создал JSONL.
    expect((await runtime.inspectSessionFile(file)).exists).toBe(false);
    // SessionManager.open тоже открывает этот путь, а не пользовательский ~/.pi.
    expect(SessionManager.open(file, sessions, root).getSessionFile()).toBe(file);
  });
});
