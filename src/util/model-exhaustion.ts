// Детектор исчерпания лимитов/квот моделей и трекер cooldown (docs/08-model-profiles.md §5, D44, D47).
//
// Провайдеры почти никогда не сообщают срок сброса в тексте ошибки: Codex, например, отдаёт
// "The usage limit has been reached" без времени. Поэтому срок берётся так:
//  1. из текста ошибки, если он там есть (parseResetCooldownMs);
//  2. иначе по нарастающему графику проб (PROBE_SCHEDULE_MS): следующая попытка supervisor-а и
//     есть проба. Пока лимит держится, запрос отвергается провайдером до генерации, поэтому
//     проба дешёвая; график не даёт долбиться в исчерпанную модель каждые 30 минут.
//
// Лимит вида "usage limit"/"quota" у Codex и подобных — на аккаунт, а не на модель, поэтому
// такие ошибки кладут на cooldown всего провайдера (scope "provider").

import { systemClock } from "./clock.js";

const EXHAUSTION_PATTERNS = [
  /usage\s*limit/i,
  /rate\s*limit/i,
  /insufficient_quota/i,
  /quota\s*exceeded/i,
  /resource_exhausted/i,
  /too\s*many\s*requests/i,
  /throttlingexception/i,
  /toomanyrequestsexception/i,
  /overloaded/i,
  /\b429\b/,
];

/** Лимит на аккаунт/подписку: бессмысленно пробовать другие модели того же провайдера. */
const ACCOUNT_LEVEL_PATTERNS = [
  /usage\s*limit/i,
  /insufficient_quota/i,
  /quota\s*exceeded/i,
  /out\s*of\s*budget/i,
  /available\s*balance/i,
  /billing/i,
  /plan\s*limit/i,
  /subscription/i,
];

/** График проб, когда провайдер не сообщил срок сброса. */
export const PROBE_SCHEDULE_MS: readonly number[] = [
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
  2 * 60 * 60 * 1000,
  4 * 60 * 60 * 1000,
  8 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];

/** Записи старше этого срока не нужны: держим только чтобы помнить номер попытки. */
const RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Абсурдные сроки из текста ошибки отбрасываем: скорее всего распознали не то. */
const MAX_PARSED_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

/** Проверить, является ли ошибка провайдера ошибкой лимита/квоты/rate limit. */
export function isModelExhaustedError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return EXHAUSTION_PATTERNS.some((pattern) => pattern.test(msg));
}

export type CooldownScope = "provider" | "model";

/**
 * На что распространяется лимит: на весь аккаунт провайдера или только на модель.
 * Короткие rate limit-ы бывают per-model, лимиты подписки — всегда на аккаунт.
 */
export function exhaustionScope(err: unknown): CooldownScope {
  if (!err) return "model";
  const msg = err instanceof Error ? err.message : String(err);
  return ACCOUNT_LEVEL_PATTERNS.some((pattern) => pattern.test(msg)) ? "provider" : "model";
}

const UNIT_MS: Array<readonly [RegExp, number]> = [
  [/^(?:d|days?|сут(?:ки|ок)?|дн(?:я|ей|ь)?)$/i, 24 * 60 * 60 * 1000],
  [/^(?:h|hrs?|hours?|ч(?:ас(?:а|ов)?)?)$/i, 60 * 60 * 1000],
  [/^(?:m|mins?|minutes?|мин(?:ут(?:а|ы|у)?)?)$/i, 60 * 1000],
  [/^(?:s|secs?|seconds?|сек(?:унд(?:а|ы|у)?)?)$/i, 1000],
];

function unitMs(unit: string): number | null {
  for (const [pattern, ms] of UNIT_MS) if (pattern.test(unit)) return ms;
  return null;
}

/** "in 14m30s", "try again in ~45 min", "через 2 дня" → сумма всех пар «число единица». */
function parseRelative(msg: string): number | null {
  const anchor = /(?:try\s+again\s+in|retry\s+in|resets?\s+in|available\s+in|in|after|через)\s*~?\s*(?=\d)/i.exec(msg);
  if (!anchor) return null;
  let rest = msg.slice(anchor.index + anchor[0].length);
  let total = 0;
  for (;;) {
    const pair = /^\s*(\d+)\s*([a-zа-яё]+)/i.exec(rest);
    if (!pair?.[1] || !pair[2]) break;
    const ms = unitMs(pair[2]);
    if (ms === null) break;
    total += parseInt(pair[1], 10) * ms;
    rest = rest.slice(pair[0].length);
  }
  return total > 0 ? total : null;
}

/** "resets at 2026-11-04T10:00:00Z", "resets_at: 1762250400" → дельта от now. */
function parseAbsolute(msg: string, now: number): number | null {
  const unix = /resets?_at["'\s:=]+(\d{10,13})\b/i.exec(msg);
  if (unix?.[1]) {
    const raw = parseInt(unix[1], 10);
    const at = raw > 1e11 ? raw : raw * 1000;
    const delta = at - now;
    if (delta > 0) return delta;
  }
  const iso = /(?:resets?|will\s+reset|reset)\s*(?:at|on|:)?\s*(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(msg);
  if (iso?.[1]) {
    const at = Date.parse(iso[1]);
    if (Number.isFinite(at)) {
      const delta = at - now;
      if (delta > 0) return delta;
    }
  }
  return null;
}

/**
 * Попытаться извлечь время сброса/ожидания из текста ошибки.
 * Поддерживает `retry-after` (секунды и HTTP-date), относительные интервалы
 * ("in 14m30s", "try again in ~45 min", "in 2 days", "через 5 часов") и абсолютное время
 * сброса ("resets at <ISO>", "resets_at: <unix>"). Возвращает миллисекунды или null.
 */
export function parseResetCooldownMs(err: unknown, now = systemClock.now().getTime()): number | null {
  if (!err) return null;
  const msg = err instanceof Error ? err.message : String(err);

  const candidates: Array<number | null> = [];

  // retry-after: 120 (секунды) и retry-after-ms: 1500
  const retryAfterMs = /retry-after-ms["'\s:=]+(\d+)/i.exec(msg);
  if (retryAfterMs?.[1]) candidates.push(parseInt(retryAfterMs[1], 10));
  const retryAfter = /retry-after["'\s:=]+(\d+)\b/i.exec(msg);
  if (retryAfter?.[1]) candidates.push(parseInt(retryAfter[1], 10) * 1000);

  // retry-after: Wed, 04 Nov 2026 10:00:00 GMT
  const retryAfterDate = /retry-after["'\s:=]+([A-Z][a-z]{2},\s*\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}[^,\n]*)/i.exec(msg);
  if (retryAfterDate?.[1]) {
    const at = Date.parse(retryAfterDate[1]);
    if (Number.isFinite(at) && at - now > 0) candidates.push(at - now);
  }

  candidates.push(parseAbsolute(msg, now));
  candidates.push(parseRelative(msg));

  for (const value of candidates) {
    if (value === null || value === undefined) continue;
    if (value > 0 && value <= MAX_PARSED_COOLDOWN_MS) return value;
  }
  return null;
}

export type CooldownRecord = {
  provider: string;
  /** null — лимит на весь провайдер */
  modelId: string | null;
  exhaustedUntil: number;
  /** Номер попытки для нарастающего графика проб */
  attempt: number;
  reason: string;
  recordedAt: number;
};

/** Хранилище cooldown-ов между запусками процесса. */
export interface CooldownPersistence {
  load(): CooldownRecord[];
  save(records: readonly CooldownRecord[]): void;
}

const providerKey = (provider: string) => `${provider.toLowerCase()}/*`;
const modelKey = (provider: string, modelId: string) => `${provider.toLowerCase()}/${modelId.toLowerCase()}`;
const recordKey = (r: CooldownRecord) => (r.modelId === null ? providerKey(r.provider) : modelKey(r.provider, r.modelId));

/** Трекер временной недоступности моделей из-за лимитов; при bindPersistence переживает перезапуск. */
export class ModelCooldownTracker {
  private readonly records = new Map<string, CooldownRecord>();
  private persistence: CooldownPersistence | null = null;
  private loaded = true;

  /** Подключить дисковое хранилище. Записи подхватываются при первом обращении. */
  bindPersistence(persistence: CooldownPersistence | null): void {
    this.persistence = persistence;
    this.loaded = persistence === null;
    if (persistence === null) return;
    this.records.clear();
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const stored = this.persistence?.load() ?? [];
    for (const r of stored) this.records.set(recordKey(r), r);
  }

  private flush(now: number): void {
    if (!this.persistence) return;
    for (const [key, r] of [...this.records]) {
      if (now - r.recordedAt > RECORD_TTL_MS) this.records.delete(key);
    }
    this.persistence.save([...this.records.values()]);
  }

  /**
   * Запомнить исчерпание. `durationMs` — срок от провайдера; если его нет, берётся следующий
   * шаг графика проб для этого ключа.
   */
  recordExhausted(
    provider: string,
    modelId: string,
    durationMs?: number | null,
    reason = "лимит исчерпан",
    now = systemClock.now().getTime(),
    opts: { scope?: CooldownScope } = {},
  ): CooldownRecord {
    this.ensureLoaded();
    const scope = opts.scope ?? "model";
    const key = scope === "provider" ? providerKey(provider) : modelKey(provider, modelId);
    const previous = this.records.get(key);
    const known = durationMs !== undefined && durationMs !== null && durationMs > 0;
    const attempt = known ? 1 : Math.min((previous?.attempt ?? 0) + 1, PROBE_SCHEDULE_MS.length);
    const step = PROBE_SCHEDULE_MS[Math.min(attempt, PROBE_SCHEDULE_MS.length) - 1] ?? PROBE_SCHEDULE_MS[0] ?? 0;
    const cooldown = known ? (durationMs as number) : step;
    const record: CooldownRecord = {
      provider,
      modelId: scope === "provider" ? null : modelId,
      exhaustedUntil: now + cooldown,
      attempt,
      reason,
      recordedAt: now,
    };
    this.records.set(key, record);
    this.flush(now);
    return record;
  }

  /** Успешный вызов: снять cooldown и сбросить график проб. */
  recordSuccess(provider: string, modelId: string, now = systemClock.now().getTime()): void {
    this.ensureLoaded();
    const removed = this.records.delete(modelKey(provider, modelId)) || this.records.delete(providerKey(provider));
    if (removed) this.flush(now);
  }

  isExhausted(provider: string, modelId: string, now = systemClock.now().getTime()): boolean {
    return this.remaining(provider, modelId, now) > 0;
  }

  getCooldownRemainingMs(provider: string, modelId: string, now = systemClock.now().getTime()): number {
    return this.remaining(provider, modelId, now);
  }

  /** Активная запись, из-за которой модель недоступна (провайдерская имеет приоритет). */
  activeRecord(provider: string, modelId: string, now = systemClock.now().getTime()): CooldownRecord | null {
    this.ensureLoaded();
    for (const key of [providerKey(provider), modelKey(provider, modelId)]) {
      const record = this.records.get(key);
      if (record && now < record.exhaustedUntil) return record;
    }
    return null;
  }

  private remaining(provider: string, modelId: string, now: number): number {
    const record = this.activeRecord(provider, modelId, now);
    return record ? Math.max(0, record.exhaustedUntil - now) : 0;
  }

  getEarliestResetMs(models: Array<{ provider: string; modelId: string }>, now = systemClock.now().getTime()): number | null {
    let earliest: number | null = null;
    for (const m of models) {
      const remaining = this.remaining(m.provider, m.modelId, now);
      if (remaining > 0 && (earliest === null || remaining < earliest)) earliest = remaining;
    }
    return earliest;
  }

  /** Активные cooldown-ы для `teo models cooldown`. */
  list(now = systemClock.now().getTime()): CooldownRecord[] {
    this.ensureLoaded();
    return [...this.records.values()]
      .filter((r) => now < r.exhaustedUntil)
      .sort((a, b) => a.exhaustedUntil - b.exhaustedUntil);
  }

  /**
   * Снять cooldown вручную. Без аргументов — всё; только провайдер — все его записи;
   * провайдер и модель — запись модели и запись провайдера.
   */
  reset(provider?: string, modelId?: string, now = systemClock.now().getTime()): number {
    this.ensureLoaded();
    let removed = 0;
    for (const [key, record] of [...this.records]) {
      if (provider && record.provider.toLowerCase() !== provider.toLowerCase()) continue;
      if (modelId && record.modelId !== null && record.modelId.toLowerCase() !== modelId.toLowerCase()) continue;
      this.records.delete(key);
      removed++;
    }
    if (removed > 0) this.flush(now);
    return removed;
  }

  clear(): void {
    this.records.clear();
    this.loaded = this.persistence === null;
  }
}

/** Глобальный синглтон трекера cooldown в рамках процесса. */
export const defaultCooldownTracker = new ModelCooldownTracker();
