import { describe, expect, it } from "vitest";
import { nextAction } from "../../src/domain/next-action.js";
import { checkInvariants, haltedState, type TaskState } from "../../src/domain/task-state.js";
import { nextActionText, statusBadge } from "../../src/ui/messages.js";
import { createIdGenerator } from "../../src/util/ids.js";
import { FakeClock } from "../helpers/fake-clock.js";

const NOW = new Date("2026-10-25T10:00:00.000Z");

function base(over: Partial<TaskState> = {}): TaskState {
  return {
    schemaVersion: 1,
    key: "T-1",
    title: "t",
    projectRoot: "/p",
    workspacePath: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    version: 1,
    process: "test",
    policyHash: `sha256:${"0".repeat(64)}`,
    policySchema: "teo/v1",
    stage: "s",
    stageEnteredAt: NOW.toISOString(),
    stageEntryEventId: "E",
    stageCycles: 0,
    stageRechecks: { count: 0, waitedMinutes: 0, firstScheduledAt: null },
    status: "active",
    statusReason: null,
    phase: "agent_pending",
    currentRun: null,
    agentRunCounters: {},
    consecutiveRestarts: 0,
    nextAgentInput: { kind: "initial", message: null, decisionId: null },
    wait: null,
    supervisor: { sessionFile: "sessions/supervisor.jsonl", cycle: 0, trigger: null, lastPolicyHashShown: null },
    pendingDecision: null,
    lastAppliedDecisionId: null,
    lastDecision: null,
    pendingHumanRequest: null,
    hostSession: null,
    lastEventId: "E",
    outbox: [],
    ...over,
  };
}

const run = {
  runId: "R",
  agentId: "worker",
  attempt: 2,
  stage: "s",
  sessionFile: "sessions/worker-002.jsonl",
  sessionMode: "fresh" as const,
  status: "running" as const,
  settleReason: null,
  promptsSent: [],
  startedAt: null,
  finishedAt: null,
};

const question = {
  requestId: "Q",
  origin: "supervisor" as const,
  runId: null,
  question: "Подтверждаете план?",
  context: null,
  options: null,
  allowFreeText: true,
  attachments: [],
  requestedAt: NOW.toISOString(),
};

const wait = {
  decisionId: "D",
  number: 1,
  waitingFor: "ответ ревьюера",
  message: "проверь",
  delayMinutes: 30,
  scheduledAt: NOW.toISOString(),
  dueAt: "2026-10-25T10:30:00.000Z",
  targetPhase: null,
  resetKnown: true,
};

describe("инварианты state", () => {
  it("корректные состояния", () => {
    for (const s of [
      base(),
      base({ phase: "agent_running", nextAgentInput: null, currentRun: run }),
      base({ phase: "human_pending", status: "waiting_human", pendingHumanRequest: question, nextAgentInput: null }),
      base({ phase: "agent_running", status: "waiting_human", currentRun: run, pendingHumanRequest: { ...question, origin: "agent", runId: "R" } }),
      base({ phase: "waiting", wait, currentRun: run, status: "interrupted" }),
      haltedState(base(), "blocked", null),
      base({ status: "interrupted", phase: "supervisor_running" }),
    ]) {
      expect(checkInvariants(s, "T-1")).toEqual([]);
    }
  });

  it.each<[string, Partial<TaskState>]>([
    ["halted без терминального статуса", { phase: "halted" }],
    ["терминальный статус без halted", { status: "terminal" }],
    ["waiting_human без вопроса", { status: "waiting_human" }],
    ["вопрос без waiting_human", { pendingHumanRequest: question }],
    ["human_pending с вопросом агента", { phase: "human_pending", status: "waiting_human", pendingHumanRequest: { ...question, origin: "agent" } }],
    ["вопрос агента вне agent_running", { status: "waiting_human", pendingHumanRequest: { ...question, origin: "agent" } }],
    ["decision_pending без решения", { phase: "decision_pending" }],
    ["agent_pending без входа", { nextAgentInput: null }],
    ["agent_running без run", { phase: "agent_running" }],
    ["waiting без wait", { phase: "waiting", currentRun: run }],
    ["wait вне waiting", { wait }],
    ["waiting без run", { phase: "waiting", wait }],
    ["waiting при blocked", { phase: "waiting", wait, currentRun: run, status: "waiting_human", pendingHumanRequest: question }],
    ["сессия вне каталога", { currentRun: { ...run, sessionFile: "../x.jsonl" } }],
    ["абсолютный путь сессии", { currentRun: { ...run, sessionFile: "/etc/x" } }],
    ["key не совпадает с каталогом", { key: "T-2" }],
  ])("%s", (_name, over) => {
    expect(checkInvariants(base(over), "T-1")).not.toEqual([]);
  });
});

describe("next-action", () => {
  const ctx = { stageAgent: "worker", now: NOW, live: false };
  const text = (s: TaskState, live = false) => nextActionText(nextAction(s, { ...ctx, live }), { key: "T-1", now: NOW });

  it("текст для каждой фазы и триггера", () => {
    expect(text(base())).toBe("запустить agent worker");
    expect(text(base({ nextAgentInput: { kind: "continue", message: "m", decisionId: "D" }, currentRun: run }))).toBe(
      "продолжить agent worker по замечанию supervisor",
    );
    expect(text(base({ nextAgentInput: { kind: "restart", message: "m", decisionId: "D" }, currentRun: run }))).toBe("перезапустить agent worker");
    expect(text(base({ nextAgentInput: { kind: "recheck", message: "m", decisionId: "D" }, currentRun: run }))).toBe(
      "agent worker выполнит перепроверку",
    );
    const running = base({ phase: "agent_running", nextAgentInput: null, currentRun: run });
    expect(text(running, true)).toBe("agent worker работает");
    expect(text(running)).toBe("agent worker прерван — будет восстановлен при teo resume T-1");
    const sp = (kind: NonNullable<TaskState["supervisor"]["trigger"]>["kind"]) =>
      text(base({ phase: "supervisor_pending", nextAgentInput: null, currentRun: run, supervisor: { ...base().supervisor, trigger: { kind, ref: null } } }));
    expect(sp("agent_settled")).toBe("supervisor проверит результат worker");
    expect(sp("human_responded")).toBe("supervisor обработает ответ пользователя");
    expect(sp("recovered")).toBe("supervisor разберёт прерванный ход агента");
    expect(text(base({ phase: "supervisor_running", nextAgentInput: null }), true)).toBe("supervisor принимает решение");
    expect(
      text(
        base({
          phase: "decision_pending",
          nextAgentInput: null,
          pendingDecision: { decisionId: "D", cycle: 1, action: "block_task", input: { expectedStateVersion: 1, reason: "r", resolutionHint: "h" }, decidedAt: NOW.toISOString() },
        }),
      ),
    ).toBe("применить решение block_task");
    expect(text(base({ phase: "human_pending", status: "waiting_human", pendingHumanRequest: question, nextAgentInput: null }))).toBe(
      "ждёт ответа пользователя: Подтверждаете план?",
    );
    const waiting = base({ phase: "waiting", wait, currentRun: run, nextAgentInput: null });
    expect(text(waiting, true)).toBe("перепроверка в 10:30 (через 30 мин): ответ ревьюера");
    expect(text(waiting)).toContain("teo resume T-1 (--now — сразу)");
    expect(text(base({ phase: "waiting", wait: { ...wait, dueAt: "2026-10-25T09:00:00.000Z" }, currentRun: run, nextAgentInput: null }))).toBe(
      "перепроверка просрочена — начнётся при teo resume T-1",
    );
    expect(text(haltedState(base(), "terminal", null))).toBe("завершена");
    expect(text(haltedState(base(), "cancelled", null))).toBe("отменена");
    expect(text(haltedState(base(), "blocked", { code: "X", message: "нет доступа к CI", at: "" }))).toBe(
      "заблокирована: нет доступа к CI — teo resume T-1",
    );
  });

  it("бейдж меню", () => {
    const b = (s: TaskState, live = false, livePid: number | null = null) =>
      statusBadge(nextAction(s, { ...ctx, live }), { now: NOW, livePid, interrupted: s.status === "interrupted" });
    expect(b(base({ phase: "agent_running", nextAgentInput: null, currentRun: run }), true, 18432)).toBe("● агент работает (PID 18432)");
    expect(b(base({ phase: "human_pending", status: "waiting_human", pendingHumanRequest: question, nextAgentInput: null }))).toBe("? ждёт ответа");
    expect(b(base({ phase: "waiting", wait, currentRun: run, nextAgentInput: null }))).toBe("⏳ перепроверка в 10:30");
    expect(b(haltedState(base(), "blocked", null))).toBe("⛔ заблокирована");
    expect(b(base())).toBe("○ ждёт запуска агента");
    expect(b(base({ status: "interrupted" }))).toBe("◌ прервана");
  });
});

describe("ids", () => {
  it("монотонны и больше id из чужого процесса, даже если его часы впереди", () => {
    const clock = new FakeClock();
    const ids = createIdGenerator(clock);
    const a = ids.next();
    const b = ids.next(a);
    expect(b > a).toBe(true);
    const future = createIdGenerator(new FakeClock("2026-10-25T11:00:00.000Z")).next();
    const c = ids.next(future);
    expect(c > future).toBe(true);
    expect(ids.next(c) > c).toBe(true);
  });
});
