// Нормализация проверенного front matter: default-значения из 01-policy.md §2.1.

import type {
  AgentDef,
  PiResources,
  PolicySpec,
  RuntimeSettings,
  Stage,
  SupervisorDef,
} from "../domain/policy.js";
import { POLICY_SCHEMA_ID } from "../domain/policy.js";
import { RECHECK_DEFAULTS, type RawAgent, type RawPolicy, type RawStage } from "./policy-schema.js";

export const RUNTIME_DEFAULTS: RuntimeSettings = {
  policyChangeMode: "confirm",
  maxConsecutiveRestarts: 3,
  supervisorProtocolRetries: 1,
  maxInvalidDecisionsPerCycle: 3,
  maxCyclesPerStage: null,
  supervisorTimeoutMinutes: 30,
  technicalRetries: 2,
  technicalRetryDelaySeconds: 15,
};

/** У дочерних агентов окружение Pi подгружается целиком (решение Q2). */
const AGENT_RESOURCES: PiResources = { contextFiles: "inherit", extensions: "inherit", skills: "inherit" };
/** Supervisor-у AGENTS.md и skills не нужны; расширения нужны как провайдеры моделей (01-policy.md §2.7). */
const SUPERVISOR_RESOURCES: PiResources = { contextFiles: "none", extensions: "inherit", skills: "none" };

function dict<T>(entries: Iterable<[string, T]>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const [k, v] of entries) out[k] = v;
  return out;
}

function optionalText(value: string | undefined): string | null {
  return value === undefined || value.trim() === "" ? null : value;
}

function resources(
  raw: { [K in keyof PiResources]?: PiResources[K] | undefined } | undefined,
  defaults: PiResources,
): PiResources {
  return {
    contextFiles: raw?.contextFiles ?? defaults.contextFiles,
    extensions: raw?.extensions ?? defaults.extensions,
    skills: raw?.skills ?? defaults.skills,
  };
}

function normalizeStage(id: string, raw: RawStage): Stage {
  const title = raw.title.trim();
  const description = optionalText(raw.description);
  if (raw.terminal === true) return { kind: "terminal", id, title, description };

  return {
    kind: "work",
    id,
    title,
    description,
    // graph-validator гарантирует наличие agent и transitions у нетерминального этапа
    agent: raw.agent ?? "",
    instructions: optionalText(raw.instructions),
    session: raw.session ?? "fresh",
    transitions: (raw.transitions ?? []).map((t) => ({
      to: t.to,
      when: t.when,
      guards: {
        evidence: t.guards?.evidence ?? "optional",
        humanResponse: t.guards?.humanResponse ?? "optional",
      },
    })),
    recheck: raw.recheck
      ? {
          minMinutes: raw.recheck.minMinutes ?? RECHECK_DEFAULTS.minMinutes,
          maxMinutes: raw.recheck.maxMinutes ?? RECHECK_DEFAULTS.maxMinutes,
          maxCount: raw.recheck.maxCount ?? RECHECK_DEFAULTS.maxCount,
        }
      : null,
  };
}

function normalizeAgent(id: string, raw: RawAgent): AgentDef {
  return {
    id,
    title: raw.title?.trim() ?? id,
    model: raw.model ?? "default",
    thinking: raw.thinking ?? null,
    instructions: raw.instructions,
    tools: raw.tools ? [...raw.tools] : null,
    excludeTools: raw.excludeTools ? [...raw.excludeTools] : [],
    askUser: raw.askUser ?? true,
    piResources: resources(raw.piResources, AGENT_RESOURCES),
    timeoutMinutes: raw.timeoutMinutes ?? null,
  };
}

export function normalizePolicy(raw: RawPolicy): PolicySpec {
  const supervisor: SupervisorDef = {
    model: raw.supervisor.model ?? "default",
    thinking: raw.supervisor.thinking ?? null,
    instructions: raw.supervisor.instructions,
    piResources: resources(raw.supervisor.piResources, SUPERVISOR_RESOURCES),
  };

  const rt = raw.runtime ?? {};
  const runtime: RuntimeSettings = {
    policyChangeMode: rt.policyChangeMode ?? RUNTIME_DEFAULTS.policyChangeMode,
    maxConsecutiveRestarts: rt.maxConsecutiveRestarts ?? RUNTIME_DEFAULTS.maxConsecutiveRestarts,
    supervisorProtocolRetries: rt.supervisorProtocolRetries ?? RUNTIME_DEFAULTS.supervisorProtocolRetries,
    maxInvalidDecisionsPerCycle: rt.maxInvalidDecisionsPerCycle ?? RUNTIME_DEFAULTS.maxInvalidDecisionsPerCycle,
    maxCyclesPerStage: rt.maxCyclesPerStage === undefined ? RUNTIME_DEFAULTS.maxCyclesPerStage : rt.maxCyclesPerStage,
    supervisorTimeoutMinutes: rt.supervisorTimeoutMinutes ?? RUNTIME_DEFAULTS.supervisorTimeoutMinutes,
    technicalRetries: rt.technicalRetries ?? RUNTIME_DEFAULTS.technicalRetries,
    technicalRetryDelaySeconds: rt.technicalRetryDelaySeconds ?? RUNTIME_DEFAULTS.technicalRetryDelaySeconds,
  };

  return {
    schema: POLICY_SCHEMA_ID,
    workflow: {
      initialStage: raw.workflow.initialStage,
      stages: dict(Object.entries(raw.workflow.stages).map(([id, s]) => [id, normalizeStage(id, s)])),
    },
    agents: dict(Object.entries(raw.agents).map(([id, a]) => [id, normalizeAgent(id, a)])),
    supervisor,
    runtime,
  };
}
