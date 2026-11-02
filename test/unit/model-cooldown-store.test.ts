import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cooldownFilePath, FileCooldownStore } from "../../src/util/model-cooldown-store.js";
import { ModelCooldownTracker, type CooldownRecord } from "../../src/util/model-exhaustion.js";
import { tmpDir } from "../helpers/tmp.js";

const record = (over: Partial<CooldownRecord> = {}): CooldownRecord => ({
  provider: "openai-codex",
  modelId: null,
  exhaustedUntil: 2_000_000,
  attempt: 2,
  reason: "usage limit",
  recordedAt: 1_000_000,
  ...over,
});

describe("FileCooldownStore", () => {
  it("путь лежит в каталоге процессов, а не в .teo проекта", () => {
    expect(cooldownFilePath("/home/u")).toBe(path.join("/home/u", ".pi", "teo", "model-cooldowns.json"));
  });

  it("round-trip записи и чтения", async () => {
    const dir = await tmpDir();
    const store = new FileCooldownStore(path.join(dir, "teo", "model-cooldowns.json"));

    expect(store.load()).toEqual([]);

    const records = [record(), record({ provider: "antigravity", modelId: "gemini-3.8-flash-high", attempt: 1 })];
    store.save(records);
    expect(store.load()).toEqual(records);
  });

  it("битый и чужой файл трактуются как пустой cooldown, а не как ошибка", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "model-cooldowns.json");

    writeFileSync(file, "{ это не json");
    expect(new FileCooldownStore(file).load()).toEqual([]);

    writeFileSync(file, JSON.stringify({ schema: 99, records: [{ nonsense: true }] }));
    expect(new FileCooldownStore(file).load()).toEqual([]);
  });

  it("токены из текста ошибки не попадают в файл", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "model-cooldowns.json");
    const store = new FileCooldownStore(file);

    store.save([record({ reason: "401 from Bearer sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" })]);

    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("sk-ant-api03");
    expect(store.load()[0]?.reason).toContain("401 from Bearer");
  });

  it("недоступный каталог не ломает работу", () => {
    const store = new FileCooldownStore("/proc/teo-forbidden/model-cooldowns.json");
    expect(() => store.save([record()])).not.toThrow();
    expect(store.load()).toEqual([]);
  });

  it("трекер с хранилищем переживает перезапуск процесса", async () => {
    const dir = await tmpDir();
    mkdirSync(path.join(dir, "teo"), { recursive: true });
    const file = path.join(dir, "teo", "model-cooldowns.json");
    const t0 = 1_000_000;

    const first = new ModelCooldownTracker();
    first.bindPersistence(new FileCooldownStore(file));
    first.recordExhausted("openai-codex", "gpt-5.6-sol", 600_000, "usage limit", t0, { scope: "provider" });

    // Новый процесс: свой трекер, то же хранилище
    const second = new ModelCooldownTracker();
    second.bindPersistence(new FileCooldownStore(file));
    expect(second.isExhausted("openai-codex", "gpt-5.6-luna", t0 + 1)).toBe(true);

    // Ручной сброс виден и на диске
    expect(second.reset("openai-codex", undefined, t0)).toBe(1);
    const third = new ModelCooldownTracker();
    third.bindPersistence(new FileCooldownStore(file));
    expect(third.list(t0)).toEqual([]);
  });
});
