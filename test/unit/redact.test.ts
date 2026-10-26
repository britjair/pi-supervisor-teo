// Redaction на реальных форматах токенов (06-implementation.md §4.1, M6).
// Токены собираются из частей: в репозитории нет строк, похожих на настоящие секреты целиком.

import { describe, expect, it } from "vitest";
import { MAX_EVENT_STRING, REDACTED, argsPreview, redact, redactEventPayload, redactString } from "../../src/util/redact.js";

const alnum = (n: number) => "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY".repeat(4).slice(0, n);
const upper = (n: number) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".repeat(2).slice(0, n);

const TOKENS: Record<string, string> = {
  "OpenAI project": "sk-" + "proj-" + alnum(48),
  "Anthropic": "sk-" + "ant-api03-" + alnum(40) + "-" + alnum(20),
  "Stripe live": "sk_" + "live_" + alnum(24),
  "Stripe restricted": "rk_" + "test_" + alnum(24),
  "GitHub classic": "ghp" + "_" + alnum(36),
  "GitHub app": "ghs" + "_" + alnum(36),
  "GitHub fine-grained": "github" + "_pat_" + "11A" + alnum(19) + "_" + alnum(59),
  "GitLab personal": "gl" + "pat-" + alnum(20),
  "GitLab deploy": "gl" + "dt-" + alnum(20),
  "Slack bot": "xo" + "xb-" + "1234567890-1234567890123-" + alnum(24),
  "Slack app": "xa" + "pp-1-" + "A01" + upper(8) + "-1234567890-" + alnum(32).toLowerCase(),
  "Slack webhook": "https://hooks.slack" + ".com/services/T0" + upper(7) + "/B0" + upper(7) + "/" + alnum(24),
  "AWS access key": "AK" + "IA" + upper(16),
  "AWS temporary key": "AS" + "IA" + upper(16),
  "Google API key": "AI" + "za" + alnum(35),
  "Google OAuth": "ya" + "29." + alnum(40),
  "Atlassian": "ATA" + "TT3" + alnum(60),
  "npm": "np" + "m_" + alnum(36),
  "PyPI": "py" + "pi-" + "AgEIcHlwaS5vcmc" + alnum(50),
  "Docker Hub": "dckr" + "_pat_" + alnum(27),
  "Hugging Face": "h" + "f_" + alnum(34),
  "SendGrid": "S" + "G." + alnum(22) + "." + alnum(43),
  "Telegram": "1234567890" + ":AA" + alnum(33),
  "JWT": "ey" + "JhbGciOiJIUzI1NiJ9." + "ey" + "JzdWIiOiIxMjM0NTY3ODkwIn0." + alnum(43),
};

describe("redactString", () => {
  for (const [name, token] of Object.entries(TOKENS)) {
    it(`скрывает ${name}`, () => {
      const out = redactString(`до ${token} после`);
      expect(out).not.toContain(token);
      expect(out).toContain(REDACTED);
      expect(out.startsWith("до ")).toBe(true);
      expect(out.endsWith(" после")).toBe(true);
    });
  }

  it("скрывает закрытые ключи PEM, OpenSSH и PGP целиком", () => {
    for (const kind of ["RSA PRIVATE KEY", "OPENSSH PRIVATE KEY", "PRIVATE KEY", "PGP PRIVATE KEY BLOCK"]) {
      const block = `-----BEGIN ${kind}-----\n${alnum(64)}\n${alnum(64)}\n-----END ${kind}-----`;
      expect(redactString(`ключ:\n${block}\nконец`)).toBe(`ключ:\n${REDACTED}\nконец`);
    }
  });

  it("скрывает заголовки авторизации, сохраняя имя заголовка", () => {
    expect(redactString("curl -H 'Authorization: Bearer " + alnum(32) + "'")).toBe(`curl -H 'Authorization: ${REDACTED}'`);
    expect(redactString("Authorization: Basic " + "dXNlcjpwYXNzd29yZA==")).toBe(`Authorization: ${REDACTED}`);
  });

  it("скрывает пароль в URL, сохраняя пользователя и хост", () => {
    expect(redactString("git clone https://deploy:" + alnum(20) + "@gitlab.example.com/x.git")).toBe(
      `git clone https://deploy:${REDACTED}@gitlab.example.com/x.git`,
    );
    expect(redactString("postgres://app:" + "hunter2hunter2" + "@db:5432/app")).toBe(`postgres://app:${REDACTED}@db:5432/app`);
  });

  it("скрывает значения присваиваний в env, JSON, YAML и query string", () => {
    expect(redactString("export GITLAB_TOKEN=" + alnum(12))).toBe(`export GITLAB_TOKEN=${REDACTED}`);
    expect(redactString('{"password": "' + "correct-horse" + '"}')).toBe(`{"password": "${REDACTED}"}`);
    expect(redactString("db_password: " + "s3cr3t-value")).toBe(`db_password: ${REDACTED}`);
    expect(redactString("aws_secret_access_key = " + alnum(40))).toBe(`aws_secret_access_key = ${REDACTED}`);
    expect(redactString("https://api.example.com/v1?access_token=" + alnum(20) + "&page=2")).toBe(
      `https://api.example.com/v1?access_token=${REDACTED}&page=2`,
    );
  });

  it("не трогает обычный текст, хеши, идентификаторы и счётчики токенов", () => {
    const text = [
      "commit 7baf12c0a9d4e1f2b3c4d5e6f708192a3b4c5d6e на ветке feature/PAY-142",
      "sha256:9b7e3f1c2d4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1",
      "run 01JB2XKQ8M3N4P5R6S7T8V9W0X, event 01JB2XKQ8M3N4P5R6S7T8V9W0Y",
      "inputTokens: 412000, outputTokens: 38000, maxTokens: 8192",
      "tokens: 41k · Basic configuration of the token bucket",
      "go test ./... && npm run build",
    ].join("\n");
    expect(redactString(text)).toBe(text);
  });

  it("идемпотентна", () => {
    const once = redactString("GITHUB_TOKEN=" + TOKENS["GitHub classic"]);
    expect(redactString(once)).toBe(once);
  });
});

describe("redact", () => {
  it("скрывает строковые значения секретных ключей на любой глубине", () => {
    const out = redact({ apiKey: "x1", nested: [{ Authorization: "y2", cookie: "z3" }], private_key: "k" });
    expect(out).toEqual({ apiKey: REDACTED, nested: [{ Authorization: REDACTED, cookie: REDACTED }], private_key: REDACTED });
  });

  it("сохраняет счётчики токенов и прочие числа", () => {
    const usage = { inputTokens: 412000, outputTokens: 38000, maxTokens: 8192, costUsd: 3.87, token_count: 5 };
    expect(redact(usage)).toEqual(usage);
  });

  it("обрезает длинные строки с пометкой", () => {
    const out = redact({ text: "a".repeat(100) }, { maxString: 10 });
    expect(out.text).toMatch(/^a{10}\n…\[обрезано: показано 10 из 100 символов\]$/);
  });

  it("argsPreview — одна строка без секретов", () => {
    const preview = argsPreview({ command: "curl -H 'Authorization: Bearer " + alnum(32) + "'\n  https://x" });
    expect(preview).not.toContain("\n");
    expect(preview).toContain(REDACTED);
  });
});

describe("redactEventPayload", () => {
  it("скрывает секреты в payload и ограничивает строки 16 KB", () => {
    const out = redactEventPayload("supervisor.note", { cycle: 1, text: "токен " + TOKENS["npm"] + " " + "x".repeat(MAX_EVENT_STRING) }) as { text: string };
    expect(out.text).not.toContain(TOKENS["npm"]);
    expect(out.text).toContain("обрезано");
  });

  it("не редактирует ответ человека в нативном диалоге — это дословное доказательство approval", () => {
    const payload = { requestId: null, answer: "используй ключ " + TOKENS["Stripe live"], selectedOption: null };
    expect(redactEventPayload("human.responded", payload)).toBe(payload);
  });

  it("редактирует обычное сообщение человека из чата расширения (D43)", () => {
    const payload = { requestId: null, answer: "токен " + TOKENS["GitHub classic"], selectedOption: null, channel: "chat" };
    const out = redactEventPayload("human.responded", payload) as typeof payload;
    expect(out).not.toBe(payload);
    expect(out.answer).toBe(`токен ${REDACTED}`);
  });
});
