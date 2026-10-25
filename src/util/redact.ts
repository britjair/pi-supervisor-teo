// Редактирование секретов, 04-agents.md §8. Ответы человека не редактируются (02-storage.md §6.3).

const SECRET_KEY_RE = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|private[_-]?key)/i;

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];
const URL_CREDENTIALS_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;

export const REDACTED = "[REDACTED]";
export const MAX_EVENT_STRING = 16 * 1024;

export function redactString(s: string): string {
  let out = s;
  for (const re of PATTERNS) out = out.replace(re, REDACTED);
  return out.replace(URL_CREDENTIALS_RE, (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`);
}

/** Глубокая копия со скрытыми секретами: по имени ключа и по формату строки. */
export function redact<T>(value: T, opts: { maxString?: number } = {}): T {
  const max = opts.maxString ?? Infinity;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return truncate(redactString(v), max);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = SECRET_KEY_RE.test(k) && (typeof val === "string" || typeof val === "number") ? REDACTED : walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
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
