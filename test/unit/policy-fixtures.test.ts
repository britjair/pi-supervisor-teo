import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GRAPH_ERROR_CODES } from "../../src/domain/policy.js";
import { PolicyError } from "../../src/errors/errors.js";
import { loadPolicyFile } from "../../src/policy/policy-loader.js";
import { policyIssueText } from "../../src/ui/messages.js";
import { readMarkers, sortExpectations } from "../helpers/markers.js";
import { examplePolicy, invalidDir, validDir } from "../helpers/paths.js";

const invalidFiles = readdirSync(invalidDir).filter((f) => f.endsWith(".md")).sort();
const validFiles = readdirSync(validDir).filter((f) => f.endsWith(".md")).sort();

/** INITIAL_STAGE_MISSING.md → POLICY_GRAPH; POLICY_YAML--duplicate-key.md → POLICY_YAML */
function expectedStep(file: string): string {
  const name = path.basename(file, ".md").split("--")[0] ?? "";
  return name.startsWith("POLICY_") ? name : "POLICY_GRAPH";
}

async function loadError(file: string): Promise<PolicyError> {
  const err = await loadPolicyFile(file).then(
    () => null,
    (e: unknown) => e,
  );
  if (!(err instanceof PolicyError)) throw new Error(`${file}: ожидалась PolicyError, получено ${String(err)}`);
  return err;
}

describe("invalid fixtures", () => {
  it.each(GRAPH_ERROR_CODES)("для кода %s есть фикстура invalid/<code>.md", (code) => {
    expect(invalidFiles).toContain(`${code}.md`);
  });

  it.each(invalidFiles)("%s", async (name) => {
    const file = path.join(invalidDir, name);
    const err = await loadError(file);
    expect(err.code).toBe(expectedStep(name));
    expect(err.exitCode).toBe(2);
    expect(err.file).toBe(file);

    const expected = readMarkers(readFileSync(file, "utf8"), "expect");
    if (expected.length > 0) {
      const actual = err.issues.map((i) => ({ code: i.code, line: i.line }));
      expect(sortExpectations(actual)).toEqual(sortExpectations(expected));
    }
    for (const issue of err.issues) {
      expect(policyIssueText(issue), `нет текста для ${issue.code}`).not.toBe(issue.code);
    }
  });

  it("графовая фикстура с кодом в имени сообщает ровно эту ошибку", async () => {
    for (const code of GRAPH_ERROR_CODES) {
      const err = await loadError(path.join(invalidDir, `${code}.md`));
      expect(err.issues.map((i) => i.code)).toEqual([code]);
    }
  });
});

describe("valid fixtures", () => {
  it.each([...validFiles.map((f) => path.join(validDir, f)), examplePolicy])("%s загружается", async (file) => {
    const policy = await loadPolicyFile(file);
    const expectedWarnings = readMarkers(readFileSync(file, "utf8"), "warn");
    expect(sortExpectations(policy.warnings.map((w) => ({ code: w.code, line: w.line })))).toEqual(
      sortExpectations(expectedWarnings),
    );
    for (const w of policy.warnings) expect(policyIssueText(w)).not.toBe(w.code);
  });
});
