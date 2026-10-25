// Фикстуры пишутся настоящим SessionManager 1.4.0, не вручную сериализованным JSONL.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { inspectPiSessionFile, readPiTranscript } from "../../src/agents/pi/session-inspector.js";
import { tmpDir } from "../helpers/tmp.js";

const id = "01J00000000000000000000000";
const usage = { input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function session(file: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const manager = SessionManager.open(file, path.dirname(file), path.dirname(file));
  manager.appendMessage({ role: "user", content: `[sdlc:prompt id=${id} kind=initial run=${id}]\nТест`, timestamp: 1 });
  return manager;
}

it("различает доставленный prompt и зависший tool call на настоящем JSONL Pi", async () => {
  const file = path.join(await tmpDir(), "sessions", "agent.jsonl");
  const manager = await session(file);
  manager.appendMessage({ role: "assistant", content: [
    { type: "text", text: "Проверяю" },
    { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "git push" } },
  ], api: "anthropic-messages", provider: "anthropic", model: "test", usage, stopReason: "toolUse", timestamp: 2 });
  expect(await inspectPiSessionFile(file)).toMatchObject({
    exists: true, valid: true, promptIds: [id], messageCount: 2,
    lastEntry: { kind: "assistant", stopReason: "toolUse", danglingToolCalls: [{ toolCallId: "call-1", toolName: "bash", argsPreview: '{"command":"git push"}' }] },
  });
  expect(await readPiTranscript(file, { tail: 2 })).toEqual([
    { kind: "assistant", text: "Проверяю" },
    { kind: "tool_call", toolCallId: "call-1", toolName: "bash", argsPreview: '{"command":"git push"}' },
  ]);
  manager.appendMessage({ role: "toolResult", toolCallId: "other", toolName: "read", isError: false, content: [{ type: "text", text: "ok" }], timestamp: 3 });
  expect((await inspectPiSessionFile(file)).lastEntry).toMatchObject({ kind: "assistant", danglingToolCalls: [{ toolCallId: "call-1" }] });
  await appendFile(file, "{обрезано");
  expect(await inspectPiSessionFile(file)).toMatchObject({ valid: false, parseError: expect.stringContaining("строка 5") });
});

it("последний завершённый ответ и tool result корректно определяются после служебных записей", async () => {
  const file = path.join(await tmpDir(), "sessions", "agent.jsonl");
  const manager = await session(file);
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Готово" }], api: "anthropic-messages", provider: "anthropic", model: "test", usage, stopReason: "stop", timestamp: 2 });
  expect((await inspectPiSessionFile(file)).lastEntry).toMatchObject({ kind: "assistant", stopReason: "stop", text: "Готово" });
  manager.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false, content: [{ type: "text", text: "hello" }], timestamp: 3 });
  expect((await inspectPiSessionFile(file)).lastEntry).toEqual({ kind: "toolResult" });
  expect((await readPiTranscript(file, { tail: 1 }))[0]).toMatchObject({ kind: "tool_result", ok: true });
  await writeFile(path.join(path.dirname(file), "empty.jsonl"), "");
  expect(await inspectPiSessionFile(path.join(path.dirname(file), "empty.jsonl"))).toMatchObject({ exists: true, valid: true, promptIds: [] });
});
