// Snapshot-тесты шаблонов промптов на двух разных Policy (06-implementation.md §4.1, критерий 10).
// Процесс приходит только из Policy: на другой Policy те же шаблоны дают другие этапы и переходы.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initialPrompt } from "../../src/agents/prompts/agent-prompts.js";
import { evaluationPrompt, supervisorSystemPrompt } from "../../src/agents/prompts/supervisor-prompts.js";
import { getAgent, getStage, type LoadedPolicy, type WorkStage } from "../../src/domain/policy.js";
import { parsePolicyBytes } from "../../src/policy/policy-loader.js";
import { validDir } from "../helpers/paths.js";

const POLICIES = ["discover-execute-done", "spec-8-1-example"];
const NOW = new Date("2026-10-25T10:00:00.000Z");
const ID = (n: number) => `01JB2XKQ8M3N4P5R6S7T8V9W${String(n).padStart(2, "0")}`;

function load(name: string): LoadedPolicy {
  const file = path.join(validDir, `${name}.md`);
  return parsePolicyBytes(readFileSync(file), file);
}

function initialStage(policy: LoadedPolicy): WorkStage {
  const stage = getStage(policy.spec, policy.spec.workflow.initialStage);
  if (stage?.kind !== "work") throw new Error("начальный этап должен быть рабочим");
  return stage;
}

/** Локальное время процесса зависит от TZ машины: в снимке — заглушка. */
const stable = (prompt: string) => prompt.replace(/^Сейчас: .*$/m, "Сейчас: <локальное время>");

describe.each(POLICIES)("промпты на Policy %s", (name) => {
  const policy = load(name);
  const stage = initialStage(policy);
  const agent = getAgent(policy.spec, stage.agent);
  if (!agent) throw new Error(`агента ${stage.agent} нет`);
  const snapshot = (kind: string) => path.join(import.meta.dirname, "__snapshots__", "prompts", `${name}.${kind}.md`);

  it("initial prompt агента начального этапа", async () => {
    const prompt = initialPrompt({
      promptId: ID(1),
      runId: ID(2),
      kind: "initial",
      task: { key: "PAY-142", title: "Оплата через СБП", description: "Добавить СБП как способ оплаты на чекауте." },
      spec: policy.spec,
      stage,
      agent,
      handoff: null,
      previousResults: [],
      artifacts: [],
      taskDirDisplay: ".teo/tasks/PAY-142",
    });
    await expect(prompt).toMatchFileSnapshot(snapshot("initial"));
  });

  it("evaluation prompt supervisor-а после отчёта агента", async () => {
    const prompt = evaluationPrompt({
      promptId: ID(3),
      cycle: 1,
      key: "PAY-142",
      title: "Оплата через СБП",
      version: 5,
      now: NOW,
      policyHash: policy.hash,
      policyRaw: null,
      spec: policy.spec,
      stage,
      stageEnteredAt: NOW.toISOString(),
      stageCycles: 1,
      consecutiveRestarts: 0,
      maxRestarts: policy.spec.runtime.maxConsecutiveRestarts,
      rechecks: null,
      trigger: {
        kind: "agent_settled",
        agentId: agent.id,
        attempt: 1,
        runId: ID(2),
        settleReason: "reported_result",
        report: {
          kind: "result",
          at: NOW.toISOString(),
          data: {
            summary: "Изучил репозиторий, план в artifacts/plan.md",
            evidence: [{ kind: "file", value: "artifacts/plan.md" }],
            artifacts: [{ kind: "file", pathOrUrl: "artifacts/plan.md" }],
          },
        },
        lastAssistantText: null,
        error: null,
      },
      recentEvents: [`- ${NOW.toISOString()} ${ID(4)} agent.settled {"runId":"${ID(2)}","reason":"reported_result"}`],
    });
    await expect(stable(prompt)).toMatchFileSnapshot(snapshot("evaluation"));
    // Видны только переходы, объявленные текущим этапом этой Policy
    for (const t of stage.transitions) expect(prompt).toContain(`→ ${t.to} «${getStage(policy.spec, t.to)?.title ?? t.to}»`);
    for (const other of Object.keys(policy.spec.workflow.stages)) {
      if (other !== stage.id && !stage.transitions.some((t) => t.to === other)) expect(prompt).not.toContain(`→ ${other} «`);
    }
  });

  it("system prompt supervisor-а содержит инструкции и текст Policy", async () => {
    const prompt = supervisorSystemPrompt({ instructions: policy.spec.supervisor.instructions, body: policy.body });
    await expect(prompt).toMatchFileSnapshot(snapshot("supervisor-system"));
  });
});

it("на разных Policy одни и те же шаблоны дают разные этапы", () => {
  const [a, b] = POLICIES.map((n) => {
    const p = load(n);
    return initialStage(p);
  });
  expect(a?.id).not.toBe(b?.id);
});
