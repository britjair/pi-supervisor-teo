import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAgent, getStage } from "../../src/domain/policy.js";
import { PolicyError } from "../../src/errors/errors.js";
import { parsePolicyBytes } from "../../src/policy/policy-loader.js";
import { RUNTIME_DEFAULTS } from "../../src/policy/normalize.js";
import { validDir } from "../helpers/paths.js";

const enc = (s: string) => new TextEncoder().encode(s);
const parse = (s: string) => parsePolicyBytes(enc(s), "/virtual/SDLC.md");

function parseError(s: string): PolicyError {
  try {
    parse(s);
  } catch (err) {
    if (err instanceof PolicyError) return err;
    throw err;
  }
  throw new Error("ожидалась PolicyError");
}

const MINIMAL = `---
schema: teo/v1
workflow:
  initialStage: a
  stages:
    a:
      title: A
      agent: worker
      transitions:
        - to: b
          when: готово
    b:
      title: B
      terminal: true
agents:
  worker:
    instructions: работай
supervisor:
  instructions: проверяй
---
Правила.
`;

describe("defaults", () => {
  const policy = parse(MINIMAL);

  it("этап", () => {
    expect(getStage(policy.spec, "a")).toEqual({
      kind: "work",
      id: "a",
      title: "A",
      description: null,
      agent: "worker",
      instructions: null,
      session: "fresh",
      userSession: "same",
      transitions: [{ to: "b", when: "готово", guards: { evidence: "optional", humanResponse: "optional" } }],
      recheck: null,
    });
    expect(getStage(policy.spec, "b")).toEqual({ kind: "terminal", id: "b", title: "B", description: null });
  });

  it("агент: title = id, модель default, askUser, ресурсы inherit", () => {
    expect(getAgent(policy.spec, "worker")).toEqual({
      id: "worker",
      title: "worker",
      model: "default",
      thinking: null,
      instructions: "работай",
      tools: null,
      excludeTools: [],
      askUser: true,
      piResources: { contextFiles: "inherit", extensions: "inherit", skills: "inherit" },
      timeoutMinutes: null,
    });
  });

  it("supervisor: AGENTS.md и skills выключены, расширения подгружаются", () => {
    expect(policy.spec.supervisor).toEqual({
      model: "default",
      thinking: null,
      instructions: "проверяй",
      piResources: { contextFiles: "none", extensions: "inherit", skills: "none" },
    });
  });

  it("runtime целиком по умолчанию", () => {
    expect(policy.spec.runtime).toEqual(RUNTIME_DEFAULTS);
    expect(RUNTIME_DEFAULTS).toEqual({
      policyChangeMode: "confirm",
      maxConsecutiveRestarts: 3,
      supervisorProtocolRetries: 1,
      maxInvalidDecisionsPerCycle: 3,
      maxCyclesPerStage: null,
      supervisorTimeoutMinutes: 30,
      technicalRetries: 2,
      technicalRetryDelaySeconds: 15,
    });
  });

  it("recheck: {} включает перепроверку с default", () => {
    const p = parse(MINIMAL.replace("      agent: worker\n", "      agent: worker\n      recheck: {}\n"));
    expect(getStage(p.spec, "a")).toMatchObject({ recheck: { minMinutes: 1, maxMinutes: 120, maxCount: 20 } });
  });

  it("частично заданный recheck дополняется default", () => {
    const p = parse(MINIMAL.replace("      agent: worker\n", "      agent: worker\n      recheck:\n        maxMinutes: 15\n"));
    expect(getStage(p.spec, "a")).toMatchObject({ recheck: { minMinutes: 1, maxMinutes: 15, maxCount: 20 } });
  });

  it("словари без прототипа: id вроде constructor не путаются с Object.prototype", () => {
    expect(getStage(policy.spec, "constructor")).toBeUndefined();
    expect(policy.spec.workflow.stages["toString"]).toBeUndefined();
    const p = parse(MINIMAL.replaceAll("worker", "constructor"));
    expect(getAgent(p.spec, "constructor")?.instructions).toBe("работай");
  });
});

describe("x-* ключи", () => {
  it("игнорируются на любом уровне", () => {
    const p = parse(
      MINIMAL.replace("schema: teo/v1\n", "schema: teo/v1\nx-team: core\n")
        .replace("    a:\n", "    x-future:\n      anything: 1\n    a:\n")
        .replace("          when: готово\n", "          when: готово\n          x-note: [1, 2]\n"),
    );
    expect(Object.keys(p.spec.workflow.stages)).toEqual(["a", "b"]);
  });

  it("all-options.md: все поля схемы", () => {
    const file = path.join(validDir, "all-options.md");
    const p = parsePolicyBytes(readFileSync(file), file);
    expect(Object.keys(p.spec.workflow.stages)).toEqual(["triage", "awaiting_reply", "closed"]);
    expect(getAgent(p.spec, "triager")).toMatchObject({
      model: "anthropic/claude-opus-5-5:high",
      thinking: null,
      tools: ["read", "bash", "grep"],
      excludeTools: ["bash"],
      askUser: false,
      piResources: { contextFiles: "none", extensions: "inherit", skills: "none" },
      timeoutMinutes: 45.5,
    });
    expect(p.spec.supervisor).toMatchObject({
      thinking: "xhigh",
      piResources: { contextFiles: "inherit", extensions: "inherit", skills: "none" },
    });
    expect(getStage(p.spec, "closed")).toMatchObject({ description: "Первичный разбор обращения" });
    expect(p.spec.runtime).toMatchObject({ policyChangeMode: "pinned", maxConsecutiveRestarts: 0, maxCyclesPerStage: null });
  });
});

describe("ошибки схемы", () => {
  it("неизвестный ключ — ошибка с подсказкой", () => {
    const err = parseError(MINIMAL.replace("      transitions:\n", "      transition:\n"));
    expect(err.code).toBe("POLICY_SCHEMA");
    expect(err.issues[0]).toMatchObject({
      code: "UNKNOWN_KEY",
      path: "workflow.stages.a.transition",
      line: 9,
      params: { key: "transition", suggestion: "transitions" },
    });
  });

  it("модель с суффиксом :thinking и поле thinking одновременно", () => {
    const err = parseError(
      MINIMAL.replace("    instructions: работай\n", "    instructions: работай\n    model: openai/gpt-6:high\n    thinking: low\n"),
    );
    expect(err.issues.map((i) => [i.code, i.path])).toEqual([["MODEL_THINKING_CONFLICT", "agents.worker.thinking"]]);
  });

  it("суффикс без поля thinking и поле без суффикса допустимы", () => {
    parse(MINIMAL.replace("    instructions: работай\n", "    instructions: работай\n    model: openai/gpt-6:high\n"));
    parse(MINIMAL.replace("    instructions: работай\n", "    instructions: работай\n    model: openai/gpt-6\n    thinking: low\n"));
    // двоеточие в id модели без уровня thinking — часть id
    parse(MINIMAL.replace("    instructions: работай\n", "    instructions: работай\n    model: bedrock/anthropic.claude:1\n    thinking: low\n"));
  });

  it("modelRef default:<thinking> не поддерживается", () => {
    const err = parseError(MINIMAL.replace("    instructions: работай\n", "    instructions: работай\n    model: default:high\n"));
    expect(err.issues.map((i) => i.code)).toEqual(["INVALID_MODEL_REF"]);
  });

  it("agentId supervisor зарезервирован", () => {
    const err = parseError(MINIMAL.replaceAll("worker", "supervisor"));
    expect(err.issues.map((i) => [i.code, i.path])).toEqual([["RESERVED_AGENT_ID", "agents.supervisor"]]);
  });

  it("title без переводов строк и не длиннее 120 символов", () => {
    expect(parseError(MINIMAL.replace("title: A", `title: ${"я".repeat(121)}`)).issues[0]?.code).toBe("TITLE_TOO_LONG");
    parse(MINIMAL.replace("title: A", `title: ${"я".repeat(120)}`));
    // хвостовой перевод строки от «>» не считается многострочностью
    parse(MINIMAL.replace("title: A", "title: >\n        A"));
  });

  it("неподдерживаемая версия схемы проверяется до остальной схемы", () => {
    const err = parseError(MINIMAL.replace("schema: teo/v1", "schema: teo/v2\nunknown: 1"));
    expect(err.code).toBe("POLICY_UNSUPPORTED_SCHEMA");
    expect(err.issues[0]).toMatchObject({ code: "SCHEMA_UNSUPPORTED", line: 2, params: { value: "teo/v2" } });
  });

  it("собирает все ошибки схемы за один проход", () => {
    const err = parseError(
      MINIMAL.replace("title: A", "title: ''")
        .replace("  instructions: проверяй\n", "  instructions: проверяй\n  model: nope\n")
        .replace("---\nПравила", "runtime:\n  technicalRetries: 11\n---\nПравила"),
    );
    expect(err.issues.map((i) => i.code)).toEqual(["EMPTY_STRING", "INVALID_MODEL_REF", "OUT_OF_RANGE"]);
  });

  it("maxCyclesPerStage: null — допустимо и означает «без лимита»", () => {
    const p = parse(MINIMAL.replace("---\nПравила", "runtime:\n  maxCyclesPerStage: null\n---\nПравила"));
    expect(p.spec.runtime.maxCyclesPerStage).toBeNull();
  });
});
