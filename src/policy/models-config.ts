// Конфигурация моделей и цепочек fallback ~/.pi/teo/models.md (docs/08-model-profiles.md §3).
// Позволяет задавать модели так, как они представлены в Pi (display name, id, provider/id).

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";
import { splitFrontMatter } from "./front-matter.js";
import { POLICY_SCHEMA_ID, THINKING_LEVELS, type ThinkingLevel } from "../domain/policy.js";

const THINKING_SUFFIX_RE = new RegExp(`:(${THINKING_LEVELS.join("|")})$`, "i");

export const rawModelsConfigSchema = z.strictObject({
  schema: z.literal(POLICY_SCHEMA_ID),
  roles: z.record(z.string(), z.array(z.string())).optional(),
  profiles: z.record(z.string(), z.array(z.string())).optional(),
});

export type ModelsConfig = {
  schema: typeof POLICY_SCHEMA_ID;
  roles: Record<string, string[]>;
  profiles: Record<string, string[]>;
};

export const EMPTY_MODELS_CONFIG: ModelsConfig = Object.freeze({
  schema: POLICY_SCHEMA_ID,
  roles: Object.freeze({}),
  profiles: Object.freeze({}),
});

/** Разобрать имя модели из списка: извлекает суффикс мышления (:high, :low и т. д.). */
export function parseModelEntry(entry: string): { modelName: string; thinking: ThinkingLevel | null } {
  const trimmed = entry.trim();
  const match = THINKING_SUFFIX_RE.exec(trimmed);
  if (!match) return { modelName: trimmed, thinking: null };
  const thinking = match[1]?.toLowerCase() as ThinkingLevel;
  const modelName = trimmed.slice(0, match.index).trim();
  return { modelName, thinking };
}

/** Загрузить ~/.pi/teo/models.md. Если файла нет, возвращается пустая конфигурация. */
export async function loadModelsConfigFile(filePath: string): Promise<ModelsConfig> {
  if (!existsSync(filePath)) return EMPTY_MODELS_CONFIG;
  try {
    const content = await readFile(filePath, "utf8");
    return parseModelsConfigText(content, filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_MODELS_CONFIG;
    throw err;
  }
}

/** Разобрать текст models.md с front matter. */
export function parseModelsConfigText(content: string, _filePath = "models.md"): ModelsConfig {
  const split = splitFrontMatter(content);
  if (!("yaml" in split)) return EMPTY_MODELS_CONFIG;
  const data = YAML.parse(split.yaml);
  const raw = rawModelsConfigSchema.parse(data);
  return {
    schema: raw.schema,
    roles: raw.roles ?? {},
    profiles: raw.profiles ?? {},
  };
}

/**
 * Получить цепочку моделей для роли с учётом конфигурации.
 * Приоритет:
 * 1. Если роль задаёт явный профиль (например "strong") и он есть в profiles -> модели профиля.
 * 2. Если роль задаёт явный список -> этот список.
 * 3. Если модель "default" (или не задана), но в models.md есть role.<role> -> модели этой роли.
 * 4. Иначе -> [configuredModel] (или ["default"]).
 */
export function resolveModelChain(options: {
  role: string;
  configuredModel?: string | string[];
  modelsConfig?: ModelsConfig;
}): string[] {
  const config = options.modelsConfig ?? EMPTY_MODELS_CONFIG;
  const configured = options.configuredModel ?? "default";

  if (Array.isArray(configured)) {
    const expanded: string[] = [];
    for (const item of configured) {
      const profile = config.profiles[item];
      if (profile && profile.length > 0) expanded.push(...profile);
      else expanded.push(item);
    }
    return expanded.length > 0 ? expanded : ["default"];
  }

  // Одиночная строка
  const profile = config.profiles[configured];
  if (profile && profile.length > 0) return [...profile];

  if (configured === "default") {
    const roleChain = config.roles[options.role];
    if (roleChain && roleChain.length > 0) return [...roleChain];
  }

  return [configured];
}

export type MinimalModel = {
  provider: string;
  id: string;
  name: string;
};

/**
 * Сопоставить имя модели из конфига с моделью из каталога Pi:
 * 1. Точное provider/id
 * 2. Точное id (без учёта регистра)
 * 3. Точное name (без учёта регистра)
 * 4. Нормализованное токен-сопоставление (учитывает порядок слов вроде "Gemini Pro 3.1" vs "Gemini 3.1 Pro" и опечатки вроде GTP/GPT)
 */
export function matchPiModel<T extends MinimalModel>(
  entry: string,
  availableModels: readonly T[],
  isAuthorized?: (provider: string) => boolean,
): { model: T; thinking: ThinkingLevel | null } | null {
  const { modelName, thinking } = parseModelEntry(entry);
  if (modelName.toLowerCase() === "default") return null;

  const qLower = modelName.toLowerCase();
  const qFixed = qLower.replace(/\bgfp\b|\bgtp\b/g, "gpt");

  const filterMatches = (candidates: T[]): T | undefined => {
    if (candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];
    if (isAuthorized) {
      const authorized = candidates.filter((m) => isAuthorized(m.provider));
      if (authorized.length > 0) return authorized[0];
    }
    return candidates[0];
  };

  // 1. exact provider/id
  const exactFull = availableModels.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === qFixed);
  const bestFull = filterMatches(exactFull);
  if (bestFull) return { model: bestFull, thinking };

  // 2. exact id
  const exactId = availableModels.filter((m) => m.id.toLowerCase() === qFixed);
  const bestId = filterMatches(exactId);
  if (bestId) return { model: bestId, thinking };

  // 3. exact name
  const exactName = availableModels.filter((m) => m.name.toLowerCase() === qFixed);
  const bestName = filterMatches(exactName);
  if (bestName) return { model: bestName, thinking };

  // 4. token-based match
  const tokens = qFixed.split(/[\s/._:-]+/).filter(Boolean);
  if (tokens.length > 0) {
    const matched = availableModels.filter((m) => {
      const target = `${m.provider} ${m.id} ${m.name}`.toLowerCase();
      return tokens.every((t) => target.includes(t));
    });
    const bestToken = filterMatches(matched);
    if (bestToken) return { model: bestToken, thinking };
  }

  return null;
}
