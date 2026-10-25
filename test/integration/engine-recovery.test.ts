// Recovery после сбоев, 06-implementation.md §4.2: сценарии 12–16, 23, 28 и матрица
// fault-injection: сбой в каждой именованной точке (каждое её прохождение) с последующим recovery.

import { describe, expect, it } from "vitest";
import { FakeCrash, turn, type FakeStep, type FakeTurnContext } from "../../src/agents/fake/fake-runtime.js";
import type { TaskEvent } from "../../src/domain/events.js";
import type { HumanAnswer, HumanIO, QuestionView } from "../../src/ui/human-io.js";
import { FAULT_POINTS, InjectedFault, countingFaults, throwingAt, throwingAtOccurrence, throwingWhen, type FaultInjector } from "../../src/util/fault.js";
import type { ExitOutcome } from "../../src/workflow/outcome.js";
import { Harness } from "../helpers/engine.js";
import { ScriptedHumanIO } from "../helpers/scripted-human-io.js";

const EV = "$expectedStateVersion";
const sv = (action: string, args: Record<string, unknown> = {}) => turn.tool(action, { expectedStateVersion: EV, ...args });
const report = (summary = "готово") => turn.tool("report_result", { summary });
const EXPLORER = "sessions/explorer-001.jsonl";
const SUPERVISOR = "sessions/supervisor.jsonl";
const askUserOn = (t: string) => t.replace("    title: Исследователь\n    model: default\n    askUser: false", "    title: Исследователь\n    model: default");

const count = (events: TaskEvent[], type: string) => events.filter((e) => e.type === type).length;

/** Процесс «умер»: исключение сбоя вылетает из движка. */
async function crashes(p: Promise<unknown>): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err instanceof InjectedFault || err instanceof FakeCrash, String(err)).toBe(true);
}

describe("recovery", () => {
  it("12. падение после записи решения, до применения → решение применяется один раз", async () => {
    const h = await Harness.create();
    await h.createTask();
    h.fake
      .script(EXPLORER, report())
      .script(SUPERVISOR, sv("transition_stage", { to: "execute", reason: "ok", evidenceRefs: ["note:ok"] }))
      .script("sessions/executor-001.jsonl", report())
      .script(SUPERVISOR, sv("block_task", { reason: "стоп", resolutionHint: "-" }));
    await crashes(h.run("T-1", { faults: throwingAt("before-decision-apply") }));
    expect((await h.state()).phase).toBe("decision_pending");
    await h.run();
    const events = await h.events();
    expect(count(events, "stage.transitioned")).toBe(1);
    expect(count(events, "supervisor.decision")).toBe(2);
    expect(count(events, "decision.applied")).toBe(2);
    expect((await h.state()).stage).toBe("execute");
  });

  it("12a. падение внутри control tool после записи решения → не теряется и не принимается повторно", async () => {
    const h = await Harness.create();
    await h.createTask();
    h.fake.script(EXPLORER, report()).script(SUPERVISOR, sv("block_task", { reason: "стоп", resolutionHint: "-" }));
    await crashes(h.run("T-1", { faults: throwingAt("in-control-tool") }));
    expect(await h.run()).toEqual({ kind: "blocked", code: "SUPERVISOR_BLOCKED" });
    const events = await h.events();
    expect(count(events, "supervisor.decision")).toBe(1);
    expect(count(events, "decision.applied")).toBe(1);
    expect(h.promptsTo(SUPERVISOR)).toHaveLength(1);
  });

  it("13. падение после commit перехода, до append события → событие восстановлено из outbox", async () => {
    const h = await Harness.create();
    await h.createTask();
    h.fake
      .script(EXPLORER, report())
      .script(SUPERVISOR, sv("transition_stage", { to: "execute", reason: "ok", evidenceRefs: ["note:ok"] }))
      .script("sessions/executor-001.jsonl", report())
      .script(SUPERVISOR, sv("block_task", { reason: "стоп", resolutionHint: "-" }));
    const fault = throwingWhen("after-state-commit", (i) => i.events?.includes("stage.transitioned") ?? false);
    await crashes(h.run("T-1", { faults: fault }));
    expect(fault.fired()).toBe(true);
    expect((await h.state()).stage).toBe("execute");
    expect(await h.types()).not.toContain("stage.transitioned");
    await h.run();
    const events = await h.events();
    expect(count(events, "stage.transitioned")).toBe(1);
    const ids = events.map((e) => e.id);
    expect([...ids].sort()).toEqual(ids);
  });

  it("14. падение до доставки prompt агенту → prompt отправлен заново, без дубликата run", async () => {
    const h = await Harness.create();
    await h.createTask();
    h.fake.script(EXPLORER, report()).script(SUPERVISOR, sv("block_task", { reason: "стоп", resolutionHint: "-" }));
    await crashes(h.run("T-1", { faults: throwingAt("before-agent-prompt") }));
    const crashed = await h.state();
    expect(crashed.phase).toBe("agent_running");
    expect(h.promptsTo(EXPLORER)).toHaveLength(0);
    await h.run();
    const events = await h.events();
    expect(count(events, "agent.started")).toBe(1);
    expect(h.promptsTo(EXPLORER)).toHaveLength(1);
    const s = await h.state();
    expect(s.currentRun?.runId).toBe(crashed.currentRun?.runId);
    expect(s.currentRun?.promptsSent).toHaveLength(1);
    expect(s.agentRunCounters).toEqual({ explorer: 1 });
    expect(events.find((e) => e.type === "runtime.recovered")?.payload).toMatchObject({ action: "resend_prompt" });
  });

  it("15. падение во время tool call агента → supervisor получил recovered с висящим вызовом; агент не продолжен", async () => {
    const h = await Harness.create();
    await h.createTask();
    h.fake
      .script(EXPLORER, turn.text("Пушу ветку"), turn.crashInTool("bash", { command: "git push origin feature" }))
      .script(SUPERVISOR, sv("block_task", { reason: "проверю вручную", resolutionHint: "-" }));
    await crashes(h.run());
    await h.run();
    expect(h.promptsTo(EXPLORER)).toHaveLength(1);
    const prompt = h.promptsTo(SUPERVISOR)[0] ?? "";
    expect(prompt).toContain("# Причина цикла: recovered");
    expect(prompt).toContain('Незавершённый вызов инструмента: bash {"command":"git push origin feature"}');
    expect(prompt).toContain("Внешние побочные эффекты могли произойти, а могли и нет");
    expect((await h.events()).find((e) => e.type === "agent.settled")?.payload).toMatchObject({ reason: "interrupted" });
  });

  it("16. падение во время ask_user → вопрос задан повторно, агент продолжен с ответом", async () => {
    const base = await Harness.create();
    const h = await Harness.create({ policy: askUserOn(base.policyText) });
    await h.createTask();
    h.fake
      .script(EXPLORER, turn.tool("ask_user", { question: "Какая БД?" }), report("после ответа"))
      .script(SUPERVISOR, sv("block_task", { reason: "стоп", resolutionHint: "-" }));
    await crashes(h.run("T-1", { human: new ScriptedHumanIO([]), faults: throwingAt("in-ask-user") }));
    expect((await h.state())).toMatchObject({ status: "waiting_human", phase: "agent_running" });
    // Без терминала вопрос ждёт
    expect(await h.run()).toEqual({ kind: "waiting_human" });
    const human = new ScriptedHumanIO([{ multiline: "PostgreSQL" }, { confirm: true }]);
    await h.run("T-1", { human });
    expect(human.printed).toContain("Какая БД?");
    const events = await h.events();
    expect(count(events, "human.requested")).toBe(1);
    expect(count(events, "human.responded")).toBe(1);
    const prompts = h.promptsTo(EXPLORER);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/kind=recovery/);
    expect(prompts[1]).toContain("Ваш вопрос был прерван рестартом. Ответ пользователя: PostgreSQL");
    expect((await h.state()).currentRun?.settleReason).toBe("reported_result");
  });

  it("отчёт записан, процесс упал до события → settle с сохранённым отчётом", async () => {
    const h = await Harness.create();
    await h.createTask();
    h.fake.script(EXPLORER, report("план готов")).script(SUPERVISOR, sv("block_task", { reason: "стоп", resolutionHint: "-" }));
    await crashes(h.run("T-1", { faults: throwingAt("in-agent-report") }));
    await h.run();
    expect((await h.state()).currentRun?.settleReason).toBe("reported_result");
    expect(h.promptsTo(SUPERVISOR)[0]).toContain("Итог: план готов");
    expect(h.promptsTo(EXPLORER)).toHaveLength(1);
  });

  it("supervisor прерван посреди цикла → цикл повторяется с trigger reevaluate", async () => {
    const h = await Harness.create();
    await h.createTask();
    h.fake
      .script(EXPLORER, report())
      .script(SUPERVISOR, turn.tool("read_state", {}), turn.crash())
      .script(SUPERVISOR, sv("block_task", { reason: "стоп", resolutionHint: "-" }));
    await crashes(h.run());
    expect((await h.state()).phase).toBe("supervisor_running");
    await h.run();
    expect(h.promptsTo(SUPERVISOR)[1]).toContain("# Причина цикла: reevaluate");
    expect((await h.state()).supervisor.cycle).toBe(2);
  });

  it("повреждённый файл сессии → выбор человека (restart)", async () => {
    const h = await Harness.create();
    await h.createTask();
    h.fake.script(EXPLORER, turn.crash()).script("sessions/explorer-002.jsonl", report()).script(SUPERVISOR, sv("block_task", { reason: "стоп", resolutionHint: "-" }));
    await crashes(h.run());
    const { appendFile } = await import("node:fs/promises");
    await appendFile(`${h.taskDir()}/sessions/explorer-001.jsonl`, "{битая строка\n");
    expect(await h.run()).toEqual({ kind: "waiting_human" });
    const human = new ScriptedHumanIO([{ select: "Перезапустить агента" }]);
    await h.run("T-1", { human });
    expect((await h.state()).currentRun?.sessionFile).toBe("sessions/explorer-002.jsonl");
    expect((await h.events()).find((e) => e.type === "runtime.recovered")?.payload).toMatchObject({ action: "ambiguous_restart" });
  });

  it("23. Ctrl+C во время работы агента → interrupted, exit 130; resume восстанавливается по §8", async () => {
    const h = await Harness.create();
    await h.createTask();
    let engine: { interrupt(s: "SIGINT"): void } | null = null;
    h.fake
      .script(EXPLORER, turn.text("Работаю"), turn.effect(() => engine?.interrupt("SIGINT")))
      .script(SUPERVISOR, sv("continue_current_agent", { message: "Тебя прервали, проверь состояние и продолжай" }))
      .script(EXPLORER, report())
      .script(SUPERVISOR, sv("block_task", { reason: "стоп", resolutionHint: "-" }));
    expect(await h.run("T-1", { onEngine: (e) => (engine = e) })).toEqual({ kind: "interrupted", signal: "SIGINT" });
    const s = await h.state();
    expect(s).toMatchObject({ status: "interrupted", phase: "agent_running" });
    expect((await h.events()).at(-1)).toMatchObject({ type: "runtime.interrupted", payload: { signal: "SIGINT", phase: "agent_running" } });
    expect(await h.run()).toEqual({ kind: "blocked", code: "SUPERVISOR_BLOCKED" });
    expect(h.promptsTo(SUPERVISOR)[0]).toContain("# Причина цикла: recovered");
    expect(h.promptsTo(EXPLORER)[1]).toContain("Тебя прервали");
  });

  it("ошибка провайдера: технические ретраи, затем runtime_error → supervisor", async () => {
    const h = await Harness.create();
    await h.createTask();
    h.fake
      .script(EXPLORER, turn.error("overloaded"), turn.error("overloaded"), turn.error("overloaded"))
      .script(SUPERVISOR, sv("block_task", { reason: "провайдер", resolutionHint: "-" }));
    const start = h.clock.now().getTime();
    await h.run();
    expect(h.promptsTo(EXPLORER)).toHaveLength(3);
    expect(h.promptsTo(EXPLORER)[1]).toContain("ошибкой провайдера");
    expect(h.clock.now().getTime() - start).toBe(2 * 15_000);
    const s = await h.state();
    expect(s.currentRun).toMatchObject({ status: "failed", settleReason: "runtime_error" });
    expect((await h.events()).filter((e) => e.type === "agent.failed").map((e) => (e.payload as { retrying?: boolean }).retrying ?? false)).toEqual([true, true, false]);
  });
});

// ---------- Матрица fault-injection ----------

/** Отвечает на любой вопрос: первым вариантом или фиксированным текстом. */
class AutoHuman implements HumanIO {
  asked: string[] = [];
  async select<T>(title: string, choices: ReadonlyArray<{ value: T }>): Promise<T> {
    this.asked.push(title);
    const first = choices[0];
    if (!first) throw new Error("нет вариантов");
    return first.value;
  }
  async input() {
    return "ответ";
  }
  async multiline() {
    return "ответ";
  }
  async confirm() {
    return true;
  }
  print() {}
  close() {}
  async ask(q: QuestionView): Promise<HumanAnswer> {
    this.asked.push(q.question);
    return { answer: q.options?.[0] ?? "ответ", selectedOption: null };
  }
}

/** «Модель» supervisor-а: решает по причине цикла и событиям из prompt-а, как требует Policy. */
function supervisorResponder(c: FakeTurnContext): FakeStep[] {
  const stage = /# Текущий этап: .* \((\w+)\)/.exec(c.prompt)?.[1];
  const trigger = /# Причина цикла: (\w+)/.exec(c.prompt)?.[1];
  // Ответ на вопрос именно supervisor-а (не на ask_user агента) — по событиям из prompt-а
  const asked = new Set([...c.prompt.matchAll(/human\.requested \{"requestId":"([0-9A-Z]{26})","origin":"supervisor"/g)].map((m) => m[1]));
  const answered = [...c.prompt.matchAll(/^- \S+ ([0-9A-Z]{26}) human\.responded \{"requestId":"([0-9A-Z]{26})"/gm)]
    .filter((m) => asked.has(m[2]))
    .at(-1)?.[1];
  const reported = c.prompt.includes("Итог:");
  if (stage === "discover" && (trigger === "human_responded" || answered)) {
    const ref = trigger === "human_responded" ? "$lastHumanRef" : `human:${answered}`;
    return [sv("transition_stage", { to: "execute", reason: "план подтверждён", evidenceRefs: [ref] })];
  }
  if (stage === "discover" && trigger === "agent_settled" && reported) {
    return [sv("ask_human", { question: "Подтверждаете план?", options: ["Да", "Нет"] })];
  }
  if (stage === "execute" && (trigger === "agent_settled" || trigger === "recheck_settled") && reported) {
    return [sv("transition_stage", { to: "done", reason: "сделано", evidenceRefs: ["note:сделано"] })];
  }
  // recovered, reevaluate, отчёта нет: пусть агент продолжит и отчитается
  return [sv("continue_current_agent", { message: "Проверь состояние и отчитайся" })];
}

function setupReactive(h: Harness): void {
  h.fake.respond(SUPERVISOR, supervisorResponder);
  h.fake.respond(EXPLORER, (c) =>
    /kind=initial/.test(c.prompt) ? [turn.tool("ask_user", { question: "Какая БД?" }), report("план")] : [report("план")],
  );
  h.fake.respond("sessions/executor-001.jsonl", () => [report("сделано")]);
}

async function runMatrixCase(faults: FaultInjector): Promise<{ h: Harness; outcomes: ExitOutcome[] }> {
  const base = await Harness.create({ git: false });
  const h = await Harness.create({ policy: askUserOn(base.policyText), git: false });
  await h.createTask();
  setupReactive(h);
  const human = new AutoHuman() as unknown as HumanIO;
  const outcomes: ExitOutcome[] = [];
  try {
    outcomes.push(await h.run("T-1", { human, faults }));
  } catch (err) {
    if (!(err instanceof InjectedFault)) throw err;
  }
  for (let i = 0; i < 5 && outcomes.at(-1)?.kind !== "terminal"; i++) outcomes.push(await h.run("T-1", { human }));
  return { h, outcomes };
}

describe("матрица fault-injection", () => {
  it("эталонный прогон без сбоев проходит все точки", async () => {
    const counter = countingFaults();
    const { h, outcomes } = await runMatrixCase(counter);
    expect(outcomes).toEqual([{ kind: "terminal" }]);
    for (const p of FAULT_POINTS) expect(counter.counts.get(p) ?? 0, p).toBeGreaterThan(0);
    const events = await h.events();
    expect(count(events, "stage.transitioned")).toBe(2);
  });

  it("сбой в каждой точке и каждом её прохождении: ни двойного перехода, ни повторного вопроса, ни потери решения", async () => {
    const counter = countingFaults();
    await runMatrixCase(counter);
    const failures: string[] = [];
    let cases = 0;
    for (const point of FAULT_POINTS) {
      const total = counter.counts.get(point) ?? 0;
      for (let n = 1; n <= total; n++) {
        cases++;
        const label = `${point}#${n}`;
        const { h, outcomes } = await runMatrixCase(throwingAtOccurrence(point, n));
        const events = await h.events();
        const s = await h.state();
        const decisions = events.filter((e) => e.type === "supervisor.decision").map((e) => (e.payload as { decisionId: string }).decisionId);
        const applied = events.filter((e) => e.type === "decision.applied").map((e) => (e.payload as { decisionId: string }).decisionId);
        const requested = events.filter((e) => e.type === "human.requested");
        const ids = events.map((e) => e.id);
        const problems = [
          outcomes.at(-1)?.kind !== "terminal" ? `исход ${JSON.stringify(outcomes)}` : null,
          s.status !== "terminal" ? `status ${s.status}` : null,
          count(events, "stage.transitioned") !== 2 ? `переходов ${count(events, "stage.transitioned")}` : null,
          count(events, "task.terminal") !== 1 ? `task.terminal ${count(events, "task.terminal")}` : null,
          JSON.stringify(decisions) !== JSON.stringify(applied) ? `решения ${decisions.length}, применено ${applied.length}` : null,
          new Set(applied).size !== applied.length ? "решение применено дважды" : null,
          requested.filter((e) => (e.payload as { origin: string }).origin === "supervisor").length !== 1 ? "вопрос supervisor-а повторён" : null,
          requested.filter((e) => (e.payload as { origin: string }).origin === "agent").length !== 1 ? "вопрос агента повторён" : null,
          count(events, "agent.started") !== 2 ? `run-ов ${count(events, "agent.started")}` : null,
          new Set(ids).size !== ids.length || [...ids].sort().join() !== ids.join() ? "id событий не уникальны или не монотонны" : null,
        ].filter(Boolean);
        if (problems.length) failures.push(`${label}: ${problems.join("; ")}`);
      }
    }
    expect(cases).toBeGreaterThan(30);
    expect(failures).toEqual([]);
  }, 180_000);
});
