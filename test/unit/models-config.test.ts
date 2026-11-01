import { describe, expect, it } from "vitest";
import {
  matchPiModel,
  parseModelEntry,
  parseModelsConfigText,
  resolveModelChain,
  type MinimalModel,
} from "../../src/policy/models-config.js";

const SAMPLE_MODELS: MinimalModel[] = [
  { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5" },
  { provider: "amazon-bedrock", id: "global.openai.gpt-5.6-luna", name: "GPT-5.6 Luna (Global)" },
  { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { provider: "google", id: "gemini-3.1-pro", name: "Gemini 3.1 Pro Preview" },
  { provider: "antigravity", id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High Thinking)" },
];

describe("models-config: парсинг и разрешение", () => {
  it("разбирает суффикс мышления", () => {
    expect(parseModelEntry("Opus-5.5:high")).toEqual({ modelName: "Opus-5.5", thinking: "high" });
    expect(parseModelEntry("Claude Opus 5.5")).toEqual({ modelName: "Claude Opus 5.5", thinking: null });
    expect(parseModelEntry("GPT-5.5:low")).toEqual({ modelName: "GPT-5.5", thinking: "low" });
  });

  it("парсит models.md c ролями и профилями", () => {
    const yaml = `---
schema: teo/v1
roles:
  supervisor:
    - GPT-5.5:high
    - Opus-5.5:high
    - default
  explorer:
    - Claude Sonnet 5.5
    - default
profiles:
  strong:
    - GPT-5.5:high
    - Opus-5.5:high
---
Описание моделей.`;

    const config = parseModelsConfigText(yaml);
    expect(config.schema).toBe("teo/v1");
    expect(config.roles.supervisor).toEqual(["GPT-5.5:high", "Opus-5.5:high", "default"]);
    expect(config.profiles.strong).toEqual(["GPT-5.5:high", "Opus-5.5:high"]);
  });

  it("resolveModelChain выбирает цепочку роли при model: default", () => {
    const config = parseModelsConfigText(`---
schema: teo/v1
roles:
  supervisor:
    - GPT-5.5:high
    - Opus-5.5:high
    - default
---`);

    const chain = resolveModelChain({ role: "supervisor", configuredModel: "default", modelsConfig: config });
    expect(chain).toEqual(["GPT-5.5:high", "Opus-5.5:high", "default"]);
  });

  it("resolveModelChain разворачивает профиль", () => {
    const config = parseModelsConfigText(`---
schema: teo/v1
profiles:
  fast:
    - Claude Sonnet 5.5
    - default
---`);

    const chain = resolveModelChain({ role: "worker", configuredModel: "fast", modelsConfig: config });
    expect(chain).toEqual(["Claude Sonnet 5.5", "default"]);
  });

  it("matchPiModel сопоставляет имена так, как они представлены в Pi", () => {
    expect(matchPiModel("Opus-5.5:high", SAMPLE_MODELS)).toMatchObject({
      model: { id: "claude-opus-5-5", provider: "anthropic" },
      thinking: "high",
    });

    expect(matchPiModel("GPT-5.5", SAMPLE_MODELS)).toMatchObject({
      model: { id: "gpt-5.5", provider: "openai-codex" },
      thinking: null,
    });

    // Опечатка GTP -> GPT
    expect(matchPiModel("GTP-5.6", SAMPLE_MODELS)).toMatchObject({
      model: { id: "global.openai.gpt-5.6-luna", provider: "amazon-bedrock" },
    });

    // Другой порядок слов в названии: Gemini Pro 3.1 -> Gemini 3.1 Pro Preview
    expect(matchPiModel("Gemini Pro 3.1", SAMPLE_MODELS)).toMatchObject({
      model: { id: "gemini-3.1-pro", provider: "google" },
    });

    // Полный provider/id
    expect(matchPiModel("anthropic/claude-sonnet-5-5:low", SAMPLE_MODELS)).toMatchObject({
      model: { id: "claude-sonnet-5-5", provider: "anthropic" },
      thinking: "low",
    });

    // Сопоставление с нормализацией суффиксов thinking (gemini-3.8-flash -> gemini-3.8-flash-high)
    expect(matchPiModel("antigravity/gemini-3.8-flash", SAMPLE_MODELS)).toMatchObject({
      model: { id: "gemini-3.8-flash-high", provider: "antigravity" },
    });
    expect(matchPiModel("gemini-3.8-flash", SAMPLE_MODELS)).toMatchObject({
      model: { id: "gemini-3.8-flash-high", provider: "antigravity" },
    });

    // default -> null
    expect(matchPiModel("default", SAMPLE_MODELS)).toBeNull();
  });
});
