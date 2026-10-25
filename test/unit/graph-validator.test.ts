import { describe, expect, it } from "vitest";
import { PolicyError } from "../../src/errors/errors.js";
import { parsePolicyBytes } from "../../src/policy/policy-loader.js";

/** Policy из описания графа: «a>b,c; b>d; d!» (! — терминальный). Все этапы обслуживает агент w. */
function policyFromGraph(graph: string, opts: { body?: string; extraAgents?: string[] } = {}): string {
  const stages = graph.split(";").map((s) => s.trim());
  const lines = ["---", "schema: sdlc/v1", "workflow:", `  initialStage: ${stages[0]?.split(/[>!]/)[0]}`, "  stages:"];
  for (const s of stages) {
    if (s.endsWith("!")) {
      lines.push(`    ${s.slice(0, -1)}:`, "      title: T", "      terminal: true");
      continue;
    }
    const [id, targets = ""] = s.split(">");
    lines.push(`    ${id}:`, "      title: T", "      agent: w", "      transitions:");
    for (const t of targets.split(",")) lines.push(`        - to: ${t}`, "          when: условие");
  }
  lines.push("agents:", "  w:", "    instructions: работай");
  for (const a of opts.extraAgents ?? []) lines.push(`  ${a}:`, "    instructions: работай");
  lines.push("supervisor:", "  instructions: проверяй", "---", opts.body ?? "Правила.");
  return lines.join("\n");
}

const load = (text: string) => parsePolicyBytes(new TextEncoder().encode(text), "/virtual/SDLC.md");
const warnings = (text: string) => load(text).warnings.map((w) => [w.code, w.path]);

function errors(text: string): Array<[string, string | null]> {
  try {
    load(text);
  } catch (err) {
    if (err instanceof PolicyError) return err.issues.map((i) => [i.code, i.path]);
    throw err;
  }
  return [];
}

describe("graph-validator", () => {
  it("корректный граф без ошибок и предупреждений", () => {
    expect(warnings(policyFromGraph("a>b; b>c,a; c!"))).toEqual([]);
  });

  it("переход этапа в самого себя допустим", () => {
    expect(warnings(policyFromGraph("a>a,b; b!"))).toEqual([]);
  });

  it("цикл без выхода — STAGE_DEAD_END для каждого этапа цикла", () => {
    expect(warnings(policyFromGraph("a>b,c; b>d; d>b; c!"))).toEqual([
      ["STAGE_DEAD_END", "workflow.stages.b"],
      ["STAGE_DEAD_END", "workflow.stages.d"],
    ]);
  });

  it("недостижимый этап — STAGE_UNREACHABLE", () => {
    expect(warnings(policyFromGraph("a>b; b!; orphan>b"))).toEqual([["STAGE_UNREACHABLE", "workflow.stages.orphan"]]);
  });

  it("неиспользуемый агент — AGENT_UNUSED", () => {
    expect(warnings(policyFromGraph("a>b; b!", { extraAgents: ["spare"] }))).toEqual([["AGENT_UNUSED", "agents.spare"]]);
  });

  it("пустая Markdown-часть — BODY_EMPTY", () => {
    expect(warnings(policyFromGraph("a>b; b!", { body: "\n  \n" }))).toEqual([["BODY_EMPTY", null]]);
  });

  it("недостижимость терминала — ошибка, а не набор STAGE_DEAD_END", () => {
    expect(errors(policyFromGraph("a>b; b>a; c!"))).toEqual([["NO_REACHABLE_TERMINAL", "workflow.initialStage"]]);
  });

  it("переход в несуществующий этап не ломает обход графа", () => {
    expect(errors(policyFromGraph("a>missing,b; b!"))).toEqual([
      ["TRANSITION_TARGET_MISSING", "workflow.stages.a.transitions[0].to"],
    ]);
  });

  it("все ошибки графа собираются за один проход", () => {
    const text = policyFromGraph("a>b,b,x; b!").replace("      terminal: true", "      terminal: true\n      agent: w");
    expect(errors(text)).toEqual([
      ["TRANSITION_DUPLICATE_TARGET", "workflow.stages.a.transitions[1].to"],
      ["TRANSITION_TARGET_MISSING", "workflow.stages.a.transitions[2].to"],
      ["TERMINAL_HAS_AGENT", "workflow.stages.b.agent"],
    ]);
  });
});
