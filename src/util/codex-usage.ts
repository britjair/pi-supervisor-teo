// Точный срок сброса лимитов openai-codex (docs/08-model-profiles.md §5).
//
// Текст ошибки Codex ("The usage limit has been reached") срока не содержит, а заголовки,
// различающие 5-часовое и недельное окно, pi-ai наружу не отдаёт. Единственный источник —
// backend-api: primary_window = 5 часов, secondary_window = неделя.
//
// Эндпоинт ненадёжен (отвечает 403 через Cloudflare), поэтому проба строго опортунистическая:
// любая ошибка means «срок неизвестен», и вызывающий код уходит на график проб.
// Токен читается из auth.json Pi и никуда не логируется.

import { readFileSync } from "node:fs";
import path from "node:path";

const USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const TIMEOUT_MS = 5_000;
/** Окно считаем исчерпанным почти при полном расходе: остаток в пределах погрешности. */
const USED_THRESHOLD = 99;

export type UsageWindow = { usedPercent: number; resetAt: number };
export type CodexUsage = { fiveHour: UsageWindow | null; weekly: UsageWindow | null };

function authPath(homeDir: string): string {
  return path.join(homeDir, ".pi", "agent", "auth.json");
}

function readCodexAuth(homeDir: string): { access: string; accountId: string } | null {
  try {
    const cred = JSON.parse(readFileSync(authPath(homeDir), "utf8"))["openai-codex"];
    if (typeof cred?.access === "string" && typeof cred?.accountId === "string") {
      return { access: cred.access, accountId: cred.accountId };
    }
  } catch {
    // Нет файла, нет прав, битый JSON — срок просто неизвестен.
  }
  return null;
}

function toWindow(raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const { used_percent: used, reset_at: reset } = raw as { used_percent?: unknown; reset_at?: unknown };
  if (typeof used !== "number" || typeof reset !== "number") return null;
  return { usedPercent: used, resetAt: reset * 1000 };
}

/** Окна лимитов аккаунта Codex или null, если узнать не удалось. */
export async function fetchCodexUsage(homeDir: string): Promise<CodexUsage | null> {
  const auth = readCodexAuth(homeDir);
  if (!auth) return null;
  try {
    const response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${auth.access}`,
        "chatgpt-account-id": auth.accountId,
        "User-Agent": "teo",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { rate_limit?: { primary_window?: unknown; secondary_window?: unknown } };
    const limit = body.rate_limit;
    if (!limit) return null;
    return { fiveHour: toWindow(limit.primary_window), weekly: toWindow(limit.secondary_window) };
  } catch {
    return null;
  }
}

export type ExhaustedWindow = { window: "5h" | "weekly"; resetAt: number };

/**
 * Какое окно исчерпано и когда сбросится. Если исчерпаны оба, берём более поздний срок:
 * работать можно только когда освободились оба.
 */
export function exhaustedWindow(usage: CodexUsage, now: number): ExhaustedWindow | null {
  const spent: ExhaustedWindow[] = [];
  if (usage.weekly && usage.weekly.usedPercent >= USED_THRESHOLD && usage.weekly.resetAt > now) {
    spent.push({ window: "weekly", resetAt: usage.weekly.resetAt });
  }
  if (usage.fiveHour && usage.fiveHour.usedPercent >= USED_THRESHOLD && usage.fiveHour.resetAt > now) {
    spent.push({ window: "5h", resetAt: usage.fiveHour.resetAt });
  }
  if (spent.length === 0) return null;
  return spent.reduce((latest, w) => (w.resetAt > latest.resetAt ? w : latest));
}

const WINDOW_LABEL: Record<"5h" | "weekly", string> = {
  "5h": "5-часовое окно",
  weekly: "недельное окно",
};

/**
 * Проба срока сброса для EngineCore. Умеет только openai-codex: у остальных провайдеров
 * срок приходит в тексте ошибки и разбирается parseResetCooldownMs.
 */
export function codexResetProbe(homeDir: string) {
  return async (provider: string, now: number): Promise<{ ms: number; detail: string } | null> => {
    if (provider.toLowerCase() !== "openai-codex") return null;
    const usage = await fetchCodexUsage(homeDir);
    if (!usage) return null;
    const spent = exhaustedWindow(usage, now);
    if (!spent) return null;
    return { ms: spent.resetAt - now, detail: WINDOW_LABEL[spent.window] };
  };
}
