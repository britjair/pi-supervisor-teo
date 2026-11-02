import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectTaskSeed } from "../../src/commands/task-source.js";
import { testContext } from "../helpers/context.js";
import { ScriptedHumanIO } from "../helpers/scripted-human-io.js";
import { sandbox } from "../helpers/tmp.js";

afterEach(() => vi.unstubAllGlobals());

async function configured() {
  const sb = await sandbox();
  await writeFile(`${sb.home}/.env`, [
    "JIRA_BASE_URL=https://company.atlassian.net",
    "JIRA_PROJECT_KEY=APD",
    "JIRA_TOKEN=secret",
    "JIRA_EMAIL=user@example.com",
  ].join("\n"));
  return sb;
}

describe("Jira-aware task source", () => {
  it("загружает существующую Jira-задачу и использует её key", async () => {
    const sb = await configured();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      key: "APD-12", fields: { summary: "Экспорт", description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Требования" }] }] } },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const human = new ScriptedHumanIO([
      { select: "Да, Jira-задача уже есть" },
      { input: "https://company.atlassian.net/browse/APD-12" },
      { confirm: true },
    ]);
    await expect(collectTaskSeed(testContext(sb, { human }), human, [])).resolves.toMatchObject({
      key: "APD-12", title: "Экспорт", description: expect.stringContaining("Требования"), jira: { key: "APD-12" },
    });
  });

  it("создаёт Jira-задачу после preview и использует возвращённый key", async () => {
    const sb = await configured();
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ key: "APD-13" }), { status: 201, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", request);
    const human = new ScriptedHumanIO([
      { select: "Нет, Jira-задачи ещё нет" },
      { multiline: "Добавить экспорт\nПоддержать CSV" },
      { confirm: true },
      { input: "Task" },
      { confirm: true },
    ]);
    const seed = await collectTaskSeed(testContext(sb, { human }), human, []);
    expect(seed).toMatchObject({ key: "APD-13", title: "Добавить экспорт", jira: { url: "https://company.atlassian.net/browse/APD-13" } });
    expect(human.printed).toContain("Будет создана Jira-задача");
  });

  it("при отказе от Jira генерирует LOCAL key", async () => {
    const sb = await sandbox();
    const human = new ScriptedHumanIO([
      { select: "Нет, Jira-задачи ещё нет" },
      { multiline: "Локальная задача" },
      { confirm: false },
    ]);
    const seed = await collectTaskSeed(testContext(sb, { human }), human, []);
    expect(seed).toMatchObject({ key: expect.stringMatching(/^LOCAL-/), title: "Локальная задача", jira: null });
  });
});
