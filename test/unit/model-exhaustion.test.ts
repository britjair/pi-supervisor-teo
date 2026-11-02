import { describe, expect, it } from "vitest";
import {
  exhaustionScope,
  isModelExhaustedError,
  ModelCooldownTracker,
  parseResetCooldownMs,
  PROBE_SCHEDULE_MS,
  type CooldownPersistence,
  type CooldownRecord,
} from "../../src/util/model-exhaustion.js";

describe("model-exhaustion: детектор и трекер cooldown", () => {
  it("распознает различные ошибки исчерпания лимитов и квот", () => {
    expect(isModelExhaustedError(new Error("Codex error: The usage limit has been reached"))).toBe(true);
    expect(isModelExhaustedError("Rate limit reached for model gpt-4")).toBe(true);
    expect(isModelExhaustedError("insufficient_quota: You exceeded your current quota")).toBe(true);
    expect(isModelExhaustedError("Google error: RESOURCE_EXHAUSTED")).toBe(true);
    expect(isModelExhaustedError("Bedrock: ThrottlingException")).toBe(true);
    expect(isModelExhaustedError("Anthropic: overloaded_error")).toBe(true);
    expect(isModelExhaustedError("HTTP 429 Too Many Requests")).toBe(true);

    expect(isModelExhaustedError(new Error("File not found"))).toBe(false);
    expect(isModelExhaustedError("SyntaxError: Unexpected token")).toBe(false);
    expect(isModelExhaustedError(null)).toBe(false);
  });

  it("парсит время сброса/ожидания из текста ошибки", () => {
    expect(parseResetCooldownMs("Please try again in 14m30s.")).toBe((14 * 60 + 30) * 1000);
    expect(parseResetCooldownMs("rate limit exceeded, retry-after: 120")).toBe(120 * 1000);
    expect(parseResetCooldownMs("Quota resets in 5 minutes")).toBe(5 * 60 * 1000);
    expect(parseResetCooldownMs("Quota resets in 45 seconds")).toBe(45 * 1000);
    expect(parseResetCooldownMs("The usage limit has been reached")).toBeNull();
  });

  it("парсит часы, сутки, тильду и русские формы", () => {
    expect(parseResetCooldownMs("You have hit your ChatGPT usage limit. Try again in ~45 min.")).toBe(45 * 60 * 1000);
    expect(parseResetCooldownMs("Limit reached, try again in 5 hours")).toBe(5 * 60 * 60 * 1000);
    expect(parseResetCooldownMs("Weekly limit reached, try again in 2 days")).toBe(2 * 24 * 60 * 60 * 1000);
    expect(parseResetCooldownMs("Лимит исчерпан, повторите через 30 минут")).toBe(30 * 60 * 1000);
    expect(parseResetCooldownMs("retry in 1h30m")).toBe(90 * 60 * 1000);
    expect(parseResetCooldownMs("retry-after-ms: 1500")).toBe(1500);
  });

  it("парсит абсолютное время сброса относительно now", () => {
    const now = Date.parse("2026-11-02T06:00:00.000Z");
    expect(parseResetCooldownMs("Your limit will reset at 2026-11-04T06:00:00Z", now)).toBe(2 * 24 * 60 * 60 * 1000);
    const resetAt = now + 3 * 60 * 60 * 1000;
    expect(parseResetCooldownMs(`{"resets_at": ${Math.floor(resetAt / 1000)}}`, now)).toBe(3 * 60 * 60 * 1000);
    // Уже прошедший срок не годится
    expect(parseResetCooldownMs("resets at 2026-11-01T06:00:00Z", now)).toBeNull();
    // Абсурдно далёкий срок отбрасывается
    expect(parseResetCooldownMs("resets at 2027-11-01T06:00:00Z", now)).toBeNull();
  });

  it("различает лимит аккаунта и rate limit модели", () => {
    expect(exhaustionScope("Codex error: The usage limit has been reached")).toBe("provider");
    expect(exhaustionScope("insufficient_quota")).toBe("provider");
    expect(exhaustionScope("HTTP 429 Too Many Requests")).toBe("model");
    expect(exhaustionScope("overloaded_error")).toBe("model");
  });

  it("лимит провайдера закрывает все его модели", () => {
    const tracker = new ModelCooldownTracker();
    const t0 = 1_000_000;
    tracker.recordExhausted("openai-codex", "gpt-5.6-sol", 60_000, "usage limit", t0, { scope: "provider" });

    expect(tracker.isExhausted("openai-codex", "gpt-5.6-sol", t0 + 1)).toBe(true);
    // Другая модель того же аккаунта тоже недоступна
    expect(tracker.isExhausted("openai-codex", "gpt-5.6-luna", t0 + 1)).toBe(true);
    // Чужой провайдер не затронут
    expect(tracker.isExhausted("claude-bridge", "claude-opus-5-5", t0 + 1)).toBe(false);
    expect(tracker.activeRecord("openai-codex", "gpt-5.6-luna", t0 + 1)?.modelId).toBeNull();
  });

  it("без срока от провайдера идёт по нарастающему графику проб", () => {
    const tracker = new ModelCooldownTracker();
    let t = 1_000_000;

    for (const [i, expected] of PROBE_SCHEDULE_MS.entries()) {
      const record = tracker.recordExhausted("openai-codex", "gpt-5.6-sol", null, "usage limit", t, { scope: "provider" });
      expect(record.attempt, `попытка ${i + 1}`).toBe(i + 1);
      expect(record.exhaustedUntil - t, `шаг ${i + 1}`).toBe(expected);
      t = record.exhaustedUntil + 1;
    }

    // График упирается в крышку, а не растёт бесконечно
    const capped = tracker.recordExhausted("openai-codex", "gpt-5.6-sol", null, "usage limit", t, { scope: "provider" });
    expect(capped.exhaustedUntil - t).toBe(PROBE_SCHEDULE_MS.at(-1));

    // Успешный вызов сбрасывает график на начало
    tracker.recordSuccess("openai-codex", "gpt-5.6-sol", t);
    const afterSuccess = tracker.recordExhausted("openai-codex", "gpt-5.6-sol", null, "usage limit", t, { scope: "provider" });
    expect(afterSuccess.attempt).toBe(1);
    expect(afterSuccess.exhaustedUntil - t).toBe(PROBE_SCHEDULE_MS[0]);
  });

  it("известный срок не эскалирует график", () => {
    const tracker = new ModelCooldownTracker();
    const t0 = 1_000_000;
    tracker.recordExhausted("openai-codex", "m", null, "usage limit", t0, { scope: "provider" });
    const known = tracker.recordExhausted("openai-codex", "m", 7_200_000, "usage limit", t0, { scope: "provider" });
    expect(known.attempt).toBe(1);
    expect(known.exhaustedUntil - t0).toBe(7_200_000);
  });

  it("list и reset управляют cooldown-ами вручную", () => {
    const tracker = new ModelCooldownTracker();
    const t0 = 1_000_000;
    tracker.recordExhausted("openai-codex", "gpt-5.6-sol", 600_000, "usage limit", t0, { scope: "provider" });
    tracker.recordExhausted("antigravity", "gemini-3.8-flash-high", 300_000, "429", t0);

    expect(tracker.list(t0).map((r) => r.provider)).toEqual(["antigravity", "openai-codex"]);

    expect(tracker.reset("antigravity", undefined, t0)).toBe(1);
    expect(tracker.list(t0).map((r) => r.provider)).toEqual(["openai-codex"]);

    expect(tracker.reset(undefined, undefined, t0)).toBe(1);
    expect(tracker.list(t0)).toEqual([]);
  });

  it("с дисковым хранилищем cooldown переживает перезапуск процесса", () => {
    let saved: CooldownRecord[] = [];
    const persistence: CooldownPersistence = {
      load: () => saved,
      save: (records) => void (saved = [...records]),
    };
    const t0 = 1_000_000;

    const first = new ModelCooldownTracker();
    first.bindPersistence(persistence);
    first.recordExhausted("openai-codex", "gpt-5.6-sol", 600_000, "usage limit", t0, { scope: "provider" });
    expect(saved).toHaveLength(1);

    // Новый процесс видит тот же cooldown и продолжает график, а не начинает заново
    const second = new ModelCooldownTracker();
    second.bindPersistence(persistence);
    expect(second.isExhausted("openai-codex", "gpt-5.6-luna", t0 + 1)).toBe(true);
    const next = second.recordExhausted("openai-codex", "x", null, "usage limit", t0 + 600_001, { scope: "provider" });
    expect(next.attempt).toBe(2);
  });

  it("ModelCooldownTracker отслеживает недоступность модели", () => {
    const tracker = new ModelCooldownTracker();
    const t0 = 1_000_000;

    tracker.recordExhausted("openai-codex", "gpt-5.5", 60_000, "лимит", t0);
    expect(tracker.isExhausted("openai-codex", "gpt-5.5", t0 + 10_000)).toBe(true);
    expect(tracker.getCooldownRemainingMs("openai-codex", "gpt-5.5", t0 + 10_000)).toBe(50_000);

    // По истечении времени модель снова доступна
    expect(tracker.isExhausted("openai-codex", "gpt-5.5", t0 + 60_000)).toBe(false);
    expect(tracker.isExhausted("openai-codex", "gpt-5.5", t0 + 60_001)).toBe(false);

    // Другая модель свободна
    expect(tracker.isExhausted("anthropic", "claude-opus-5-5", t0 + 10_000)).toBe(false);
  });

  it("getEarliestResetMs возвращает минимальное оставшееся время", () => {
    const tracker = new ModelCooldownTracker();
    const t0 = 1_000_000;
    tracker.recordExhausted("provider-a", "m1", 100_000, "лимит 1", t0);
    tracker.recordExhausted("provider-b", "m2", 50_000, "лимит 2", t0);

    const earliest = tracker.getEarliestResetMs([
      { provider: "provider-a", modelId: "m1" },
      { provider: "provider-b", modelId: "m2" },
    ], t0);

    expect(earliest).toBe(50_000);
  });
});
