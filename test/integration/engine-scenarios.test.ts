// Integration-сценарии 06-implementation.md §4.2 на FakeAgentRuntime: 1–11, 18–22.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { turn, type FakeTurnContext } from "../../src/agents/fake/fake-runtime.js";
import { LockConflictError } from "../../src/errors/errors.js";
import { Harness } from "../helpers/engine.js";
import { ScriptedHumanIO } from "../helpers/scripted-human-io.js";

const EV = "$expectedStateVersion";
const sv = (action: string, args: Record<string, unknown> = {}) => turn.tool(action, { expectedStateVersion: EV, ...args });
const block = (reason = "стоп теста") => sv("block_task", { reason, resolutionHint: "нет" });
const report = (summary = "готово", extra: Record<string, unknown> = {}) => turn.tool("report_result", { summary, ...extra });

const EXPLORER = "sessions/explorer-001.jsonl";
const SUPERVISOR = "sessions/supervisor.jsonl";

/** В фикстуре у агентов askUser: false — для сценариев с ask_user включаем. */
const askUserOn = (t: string) => t.replace("    title: Исследователь\n    model: default\n    askUser: false", "    title: Исследователь\n    model: default");

async function withPolicy(edit: (text: string) => string) {
  const base = await Harness.create();
  const h = await Harness.create({ policy: edit(base.policyText) });
  return h;
}

describe("агент", () => {
  it("1. создание задачи → начальный этап → агент запущен с initial prompt", async () => {
    const h = await Harness.create();
    await h.createTask("T-1", "Описание задачи для агента");
    h.fake.script(EXPLORER, report()).script(SUPERVISOR, block());
    expect(await h.run()).toEqual({ kind: "blocked", code: "SUPERVISOR_BLOCKED" });
    const [prompt] = h.promptsTo(EXPLORER);
    expect(prompt).toContain("# Задача T-1: Задача T-1\n\nОписание задачи для агента");
    expect(prompt).toContain("# Текущий этап: Изучение задачи (discover)");
    expect(prompt).toContain("# Твоя роль: Исследователь");
    expect(prompt).toContain("- → Выполнение: В artifacts/notes-plan.md описано");
    expect(prompt).toContain("[нужны доказательства]");
    const types = (await h.types()).filter((t) => t !== "task.resumed");
    expect(types.slice(0, 3)).toEqual(["task.created", "agent.started", "agent.prompted"]);
    const spec = h.fake.opened.find((s) => s.role === "agent");
    // askUser: false в Policy — ask_user не выдаётся
    expect(spec?.customTools.map((t) => t.name)).toEqual(["report_result", "report_blocker"]);
    expect(spec?.builtinTools).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    const sup = h.fake.opened.find((s) => s.role === "supervisor");
    expect(sup?.builtinTools).toEqual(["read", "grep", "find", "ls"]);
    expect(sup?.customTools.map((t) => t.name)).not.toContain("bash");
  });

  it("4. агент закончил без отчёта → unstructured_settle → supervisor получил хвост текста", async () => {
    const h = await Harness.create();
    await h.createTask();
    h.fake.script(EXPLORER, turn.text("Кажется, всё сделал"), turn.end()).script(SUPERVISOR, block());
    await h.run();
    const s = await h.state();
    expect(s.currentRun?.settleReason).toBe("unstructured_settle");
    expect(h.promptsTo(SUPERVISOR)[0]).toContain("Структурированного отчёта нет. Последний текст ассистента: Кажется, всё сделал");
    expect((await h.events()).find((e) => e.type === "agent.settled")?.payload).toMatchObject({ reason: "unstructured_settle" });
  });

  it("5. supervisor продолжил агента → та же сессия, новый promptId, прошлый отчёт в reportsHistory", async () => {
    const h = await Harness.create();
    await h.createTask();
    h.fake
      .script(EXPLORER, report("черновик"), report("готово"))
      .script(SUPERVISOR, sv("continue_current_agent", { message: "Добавь детали в план" }), block());
    await h.run();
    const prompts = h.promptsTo(EXPLORER);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/^\[sdlc:prompt id=\S+ kind=continue run=/);
    expect(prompts[1]).toContain("Сообщение supervisor:\nДобавь детали в план");
    const s = await h.state();
    expect(s.currentRun?.promptsSent).toHaveLength(2);
    expect(new Set(s.currentRun?.promptsSent).size).toBe(2);
    const record = await h.run_(s.currentRun?.runId ?? "");
    expect(record.reportsHistory.map((r) => r.data.summary)).toEqual(["черновик"]);
    expect(record.report?.data.summary).toBe("готово");
    expect((await h.types()).filter((t) => t === "agent.started")).toHaveLength(1);
    expect(await h.types()).toContain("agent.continued");
  });

  it("6. перезапуск → новая сессия -002, consecutiveRestarts = 1; сверх лимита restart отклоняется", async () => {
    const h = await withPolicy((t) => t.replace("  maxCyclesPerStage: 5", "  maxCyclesPerStage: 5\n  maxConsecutiveRestarts: 1"));
    await h.createTask();
    h.fake
      .script(EXPLORER, report("первая попытка"))
      .script("sessions/explorer-002.jsonl", report("вторая попытка"))
      .script(
        SUPERVISOR,
        sv("restart_current_agent", { reason: "ушёл не туда", message: "Начни с README" }),
        sv("restart_current_agent", { reason: "снова", message: "ещё раз" }),
        block("restart не дали"),
      );
    expect(await h.run()).toMatchObject({ kind: "blocked" });
    const s = await h.state();
    expect(s.currentRun).toMatchObject({ attempt: 2, sessionFile: "sessions/explorer-002.jsonl", sessionMode: "restart" });
    expect(s.consecutiveRestarts).toBe(1);
    const restartPrompt = h.promptsTo("explorer-002.jsonl")[0] ?? "";
    expect(restartPrompt).toMatch(/kind=restart/);
    expect(restartPrompt).toContain("# Почему это новый запуск");
    expect(restartPrompt).toContain("supervisor остановил: ушёл не туда");
    expect(restartPrompt).toContain("Указания supervisor: Начни с README");
    const rejected = (await h.events()).filter((e) => e.type === "supervisor.decision_rejected");
    expect(rejected.map((e) => e.payload)).toMatchObject([{ action: "restart_current_agent", code: "RESTART_LIMIT_REACHED" }]);
  });

  it("8. ask_user агента → ответ вернулся в tool, события с origin = agent", async () => {
    const h = await withPolicy(askUserOn);
    await h.createTask();
    let toolResult = "";
    h.fake
      .script(
        EXPLORER,
        turn.tool("ask_user", { question: "Какая БД?", options: ["PostgreSQL", "MySQL"] }),
        turn.effect((c: FakeTurnContext) => void (toolResult = c.lastToolResult?.content ?? "")),
        report(),
      )
      .script(SUPERVISOR, block());
    const human = new ScriptedHumanIO([{ select: "PostgreSQL" }]);
    await h.run("T-1", { human });
    const answer = JSON.parse(toolResult) as { answer: string; selectedOption: string; responseRef: string };
    expect(answer).toMatchObject({ answer: "PostgreSQL", selectedOption: "PostgreSQL" });
    const events = await h.events();
    const requested = events.find((e) => e.type === "human.requested");
    const responded = events.find((e) => e.type === "human.responded");
    expect(requested?.payload).toMatchObject({ origin: "agent", question: "Какая БД?", requestId: requested?.id });
    expect(responded?.payload).toMatchObject({ requestId: requested?.id, answer: "PostgreSQL" });
    expect(answer.responseRef).toBe(`human:${responded?.id}`);
    expect(human.printed).toContain("Вопрос от агента explorer · T-1 · Изучение задачи");
  });

  it("8a. без терминала ask_user возвращает агенту HUMAN_UNAVAILABLE, агент не зависает", async () => {
    const h = await withPolicy(askUserOn);
    await h.createTask();
    let toolResult = "";
    h.fake
      .script(EXPLORER, turn.tool("ask_user", { question: "?" }), turn.effect((c) => void (toolResult = c.lastToolResult?.content ?? "")), turn.tool("report_blocker", { summary: "нужен человек", details: "d", requiresHuman: true }))
      .script(SUPERVISOR, block());
    await h.run();
    expect(toolResult).toContain("HUMAN_UNAVAILABLE");
    expect((await h.state()).currentRun?.settleReason).toBe("reported_blocker");
  });

  it("guard: после отчёта прочие tools пачки блокируются; запись в state.json агенту запрещена", async () => {
    const h = await Harness.create();
    await h.createTask();
    const results: string[] = [];
    h.fake
      .script(
        EXPLORER,
        turn.tool("write", { path: ".sdlc/tasks/T-1/state.json", content: "{}" }),
        turn.effect((c) => void results.push(c.lastToolResult?.content ?? "")),
        turn.tool("write", { path: ".sdlc/tasks/T-1/artifacts/ok.md", content: "ok" }),
        turn.effect((c) => void results.push(c.lastToolResult?.content ?? "")),
        turn.tools(["report_result", { summary: "готово" }], ["write", { path: "x.txt", content: "после отчёта" }]),
      )
      .script(SUPERVISOR, block());
    await h.run();
    expect(results[0]).toContain("Запись в .sdlc/tasks/T-1/state.json запрещена");
    expect(results[1]).toBe("Записано .sdlc/tasks/T-1/artifacts/ok.md");
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(h.project, "x.txt"))).toBe(false);
    expect((await h.state()).currentRun?.settleReason).toBe("reported_result");
  });
});

describe("supervisor", () => {
  it("7. ask_human → human_pending → ответ → supervisor получил trigger human_responded", async () => {
    const h = await Harness.create();
    await h.createTask();
    h.fake
      .script(EXPLORER, report())
      .script(SUPERVISOR, sv("ask_human", { question: "Подтверждаете план?", options: ["Да", "Нет"] }), block());
    const human = new ScriptedHumanIO([{ select: "Да" }]);
    await h.run("T-1", { human });
    const events = await h.events();
    const requested = events.find((e) => e.type === "human.requested");
    const responded = events.find((e) => e.type === "human.responded");
    expect(requested?.payload).toMatchObject({ origin: "supervisor", question: "Подтверждаете план?" });
    const second = h.promptsTo(SUPERVISOR)[1] ?? "";
    expect(second).toContain("# Причина цикла: human_responded");
    expect(second).toContain(`Пользователь ответил на вопрос ${requested?.id}: «Подтверждаете план?»`);
    expect(second).toContain(`Ответ: Да  (ссылка human:${responded?.id})`);
  });

  it("9. supervisor дважды завершился без решения → blocked SUPERVISOR_NO_DECISION", async () => {
    const h = await Harness.create();
    await h.createTask();
    h.fake.script(EXPLORER, report()).script(SUPERVISOR, turn.end("Думаю"), turn.end("Всё ещё думаю"));
    expect(await h.run()).toEqual({ kind: "blocked", code: "SUPERVISOR_NO_DECISION" });
    const prompts = h.promptsTo(SUPERVISOR);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/kind=protocol_retry/);
    expect(prompts[1]).toContain("Ты завершил ход без вызова управляющего инструмента");
    const types = await h.types();
    expect(types.slice(-2)).toEqual(["supervisor.protocol_error", "task.blocked"]);
  });

  it("10. необъявленный переход → tool error → supervisor исправился в том же цикле", async () => {
    const h = await Harness.create();
    await h.createTask();
    let firstError = "";
    h.fake
      .script(EXPLORER, report())
      .script(
        SUPERVISOR,
        sv("transition_stage", { to: "done", reason: "сразу", evidenceRefs: ["note:x"] }),
        turn.effect((c) => void (firstError = c.lastToolResult?.content ?? "")),
        sv("transition_stage", { to: "execute", reason: "план", evidenceRefs: ["note:план устно"] }),
      )
      .script("sessions/executor-001.jsonl", report())
      .script(SUPERVISOR, block());
    await h.run();
    expect(firstError).toContain("TRANSITION_NOT_DECLARED: переход discover → done не объявлен. Допустимые: execute");
    expect((await h.state()).stage).toBe("execute");
    const events = await h.events();
    expect(events.filter((e) => e.type === "supervisor.decision_rejected")).toHaveLength(1);
    expect(events.filter((e) => e.type === "supervisor.started").map((e) => (e.payload as { cycle: number }).cycle)).toEqual([1, 2]);
  });

  it("11. guard humanResponse: без ссылки отклонено, со ссылкой на свежий ответ — принято", async () => {
    const h = await withPolicy((t) => t.replace("          guards:\n            evidence: required\n\n    execute:", "          guards:\n            evidence: required\n            humanResponse: required\n\n    execute:"));
    await h.createTask();
    const errors: string[] = [];
    h.fake
      .script(EXPLORER, report())
      .script(
        SUPERVISOR,
        sv("transition_stage", { to: "execute", reason: "план", evidenceRefs: ["note:план"] }),
        turn.effect((c) => void errors.push(c.lastToolResult?.content ?? "")),
        sv("transition_stage", { to: "execute", reason: "план", evidenceRefs: [] }),
        turn.effect((c) => void errors.push(c.lastToolResult?.content ?? "")),
        sv("ask_human", { question: "Утверждаете?" }),
      )
      .script(SUPERVISOR, sv("transition_stage", { to: "execute", reason: "утверждено", evidenceRefs: ["$lastHumanRef"] }))
      .script("sessions/executor-001.jsonl", report())
      .script(SUPERVISOR, block());
    const human = new ScriptedHumanIO([{ multiline: "Да, утверждаю" }, { confirm: true }]);
    await h.run("T-1", { human });
    expect(errors[0]).toContain("GUARD_HUMAN_RESPONSE_REQUIRED");
    expect(errors[1]).toContain("GUARD_EVIDENCE_REQUIRED");
    expect(errors[1]).toContain("GUARD_HUMAN_RESPONSE_REQUIRED");
    expect((await h.state()).stage).toBe("execute");
    const transition = (await h.events()).find((e) => e.type === "stage.transitioned");
    expect((transition?.payload as { evidenceRefs: string[] }).evidenceRefs[0]).toMatch(/^human:/);
  });

  it("20. maxCyclesPerStage блокирует задачу", async () => {
    const h = await withPolicy((t) => t.replace("maxCyclesPerStage: 5", "maxCyclesPerStage: 2"));
    await h.createTask();
    h.fake
      .script(EXPLORER, report("1"), report("2"), report("3"))
      .script(SUPERVISOR, sv("continue_current_agent", { message: "ещё" }), sv("continue_current_agent", { message: "ещё" }));
    expect(await h.run()).toEqual({ kind: "blocked", code: "STAGE_CYCLE_LIMIT" });
    expect((await h.state()).stageCycles).toBe(2);
    expect(h.promptsTo(SUPERVISOR)).toHaveLength(2);
  });

  it("21. без терминала ask_human → exit 5; запуск в терминале показывает тот же вопрос без нового human.requested", async () => {
    const h = await Harness.create();
    await h.createTask();
    h.fake.script(EXPLORER, report()).script(SUPERVISOR, sv("ask_human", { question: "Продолжать?", options: ["Да", "Нет"] }), block());
    expect(await h.run()).toEqual({ kind: "waiting_human" });
    expect(await h.run()).toEqual({ kind: "waiting_human" });
    expect((await h.state()).phase).toBe("human_pending");
    const human = new ScriptedHumanIO([{ select: "Нет" }]);
    await h.run("T-1", { human });
    expect(human.printed).toContain("Продолжать?");
    const types = await h.types();
    expect(types.filter((t) => t === "human.requested")).toHaveLength(1);
    expect(types.filter((t) => t === "human.responded")).toHaveLength(1);
  });

  it("cancel_task требует свежий ответ человека", async () => {
    const h = await Harness.create();
    await h.createTask();
    let error = "";
    h.fake
      .script(EXPLORER, report())
      .script(
        SUPERVISOR,
        sv("cancel_task", { reason: "не нужна", humanResponseRef: "human:01JB0000000000000000000000" }),
        turn.effect((c) => void (error = c.lastToolResult?.content ?? "")),
        sv("ask_human", { question: "Отменить?", options: ["Да", "Нет"] }),
      )
      .script(SUPERVISOR, sv("cancel_task", { reason: "пользователь согласен", humanResponseRef: "$lastHumanRef" }));
    expect(await h.run("T-1", { human: new ScriptedHumanIO([{ select: "Да" }]) })).toEqual({ kind: "cancelled" });
    expect(error).toContain("CANCEL_NOT_CONFIRMED_BY_HUMAN");
    expect((await h.state()).status).toBe("cancelled");
  });

  it("невалидные решения сверх лимита → blocked SUPERVISOR_INVALID_DECISIONS", async () => {
    const h = await Harness.create();
    await h.createTask();
    const bad = () => sv("transition_stage", { to: "nowhere", reason: "x" });
    h.fake.script(EXPLORER, report()).script(SUPERVISOR, bad(), bad(), bad(), bad());
    expect(await h.run()).toEqual({ kind: "blocked", code: "SUPERVISOR_INVALID_DECISIONS" });
  });

  it("устаревший expectedStateVersion отклоняется", async () => {
    const h = await Harness.create();
    await h.createTask();
    let error = "";
    h.fake
      .script(EXPLORER, report())
      .script(SUPERVISOR, turn.tool("block_task", { expectedStateVersion: 1, reason: "r", resolutionHint: "h" }), turn.effect((c) => void (error = c.lastToolResult?.content ?? "")), block());
    await h.run();
    expect(error).toMatch(/STALE_STATE_VERSION: expectedStateVersion 1 устарел: текущая версия \d+/);
  });
});

describe("несколько задач, lock, подмена state", () => {
  it("18. две задачи в одном проекте развиваются независимо", async () => {
    const h = await Harness.create();
    await h.createTask("T-1");
    await h.createTask("T-2");
    h.fake
      .script("T-1/sessions/explorer-001.jsonl", report("T-1 готово"))
      .script("T-1/sessions/supervisor.jsonl", block("T-1 стоп"))
      .script("T-2/sessions/explorer-001.jsonl", report("T-2 готово"))
      .script("T-2/sessions/supervisor.jsonl", sv("transition_stage", { to: "execute", reason: "ok", evidenceRefs: ["note:ok"] }))
      .script("T-2/sessions/executor-001.jsonl", report())
      .script("T-2/sessions/supervisor.jsonl", block("T-2 стоп"));
    await h.run("T-1");
    await h.run("T-2");
    expect((await h.state("T-1")).stage).toBe("discover");
    expect((await h.state("T-2")).stage).toBe("execute");
    expect(h.promptsTo("T-2/sessions/supervisor.jsonl")[0]).toContain("T-2 готово");
    expect(h.promptsTo("T-2/sessions/supervisor.jsonl")[0]).not.toContain("T-1 готово");
  });

  it("19. пока движок работает, второй процесс не может менять проект, а читать может", async () => {
    const h = await Harness.create();
    await h.createTask();
    let resolveRunning: () => void = () => undefined;
    const running = new Promise<void>((r) => (resolveRunning = r));
    let engineRef: { interrupt(s: "SIGINT"): void } | null = null;
    h.fake.script(EXPLORER, turn.effect(() => resolveRunning()), turn.hang());
    const runPromise = h.run("T-1", { onEngine: (e) => (engineRef = e) });
    await running;
    const other = h.newStore();
    await expect(other.withLock({ command: "cancel", taskKey: "T-1" }, async () => 1)).rejects.toBeInstanceOf(LockConflictError);
    expect((await other.tasks.read("T-1")).state.phase).toBe("agent_running");
    engineRef!.interrupt("SIGINT");
    expect(await runPromise).toEqual({ kind: "interrupted", signal: "SIGINT" });
  });

  it("22. подмена state.json агентом через bash → blocked STATE_TAMPERED", async () => {
    const h = await Harness.create();
    await h.createTask();
    let reportResult = "";
    h.fake.script(
      EXPLORER,
      turn.effect(async () => {
        const file = path.join(h.taskDir(), "state.json");
        const s = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
        await writeFile(file, JSON.stringify({ ...s, stage: "done" }, null, 2));
      }),
      report("сам себе перевёл этап"),
      turn.effect((c) => void (reportResult = c.lastToolResult?.content ?? "")),
      turn.end(),
    );
    expect(await h.run()).toEqual({ kind: "blocked", code: "STATE_TAMPERED" });
    const s = await h.state();
    expect(s).toMatchObject({ stage: "discover", status: "blocked", statusReason: { code: "STATE_TAMPERED" } });
    expect(reportResult).toContain("NO_ACTIVE_RUN");
  });
});
