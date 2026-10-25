// Редактирование секретов, 04-agents.md §8. Ответы человека не редактируются (02-storage.md §6.3).

const SECRET_KEY_RE = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|private[_-]?key)/i;
/** Счётчики и лимиты с «token» в имени (inputTokens, maxTokens) — не секреты. */
const NOT_SECRET_KEY_RE = /(tokens|token_?count|tokens?_?(limit|used|usage))$/i;

const PATTERNS: RegExp[] = [
  // PEM и PGP: закрытые ключи целиком
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g,
  // JWT
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // OpenAI, Anthropic (sk-ant-…), DeepSeek и другие sk-…
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  // Stripe
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  // GitHub
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // GitLab: personal, deploy, pipeline trigger, runner, feed tokens
  /\bgl(?:pat|dt|ptt|rt|ft|cbt|imt|soat)-[A-Za-z0-9_-]{16,}\b/g,
  // Slack: bot/user/app/refresh tokens и incoming webhooks
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bxapp-\d-[A-Za-z0-9-]{10,}\b/g,
  /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{16,}/g,
  // AWS access key id (долгоживущие и временные)
  /\b(?:AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16}\b/g,
  // Google API key и OAuth access token
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bya29\.[0-9A-Za-z_-]{20,}/g,
  // Atlassian (Jira/Confluence) API token
  /\bATATT3[A-Za-z0-9_=-]{40,}/g,
  // npm, PyPI, Docker Hub, Hugging Face
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bpypi-[A-Za-z0-9_-]{50,}/g,
  /\bdckr_pat_[A-Za-z0-9_-]{20,}/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g,
  // SendGrid
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  // Telegram bot token
  /\b\d{8,10}:AA[0-9A-Za-z_-]{33}\b/g,
  // HTTP-заголовки авторизации
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b((?:Proxy-)?Authorization\s*:\s*)(?:Basic|Digest|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi,
];
const URL_CREDENTIALS_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;
/** Присваивание в тексте: GITHUB_TOKEN=…, "password": "…", ?access_token=… */
const ASSIGNMENT_RE =
  /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(["']?)([^\s"'&,;)}\]]{6,})/gi;

export const REDACTED = "[REDACTED]";
export const MAX_EVENT_STRING = 16 * 1024;

export function redactString(s: string): string {
  let out = s;
  for (const re of PATTERNS) out = out.replace(re, (m, header?: unknown) => (typeof header === "string" && /authorization/i.test(header) ? `${header}${REDACTED}` : REDACTED));
  out = out.replace(URL_CREDENTIALS_RE, (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`);
  return out.replace(ASSIGNMENT_RE, (m, name: string, sep: string, quote: string, value: string) =>
    NOT_SECRET_KEY_RE.test(name) || value.startsWith(REDACTED.slice(0, -1)) ? m : `${name}${sep}${quote}${REDACTED}`,
  );
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key) && !NOT_SECRET_KEY_RE.test(key);
}

/** Глубокая копия со скрытыми секретами: по имени ключа и по формату строки. */
export function redact<T>(value: T, opts: { maxString?: number } = {}): T {
  const max = opts.maxString ?? Infinity;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return truncate(redactString(v), max);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = isSecretKey(k) && typeof val === "string" ? REDACTED : walk(val);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * Payload события перед записью в журнал (02-storage.md §6.3): секреты скрыты, строки до 16 KB.
 * Ответ человека — доказательство approval, его текст сохраняется как есть.
 */
export function redactEventPayload(type: string, payload: unknown): unknown {
  if (type === "human.responded") return payload;
  return redact(payload, { maxString: MAX_EVENT_STRING });
}

/** Обрезка с явной пометкой. */
export function truncate(s: string, max: number, note = "обрезано"): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[${note}: показано ${max} из ${s.length} символов]`;
}

/** Однострочный короткий предпросмотр аргументов tool (UI, журнал). */
export function argsPreview(args: unknown, max = 200): string {
  const text = typeof args === "string" ? args : JSON.stringify(redact(args)) ?? "";
  const flat = redactString(text).replace(/\s+/g, " ");
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
