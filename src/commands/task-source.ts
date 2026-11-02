import type { AppContext } from "../app.js";
import { UsageError } from "../errors/errors.js";
import { JiraClient, jiraConfigHint, jiraKey, loadJiraConfig, type JiraConfig, type JiraIssue } from "../integrations/jira.js";
import type { HumanIO } from "../ui/human-io.js";
import { findCaseInsensitive } from "../state/task-key.js";

const TITLE_MAX = 200;
function titleFromDescription(description: string): string {
  const line = description.split("\n").map((part) => part.trim()).find(Boolean) ?? "Новая задача";
  const chars = [...line];
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX - 1).join("") + "…" : line;
}

export type TaskSeed = { key: string; title: string; description: string; jira: JiraIssue | null };

type SourceChoice = "existing" | "missing";

function withJiraSource(issue: JiraIssue, description: string): string {
  return [`Jira: ${issue.url}`, "", description || "В Jira пока нет описания."].join("\n");
}

function duplicate(key: string, existing: readonly string[]): void {
  const found = findCaseInsensitive(key, existing);
  if (found) throw new UsageError(`Задача «${found}» уже есть в проекте.`);
}

async function completeAuth(human: HumanIO, config: JiraConfig): Promise<JiraConfig> {
  let next = config;
  let prompted = false;
  if (!next.baseUrl) {
    const baseUrl = await human.input("URL Jira", { validate: (v) => {
      try { new URL(v); return null; } catch { return "Введите полный URL Jira, например https://company.atlassian.net."; }
    } });
    next = { ...next, baseUrl };
    prompted = true;
  }
  const baseUrl = next.baseUrl;
  if (!baseUrl) throw new UsageError("Не указан URL Jira.");
  const cloud = baseUrl.includes("atlassian.net");
  if ((next.authMode === "basic" || cloud) && !next.email) {
    const email = await human.input("Email пользователя Jira", { validate: (v) => v.includes("@") ? null : "Введите email пользователя Jira." });
    next = { ...next, email, authMode: "basic" };
    prompted = true;
  }
  if (!next.token) throw new UsageError(`Не найден токен Jira. Добавьте ${next.tokenEnv}=... в ~/.env и повторите команду.`);
  if (prompted) human.print(jiraConfigHint(next));
  return next;
}

function client(config: JiraConfig): JiraClient {
  if (!config.baseUrl || !config.token) throw new UsageError("Не заполнены обязательные настройки Jira.");
  return new JiraClient({ baseUrl: config.baseUrl, token: config.token, ...(config.email ? { email: config.email } : {}), ...(config.authMode ? { authMode: config.authMode } : {}) });
}

async function existingIssue(ctx: AppContext, human: HumanIO, existing: readonly string[], initialValue?: string): Promise<TaskSeed | null> {
  const value = initialValue ?? await human.input("Ссылка или ключ Jira-задачи", { validate: (v) => jiraKey(v) ? null : "Введите ссылку Jira или ключ вида PROJECT-123." });
  const key = jiraKey(value);
  if (!key) return null;
  duplicate(key, existing);
  let config = await loadJiraConfig(ctx.homeDir, ctx.env);
  try {
    const parsed = new URL(value);
    if (!config.baseUrl) config = { ...config, baseUrl: parsed.origin };
  } catch { /* key without URL uses configured base URL */ }
  config = await completeAuth(human, config);
  const issue = await client(config).issue(key);
  human.print(["", `Найдена Jira-задача ${issue.key}`, `URL: ${issue.url}`, `Название: ${issue.title || "(без названия)"}`, "Описание:", issue.description || "(пусто)", ""].join("\n"));
  if (!(await human.confirm("Работать с этой Jira-задачей?", true))) return null;
  return { key: issue.key, title: issue.title || issue.key, description: withJiraSource(issue, issue.description), jira: issue };
}

async function createIssue(ctx: AppContext, human: HumanIO, title: string, description: string): Promise<JiraIssue> {
  let config = await loadJiraConfig(ctx.homeDir, ctx.env);
  config = await completeAuth(human, config);
  let prompted = false;
  if (!config.projectKey) {
    config = { ...config, projectKey: await human.input("Ключ Jira-проекта", { validate: (v) => /^[A-Za-z][A-Za-z0-9_]*$/.test(v) ? null : "Например: APD." }) };
    prompted = true;
  }
  if (!config.issueType) {
    config = { ...config, issueType: await human.input("Тип Jira-задачи", { initial: "Task", validate: (v) => v.trim() ? null : "Тип задачи не может быть пустым." }) };
    prompted = true;
  }
  const projectKey = config.projectKey;
  const issueType = config.issueType;
  if (!projectKey || !issueType) throw new UsageError("Не заполнены проект или тип Jira-задачи.");
  if (prompted) human.print(jiraConfigHint(config));
  human.print(["", "Будет создана Jira-задача:", `Jira: ${config.baseUrl}`, `Проект: ${projectKey}`, `Тип: ${issueType}`, `Название: ${title}`, "Описание:", description, ""].join("\n"));
  if (!(await human.confirm("Создать эту Jira-задачу?", true))) throw new UsageError("Создание Jira-задачи отменено.");
  return client(config).create({ projectKey, issueType, title, description });
}

/** New interactive start flow. Returns null when the user declines the selected existing Jira issue. */
export async function collectTaskSeed(ctx: AppContext, human: HumanIO, existing: readonly string[], initialJira?: string): Promise<TaskSeed | null> {
  const source = initialJira ? "existing" : await human.select<SourceChoice>("Есть ли уже созданная Jira-задача?", [
    { label: "Да, Jira-задача уже есть", value: "existing" },
    { label: "Нет, Jira-задачи ещё нет", value: "missing" },
  ]);
  if (source === "existing") return existingIssue(ctx, human, existing, initialJira);

  const description = await human.multiline("Что нужно сделать? Можно вставить описание или спецификацию", {
    validate: (v) => v.trim() ? null : "Описание не может быть пустым.",
  });
  const title = titleFromDescription(description);
  if (await human.confirm("Создать Jira-задачу?", true)) {
    const issue = await createIssue(ctx, human, title, description);
    duplicate(issue.key, existing);
    return { key: issue.key, title: issue.title, description: withJiraSource(issue, description), jira: issue };
  }
  let key: string;
  do key = `LOCAL-${ctx.ids.next().slice(-10)}`; while (findCaseInsensitive(key, existing));
  return { key, title, description, jira: null };
}
