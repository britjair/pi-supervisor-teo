// Реальный процесс пользователя (examples/SDLC.md) — опорная проверка загрузчика.

import { describe, expect, it } from "vitest";
import { getAgent, getStage } from "../../src/domain/policy.js";
import { loadPolicyFile } from "../../src/policy/policy-loader.js";
import { examplePolicy } from "../helpers/paths.js";

describe("examples/SDLC.md", async () => {
  const policy = await loadPolicyFile(examplePolicy);
  const { spec } = policy;

  it("загружается без ошибок и предупреждений", () => {
    expect(policy.warnings).toEqual([]);
    expect(policy.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(policy.body).toContain("# Правила процесса");
  });

  it("этапы и агенты", () => {
    expect(spec.workflow.initialStage).toBe("requirements");
    expect(Object.keys(spec.workflow.stages)).toEqual([
      "requirements",
      "plan_approval",
      "implementation",
      "code_review",
      "fixing",
      "ft_preparation",
      "feature_testing",
      "done",
    ]);
    expect(Object.keys(spec.agents)).toEqual(["analyst", "developer", "review_coordinator", "release_engineer", "qa_coordinator"]);
    expect(getStage(spec, "done")).toEqual({
      kind: "terminal",
      id: "done",
      title: "Feature testing пройден",
      description: "Автотесты прошли, QA-инженер поставил approve. Merge и релиз — вне этого процесса.",
    });
  });

  it("session: reuse и guards согласования плана", () => {
    const stage = getStage(spec, "plan_approval");
    expect(stage).toMatchObject({ kind: "work", agent: "analyst", session: "reuse", recheck: null });
    if (stage?.kind !== "work") throw new Error("ожидался рабочий этап");
    expect(stage.transitions.map((t) => [t.to, t.guards])).toEqual([
      ["implementation", { evidence: "required", humanResponse: "required" }],
      ["requirements", { evidence: "optional", humanResponse: "optional" }],
    ]);
    expect(stage.transitions[0]?.when).toContain("Пользователь явно подтвердил");
  });

  it("recheck на этапах ожидания внешних событий", () => {
    expect(getStage(spec, "code_review")).toMatchObject({ recheck: { minMinutes: 3, maxMinutes: 15, maxCount: 12 } });
    expect(getStage(spec, "ft_preparation")).toMatchObject({ recheck: { minMinutes: 3, maxMinutes: 30, maxCount: 30 } });
    expect(getStage(spec, "feature_testing")).toMatchObject({ recheck: { minMinutes: 15, maxMinutes: 960, maxCount: 30 } });
    expect(getStage(spec, "implementation")).toMatchObject({ recheck: null, session: "fresh" });
  });

  it("агенты, supervisor и runtime с default", () => {
    expect(getAgent(spec, "developer")).toMatchObject({
      title: "Разработчик",
      model: "default",
      askUser: true,
      tools: null,
      piResources: { contextFiles: "inherit", extensions: "inherit", skills: "inherit" },
    });
    expect(spec.supervisor.piResources).toEqual({ contextFiles: "none", extensions: "inherit", skills: "none" });
    expect(spec.runtime).toEqual({
      policyChangeMode: "confirm",
      maxConsecutiveRestarts: 3,
      supervisorProtocolRetries: 1,
      maxInvalidDecisionsPerCycle: 3,
      maxCyclesPerStage: 30,
      supervisorTimeoutMinutes: 30,
      technicalRetries: 2,
      technicalRetryDelaySeconds: 15,
    });
  });
});
