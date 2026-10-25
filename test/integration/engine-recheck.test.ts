// Отложенная перепроверка, 03-engine.md §12: сценарии 24–28 из 06-implementation.md §4.2.

import { describe, expect, it } from "vitest";
import { turn } from "../../src/agents/fake/fake-runtime.js";
import { InjectedFault } from "../../src/util/fault.js";
import type { WaitAction, WaitControl } from "../../src/workflow/wait-step.js";
import { Harness } from "../helpers/engine.js";
import { ScriptedHumanIO } from "../helpers/scripted-human-io.js";

const EV = "$expectedStateVersion";
const sv = (action: string, args: Record<string, unknown> = {}) => turn.tool(action, { expectedStateVersion: EV, ...args });
const EXPLORER = "sessions/explorer-001.jsonl";
const SUPERVISOR = "sessions/supervisor.jsonl";
const waitReport = (summary: string) =>
  turn.tool("report_result", { summary, externalWait: { waitingFor: "ответ ревьюера", checkAgainInMinutes: 30 } });
const recheck = (delayMinutes = 30, message = "Проверь тред") =>
  sv("schedule_recheck", { delayMinutes, waitingFor: "ответ ревьюера в треде", message });

async function harness(): Promise<Harness> {
  const base = await Harness.create();
  return Harness.create({
    policy: base.policyText.replace(
      "      agent: explorer\n",
      "      agent: explorer\n      recheck:\n        minMinutes: 5\n        maxMinutes: 60\n        maxCount: 2\n",
    ),
  });
}

/** Ожидание: заранее заданные действия человека, иначе тик с продвижением FakeClock. */
function scriptedWait(h: Harness, actions: Array<WaitAction | ((ms: number) => WaitAction)> = []): WaitControl & { ticks: number } {
  const ctl = {
    ticks: 0,
    async next(ms: number): Promise<WaitAction> {
      const a = actions.shift();
      if (a) return typeof a === "function" ? a(ms) : a;
      ctl.ticks++;
      h.clock.advance(ms);
      return { kind: "tick" };
    },
  };
  return ctl;
}

describe("отложенная перепроверка", () => {
  it("24. schedule_recheck → waiting → срок → recheck в ту же сессию → trigger recheck_settled", async () => {
    const h = await harness();
    await h.createTask();
    h.fake
      .script(EXPLORER, waitReport("запрос ревью отправлен"), turn.tool("report_result", { summary: "ревьюер ответил" }))
      .script(SUPERVISOR, recheck(30))
      .script(SUPERVISOR, sv("block_task", { reason: "стоп", resolutionHint: "-" }));
    const start = h.clock.now().getTime();
    const wait = scriptedWait(h);
    await h.run("T-1", { waitControl: wait });
    expect(h.clock.now().getTime() - start).toBe(30 * 60_000);
    expect(wait.ticks).toBe(120);
    const prompts = h.promptsTo(EXPLORER);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/kind=recheck/);
    expect(prompts[1]).toContain("Перепроверка №1 из 2 на этапе «Изучение задачи». Твой последний отчёт был 30 мин назад.");
    expect(prompts[1]).toContain("Ожидается: ответ ревьюера в треде");
    expect(prompts[1]).toContain("Сообщение supervisor:\nПроверь тред");
    const second = h.promptsTo(SUPERVISOR)[1] ?? "";
    expect(second).toContain("# Причина цикла: recheck_settled");
    expect(second).toContain("выполнил перепроверку после ожидания 30 мин (перепроверка №1)");
    expect(h.promptsTo(SUPERVISOR)[0]).toContain("Ожидание внешнего события: ответ ревьюера (агент предлагает проверить через 30 мин)");
    const s = await h.state();
    expect(s.stageCycles).toBe(1);
    expect(s.stageRechecks).toMatchObject({ count: 1, waitedMinutes: 30 });
    expect(s.currentRun?.sessionFile).toBe(EXPLORER);
    const types = await h.types();
    expect(types).toContain("wait.scheduled");
    expect((await h.events()).find((e) => e.type === "wait.finished")?.payload).toMatchObject({ reason: "due", waitedMinutes: 30 });
  });

  it("25. цепочка до maxCount → RECHECK_LIMIT_REACHED → ask_human; после перехода счётчик обнулён", async () => {
    const h = await harness();
    await h.createTask();
    let limitError = "";
    h.fake
      .script(EXPLORER, waitReport("ждём 1"), waitReport("ждём 2"), waitReport("ждём 3"))
      .script(SUPERVISOR, recheck(10))
      .script(SUPERVISOR, recheck(10))
      .script(SUPERVISOR, recheck(10), turn.effect((c) => void (limitError = c.lastToolResult?.content ?? "")), sv("ask_human", { question: "Ревьюер молчит. Что делать?" }))
      .script(SUPERVISOR, sv("transition_stage", { to: "execute", reason: "решили не ждать", evidenceRefs: ["$lastHumanRef"] }))
      .script("sessions/executor-001.jsonl", turn.tool("report_result", { summary: "ok" }))
      .script(SUPERVISOR, sv("block_task", { reason: "стоп", resolutionHint: "-" }));
    const human = new ScriptedHumanIO([{ multiline: "Не ждать" }, { confirm: true }]);
    await h.run("T-1", { human, waitControl: scriptedWait(h) });
    expect(limitError).toContain("RECHECK_LIMIT_REACHED: использованы все 2 перепроверок этапа. Выбери ask_human или block_task");
    const s = await h.state();
    expect(s.stage).toBe("execute");
    expect(s.stageRechecks).toEqual({ count: 0, waitedMinutes: 0, firstScheduledAt: null });
    // discover: agent_settled, 2 × recheck_settled, human_responded; execute: agent_settled
    const started = (await h.events()).filter((e) => e.type === "supervisor.started");
    expect(started.map((e) => (e.payload as { trigger: { kind: string } }).trigger.kind)).toEqual([
      "agent_settled",
      "recheck_settled",
      "recheck_settled",
      "human_responded",
      "agent_settled",
    ]);
  });

  it("неразрешённая перепроверка и задержка вне диапазона отклоняются", async () => {
    const h = await harness();
    await h.createTask();
    const errors: string[] = [];
    h.fake
      .script(EXPLORER, waitReport("ждём"))
      .script(SUPERVISOR, recheck(90), turn.effect((c) => void errors.push(c.lastToolResult?.content ?? "")), sv("transition_stage", { to: "execute", reason: "ok", evidenceRefs: ["note:x"] }))
      .script("sessions/executor-001.jsonl", turn.tool("report_result", { summary: "ok" }))
      .script(SUPERVISOR, recheck(10), turn.effect((c) => void errors.push(c.lastToolResult?.content ?? "")), sv("block_task", { reason: "стоп", resolutionHint: "-" }));
    await h.run();
    expect(errors[0]).toContain("RECHECK_DELAY_OUT_OF_RANGE: delayMinutes 90 вне диапазона 5..60");
    expect(errors[1]).toContain("RECHECK_NOT_ALLOWED");
  });

  it("26. q во время ожидания → exit 6, срок сохраняется; resume до срока ждёт, --no-wait выходит, после срока и --now — перепроверка", async () => {
    const h = await harness();
    await h.createTask();
    h.fake
      .script(EXPLORER, waitReport("ждём"), waitReport("ответил частично"), turn.tool("report_result", { summary: "готово" }))
      .script(SUPERVISOR, recheck(30))
      .script(SUPERVISOR, recheck(30))
      .script(SUPERVISOR, sv("block_task", { reason: "стоп", resolutionHint: "-" }));
    const reasons = async () => (await h.events()).filter((e) => e.type === "wait.finished").map((e) => (e.payload as { reason: string }).reason);

    // q: выход с exit 6, ожидание сохранено
    const quit = await h.run("T-1", { waitControl: scriptedWait(h, [{ kind: "quit" }]) });
    const waiting = await h.state();
    expect(quit).toEqual({ kind: "waiting_recheck", dueAt: waiting.wait?.dueAt });

    // --no-wait до срока: выход без изменения state
    h.clock.advance(10 * 60_000);
    expect(await h.run("T-1", { noWait: true })).toMatchObject({ kind: "waiting_recheck" });
    expect((await h.state()).wait).toEqual(waiting.wait);

    // resume до срока ждёт по тому же dueAt: тик, затем q
    const before = h.clock.now().getTime();
    expect(await h.run("T-1", { waitControl: scriptedWait(h, [(ms) => (h.clock.advance(ms), { kind: "tick" }), { kind: "quit" }]) })).toMatchObject({ kind: "waiting_recheck" });
    expect(h.clock.now().getTime() - before).toBe(15_000);
    expect((await h.state()).wait).toEqual(waiting.wait);
    expect(await reasons()).toEqual([]);

    // Срок прошёл, пока sdlc не работал: перепроверка сразу, без ожидания
    h.clock.advance(20 * 60_000);
    const t1 = h.clock.now().getTime();
    expect(await h.run("T-1", { noWait: true })).toMatchObject({ kind: "waiting_recheck" });
    expect(h.clock.now().getTime()).toBe(t1);
    expect(await reasons()).toEqual(["due"]);

    // --now: перепроверка второго ожидания без ожидания
    expect(await h.run("T-1", { checkNow: true })).toEqual({ kind: "blocked", code: "SUPERVISOR_BLOCKED" });
    expect(h.clock.now().getTime()).toBe(t1);
    expect(await reasons()).toEqual(["due", "skipped_by_human"]);
    expect(h.promptsTo(EXPLORER)).toHaveLength(3);
    expect((await h.state()).stageRechecks.count).toBe(2);
  });

  it("27. сообщение человека во время ожидания → human.responded без requestId, supervisor получил human_responded", async () => {
    const h = await harness();
    await h.createTask();
    h.fake
      .script(EXPLORER, waitReport("ждём"))
      .script(SUPERVISOR, recheck(30))
      .script(SUPERVISOR, sv("block_task", { reason: "ревьюер в отпуске", resolutionHint: "-" }));
    await h.run("T-1", { waitControl: scriptedWait(h, [{ kind: "message", text: "Ревьюер в отпуске до понедельника" }]) });
    const events = await h.events();
    const responded = events.find((e) => e.type === "human.responded");
    expect(responded?.payload).toMatchObject({ requestId: null, answer: "Ревьюер в отпуске до понедельника" });
    expect(events.find((e) => e.type === "wait.finished")?.payload).toMatchObject({ reason: "human_message", responseRef: `human:${responded?.id}` });
    const prompt = h.promptsTo(SUPERVISOR)[1] ?? "";
    expect(prompt).toContain("# Причина цикла: human_responded");
    expect(prompt).toContain(`Пользователь написал сообщение: Ревьюер в отпуске до понедельника  (ссылка human:${responded?.id})`);
    expect(h.promptsTo(EXPLORER)).toHaveLength(1);
  });

  it("28. падение процесса в фазе waiting → recovery ничего не меняет, срок сохранён", async () => {
    const h = await harness();
    await h.createTask();
    h.fake.script(EXPLORER, waitReport("ждём"), turn.tool("report_result", { summary: "ответил" })).script(SUPERVISOR, recheck(30));
    const crashing: WaitControl = {
      next: async () => {
        throw new InjectedFault("after-state-commit");
      },
    };
    await expect(h.run("T-1", { waitControl: crashing })).rejects.toBeInstanceOf(InjectedFault);
    const crashed = await h.state();
    expect(crashed.phase).toBe("waiting");
    h.fake.script(SUPERVISOR, sv("block_task", { reason: "стоп", resolutionHint: "-" }));
    const wait = scriptedWait(h);
    await h.run("T-1", { waitControl: wait });
    const types = await h.types();
    expect(types.filter((t) => t === "wait.scheduled")).toHaveLength(1);
    expect(types.filter((t) => t === "wait.finished")).toHaveLength(1);
    expect(wait.ticks).toBe(120);
  });

  it("Ctrl+C во время ожидания → interrupted, фаза waiting и срок сохранены", async () => {
    const h = await harness();
    await h.createTask();
    h.fake.script(EXPLORER, waitReport("ждём")).script(SUPERVISOR, recheck(30));
    let engine: { interrupt(s: "SIGINT"): void } | null = null;
    const ctl: WaitControl = {
      next: async () => {
        engine?.interrupt("SIGINT");
        throw new Error("aborted");
      },
    };
    expect(await h.run("T-1", { waitControl: ctl, onEngine: (e) => (engine = e) })).toEqual({ kind: "interrupted", signal: "SIGINT" });
    const s = await h.state();
    expect(s).toMatchObject({ phase: "waiting", status: "interrupted" });
    expect(s.wait).not.toBeNull();
    expect(await h.run("T-1", { noWait: true })).toMatchObject({ kind: "waiting_recheck" });
    expect((await h.state()).status).toBe("active");
  });
});
