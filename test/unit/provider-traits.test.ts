import { describe, expect, it } from "vitest";
import {
  PROVIDERS_NEEDING_SESSION_EXTENSION,
  providerOf,
  servesExtensionlessSession,
} from "../../src/agents/pi/provider-traits.js";

describe("provider-traits", () => {
  it("провайдер-мост не обслуживает сессию без расширений", () => {
    // claude-bridge проецирует промпт из капчи своего хука before_agent_start,
    // а сессия supervisor-а создаётся без расширений Pi — капчи не будет никогда.
    expect(servesExtensionlessSession("claude-bridge")).toBe(false);
    expect(servesExtensionlessSession("Claude-Bridge")).toBe(false);
  });

  it("обычные провайдеры берут промпт из контекста запроса и ограничений не имеют", () => {
    for (const provider of ["openai-codex", "anthropic", "antigravity", "google", "amazon-bedrock"]) {
      expect(servesExtensionlessSession(provider), provider).toBe(true);
    }
  });

  it("providerOf выделяет провайдера из provider/model", () => {
    expect(providerOf("claude-bridge/claude-opus-5-5")).toBe("claude-bridge");
    expect(providerOf("antigravity/gemini-3.8-flash-high")).toBe("antigravity");
    expect(providerOf("")).toBe("");
  });

  it("список ограничений узкий и осознанный", () => {
    expect(PROVIDERS_NEEDING_SESSION_EXTENSION).toEqual(["claude-bridge"]);
  });
});
