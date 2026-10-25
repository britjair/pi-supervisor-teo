import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { haltedState, type TaskState } from "../../src/domain/task-state.js";
import { StateVersionConflictError, TaskCorruptedError, TaskNotFoundError } from "../../src/errors/errors.js";
import { throwingAt, InjectedFault } from "../../src/util/fault.js";
import { newTask, testStore } from "../helpers/store.js";

const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8")) as TaskState;
const journalLines = async (file: string) =>
  (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; type: string });

const touch = (s: TaskState) => ({ ...s, stageCycles: s.stageCycles + 1 });

describe("создание задачи", () => {
  it("state, task.md, каталоги и событие task.created", async () => {
    const { store, clock } = await testStore();
    const state = await newTask(store, "T-1", "Первая");
    const t = store.tasks.task("T-1");
    expect(state).toMatchObject({
      key: "T-1",
      title: "Первая",
      version: 1,
      stage: "discover",
      phase: "agent_pending",
      status: "active",
      nextAgentInput: { kind: "initial", message: null, decisionId: null },
      createdAt: clock.now().toISOString(),
    });
    expect(state.outbox.map((e) => e.type)).toEqual(["task.created"]);
    expect(state.stageEntryEventId).toBe(state.outbox[0]?.id);
    expect(state.lastEventId).toBe(state.outbox[0]?.id);
    expect(await readJson(t.state)).toEqual(state);
    expect((await journalLines(t.events)).map((e) => e.id)).toEqual([state.lastEventId]);
    expect((await readdir(t.dir)).sort()).toEqual(["artifacts", "events.jsonl", "runs", "sessions", "state.json", "task.md"]);
    expect(await readFile(t.taskMd, "utf8")).toContain("# T-1: Первая\n\nCreated: 2026-10-25T10:00:00.000Z");
  });

  it("сбой создания не оставляет ни временного каталога, ни наполовину созданной задачи", async () => {
    const { store } = await testStore();
    await store.ensureSdlcDir();
    const { mkdir } = await import("node:fs/promises");
    // Каталог с тем же ключом появился в обход lock-а: rename не должен его заменить
    await mkdir(store.tasks.task("T-1").dir, { recursive: true });
    await expect(
      store.tasks.create(
        "T-1",
        (c) => ({ ...(baseState(c.emit("task.created", "human", { title: "t", stage: "discover", policyHash: "x", projectRoot: "/" }))) }),
        { taskMd: () => "" },
      ),
    ).rejects.toThrow(/уже существует/);
    expect(await readdir(store.layout.tasksDir)).toEqual(["T-1"]);
    expect(await readdir(store.tasks.task("T-1").dir)).toEqual([]);
  });
});

describe("commit", () => {
  it("версия +1, updatedAt, outbox и lastEventId", async () => {
    const { store, clock } = await testStore();
    const created = await newTask(store, "T-1");
    clock.advance(60_000);
    let emitted = "";
    const next = await store.tasks.commit("T-1", (s, c) => {
      emitted = c.emit("supervisor.note", "supervisor", { cycle: 1, text: "заметка" });
      return touch(s);
    });
    expect(next.version).toBe(2);
    expect(next.updatedAt).toBe(clock.now().toISOString());
    expect(next.stageCycles).toBe(1);
    expect(next.outbox).toHaveLength(1);
    expect(next.outbox[0]).toMatchObject({ id: emitted, stateVersion: 2, taskKey: "T-1", type: "supervisor.note" });
    expect(next.lastEventId).toBe(emitted);
    expect(emitted > created.lastEventId).toBe(true);
  });

  it("commit без событий сохраняет lastEventId", async () => {
    const { store } = await testStore();
    const created = await newTask(store, "T-1");
    const next = await store.tasks.commit("T-1", touch);
    expect(next.lastEventId).toBe(created.lastEventId);
    expect(next.outbox).toEqual([]);
  });

  it("expectedVersion не совпадает — конфликт без записи", async () => {
    const { store } = await testStore();
    await newTask(store, "T-1");
    await expect(store.tasks.commit("T-1", touch, { expectedVersion: 5 })).rejects.toBeInstanceOf(StateVersionConflictError);
    expect((await store.tasks.read("T-1")).state.version).toBe(1);
    await store.tasks.commit("T-1", touch, { expectedVersion: 1 });
    expect((await store.tasks.read("T-1")).state.version).toBe(2);
  });

  it("запись, нарушающая инварианты, отклоняется до записи на диск", async () => {
    const { store } = await testStore();
    await newTask(store, "T-1");
    await expect(store.tasks.commit("T-1", (s) => ({ ...s, status: "terminal" }))).rejects.toThrow(/инварианты/);
    expect((await store.tasks.read("T-1")).state).toMatchObject({ version: 1, status: "active" });
  });

  it("haltedState согласован с инвариантами", async () => {
    const { store } = await testStore();
    await newTask(store, "T-1");
    const s = await store.tasks.commit("T-1", (st, c) => haltedState(st, "cancelled", { code: "X", message: "m", at: c.now }));
    expect(s).toMatchObject({ status: "cancelled", phase: "halted", nextAgentInput: null });
  });
});

describe("outbox", () => {
  it("падение после записи state: события доставляются при следующей загрузке ровно один раз", async () => {
    const { root, clock } = await testStore();
    const a = (await testStore({ root, clock })).store;
    await newTask(a, "T-1");

    const crashing = (await testStore({ root, clock, faults: throwingAt("after-state-commit") })).store;
    await expect(
      crashing.tasks.commit("T-1", (s, c) => {
        c.emit("supervisor.note", "supervisor", { cycle: 1, text: "раз" });
        c.emit("supervisor.note", "supervisor", { cycle: 1, text: "два" });
        return touch(s);
      }),
    ).rejects.toBeInstanceOf(InjectedFault);

    const file = a.tasks.task("T-1").events;
    expect((await journalLines(file)).map((e) => e.type)).toEqual(["task.created"]);
    // Чтение без lock-а журнал не меняет, но показывает недоставленное
    const snap = await a.tasks.read("T-1");
    expect(snap.undelivered.map((e) => e.type)).toEqual(["supervisor.note", "supervisor.note"]);
    expect((await journalLines(file)).length).toBe(1);

    const b = (await testStore({ root, clock })).store;
    await b.tasks.load("T-1");
    await b.tasks.load("T-1");
    const c = (await testStore({ root, clock })).store;
    await c.tasks.load("T-1");
    const lines = await journalLines(file);
    expect(lines.map((e) => e.type)).toEqual(["task.created", "supervisor.note", "supervisor.note"]);
    expect(new Set(lines.map((e) => e.id)).size).toBe(3);
    expect((await b.tasks.read("T-1")).undelivered).toEqual([]);
  });

  it("падение посреди дописывания: недостающая часть outbox дописывается без дубликатов", async () => {
    const { store } = await testStore();
    await newTask(store, "T-1");
    const s = await store.tasks.commit("T-1", (st, c) => {
      c.emit("supervisor.note", "supervisor", { cycle: 1, text: "раз" });
      c.emit("supervisor.note", "supervisor", { cycle: 1, text: "два" });
      return st;
    });
    // Имитация: в журнал попало только первое событие outbox
    const file = store.tasks.task("T-1").events;
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    await writeFile(file, lines.slice(0, 2).join("\n") + "\n");
    expect((await store.tasks.read("T-1")).undelivered.map((e) => e.id)).toEqual([s.outbox[1]?.id]);
    await store.tasks.load("T-1");
    expect((await journalLines(file)).map((e) => e.id)).toEqual(lines.map((l) => (JSON.parse(l) as { id: string }).id));
  });

  it("следующий commit перезаписывает outbox, журнал содержит всё", async () => {
    const { store } = await testStore();
    await newTask(store, "T-1");
    await store.tasks.commit("T-1", (s, c) => (c.emit("supervisor.note", "supervisor", { cycle: 1, text: "1" }), s));
    const s = await store.tasks.commit("T-1", (st, c) => (c.emit("supervisor.note", "supervisor", { cycle: 2, text: "2" }), st));
    expect(s.outbox).toHaveLength(1);
    expect((await journalLines(store.tasks.task("T-1").events)).length).toBe(3);
  });
});

describe("загрузка", () => {
  it("нет задачи — TaskNotFoundError; каталог без state.json — TaskCorruptedError", async () => {
    const { store } = await testStore();
    await expect(store.tasks.read("NOPE")).rejects.toBeInstanceOf(TaskNotFoundError);
    await newTask(store, "T-1");
    await writeFile(store.tasks.task("T-1").state + ".bak", "");
    const { unlink } = await import("node:fs/promises");
    await unlink(store.tasks.task("T-1").state);
    await expect(store.tasks.read("T-1")).rejects.toBeInstanceOf(TaskCorruptedError);
  });

  it("невалидный JSON, нарушение схемы и инвариантов — TaskCorruptedError", async () => {
    const { store } = await testStore();
    const s = await newTask(store, "T-1");
    const file = store.tasks.task("T-1").state;
    for (const bad of [
      "{",
      JSON.stringify({ ...s, version: "1" }),
      JSON.stringify({ ...s, phase: "halted" }),
      JSON.stringify({ ...s, key: "T-2" }),
      JSON.stringify({ ...s, currentRun: { ...fakeRun(), sessionFile: "../../../x.jsonl" } }),
    ]) {
      await writeFile(file, bad);
      await expect(store.tasks.read("T-1")).rejects.toBeInstanceOf(TaskCorruptedError);
    }
  });

  it("подмена state.json после нашей записи — blocked/STATE_TAMPERED, копия рядом", async () => {
    const { store } = await testStore();
    const s = await newTask(store, "T-1");
    const file = store.tasks.task("T-1").state;
    const forged = { ...s, stage: "done", title: "подменено" };
    await writeFile(file, JSON.stringify(forged));

    const loaded = await store.tasks.load("T-1");
    expect(loaded).toMatchObject({ status: "blocked", phase: "halted", stage: "discover", title: s.title, version: 2 });
    expect(loaded.statusReason?.code).toBe("STATE_TAMPERED");
    expect(loaded.outbox.map((e) => e.type)).toEqual(["task.blocked"]);
    const copies = (await readdir(path.dirname(file))).filter((f) => f.startsWith("state.json.tampered-"));
    expect(copies).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(path.dirname(file), copies[0] ?? ""), "utf8"))).toMatchObject({ title: "подменено" });
    // Повторная загрузка — файл наш, подмены нет
    expect((await store.tasks.load("T-1")).version).toBe(2);
  });

  it("другой процесс (новый store) подмену не видит: hash помнит только записавший процесс", async () => {
    const { root, clock, store } = await testStore();
    const s = await newTask(store, "T-1");
    await writeFile(store.tasks.task("T-1").state, JSON.stringify({ ...s, title: "правка вручную" }, null, 2));
    const other = (await testStore({ root, clock })).store;
    expect((await other.tasks.load("T-1")).title).toBe("правка вручную");
  });

  it("оборванный хвост журнала переносится в .corrupt-файл, пишется runtime.recovered", async () => {
    const { store } = await testStore();
    await newTask(store, "T-1");
    const file = store.tasks.task("T-1").events;
    const before = await readFile(file, "utf8");
    await writeFile(file, before + '{"id":"01J');

    const s = await store.tasks.load("T-1");
    expect(s.version).toBe(2);
    expect(s.outbox[0]).toMatchObject({ type: "runtime.recovered", payload: { action: "truncated_event_tail" } });
    const lines = await journalLines(file);
    expect(lines.map((e) => e.type)).toEqual(["task.created", "runtime.recovered"]);
    const corrupt = (await readdir(path.dirname(file))).filter((f) => f.startsWith("events.jsonl.corrupt-"));
    expect(corrupt).toHaveLength(1);
    expect(await readFile(path.join(path.dirname(file), corrupt[0] ?? ""), "utf8")).toBe('{"id":"01J');
  });
});

function fakeRun() {
  return {
    runId: "01JB2X0000000000000000000",
    agentId: "explorer",
    attempt: 1,
    stage: "discover",
    sessionFile: "sessions/explorer-001.jsonl",
    sessionMode: "fresh",
    status: "pending",
    settleReason: null,
    promptsSent: [],
    startedAt: null,
    finishedAt: null,
  };
}

function baseState(createdId: string) {
  return {
    schemaVersion: 1 as const,
    key: "T-1",
    title: "t",
    projectRoot: "/",
    workspacePath: null,
    createdAt: "2026-10-25T10:00:00.000Z",
    policyHash: `sha256:${"0".repeat(64)}` as const,
    policySchema: "sdlc/v1" as const,
    stage: "discover",
    stageEnteredAt: "2026-10-25T10:00:00.000Z",
    stageEntryEventId: createdId,
    stageCycles: 0,
    stageRechecks: { count: 0, waitedMinutes: 0, firstScheduledAt: null },
    status: "active" as const,
    statusReason: null,
    phase: "agent_pending" as const,
    currentRun: null,
    agentRunCounters: {},
    consecutiveRestarts: 0,
    nextAgentInput: { kind: "initial" as const, message: null, decisionId: null },
    wait: null,
    supervisor: { sessionFile: "sessions/supervisor.jsonl", cycle: 0, trigger: null, lastPolicyHashShown: null },
    pendingDecision: null,
    lastAppliedDecisionId: null,
    lastDecision: null,
    pendingHumanRequest: null,
  };
}
