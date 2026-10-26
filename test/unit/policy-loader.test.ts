import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyError } from "../../src/errors/errors.js";
import { PolicyLoader, defaultPolicyPath, loadPolicyFile } from "../../src/policy/policy-loader.js";
import { hashPolicyBytes } from "../../src/policy/policy-hash.js";
import { readFileSync } from "node:fs";
import { validDir } from "../helpers/paths.js";
import { tmpDir } from "../helpers/tmp.js";

const VALID = readFileSync(path.join(validDir, "discover-execute-done.md"), "utf8");

async function codeOf(file: string): Promise<{ code: string; issues: string[]; lines: Array<number | null> }> {
  try {
    await loadPolicyFile(file);
  } catch (err) {
    if (err instanceof PolicyError) {
      expect(err.exitCode).toBe(2);
      return { code: err.code, issues: err.issues.map((i) => i.code), lines: err.issues.map((i) => i.line) };
    }
    throw err;
  }
  throw new Error("ожидалась PolicyError");
}

describe("preflight файла", () => {
  it("путь по умолчанию — ~/.pi/SDLC.md", () => {
    expect(defaultPolicyPath("/home/u")).toBe("/home/u/.pi/SDLC.md");
  });

  it("нет файла → POLICY_NOT_FOUND", async () => {
    const dir = await tmpDir();
    expect(await codeOf(path.join(dir, "SDLC.md"))).toMatchObject({ code: "POLICY_NOT_FOUND", issues: ["ENOENT"] });
    expect(await codeOf(path.join(dir, "missing-dir", "SDLC.md"))).toMatchObject({ code: "POLICY_NOT_FOUND" });
  });

  it("каталог вместо файла → POLICY_NOT_FILE", async () => {
    const dir = await tmpDir();
    await mkdir(path.join(dir, "SDLC.md"));
    expect(await codeOf(path.join(dir, "SDLC.md"))).toMatchObject({ code: "POLICY_NOT_FILE", issues: ["IS_DIRECTORY"] });
  });

  it("симлинк на файл допустим", async () => {
    const dir = await tmpDir();
    await writeFile(path.join(dir, "real.md"), VALID);
    await symlink(path.join(dir, "real.md"), path.join(dir, "SDLC.md"));
    const p = await loadPolicyFile(path.join(dir, "SDLC.md"));
    expect(p.spec.workflow.initialStage).toBe("discover");
  });

  it("битый симлинк → POLICY_NOT_FOUND", async () => {
    const dir = await tmpDir();
    await symlink(path.join(dir, "nowhere.md"), path.join(dir, "SDLC.md"));
    expect(await codeOf(path.join(dir, "SDLC.md"))).toMatchObject({ code: "POLICY_NOT_FOUND" });
  });

  it.skipIf(process.getuid?.() === 0)("нет прав на чтение → POLICY_UNREADABLE", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "SDLC.md");
    await writeFile(file, VALID);
    await chmod(file, 0o000);
    expect(await codeOf(file)).toMatchObject({ code: "POLICY_UNREADABLE", issues: ["EACCES"] });
  });

  it("пустой и пробельный файл → POLICY_EMPTY", async () => {
    const dir = await tmpDir();
    for (const content of ["", " \n\t\n", "\uFEFF\n"]) {
      await writeFile(path.join(dir, "SDLC.md"), content);
      expect(await codeOf(path.join(dir, "SDLC.md"))).toMatchObject({ code: "POLICY_EMPTY" });
    }
  });

  it("не UTF-8 → POLICY_ENCODING с номером строки", async () => {
    const dir = await tmpDir();
    const bytes = Buffer.concat([Buffer.from("---\nschema: teo/v1\ntitle: "), Buffer.from([0xcf, 0xeb, 0xe0, 0xed]), Buffer.from("\n---\n")]);
    await writeFile(path.join(dir, "SDLC.md"), bytes);
    expect(await codeOf(path.join(dir, "SDLC.md"))).toEqual({ code: "POLICY_ENCODING", issues: ["INVALID_UTF8"], lines: [3] });
  });
});

describe("загрузка", () => {
  it("BOM и CRLF не мешают; номера строк сохраняются", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "SDLC.md");
    const crlf = "\uFEFF" + VALID.replaceAll("\n", "\r\n");
    await writeFile(file, crlf);
    const p = await loadPolicyFile(file);
    expect(p.raw).toBe(crlf);
    expect(p.hash).toBe(hashPolicyBytes(Buffer.from(crlf, "utf8")));
    expect(Object.keys(p.spec.workflow.stages)).toEqual(["discover", "execute", "done"]);

    await writeFile(file, crlf.replace("agent: executor", "agent: executr"));
    expect(await codeOf(file)).toMatchObject({ issues: ["STAGE_AGENT_MISSING"], lines: [VALID.split("\n").findIndex((l) => l.includes("agent: executor")) + 1] });
  });

  it("body — Markdown после front matter", async () => {
    const dir = await tmpDir();
    await writeFile(path.join(dir, "SDLC.md"), VALID);
    const p = await loadPolicyFile(path.join(dir, "SDLC.md"));
    expect(p.body.trim()).toBe("# Правила\n\nОтчёт агента — не доказательство. Коммит подтверждается только инструментами git.");
    expect(p.schema).toBe("teo/v1");
    expect(p.path).toBe(path.join(dir, "SDLC.md"));
  });

  it("PolicyLoader перечитывает файл при каждом вызове", async () => {
    const dir = await tmpDir();
    const file = path.join(dir, "SDLC.md");
    await writeFile(file, VALID);
    const loader = new PolicyLoader(file);
    const first = await loader.loadAndValidate();
    await writeFile(file, VALID + "\nДобавлено правило.\n");
    const second = await loader.loadAndValidate();
    expect(second.hash).not.toBe(first.hash);
    expect(second.body).toContain("Добавлено правило.");
  });

  it("YAML-бомба из алиасов отклоняется", async () => {
    const dir = await tmpDir();
    const lines = ["---", "schema: teo/v1", "a0: &a0 [x, x, x, x, x, x, x, x, x, x]"];
    for (let i = 1; i < 12; i++) {
      lines.push(`a${i}: &a${i} [${Array.from({ length: 10 }, () => `*a${i - 1}`).join(", ")}]`);
    }
    lines.push("---");
    await writeFile(path.join(dir, "SDLC.md"), lines.join("\n"));
    await expect(loadPolicyFile(path.join(dir, "SDLC.md"))).rejects.toThrow();
  });
});
