// Zod-схема front matter sdlc/v1, 01-policy.md §2.
// Схема описывает «сырой» вид файла: поля этапа опциональны, а их согласованность
// (терминальный этап без агента и т.п.) проверяет graph-validator.ts кодами §3.1.
// Default-значения применяет normalize() после успешной графовой проверки.

import { z } from "zod";
import {
  AGENT_ID_RE,
  POLICY_SCHEMA_ID,
  RESERVED_AGENT_IDS,
  STAGE_ID_RE,
  THINKING_LEVELS,
  TITLE_MAX_LENGTH,
  parseModelRef,
} from "../domain/policy.js";
import { closestMatch } from "../util/strings.js";

type Segment = string | number;

const custom = (code: string, params: Record<string, unknown> = {}) => ({ params: { code, ...params } });

const textSchema = z.string().refine((s) => s.trim().length > 0, custom("EMPTY_STRING"));

const titleSchema = z
  .string()
  .refine((s) => s.trim().length > 0, custom("EMPTY_STRING"))
  .refine((s) => !/[\r\n]/.test(s.trim()), custom("TITLE_MULTILINE"))
  .refine((s) => s.trim().length <= TITLE_MAX_LENGTH, custom("TITLE_TOO_LONG", { max: TITLE_MAX_LENGTH }));

const refSchema = z.string().refine((s) => s.trim().length > 0, custom("EMPTY_STRING"));

const modelRefSchema = z.string().refine((s) => parseModelRef(s) !== null, custom("INVALID_MODEL_REF"));

const thinkingSchema = z.enum(THINKING_LEVELS);
const resourceModeSchema = z.enum(["inherit", "none"]);
const guardLevelSchema = z.enum(["required", "optional"]);

const minutesSchema = z.number().min(1).max(1440);

const piResourcesSchema = z.strictObject({
  contextFiles: resourceModeSchema.optional(),
  extensions: resourceModeSchema.optional(),
  skills: resourceModeSchema.optional(),
});

const guardsSchema = z.strictObject({
  evidence: guardLevelSchema.optional(),
  humanResponse: guardLevelSchema.optional(),
});

const transitionSchema = z.strictObject({
  to: refSchema,
  when: textSchema,
  guards: guardsSchema.optional(),
});

export const RECHECK_DEFAULTS = { minMinutes: 1, maxMinutes: 120, maxCount: 20 } as const;

const recheckSchema = z.strictObject({
  minMinutes: minutesSchema.optional(),
  maxMinutes: minutesSchema.optional(),
  maxCount: z.int().min(1).max(1000).optional(),
});

const stageSchema = z.strictObject({
  title: titleSchema,
  description: z.string().optional(),
  agent: refSchema.optional(),
  instructions: textSchema.optional(),
  session: z.enum(["fresh", "reuse"]).optional(),
  transitions: z.array(transitionSchema).optional(),
  recheck: recheckSchema.optional(),
  terminal: z.boolean().optional(),
});

const agentSchema = z.strictObject({
  title: titleSchema.optional(),
  model: modelRefSchema.optional(),
  thinking: thinkingSchema.optional(),
  instructions: textSchema,
  tools: z.array(refSchema).optional(),
  excludeTools: z.array(refSchema).optional(),
  askUser: z.boolean().optional(),
  piResources: piResourcesSchema.optional(),
  timeoutMinutes: minutesSchema.optional(),
});

const supervisorSchema = z.strictObject({
  model: modelRefSchema.optional(),
  thinking: thinkingSchema.optional(),
  instructions: textSchema,
  piResources: piResourcesSchema.optional(),
});

const runtimeSchema = z.strictObject({
  policyChangeMode: z.enum(["confirm", "latest", "pinned"]).optional(),
  maxConsecutiveRestarts: z.int().min(0).max(100).optional(),
  supervisorProtocolRetries: z.int().min(0).max(10).optional(),
  maxInvalidDecisionsPerCycle: z.int().min(1).max(20).optional(),
  maxCyclesPerStage: z.int().min(1).max(1000).nullable().optional(),
  supervisorTimeoutMinutes: minutesSchema.optional(),
  technicalRetries: z.int().min(0).max(10).optional(),
  technicalRetryDelaySeconds: z.int().min(1).max(600).optional(),
});

export const rawPolicySchema = z.strictObject({
  schema: z.literal(POLICY_SCHEMA_ID),
  workflow: z.strictObject({
    initialStage: refSchema,
    stages: z.record(z.string(), stageSchema),
  }),
  agents: z.record(z.string(), agentSchema),
  supervisor: supervisorSchema,
  runtime: runtimeSchema.optional(),
});

export type RawPolicy = z.infer<typeof rawPolicySchema>;
export type RawStage = z.infer<typeof stageSchema>;
export type RawAgent = z.infer<typeof agentSchema>;

/** Ключи, допустимые на уровне `path`, — для подсказки при опечатке. */
export function knownKeysAt(path: readonly Segment[]): readonly string[] | null {
  const p = path.map((s) => (typeof s === "number" ? "#" : s));
  const at = (...pattern: string[]) =>
    p.length === pattern.length && pattern.every((x, i) => x === "*" || x === p[i]);

  if (at()) return Object.keys(rawPolicySchema.shape);
  if (at("workflow")) return ["initialStage", "stages"];
  if (at("workflow", "stages", "*")) return Object.keys(stageSchema.shape);
  if (at("workflow", "stages", "*", "transitions", "#")) return Object.keys(transitionSchema.shape);
  if (at("workflow", "stages", "*", "transitions", "#", "guards")) return Object.keys(guardsSchema.shape);
  if (at("workflow", "stages", "*", "recheck")) return Object.keys(RECHECK_DEFAULTS);
  if (at("agents", "*")) return Object.keys(agentSchema.shape);
  if (at("agents", "*", "piResources") || at("supervisor", "piResources")) return Object.keys(piResourcesSchema.shape);
  if (at("supervisor")) return Object.keys(supervisorSchema.shape);
  if (at("runtime")) return Object.keys(runtimeSchema.shape);
  return null;
}

/** Ключи `x-*` разрешены на любом уровне и игнорируются (01-policy.md §2.1). */
export function stripExtensionKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripExtensionKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!k.startsWith("x-")) out[k] = stripExtensionKeys(v);
    }
    return out;
  }
  return value;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Проверки, которым нужны соседние поля или ключи словарей. Они выполняются отдельно от Zod:
 * его refinements не запускаются, пока внутри объекта есть другие ошибки,
 * а автор Policy должен увидеть все проблемы за один проход (01-policy.md §1.2).
 * Работает с непроверенными данными, поэтому каждое поле проверяется на тип.
 */
export function structuralChecks(data: unknown): SchemaProblem[] {
  const out: SchemaProblem[] = [];
  if (!isObject(data)) return out;

  const checkIds = (map: unknown, path: Segment[], kind: "stage" | "agent") => {
    if (!isObject(map)) return;
    const ids = Object.keys(map);
    if (ids.length === 0) out.push({ code: "EMPTY_MAP", path, params: { kind } });
    const re = kind === "stage" ? STAGE_ID_RE : AGENT_ID_RE;
    for (const id of ids) {
      if (!re.test(id)) out.push({ code: "INVALID_ID", path: [...path, id], params: { kind, id } });
      else if (kind === "agent" && RESERVED_AGENT_IDS.includes(id)) {
        out.push({ code: "RESERVED_AGENT_ID", path: [...path, id], params: { id } });
      }
    }
  };

  // Модель с суффиксом :thinking и поле thinking одновременно (01-policy.md §2.3)
  const checkModelThinking = (def: unknown, path: Segment[]) => {
    if (!isObject(def) || typeof def["model"] !== "string" || def["thinking"] === undefined) return;
    if (parseModelRef(def["model"])?.thinking) {
      out.push({
        code: "MODEL_THINKING_CONFLICT",
        path: [...path, "thinking"],
        params: { model: def["model"], thinking: String(def["thinking"]) },
      });
    }
  };

  const workflow = data["workflow"];
  const stages = isObject(workflow) ? workflow["stages"] : undefined;
  checkIds(stages, ["workflow", "stages"], "stage");
  if (isObject(stages)) {
    for (const [id, stage] of Object.entries(stages)) {
      const recheck = isObject(stage) ? stage["recheck"] : undefined;
      if (!isObject(recheck)) continue;
      const min = typeof recheck["minMinutes"] === "number" ? recheck["minMinutes"] : RECHECK_DEFAULTS.minMinutes;
      const max = typeof recheck["maxMinutes"] === "number" ? recheck["maxMinutes"] : RECHECK_DEFAULTS.maxMinutes;
      if (min > max) {
        const field = recheck["maxMinutes"] === undefined ? "minMinutes" : "maxMinutes";
        out.push({
          code: "RECHECK_RANGE",
          path: ["workflow", "stages", id, "recheck", field],
          params: { minMinutes: min, maxMinutes: max },
        });
      }
    }
  }

  checkIds(data["agents"], ["agents"], "agent");
  if (isObject(data["agents"])) {
    for (const [id, agent] of Object.entries(data["agents"])) checkModelThinking(agent, ["agents", id]);
  }
  checkModelThinking(data["supervisor"], ["supervisor"]);
  return out;
}

/** Проблема схемы в независимом от Zod виде; текст строит ui/messages.ts. */
export type SchemaProblem = {
  code: string;
  path: Segment[];
  params: Record<string, string | number | boolean | null | readonly string[]>;
};

export function describeValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function valueAt(root: unknown, path: readonly Segment[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

const primitive = (v: unknown): string | number | boolean | null =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : v === null ? null : String(v);

/** Перевод issues Zod в SchemaProblem. `input` — данные, переданные в схему (для типа полученного значения). */
export function toSchemaProblems(issues: readonly z.core.$ZodIssue[], input: unknown): SchemaProblem[] {
  const out: SchemaProblem[] = [];
  for (const issue of issues) {
    const path = issue.path.filter((s): s is Segment => typeof s !== "symbol");
    switch (issue.code) {
      case "unrecognized_keys":
        for (const key of issue.keys) {
          const known = knownKeysAt(path) ?? [];
          out.push({
            code: "UNKNOWN_KEY",
            path: [...path, key],
            params: { key, known, suggestion: closestMatch(key, known) },
          });
        }
        break;
      case "invalid_type": {
        const received = valueAt(input, path);
        if (received === undefined) {
          out.push({ code: "REQUIRED", path, params: {} });
        } else if (issue.expected === "int" && typeof received === "number") {
          out.push({ code: "NOT_INTEGER", path, params: { value: received } });
        } else {
          out.push({
            code: "INVALID_TYPE",
            path,
            params: { expected: String(issue.expected), received: describeValueType(received) },
          });
        }
        break;
      }
      case "too_small":
      case "too_big": {
        const value = valueAt(input, path);
        const bound = issue.code === "too_small" ? { min: Number(issue.minimum) } : { max: Number(issue.maximum) };
        out.push({ code: "OUT_OF_RANGE", path, params: { ...bound, value: primitive(value) } });
        break;
      }
      case "invalid_value":
        out.push({
          code: "INVALID_ENUM",
          path,
          params: { allowed: issue.values.map(String), value: primitive(valueAt(input, path)) },
        });
        break;
      case "custom": {
        const { code, ...params } = (issue.params ?? {}) as Record<string, unknown>;
        const clean: SchemaProblem["params"] = {};
        for (const [k, v] of Object.entries(params)) {
          clean[k] = Array.isArray(v) ? v.map(String) : primitive(v);
        }
        out.push({ code: typeof code === "string" ? code : "INVALID_VALUE", path, params: clean });
        break;
      }
      default:
        out.push({ code: "INVALID_VALUE", path, params: { detail: issue.message } });
    }
  }
  return out;
}
