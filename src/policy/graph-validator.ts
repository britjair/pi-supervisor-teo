// Ссылочная и графовая валидация Policy, 01-policy.md §3.
// Выполняется после успешного разбора схемы и собирает все проблемы сразу.

import type { GraphErrorCode, GraphWarningCode, PolicyIssue, PolicyIssueParam } from "../domain/policy.js";
import { closestMatch } from "../util/strings.js";
import type { RawPolicy, RawStage } from "./policy-schema.js";
import { formatPath, type Locator } from "./yaml-locate.js";

type Segment = string | number;

export type GraphValidationResult = {
  errors: PolicyIssue[];
  warnings: PolicyIssue[];
};

/** Этап считается терминальным, только если явно написано `terminal: true`. */
function isTerminal(stage: RawStage): boolean {
  return stage.terminal === true;
}

const TERMINAL_FORBIDDEN_FIELDS = ["agent", "instructions", "session", "recheck"] as const;

export function validateGraph(raw: RawPolicy, body: string, locate: Locator): GraphValidationResult {
  const errors: PolicyIssue[] = [];
  const warnings: PolicyIssue[] = [];

  const issue = (code: string, path: Segment[], params: Record<string, PolicyIssueParam> = {}): PolicyIssue => ({
    code,
    path: formatPath(path),
    line: locate(path),
    params,
  });
  const error = (code: GraphErrorCode, path: Segment[], params?: Record<string, PolicyIssueParam>) =>
    errors.push(issue(code, path, params));
  const warn = (code: GraphWarningCode, path: Segment[], params?: Record<string, PolicyIssueParam>) =>
    warnings.push(issue(code, path, params));

  const stages = new Map(Object.entries(raw.workflow.stages));
  const agents = new Map(Object.entries(raw.agents));
  const stageIds = [...stages.keys()];
  const agentIds = [...agents.keys()];
  const stagePath = (id: string): Segment[] => ["workflow", "stages", id];

  const refParams = (value: string, known: string[]) => ({
    value,
    known,
    suggestion: closestMatch(value, known),
  });

  // Этапы по отдельности
  for (const [id, stage] of stages) {
    if (stage.terminal === false) error("TERMINAL_FALSE", [...stagePath(id), "terminal"], { stage: id });

    if (isTerminal(stage)) {
      if (stage.transitions && stage.transitions.length > 0) {
        error("TERMINAL_HAS_TRANSITIONS", [...stagePath(id), "transitions"], { stage: id });
      }
      const present = TERMINAL_FORBIDDEN_FIELDS.filter((f) => stage[f] !== undefined);
      if (present.length > 0) {
        error("TERMINAL_HAS_AGENT", [...stagePath(id), present[0] ?? "agent"], { stage: id, fields: present });
      }
      continue;
    }

    if (stage.agent === undefined) {
      error("NONTERMINAL_NO_AGENT", stagePath(id), { stage: id });
    } else if (!agents.has(stage.agent)) {
      error("STAGE_AGENT_MISSING", [...stagePath(id), "agent"], { stage: id, ...refParams(stage.agent, agentIds) });
    }

    const transitions = stage.transitions ?? [];
    if (transitions.length === 0) {
      error("NONTERMINAL_NO_TRANSITIONS", stage.transitions ? [...stagePath(id), "transitions"] : stagePath(id), {
        stage: id,
      });
    }

    const seenTargets = new Map<string, number>();
    transitions.forEach((t, i) => {
      const path = [...stagePath(id), "transitions", i, "to"];
      if (!stages.has(t.to)) {
        error("TRANSITION_TARGET_MISSING", path, { stage: id, ...refParams(t.to, stageIds) });
      }
      const first = seenTargets.get(t.to);
      if (first !== undefined) {
        error("TRANSITION_DUPLICATE_TARGET", path, { stage: id, target: t.to, firstIndex: first, index: i });
      } else {
        seenTargets.set(t.to, i);
      }
    });
  }

  // Начальный этап и достижимость
  const initial = raw.workflow.initialStage;
  const initialStage = stages.get(initial);
  if (!initialStage) {
    error("INITIAL_STAGE_MISSING", ["workflow", "initialStage"], refParams(initial, stageIds));
  } else if (isTerminal(initialStage)) {
    error("INITIAL_STAGE_TERMINAL", ["workflow", "initialStage"], { stage: initial });
  }

  const successors = (id: string): string[] => {
    const stage = stages.get(id);
    if (!stage || isTerminal(stage)) return [];
    return (stage.transitions ?? []).map((t) => t.to).filter((to) => stages.has(to));
  };
  const reachableFrom = (start: string): Set<string> => {
    const seen = new Set<string>([start]);
    const queue = [start];
    for (let cur = queue.shift(); cur !== undefined; cur = queue.shift()) {
      for (const next of successors(cur)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  };
  const reachesTerminal = (start: string): boolean =>
    [...reachableFrom(start)].some((id) => {
      const s = stages.get(id);
      return s !== undefined && isTerminal(s);
    });

  if (initialStage) {
    const reachable = reachableFrom(initial);
    const terminalReachable = reachesTerminal(initial);
    if (!terminalReachable) {
      error("NO_REACHABLE_TERMINAL", ["workflow", "initialStage"], { initialStage: initial });
    }

    for (const [id, stage] of stages) {
      if (!reachable.has(id)) {
        warn("STAGE_UNREACHABLE", stagePath(id), { stage: id, initialStage: initial });
      } else if (terminalReachable && !isTerminal(stage) && !reachesTerminal(id)) {
        warn("STAGE_DEAD_END", stagePath(id), { stage: id });
      }
    }
  }

  const usedAgents = new Set(
    [...stages.values()].filter((s) => !isTerminal(s) && s.agent !== undefined).map((s) => s.agent),
  );
  for (const id of agentIds) {
    if (!usedAgents.has(id)) warn("AGENT_UNUSED", ["agents", id], { agent: id });
  }

  if (body.trim() === "") warnings.push({ code: "BODY_EMPTY", path: null, line: null, params: {} });

  return { errors, warnings };
}
