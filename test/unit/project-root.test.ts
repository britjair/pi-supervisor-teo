import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectProjectRoot } from "../../src/project/project-root.js";
import { execFileNoThrow, type Exec } from "../../src/util/exec.js";
import { runProcess, tmpDir } from "../helpers/tmp.js";

describe("detectProjectRoot", () => {
  it("внутри git-репозитория — его корень", async () => {
    const repo = await realpath(await tmpDir());
    await runProcess("git", ["init", "-q"], repo);
    const nested = path.join(repo, "a", "b");
    await mkdir(nested, { recursive: true });
    expect(await detectProjectRoot(nested, execFileNoThrow)).toEqual({ root: repo, source: "git" });
  });

  it("вне git — текущий каталог", async () => {
    const dir = await realpath(await tmpDir());
    expect(await detectProjectRoot(dir, execFileNoThrow)).toEqual({ root: dir, source: "cwd" });
  });

  it("git не установлен — текущий каталог", async () => {
    const dir = await realpath(await tmpDir());
    const noGit: Exec = () => Promise.reject(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }));
    expect(await detectProjectRoot(dir, noGit)).toEqual({ root: dir, source: "cwd" });
  });
});
