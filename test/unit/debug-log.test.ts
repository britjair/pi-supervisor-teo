import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEBUG_LOG_MAX_BYTES, DebugLog } from "../../src/util/debug-log.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { tmpDir } from "../helpers/tmp.js";

describe("DebugLog", () => {
  it("не создаёт .sdlc: строки ждут каталога, потом пишутся без секретов", async () => {
    const root = await tmpDir();
    const file = path.join(root, ".sdlc", "debug.log");
    const clock = new FakeClock();
    const log = new DebugLog(() => clock.now());
    log.attach(file);
    log.write("до каталога, токен ghp" + "_" + "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xYz123");
    expect(existsSync(path.dirname(file))).toBe(false);
    expect(log.path).toBeNull();

    await mkdir(path.dirname(file));
    log.write("после");
    const text = await readFile(file, "utf8");
    expect(text).toContain("2026-10-25T10:00:00.000Z");
    expect(text).toContain("до каталога, токен [REDACTED]");
    expect(text).toContain("после");
    expect(log.path).toBe(file);
  });

  it("лог прошлого процесса остаётся одной копией .1", async () => {
    const root = await tmpDir();
    const file = path.join(root, "debug.log");
    await writeFile(file, "прошлый процесс\n");
    await writeFile(`${file}.1`, "позапрошлый\n");
    const log = new DebugLog(() => new Date());
    log.attach(file);
    log.write("новый");
    expect(await readFile(`${file}.1`, "utf8")).toBe("прошлый процесс\n");
    expect(await readFile(file, "utf8")).toMatch(/новый\n$/);
    expect(await readFile(file, "utf8")).not.toContain("прошлый");
  });

  it("внутри процесса ротация по размеру 5 MB", async () => {
    const root = await tmpDir();
    const file = path.join(root, "debug.log");
    const log = new DebugLog(() => new Date());
    log.attach(file);
    log.write("первая");
    await writeFile(file, "x".repeat(DEBUG_LOG_MAX_BYTES + 1));
    log.write("после ротации");
    expect((await readFile(`${file}.1`, "utf8")).length).toBe(DEBUG_LOG_MAX_BYTES + 1);
    expect(await readFile(file, "utf8")).toContain("после ротации");
  });
});
