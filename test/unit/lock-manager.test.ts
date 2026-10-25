import { existsSync } from "node:fs";
import { readdir, readFile, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LockConflictError, LockLostError } from "../../src/errors/errors.js";
import { LockManager, type ProjectLock } from "../../src/state/lock-manager.js";
import { systemClock } from "../../src/util/clock.js";
import { deadPid } from "../helpers/dead-pid.js";
import { tmpDir } from "../helpers/tmp.js";

const host = os.hostname();

async function setup(opts: { hostname?: string; pid?: number; heartbeatMs?: number } = {}) {
  const dir = await tmpDir();
  const file = path.join(dir, "project.lock.json");
  const make = (o: { hostname?: string; pid?: number; heartbeatMs?: number } = {}) =>
    new LockManager({
      file,
      clock: systemClock,
      hostname: o.hostname ?? opts.hostname ?? host,
      pid: o.pid ?? opts.pid ?? process.pid,
      processStartedAt: "2026-10-25T10:00:00.000Z",
      heartbeatMs: o.heartbeatMs ?? opts.heartbeatMs ?? 60_000,
    });
  return { dir, file, make };
}

function foreignLock(over: Partial<ProjectLock>): ProjectLock {
  return {
    pid: 1,
    hostname: host,
    processStartedAt: "2026-10-25T09:00:00.000Z",
    taskKey: "T-1",
    command: "resume",
    acquiredAt: "2026-10-25T09:00:00.000Z",
    heartbeatAt: "2026-10-25T09:00:00.000Z",
    nonce: "old",
    ...over,
  };
}

describe("LockManager", () => {
  it("захват создаёт файл, освобождение удаляет", async () => {
    const { file, make } = await setup();
    const lock = await make().acquire({ command: "new", taskKey: "T-1" });
    const content = JSON.parse(await readFile(file, "utf8")) as ProjectLock;
    expect(content).toMatchObject({ pid: process.pid, hostname: host, taskKey: "T-1", command: "new", nonce: lock.nonce });
    await lock.release();
    await lock.release();
    expect(await make().inspect()).toEqual({ kind: "none" });
  });

  it("второй захват при живом владельце — LockConflictError с данными владельца", async () => {
    const { make } = await setup();
    const held = await make().acquire({ command: "new", taskKey: "T-1" });
    const err = await make().acquire({ command: "cancel", taskKey: "T-2" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockConflictError);
    expect((err as LockConflictError).exitCode).toBe(3);
    expect((err as LockConflictError).holder).toMatchObject({ pid: process.pid, taskKey: "T-1", command: "new" });
    await held.release();
  });

  it("живой PID не снимается даже со старым heartbeat", async () => {
    const { file, make } = await setup();
    await writeFile(file, JSON.stringify(foreignLock({ pid: process.ppid, heartbeatAt: "2020-01-01T00:00:00.000Z" })));
    expect(await make().inspect()).toMatchObject({ kind: "held", alive: true, stale: false });
    await expect(make().acquire({ command: "new", taskKey: null })).rejects.toBeInstanceOf(LockConflictError);
  });

  it("мёртвый PID на этом хосте — lock протух и забирается", async () => {
    const { dir, file, make } = await setup();
    await writeFile(file, JSON.stringify(foreignLock({ pid: await deadPid() })));
    expect(await make().inspect()).toMatchObject({ kind: "held", alive: false, stale: true });
    const lock = await make().acquire({ command: "new", taskKey: null });
    expect((JSON.parse(await readFile(file, "utf8")) as ProjectLock).nonce).toBe(lock.nonce);
    expect(await readdir(dir)).toEqual(["project.lock.json"]);
    await lock.release();
  });

  it("lock другого хоста никогда не снимается автоматически", async () => {
    const { file, make } = await setup();
    await writeFile(file, JSON.stringify(foreignLock({ hostname: "other-host", pid: await deadPid() })));
    expect(await make().inspect()).toMatchObject({ kind: "held", alive: null, stale: false });
    await expect(make().acquire({ command: "new", taskKey: null })).rejects.toBeInstanceOf(LockConflictError);
  });

  it("неразбираемый lock: свежий — конфликт, старше 30 с — забирается", async () => {
    const { file, make } = await setup();
    await writeFile(file, "");
    expect(await make().inspect()).toMatchObject({ kind: "unreadable", stale: false });
    await expect(make().acquire({ command: "new", taskKey: null })).rejects.toBeInstanceOf(LockConflictError);
    const old = new Date(systemClock.now().getTime() - 60_000);
    await utimes(file, old, old);
    const lock = await make().acquire({ command: "new", taskKey: null });
    await lock.release();
  });

  it("гонка takeover-ов одного протухшего lock-а: выигрывает ровно один", async () => {
    const dead = await deadPid();
    for (let round = 0; round < 30; round++) {
      const { dir, file, make } = await setup();
      await writeFile(file, JSON.stringify(foreignLock({ pid: dead })));
      const results = await Promise.allSettled(
        ["a", "b", "c", "d", "e"].map((command) => make().acquire({ command, taskKey: null })),
      );
      const won = results.filter((r) => r.status === "fulfilled");
      expect(won).toHaveLength(1);
      for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(LockConflictError);
      const winner = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<LockManager["acquire"]>>>).value;
      expect((JSON.parse(await readFile(file, "utf8")) as ProjectLock).nonce).toBe(winner.nonce);
      await winner.release();
      expect(await readdir(dir)).toEqual([]);
    }
  });

  it("heartbeat по таймеру обновляет файл", async () => {
    const { file, make } = await setup({ heartbeatMs: 20 });
    const lock = await make().acquire({ command: "resume", taskKey: "T-1" });
    const first = (JSON.parse(await readFile(file, "utf8")) as ProjectLock).heartbeatAt;
    let current = first;
    for (let i = 0; i < 100 && current === first; i++) {
      await new Promise((r) => setTimeout(r, 20));
      current = (JSON.parse(await readFile(file, "utf8")) as ProjectLock).heartbeatAt;
    }
    expect(current > first).toBe(true);
    await lock.release();
    expect(existsSync(file)).toBe(false);
    expect(lock.signal.aborted).toBe(false);
  });

  it("чужой nonce в файле — lock потерян, чужой файл при освобождении не удаляется", async () => {
    const { file, make } = await setup();
    const lost: LockLostError[] = [];
    const lock = await make().acquire({ command: "resume", taskKey: "T-1", onLost: (e) => lost.push(e) });
    const first = (JSON.parse(await readFile(file, "utf8")) as ProjectLock).heartbeatAt;
    await new Promise((r) => setTimeout(r, 5));
    await lock.heartbeat();
    expect((JSON.parse(await readFile(file, "utf8")) as ProjectLock).heartbeatAt > first).toBe(true);

    await writeFile(file, JSON.stringify(foreignLock({ pid: process.pid, nonce: "intruder" })));
    await lock.heartbeat();
    expect(lost).toHaveLength(1);
    expect(lock.signal.aborted).toBe(true);
    expect(lock.signal.reason).toBeInstanceOf(LockLostError);
    expect((lock.signal.reason as LockLostError).exitCode).toBe(3);
    await lock.release();
    expect((JSON.parse(await readFile(file, "utf8")) as ProjectLock).nonce).toBe("intruder");
  });

  it("mutex takeover-а от умершего процесса снимается через 30 с", async () => {
    const { dir, file, make } = await setup();
    await writeFile(file, JSON.stringify(foreignLock({ pid: await deadPid() })));
    await writeFile(`${file}.takeover`, "{}");
    await expect(make().acquire({ command: "new", taskKey: null })).rejects.toBeInstanceOf(LockConflictError);
    const old = new Date(systemClock.now().getTime() - 60_000);
    await utimes(`${file}.takeover`, old, old);
    const lock = await make().acquire({ command: "new", taskKey: null });
    expect(await readdir(dir)).toEqual(["project.lock.json"]);
    await lock.release();
  });

  it("lock-файл удалён вручную — тоже потеря lock-а", async () => {
    const { file, make } = await setup();
    const lock = await make().acquire({ command: "resume", taskKey: null });
    const { unlink } = await import("node:fs/promises");
    await unlink(file);
    await lock.heartbeat();
    expect(lock.signal.aborted).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("setTask обновляет задачу в файле", async () => {
    const { file, make } = await setup();
    const lock = await make().acquire({ command: "interactive", taskKey: null });
    await lock.setTask("T-9");
    expect((JSON.parse(await readFile(file, "utf8")) as ProjectLock).taskKey).toBe("T-9");
    await lock.release();
  });
});
