import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JiraClient, jiraKey, loadJiraConfig } from "../../src/integrations/jira.js";
import { tmpDir } from "../helpers/tmp.js";

describe("Jira integration", () => {
  it("извлекает key из ключа и URL", () => {
    expect(jiraKey("apd-1253")).toBe("APD-1253");
    expect(jiraKey("https://company.atlassian.net/browse/APD-1253")).toBe("APD-1253");
    expect(jiraKey("https://company.atlassian.net/issues/APD-1253?x=1")).toBe("APD-1253");
    expect(jiraKey("что-то другое")).toBeNull();
  });

  it("загружает несекретные настройки из jira.md, а секрет из ~/.env", async () => {
    const home = await tmpDir();
    await mkdir(path.join(home, ".pi", "teo"), { recursive: true });
    await writeFile(path.join(home, ".pi", "teo", "jira.md"), `---\nschema: teo/jira-v1\nbaseUrl: https://jira.example\nprojectKey: APD\nissueType: Task\nauth:\n  mode: basic\n  tokenEnv: CUSTOM_JIRA_TOKEN\n  emailEnv: CUSTOM_JIRA_EMAIL\n---\n`);
    await writeFile(path.join(home, ".env"), "CUSTOM_JIRA_TOKEN=secret-value\nCUSTOM_JIRA_EMAIL=user@example.com\n");
    await expect(loadJiraConfig(home, {})).resolves.toMatchObject({
      baseUrl: "https://jira.example", projectKey: "APD", issueType: "Task", authMode: "basic", email: "user@example.com", token: "secret-value",
    });
  });

  it("читает существующую задачу и преобразует ADF в текст", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const request: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({
        key: "APD-7",
        fields: { summary: "Название", description: { type: "doc", version: 1, content: [
          { type: "paragraph", content: [{ type: "text", text: "Первая строка" }] },
          { type: "paragraph", content: [{ type: "text", text: "Вторая строка" }] },
        ] } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new JiraClient({ baseUrl: "https://jira.example", token: "token", authMode: "bearer" }, request);
    await expect(client.issue("APD-7")).resolves.toEqual({
      key: "APD-7", url: "https://jira.example/browse/APD-7", title: "Название", description: "Первая строка\nВторая строка",
    });
    expect(capturedUrl).toContain("/rest/api/3/issue/APD-7");
    expect(capturedInit?.headers).toMatchObject({ Authorization: "Bearer token" });
  });

  it("создаёт задачу и не включает token в ошибку API", async () => {
    let createInit: RequestInit | undefined;
    const ok: typeof fetch = async (_input, init) => {
      createInit = init;
      return new Response(JSON.stringify({ key: "APD-8" }), { status: 201, headers: { "content-type": "application/json" } });
    };
    const client = new JiraClient({ baseUrl: "https://jira.example/", token: "secret", email: "user@example.com", authMode: "basic" }, ok);
    await expect(client.create({ projectKey: "APD", issueType: "Task", title: "Новая", description: "Описание" })).resolves.toMatchObject({ key: "APD-8" });
    const body = JSON.parse(String(createInit?.body));
    expect(body.fields).toMatchObject({ project: { key: "APD" }, issuetype: { name: "Task" }, summary: "Новая" });

    const failed = new JiraClient({ baseUrl: "https://jira.example", token: "do-not-print" }, (async () => new Response("forbidden", { status: 403 })) as typeof fetch);
    const error: unknown = await failed.issue("APD-9").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected Jira error");
    expect(error.message).toContain("HTTP 403");
    expect(error.message).not.toContain("do-not-print");
  });
});
