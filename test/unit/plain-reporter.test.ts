import { describe, expect, it } from "vitest";
import { PlainReporter } from "../../src/ui/plain/plain-reporter.js";
import { FakeClock } from "../helpers/fake-clock.js";

describe("PlainReporter", () => {
  it("печатает стабильный машинно-читаемый формат и собирает text delta в строки", () => {
    let output = "";
    const clock = new FakeClock("2026-10-24T12:33:00.000Z");
    const reporter = new PlainReporter({ write: (text: string) => { output += text; } }, clock);

    reporter.context({ key: "PAY-142", stage: "review", agent: "reviewer#2" });
    reporter.emit({ type: "agent.started", stage: "review", stageTitle: "Ревью", agentId: "reviewer", attempt: 2, inputKind: "initial" });
    reporter.emit({ type: "text", actor: "agent", text: "Проверяю " });
    reporter.emit({ type: "text", actor: "agent", text: "изменения\nСледующая строка" });
    reporter.emit({ type: "tool.started", actor: "agent", toolName: "bash", argsPreview: "go test ./..." });
    reporter.emit({ type: "tool.finished", actor: "agent", toolName: "bash", ok: true });
    reporter.emit({ type: "agent.settled", agentId: "reviewer", attempt: 2, reason: "reported_result" });
    reporter.context({ key: "PAY-142", stage: "review", agent: null });
    reporter.emit({ type: "supervisor.started", cycle: 7, trigger: "agent_settled" });
    reporter.emit({ type: "decision", cycle: 7, action: "transition_stage", summary: "review → fixing" });
    reporter.emit({ type: "transition", from: "review", fromTitle: "Ревью", to: "fixing", toTitle: "Исправления", reason: "нужны правки", terminal: false });

    expect(output).toBe([
      "[2026-10-24T12:33:00.000Z][PAY-142][review][reviewer#2] started",
      "[2026-10-24T12:33:00.000Z][PAY-142][review][reviewer#2] Проверяю изменения",
      "[2026-10-24T12:33:00.000Z][PAY-142][review][reviewer#2] Следующая строка",
      "[2026-10-24T12:33:00.000Z][PAY-142][review][reviewer#2] tool bash: go test ./...",
      "[2026-10-24T12:33:00.000Z][PAY-142][review][reviewer#2] tool bash ok",
      "[2026-10-24T12:33:00.000Z][PAY-142][review][reviewer#2] settled: reported_result",
      "[2026-10-24T12:33:00.000Z][PAY-142][supervisor] cycle 7 started (agent_settled)",
      "[2026-10-24T12:33:00.000Z][PAY-142][supervisor] decision transition_stage → fixing",
      "[2026-10-24T12:33:00.000Z][PAY-142] transition review → fixing",
      "",
    ].join("\n"));
  });

  it("форматирует ожидание и периодический статус по §5", () => {
    let output = "";
    const reporter = new PlainReporter({ write: (text: string) => { output += text; } }, new FakeClock("2026-10-24T12:33:00.000Z"));
    reporter.context({ key: "CRM-12", stage: "review", agent: null });
    reporter.emit({ type: "waiting", dueAt: "2026-10-24T12:40:00.000Z", minutes: 7, number: 4, maxCount: 40, waitingFor: "ответ ревьюера" });
    reporter.emit({ type: "waiting.tick", minutesLeft: 2 });
    expect(output).toContain("[CRM-12] waiting until 2026-10-24T12:40:00.000Z (7 min, 4/40): ответ ревьюера");
    expect(output).toContain("[CRM-12] still waiting, 2 min left");
  });
});
