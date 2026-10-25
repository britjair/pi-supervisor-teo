import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../src/domain/events.js";
import { TaskCorruptedError } from "../../src/errors/errors.js";
import { EventJournal } from "../../src/state/event-store.js";
import { tmpDir } from "../helpers/tmp.js";

const ev = (i: number, text = "x"): TaskEvent => ({
  id: `01JB${String(i).padStart(22, "0")}`,
  timestamp: "2026-10-25T10:00:00.000Z",
  taskKey: "T-1",
  type: "supervisor.note",
  stateVersion: i,
  actor: "supervisor",
  payload: { cycle: i, text },
});

async function journal(events: TaskEvent[], tail = "") {
  const file = path.join(await tmpDir(), "events.jsonl");
  await writeFile(file, events.map((e) => JSON.stringify(e) + "\n").join("") + tail);
  return new EventJournal(file, "T-1");
}

describe("EventJournal", () => {
  it("нет файла — пустой журнал", async () => {
    const j = new EventJournal(path.join(await tmpDir(), "events.jsonl"), "T-1");
    expect(await j.readAll()).toEqual({ events: [], broken: null });
    expect(await j.readTail(10)).toEqual({ events: [], broken: null });
  });

  it("append и readAll", async () => {
    const j = await journal([]);
    await j.append([ev(1), ev(2)]);
    expect((await j.readAll()).events.map((e) => e.stateVersion)).toEqual([1, 2]);
  });

  it("последняя строка без перевода строки — оборванный хвост", async () => {
    const j = await journal([ev(1), ev(2)], '{"id":"01JB');
    for (const r of [await j.readAll(), await j.readTail(10)]) {
      expect(r.events).toHaveLength(2);
      expect(r.broken?.bytes.toString()).toBe('{"id":"01JB');
    }
  });

  it("последняя целая строка с невалидным JSON — тоже хвост", async () => {
    const j = await journal([ev(1)], "мусор\n");
    expect((await j.readAll()).broken?.bytes.toString()).toBe("мусор\n");
    expect((await j.readTail(5)).broken?.bytes.toString()).toBe("мусор\n");
  });

  it("невалидная строка в середине — TaskCorruptedError с номером строки", async () => {
    const file = path.join(await tmpDir(), "events.jsonl");
    await writeFile(file, [JSON.stringify(ev(1)), "{битая", JSON.stringify(ev(3))].join("\n") + "\n");
    const err = await new EventJournal(file, "T-1").readAll().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskCorruptedError);
    expect((err as TaskCorruptedError).line).toBe(2);
    await expect(new EventJournal(file, "T-1").readTail(10)).rejects.toBeInstanceOf(TaskCorruptedError);
  });

  it("корректный JSON неверной формы считается невалидной записью", async () => {
    const file = path.join(await tmpDir(), "events.jsonl");
    await writeFile(file, [JSON.stringify({ hello: 1 }), JSON.stringify(ev(2))].join("\n") + "\n");
    await expect(new EventJournal(file, "T-1").readAll()).rejects.toBeInstanceOf(TaskCorruptedError);
  });

  it("cutBrokenTail переносит хвост и обрезает файл до целой строки", async () => {
    const j = await journal([ev(1)], "обрыв");
    const tail = await j.readAll();
    const moved = await j.cutBrokenTail(tail.broken!, "stamp");
    expect(moved).toBe(`${j.file}.corrupt-stamp`);
    expect(await readFile(moved, "utf8")).toBe("обрыв");
    expect(await readFile(j.file, "utf8")).toBe(JSON.stringify(ev(1)) + "\n");
    expect((await j.readAll()).broken).toBeNull();
  });

  it("readTail читает с конца большой журнал блоками и не грузит лишнее", async () => {
    // ~3000 событий по ~300 байт: больше нескольких блоков по 64 KB
    const events = Array.from({ length: 3000 }, (_, i) => ev(i + 1, "я".repeat(80)));
    const j = await journal(events);
    const tail = await j.readTail(64);
    expect(tail.events.map((e) => e.stateVersion)).toEqual(events.slice(-64).map((e) => e.stateVersion));
    expect(tail.broken).toBeNull();
    expect((await j.readTail(1)).events.map((e) => e.stateVersion)).toEqual([3000]);
    expect((await j.readTail(5000)).events).toHaveLength(3000);
  });

  it("многобайтовые символы на границе блока не ломают разбор", async () => {
    for (const n of [1, 7, 200, 219, 220, 221]) {
      const events = Array.from({ length: n }, (_, i) => ev(i + 1, "ж".repeat(150 + (i % 13))));
      const j = await journal(events);
      expect((await j.readTail(n)).events).toHaveLength(n);
    }
  });
});
