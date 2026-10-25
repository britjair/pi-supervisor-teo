import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { indexMatches } from "../../src/state/index-store.js";
import { newTask, testStore } from "../helpers/store.js";

describe("index.json", () => {
  it("обновляется после каждой записи state", async () => {
    const { store, clock } = await testStore();
    await newTask(store, "T-1", "Первая");
    clock.advance(1000);
    await newTask(store, "T-2", "Вторая");
    const index = await store.index.read();
    expect(index?.tasks.map((t) => [t.key, t.stageTitle, t.stateVersion, t.phase])).toEqual([
      ["T-2", "Изучение задачи", 1, "agent_pending"],
      ["T-1", "Изучение задачи", 1, "agent_pending"],
    ]);
  });

  it("испорченный или устаревший index перестраивается из state-файлов под lock-ом", async () => {
    const { store } = await testStore();
    await newTask(store, "T-1");
    await newTask(store, "T-2");
    await writeFile(store.layout.index, "{ мусор");
    expect(await store.index.read()).toBeNull();
    expect(await store.withLock({ command: "doctor", taskKey: null }, async () => (await store.index.read())?.tasks.length)).toBe(2);

    await writeFile(store.layout.index, JSON.stringify({ schemaVersion: 1, generatedAt: "x", tasks: [] }));
    expect(indexMatches(await store.index.read(), [{ key: "T-1", version: 1 }])).toBe(false);
    expect(await store.syncIndex()).toBe(true);
    expect(await store.syncIndex()).toBe(false);
  });

  it("повреждённая задача видна в списке, но не попадает в index", async () => {
    const { store } = await testStore();
    await newTask(store, "T-1");
    await newTask(store, "T-2");
    await writeFile(store.tasks.task("T-2").state, "{");
    const list = await store.listTasks();
    expect(list.map((t) => [t.key, t.ok])).toEqual([
      ["T-1", true],
      ["T-2", false],
    ]);
    await store.syncIndex();
    expect(JSON.parse(await readFile(store.layout.index, "utf8")).tasks.map((t: { key: string }) => t.key)).toEqual(["T-1"]);
  });

  it("отсутствие этапа в Policy — stageTitle null", async () => {
    const { store } = await testStore();
    const s = await newTask(store, "T-1");
    await writeFile(store.tasks.task("T-1").state, JSON.stringify({ ...s, stage: "gone", version: 2 }));
    await store.syncIndex();
    expect((await store.index.read())?.tasks[0]?.stageTitle).toBeNull();
  });
});
