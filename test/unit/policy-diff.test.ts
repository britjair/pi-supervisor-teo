import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePolicyBytes } from "../../src/policy/policy-loader.js";
import { diffPolicies, lineDiffStats } from "../../src/policy/policy-diff.js";
import { policyDiffLine } from "../../src/ui/messages.js";
import { examplePolicy, validDir } from "../helpers/paths.js";

const BASE = readFileSync(path.join(validDir, "discover-execute-done.md"), "utf8");
const load = (text: string) => parsePolicyBytes(new TextEncoder().encode(text), "/virtual/SDLC.md");
const diff = (a: string, b: string) => diffPolicies(load(a), load(b));

describe("policy-diff", () => {
  it("одинаковые версии — пустой diff", () => {
    expect(diff(BASE, BASE)).toEqual([]);
  });

  it("добавление и удаление этапа, изменение перехода", () => {
    const next = BASE.replace(
      "        - to: done\n          when: >\n            Файл NOTES.md",
      "        - to: review\n          when: Готово к ревью.\n        - to: done\n          when: >\n            Файл NOTES.md",
    ).replace(
      "    done:\n      title: Готово\n      terminal: true",
      "    review:\n      title: Ревью\n      agent: executor\n      transitions:\n        - to: done\n          when: Ок.\n    done:\n      title: Готово\n      terminal: true",
    );
    expect(diff(BASE, next)).toEqual([
      { kind: "stage_added", stageId: "review", title: "Ревью" },
      { kind: "transition_added", stageId: "execute", target: "review" },
    ]);
    expect(diff(next, BASE)).toEqual([
      { kind: "stage_removed", stageId: "review", title: "Ревью" },
      { kind: "transition_removed", stageId: "execute", target: "review" },
    ]);
  });

  it("условие и guards перехода; тексты без значений", () => {
    const next = BASE.replace("Файл NOTES.md закоммичен", "Файл NOTES.md создан и закоммичен").replace(
      "          guards:\n            evidence: required\n\n    done:",
      "          guards:\n            evidence: optional\n\n    done:",
    );
    expect(diff(BASE, next)).toEqual([
      { kind: "transition_changed", stageId: "execute", target: "done", field: "when" },
      { kind: "transition_changed", stageId: "execute", target: "done", field: "guards.evidence", from: "required", to: "optional" },
    ]);
  });

  it("инструкции агента, агент этапа, runtime, supervisor и body", () => {
    const next = BASE.replace("Ты выполняешь задачу по плану", "Ты аккуратно выполняешь задачу по плану")
      .replace("      agent: executor\n", "      agent: explorer\n      session: reuse\n")
      .replace("  maxCyclesPerStage: 5", "  maxCyclesPerStage: 7\n  maxConsecutiveRestarts: 5")
      .replace("supervisor:\n  model: default", "supervisor:\n  model: anthropic/claude-opus-5-5")
      .replace("# Правила\n", "# Правила\n\nНовое правило.\n");
    const entries = diff(BASE, next);
    expect(entries).toEqual([
      { kind: "stage_changed", stageId: "execute", field: "agent", from: "executor", to: "explorer" },
      { kind: "stage_changed", stageId: "execute", field: "session", from: "fresh", to: "reuse" },
      { kind: "agent_changed", agentId: "executor", field: "instructions" },
      { kind: "supervisor_changed", field: "model", from: "default", to: "anthropic/claude-opus-5-5" },
      { kind: "runtime_changed", field: "maxConsecutiveRestarts", from: 3, to: 5 },
      { kind: "runtime_changed", field: "maxCyclesPerStage", from: 5, to: 7 },
      { kind: "body_changed", added: 2, removed: 0 },
    ]);
    expect(entries.map((e) => { const l = policyDiffLine(e); return `${l.mark} ${l.text}`; })).toEqual([
      "~ этап execute: agent executor → explorer",
      "~ этап execute: session fresh → reuse",
      "~ агент executor: instructions изменено",
      "~ supervisor: model default → anthropic/claude-opus-5-5",
      "~ runtime.maxConsecutiveRestarts: 3 → 5",
      "~ runtime.maxCyclesPerStage: 5 → 7",
      "~ Markdown-часть изменена (+2 / −0 строк)",
    ]);
  });

  it("recheck и смена терминальности", () => {
    const withRecheck = BASE.replace("      agent: executor\n", "      agent: executor\n      recheck:\n        maxCount: 3\n");
    expect(diff(BASE, withRecheck)).toEqual([
      { kind: "stage_changed", stageId: "execute", field: "recheck", from: false, to: true },
      { kind: "stage_changed", stageId: "execute", field: "recheck.minMinutes", from: null, to: 1 },
      { kind: "stage_changed", stageId: "execute", field: "recheck.maxMinutes", from: null, to: 120 },
      { kind: "stage_changed", stageId: "execute", field: "recheck.maxCount", from: null, to: 3 },
    ]);
  });

  it("реальная Policy: изменение примера пользователя", () => {
    const example = readFileSync(examplePolicy, "utf8");
    const next = example.replace("maxCount: 12", "maxCount: 20");
    expect(diff(example, next)).toEqual([
      { kind: "stage_changed", stageId: "code_review", field: "recheck.maxCount", from: 12, to: 20 },
    ]);
  });

  it("lineDiffStats считает строки по LCS", () => {
    expect(lineDiffStats("a\nb\nc", "a\nc\nd")).toEqual({ added: 1, removed: 1 });
    expect(lineDiffStats("a\nb", "a\nb")).toEqual({ added: 0, removed: 0 });
    expect(lineDiffStats("", "x\ny")).toEqual({ added: 2, removed: 1 });
  });
});
