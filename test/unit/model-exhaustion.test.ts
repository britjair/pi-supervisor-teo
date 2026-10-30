import { describe, expect, it } from "vitest";
import {
  isModelExhaustedError,
  ModelCooldownTracker,
  parseResetCooldownMs,
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
