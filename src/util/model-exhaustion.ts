// Детектор исчерпания лимитов/квот моделей и трекер cooldown (docs/08-model-profiles.md §5, D44, D47).

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

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000; // 30 минут по умолчанию (D47)

/** Проверить, является ли ошибка провайдера ошибкой лимита/квоты/rate limit. */
export function isModelExhaustedError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return EXHAUSTION_PATTERNS.some((pattern) => pattern.test(msg));
}

/**
 * Попытаться извлечь время сброса/ожидания из текста ошибки.
 * Поддерживает:
 * - "try again in 14m30s"
 * - "try again in 45s"
 * - "resets in 12 minutes"
 * - "retry-after: 120"
 * Возвращает миллисекунды ожидания или null.
 */
export function parseResetCooldownMs(err: unknown): number | null {
  if (!err) return null;
  const msg = err instanceof Error ? err.message : String(err);

  // retry-after: 120 (секунды)
  const retryAfter = /retry-after:\s*(\d+)/i.exec(msg);
  if (retryAfter && retryAfter[1]) return parseInt(retryAfter[1], 10) * 1000;

  // in XmYs / in Xm
  const minSec = /(?:in|after)\s+(\d+)\s*m(?:in(?:ute)?s?)?(?:\s*(\d+)\s*s(?:ec(?:ond)?s?)?)?/i.exec(msg);
  if (minSec && minSec[1]) {
    const mins = parseInt(minSec[1], 10);
    const secs = minSec[2] ? parseInt(minSec[2], 10) : 0;
    return (mins * 60 + secs) * 1000;
  }

  // in Xs
  const justSec = /(?:in|after)\s+(\d+)\s*s(?:ec(?:ond)?s?)?/i.exec(msg);
  if (justSec && justSec[1]) return parseInt(justSec[1], 10) * 1000;

  return null;
}

export type CooldownRecord = {
  provider: string;
  modelId: string;
  exhaustedUntil: number; // timestamp ms
  reason: string;
};

/** In-memory трекер временной недоступности моделей из-за лимитов. */
export class ModelCooldownTracker {
  private readonly records = new Map<string, CooldownRecord>();

  private key(provider: string, modelId: string): string {
    return `${provider.toLowerCase()}/${modelId.toLowerCase()}`;
  }

  recordExhausted(provider: string, modelId: string, durationMs?: number, reason = "лимит исчерпан", now = systemClock.now().getTime()): CooldownRecord {
    const cooldown = durationMs && durationMs > 0 ? durationMs : DEFAULT_COOLDOWN_MS;
    const exhaustedUntil = now + cooldown;
    const record: CooldownRecord = { provider, modelId, exhaustedUntil, reason };
    this.records.set(this.key(provider, modelId), record);
    return record;
  }

  isExhausted(provider: string, modelId: string, now = systemClock.now().getTime()): boolean {
    const record = this.records.get(this.key(provider, modelId));
    if (!record) return false;
    if (now >= record.exhaustedUntil) {
      this.records.delete(this.key(provider, modelId));
      return false;
    }
    return true;
  }

  getCooldownRemainingMs(provider: string, modelId: string, now = systemClock.now().getTime()): number {
    const record = this.records.get(this.key(provider, modelId));
    if (!record) return 0;
    return Math.max(0, record.exhaustedUntil - now);
  }

  getEarliestResetMs(models: Array<{ provider: string; modelId: string }>, now = systemClock.now().getTime()): number | null {
    let earliest: number | null = null;
    for (const m of models) {
      const remaining = this.getCooldownRemainingMs(m.provider, m.modelId, now);
      if (remaining > 0) {
        if (earliest === null || remaining < earliest) earliest = remaining;
      }
    }
    return earliest;
  }

  clear(): void {
    this.records.clear();
  }
}

/** Глобальный синглтон трекера cooldown в рамках процесса. */
export const defaultCooldownTracker = new ModelCooldownTracker();
