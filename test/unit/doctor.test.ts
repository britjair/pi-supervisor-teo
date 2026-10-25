import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AppContext } from "../../src/app.js";
import { compareVersions, runDoctor } from "../../src/commands/doctor.js";
import { PolicyLoader } from "../../src/policy/policy-loader.js";
import { createStyle } from "../../src/ui/plain/style.js";
import { systemClock } from "../../src/util/clock.js";
import { execFileNoThrow } from "../../src/util/exec.js";
import { examplePolicy } from "../helpers/paths.js";
import { sandbox } from "../helpers/tmp.js";

async function doctorWith(nodeVersion: string, color = false) {
  const sb = await sandbox(readFileSync(examplePolicy));
  let out = "";
  const ctx: AppContext = {
    cwd: sb.project,
    homeDir: sb.home,
    env: {},
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: () => true },
    interactive: false,
    verbose: false,
    style: createStyle(color),
    clock: systemClock,
    exec: execFileNoThrow,
    nodeVersion,
    policyLoader: new PolicyLoader(sb.policyPath),
  };
  const code = await runDoctor(ctx, { fix: false });
  return { code, out };
}

describe("doctor", () => {
  it("compareVersions", () => {
    expect(compareVersions("22.19.0", "22.19.0")).toBe(0);
    expect(compareVersions("22.9.1", "22.19.0")).toBe(-1);
    expect(compareVersions("26.12.1", "22.19.0")).toBe(1);
    expect(compareVersions("22.19", "22.19.0")).toBe(0);
  });

  it("старый Node.js — ошибка окружения, exit 1", async () => {
    const { code, out } = await doctorWith("22.18.0");
    expect(code).toBe(1);
    expect(out).toContain("✗ Node.js 22.18.0 (нужно ≥ 22.19.0)");
    expect(out).toContain("Итог: 1 ошибка, 0 предупреждений.");
  });

  it("цветной вывод только при включённом стиле", async () => {
    expect((await doctorWith("26.0.0", true)).out).toContain("\u001b[32m✓\u001b[39m");
    expect((await doctorWith("26.0.0", false)).out).not.toContain("\u001b[");
  });
});
