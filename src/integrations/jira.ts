import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { UsageError } from "../errors/errors.js";

export type JiraAuthMode = "bearer" | "basic";

export type JiraConfig = {
  baseUrl?: string;
  projectKey?: string;
  issueType?: string;
  email?: string;
  token?: string;
  authMode?: JiraAuthMode;
  tokenEnv: string;
  emailEnv: string;
};

export type JiraIssue = { key: string; url: string; title: string; description: string };
export type JiraCreateInput = { projectKey: string; issueType: string; title: string; description: string };

type Fetch = typeof fetch;
type JiraFile = {
  schema?: string;
  baseUrl?: string;
  projectKey?: string;
  issueType?: string;
  auth?: { mode?: JiraAuthMode; tokenEnv?: string; emailEnv?: string };
};

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[match[1] ?? ""] = value;
  }
  return out;
}

async function optionalFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function frontMatter(text: string): unknown {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/.exec(text);
  return parseYaml(match?.[1] ?? text);
}

/** Loads non-secret settings from ~/.pi/teo/jira.md and secrets from env/~/.env. */
export async function loadJiraConfig(homeDir: string, env: Record<string, string | undefined>): Promise<JiraConfig> {
  const envFile = parseEnv((await optionalFile(path.join(homeDir, ".env"))) ?? "");
  const value = (name: string): string | undefined => env[name] || envFile[name];
  const configText = await optionalFile(path.join(homeDir, ".pi", "teo", "jira.md"));
  const raw = (configText ? frontMatter(configText) : {}) as JiraFile;
  if (raw.schema !== undefined && raw.schema !== "teo/jira-v1") throw new UsageError("Неверная schema в ~/.pi/teo/jira.md: ожидается teo/jira-v1.");
  const tokenEnv = raw.auth?.tokenEnv ?? "JIRA_TOKEN";
  const emailEnv = raw.auth?.emailEnv ?? "JIRA_EMAIL";
  const email = value(emailEnv);
  const baseUrl = raw.baseUrl ?? value("JIRA_BASE_URL");
  const projectKey = raw.projectKey ?? value("JIRA_PROJECT_KEY");
  const issueType = raw.issueType ?? value("JIRA_ISSUE_TYPE");
  const token = value(tokenEnv);
  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(projectKey ? { projectKey } : {}),
    ...(issueType ? { issueType } : {}),
    ...(token ? { token } : {}),
    ...(email ? { email } : {}),
    ...(raw.auth?.mode ? { authMode: raw.auth.mode } : email ? { authMode: "basic" as const } : {}),
    tokenEnv,
    emailEnv,
  };
}

export function jiraKey(value: string): string | null {
  const input = value.trim();
  const direct = /^([A-Za-z][A-Za-z0-9_]*-\d+)$/.exec(input);
  if (direct) return direct[1]?.toUpperCase() ?? null;
  try {
    const url = new URL(input);
    const match = /\/(?:browse|issues)\/([A-Za-z][A-Za-z0-9_]*-\d+)(?:[/?#]|$)/i.exec(url.pathname + url.search + url.hash);
    return match?.[1]?.toUpperCase() ?? null;
  } catch {
    return null;
  }
}

function adfText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(adfText).join("");
  if (typeof value !== "object") return "";
  const node = value as { type?: string; text?: string; content?: unknown[] };
  if (node.type === "text") return node.text ?? "";
  const body = adfText(node.content ?? []);
  return ["paragraph", "heading", "listItem"].includes(node.type ?? "") ? body + "\n" : body;
}

function adf(description: string): object {
  return {
    type: "doc",
    version: 1,
    content: description.split("\n").map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : [],
    })),
  };
}

export class JiraClient {
  constructor(
    private readonly config: Required<Pick<JiraConfig, "baseUrl" | "token">> & Pick<JiraConfig, "email" | "authMode">,
    private readonly request: Fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    const mode = this.config.authMode ?? (this.config.email ? "basic" : "bearer");
    const authorization = mode === "basic"
      ? `Basic ${Buffer.from(`${this.config.email ?? ""}:${this.config.token}`).toString("base64")}`
      : `Bearer ${this.config.token}`;
    return { Authorization: authorization, Accept: "application/json", "Content-Type": "application/json" };
  }

  private async json(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.request(url, { ...init, headers: { ...this.headers(), ...(init.headers ?? {}) } });
    } catch {
      throw new UsageError("Не удалось подключиться к Jira. Проверьте URL и сетевое соединение.");
    }
    if (!response.ok) throw new UsageError(`Jira API вернул HTTP ${response.status}. Проверьте доступ и настройки Jira.`);
    return await response.json() as Record<string, unknown>;
  }

  async issue(key: string): Promise<JiraIssue> {
    const base = this.config.baseUrl.replace(/\/$/, "");
    const data = await this.json(`${base}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description`);
    const fields = (data["fields"] ?? {}) as Record<string, unknown>;
    return {
      key: String(data["key"] ?? key).toUpperCase(),
      url: `${base}/browse/${String(data["key"] ?? key).toUpperCase()}`,
      title: String(fields["summary"] ?? "").trim(),
      description: adfText(fields["description"]).trim(),
    };
  }

  async create(input: JiraCreateInput): Promise<JiraIssue> {
    const base = this.config.baseUrl.replace(/\/$/, "");
    const data = await this.json(`${base}/rest/api/3/issue`, {
      method: "POST",
      body: JSON.stringify({ fields: {
        project: { key: input.projectKey },
        issuetype: { name: input.issueType },
        summary: input.title,
        description: adf(input.description),
      } }),
    });
    const key = String(data["key"] ?? "").toUpperCase();
    if (!key) throw new UsageError("Jira создала задачу, но не вернула её ключ.");
    return { key, url: `${base}/browse/${key}`, title: input.title, description: input.description };
  }
}

export function jiraConfigHint(config: JiraConfig): string {
  return [
    "Чтобы не вводить настройки Jira каждый раз, создайте ~/.pi/teo/jira.md:",
    "---",
    "schema: teo/jira-v1",
    `baseUrl: ${config.baseUrl ?? "https://company.atlassian.net"}`,
    `projectKey: ${config.projectKey ?? "PROJECT"}`,
    `issueType: ${config.issueType ?? "Task"}`,
    "auth:",
    `  mode: ${config.authMode ?? "basic"}`,
    `  tokenEnv: ${config.tokenEnv}`,
    `  emailEnv: ${config.emailEnv}`,
    "---",
    `Секрет ${config.tokenEnv} храните в ~/.env, а не в jira.md.`,
  ].join("\n");
}
