// Тестовый процесс подбора автомобиля (examples/car-selection/SDLC.md): загружается и задаёт ожидаемый граф.

import path from "node:path";
import { describe, expect, it } from "vitest";
import { getStage } from "../../src/domain/policy.js";
import { loadPolicyFile } from "../../src/policy/policy-loader.js";
import { repoRoot } from "../helpers/paths.js";

describe("examples/car-selection/SDLC.md", async () => {
  const policy = await loadPolicyFile(path.join(repoRoot, "examples", "car-selection", "SDLC.md"));
  const { spec } = policy;
  const work = (id: string) => {
    const stage = getStage(spec, id);
    if (stage?.kind !== "work") throw new Error(`этап ${id} должен быть рабочим`);
    return stage;
  };

  it("загружается без ошибок и предупреждений", () => {
    expect(policy.warnings).toEqual([]);
  });

  it("четыре агента ведут задачу по этапам до терминального", () => {
    expect(spec.workflow.initialStage).toBe("fuel_type");
    expect(Object.keys(spec.workflow.stages)).toEqual(["fuel_type", "brand_selection", "dealer_selection", "order_summary", "completed"]);
    expect(["fuel_type", "brand_selection", "dealer_selection", "order_summary"].map((id) => work(id).agent)).toEqual([
      "fuel_consultant",
      "brand_consultant",
      "sales_manager",
      "account_manager",
    ]);
    expect(getStage(spec, "completed")?.kind).toBe("terminal");
  });

  it("выбор клиента подтверждается его ответом; сводка — без вопросов клиенту", () => {
    for (const id of ["fuel_type", "brand_selection", "dealer_selection"]) {
      expect(work(id).transitions[0]?.guards).toEqual({ evidence: "required", humanResponse: "required" });
    }
    expect(work("brand_selection").transitions.map((t) => t.to)).toEqual(["dealer_selection", "fuel_type"]);
    expect(work("dealer_selection").transitions.map((t) => t.to)).toEqual(["order_summary", "brand_selection"]);
    expect(work("order_summary").transitions).toEqual([expect.objectContaining({ to: "completed" })]);
    expect(spec.agents["account_manager"]?.askUser).toBe(false);
    expect(spec.agents["fuel_consultant"]?.askUser).toBe(true);
  });
});
