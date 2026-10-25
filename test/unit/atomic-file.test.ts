import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendLine, writeFileAtomic } from "../../src/state/atomic-file.js";
import { resolveInside } from "../../src/state/layout.js";
import { tmpDir } from "../helpers/tmp.js";

describe("atomic-file", () => {
  it("записывает и заменяет файл, не оставляя tmp", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "state.json");
    await writeFileAtomic(file, "1");
    await writeFileAtomic(file, "2");
    expect(await readFile(file, "utf8")).toBe("2");
    expect(await readdir(dir)).toEqual(["state.json"]);
  });

  it("при ошибке до rename целевой файл не меняется, tmp удаляется", async () => {
    const dir = await tmpDir();
    const target = path.join(dir, "target");
    await writeFile(path.join(dir, "keep"), "old");
    // rename файла поверх непустого каталога падает
    const { mkdir } = await import("node:fs/promises");
    await mkdir(target);
    await writeFile(path.join(target, "inner"), "x");
    await expect(writeFileAtomic(target, "new")).rejects.toThrow();
    expect((await readdir(dir)).sort()).toEqual(["keep", "target"]);
  });

  it("appendLine дописывает строки", async () => {
    const file = path.join(await tmpDir(), "events.jsonl");
    await appendLine(file, "a");
    await appendLine(file, "b");
    expect(await readFile(file, "utf8")).toBe("a\nb\n");
  });

  it("resolveInside не выпускает за пределы каталога", () => {
    expect(resolveInside("/p/.sdlc/tasks/T", "artifacts/plan.md")).toBe("/p/.sdlc/tasks/T/artifacts/plan.md");
    expect(resolveInside("/p/.sdlc/tasks/T", "")).toBe("/p/.sdlc/tasks/T");
    expect(resolveInside("/p/.sdlc/tasks/T", "../U/state.json")).toBeNull();
    expect(resolveInside("/p/.sdlc/tasks/T", "/etc/passwd")).toBeNull();
    expect(resolveInside("/p/.sdlc/tasks/T", "..foo")).toBe("/p/.sdlc/tasks/T/..foo");
  });
});
