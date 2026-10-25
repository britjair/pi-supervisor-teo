// Структурный diff двух версий Policy, 01-policy.md §4.4.
// Результат — данные: он кладётся в policy.changed.payload.diff, текст строит ui/messages.ts.

import type { AgentDef, PolicySpec, Stage, SupervisorDef } from "../domain/policy.js";

export type DiffValue = string | number | boolean | null;

export type PolicyDiffEntry =
  | { kind: "initial_stage_changed"; from: string; to: string }
  | { kind: "stage_added"; stageId: string; title: string }
  | { kind: "stage_removed"; stageId: string; title: string }
  /** Для длинных текстов (instructions, description) значения не сохраняются, только факт изменения. */
  | { kind: "stage_changed"; stageId: string; field: string; from?: DiffValue; to?: DiffValue }
  | { kind: "transition_added"; stageId: string; target: string }
  | { kind: "transition_removed"; stageId: string; target: string }
  | { kind: "transition_changed"; stageId: string; target: string; field: string; from?: DiffValue; to?: DiffValue }
  | { kind: "agent_added"; agentId: string }
  | { kind: "agent_removed"; agentId: string }
  | { kind: "agent_changed"; agentId: string; field: string; from?: DiffValue; to?: DiffValue }
  | { kind: "supervisor_changed"; field: string; from?: DiffValue; to?: DiffValue }
  | { kind: "runtime_changed"; field: string; from: DiffValue; to: DiffValue }
  | { kind: "body_changed"; added: number; removed: number };

type PolicyVersion = { spec: PolicySpec; body: string };

const TEXT_FIELDS = new Set(["instructions", "description", "when"]);

function scalar(value: unknown): DiffValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

/** Сравнение полей объектов: текстовые поля без значений, остальные — с from/to. */
function fieldChanges(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
  fields: readonly string[],
): Array<{ field: string; from?: DiffValue; to?: DiffValue }> {
  const out: Array<{ field: string; from?: DiffValue; to?: DiffValue }> = [];
  for (const field of fields) {
    const a = scalar(from[field]);
    const b = scalar(to[field]);
    if (a === b) continue;
    out.push(TEXT_FIELDS.has(field) ? { field } : { field, from: a, to: b });
  }
  return out;
}

function flatten(prefix: string, value: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!value) return out;
  for (const [k, v] of Object.entries(value)) out[`${prefix}.${k}`] = v;
  return out;
}

function stageFields(stage: Stage): Record<string, unknown> {
  if (stage.kind === "terminal") {
    return { title: stage.title, description: stage.description, terminal: true };
  }
  return {
    title: stage.title,
    description: stage.description,
    terminal: false,
    agent: stage.agent,
    instructions: stage.instructions,
    session: stage.session,
    recheck: stage.recheck !== null,
    ...flatten("recheck", stage.recheck),
  };
}

const STAGE_FIELDS = [
  "terminal",
  "title",
  "description",
  "agent",
  "instructions",
  "session",
  "recheck",
  "recheck.minMinutes",
  "recheck.maxMinutes",
  "recheck.maxCount",
] as const;

function agentFields(agent: AgentDef | SupervisorDef): Record<string, unknown> {
  const { piResources, ...rest } = agent as AgentDef;
  return {
    ...rest,
    tools: "tools" in agent ? (agent.tools?.join(",") ?? null) : undefined,
    excludeTools: "excludeTools" in agent ? agent.excludeTools.join(",") : undefined,
    ...flatten("piResources", piResources),
  };
}

const AGENT_FIELDS = [
  "title",
  "model",
  "thinking",
  "instructions",
  "tools",
  "excludeTools",
  "askUser",
  "timeoutMinutes",
  "piResources.contextFiles",
  "piResources.extensions",
  "piResources.skills",
] as const;

/** Число добавленных и удалённых строк по LCS. */
export function lineDiffStats(from: string, to: string): { added: number; removed: number } {
  const a = from.split("\n");
  const b = to.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  let lcs = 0;
  if (x.length * y.length <= 25_000_000) {
    let prev = new Array<number>(y.length + 1).fill(0);
    for (let i = 1; i <= x.length; i++) {
      const cur = new Array<number>(y.length + 1).fill(0);
      for (let j = 1; j <= y.length; j++) {
        cur[j] = x[i - 1] === y[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, cur[j - 1] ?? 0);
      }
      prev = cur;
    }
    lcs = prev[y.length] ?? 0;
  } else {
    // Очень большие тексты: приближение по мультимножеству строк.
    const counts = new Map<string, number>();
    for (const line of x) counts.set(line, (counts.get(line) ?? 0) + 1);
    for (const line of y) {
      const n = counts.get(line) ?? 0;
      if (n > 0) {
        lcs++;
        counts.set(line, n - 1);
      }
    }
  }
  return { added: y.length - lcs, removed: x.length - lcs };
}

export function diffPolicies(from: PolicyVersion, to: PolicyVersion): PolicyDiffEntry[] {
  const out: PolicyDiffEntry[] = [];
  const a = from.spec;
  const b = to.spec;

  if (a.workflow.initialStage !== b.workflow.initialStage) {
    out.push({ kind: "initial_stage_changed", from: a.workflow.initialStage, to: b.workflow.initialStage });
  }

  const oldStages = new Map(Object.entries(a.workflow.stages));
  const newStages = new Map(Object.entries(b.workflow.stages));
  for (const [id, stage] of newStages) {
    if (!oldStages.has(id)) out.push({ kind: "stage_added", stageId: id, title: stage.title });
  }
  for (const [id, stage] of oldStages) {
    if (!newStages.has(id)) out.push({ kind: "stage_removed", stageId: id, title: stage.title });
  }
  for (const [id, oldStage] of oldStages) {
    const newStage = newStages.get(id);
    if (!newStage) continue;
    for (const change of fieldChanges(stageFields(oldStage), stageFields(newStage), STAGE_FIELDS)) {
      out.push({ kind: "stage_changed", stageId: id, ...change });
    }
    const oldT = new Map(oldStage.kind === "work" ? oldStage.transitions.map((t) => [t.to, t]) : []);
    const newT = new Map(newStage.kind === "work" ? newStage.transitions.map((t) => [t.to, t]) : []);
    for (const target of newT.keys()) {
      if (!oldT.has(target)) out.push({ kind: "transition_added", stageId: id, target });
    }
    for (const [target, t] of oldT) {
      const n = newT.get(target);
      if (!n) {
        out.push({ kind: "transition_removed", stageId: id, target });
        continue;
      }
      const fields = { when: t.when, "guards.evidence": t.guards.evidence, "guards.humanResponse": t.guards.humanResponse };
      const nfields = { when: n.when, "guards.evidence": n.guards.evidence, "guards.humanResponse": n.guards.humanResponse };
      for (const change of fieldChanges(fields, nfields, Object.keys(fields))) {
        out.push({ kind: "transition_changed", stageId: id, target, ...change });
      }
    }
  }

  const oldAgents = new Map(Object.entries(a.agents));
  const newAgents = new Map(Object.entries(b.agents));
  for (const id of newAgents.keys()) if (!oldAgents.has(id)) out.push({ kind: "agent_added", agentId: id });
  for (const id of oldAgents.keys()) if (!newAgents.has(id)) out.push({ kind: "agent_removed", agentId: id });
  for (const [id, oldAgent] of oldAgents) {
    const newAgent = newAgents.get(id);
    if (!newAgent) continue;
    for (const change of fieldChanges(agentFields(oldAgent), agentFields(newAgent), AGENT_FIELDS)) {
      out.push({ kind: "agent_changed", agentId: id, ...change });
    }
  }

  for (const change of fieldChanges(agentFields(a.supervisor), agentFields(b.supervisor), AGENT_FIELDS)) {
    out.push({ kind: "supervisor_changed", ...change });
  }

  for (const field of Object.keys(a.runtime) as Array<keyof typeof a.runtime>) {
    if (a.runtime[field] !== b.runtime[field]) {
      out.push({ kind: "runtime_changed", field, from: a.runtime[field], to: b.runtime[field] });
    }
  }

  if (from.body !== to.body) out.push({ kind: "body_changed", ...lineDiffStats(from.body, to.body) });

  return out;
}
