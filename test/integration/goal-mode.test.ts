// Режим цели (docs/07-extension-mode.md §5, D35): встроенный процесс processes/goal.md.

import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { turn } from "../../src/agents/fake/fake-runtime.js";
import { runInteractive } from "../../src/commands/interactive.js";
import { goalTitle } from "../../src/commands/new.js";
import type { TaskState } from "../../src/domain/task-state.js";
import { GOAL_PROCESS, ProcessCatalog, builtinProcessesDir } from "../../src/policy/process-catalog.js";
import { testContext } from "../helpers/context.js";
import { Harness } from "../helpers/engine.js";
import { repoRoot, validDir } from "../helpers/paths.js";
import { ScriptedHumanIO } from "../helpers/scripted-human-io.js";
import { runCli, sandbox, type Sandbox } from "../helpers/tmp.js";

const GOAL_FILE = path.join(repoRoot, "processes", "goal.md");
const DED = readFileSync(path.join(validDir, "discover-execute-done.md"));
const AGENT = "sessions/performer-001.jsonl";
const SUPERVISOR = "sessions/supervisor.jsonl";

const state = async (sb: Sandbox, key: string) =>
  JSON.parse(await readFile(path.join(sb.project, ".teo", "tasks", key, "state.json"), "utf8")) as TaskState;
const taskMd = (sb: Sandbox, key: string) => readFile(path.join(sb.project, ".teo", "tasks", key, "task.md"), "utf8");

describe("встроенный процесс цели", () => {
  it("лежит в processes/ пакета и находится из исходников", async () => {
    expect(builtinProcessesDir()).toBe(path.join(repoRoot, "processes"));
    const sb = await sandbox(DED, { process: "dev" });
    const all = await new ProcessCatalog(sb.processesDir).loadAll();
    expect(all.map((p) => [p.name, p.builtin, p.ok])).toEqual([["dev", false, true], [GOAL_PROCESS, true, true]]);
    const goal = all[1];
    expect(goal?.ok && goal.policy.warnings).toEqual([]);
  });

  it("свой ~/.pi/teo/goal.md заменяет встроенный", async () => {
    const sb = await sandbox(DED, { process: GOAL_PROCESS });
    const all = await new ProcessCatalog(sb.processesDir).loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: GOAL_PROCESS, builtin: false, path: sb.policyPath });
  });

  it("название по цели — первая непустая строка, не длиннее 200 символов", () => {
    expect(goalTitle("\n  Создай NOTES.md  \nподробности")).toBe("Создай NOTES.md");
    const long = goalTitle("ц".repeat(300));
    expect([...long]).toHaveLength(200);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("teo new --goal", () => {
  it("без терминала: процесс goal, цель — описание, название — первая строка цели", async () => {
    const sb = await sandbox(DED, { process: "dev" });
    const r = await runCli(sb, ["new", "G-1", "--goal", "Создай NOTES.md со строкой hello\nи закоммить", "--no-run"]);
    expect(r.code, r.stderr).toBe(0);
    expect(await state(sb, "G-1")).toMatchObject({ process: GOAL_PROCESS, title: "Создай NOTES.md со строкой hello", stage: "pursuit" });
    expect(await taskMd(sb, "G-1")).toContain("## Описание\n\nСоздай NOTES.md со строкой hello\nи закоммить\n");
    expect((await runCli(sb, [])).stdout).toMatch(/G-1\s+goal\s+Достижение цели/);

    const titled = await runCli(sb, ["new", "G-2", "--goal", "цель", "--title", "Своё название", "--no-run"]);
    expect(titled.code).toBe(0);
    expect((await state(sb, "G-2")).title).toBe("Своё название");
  });

  it("работает без своих процессов; с --process или --description — ошибка ввода", async () => {
    const sb = await sandbox();
    expect((await runCli(sb, ["new", "G-1", "--goal", "цель", "--no-run"])).code).toBe(0);
    expect((await state(sb, "G-1")).process).toBe(GOAL_PROCESS);
    for (const extra of [["--process", "dev"], ["--description", "d"]]) {
      const r = await runCli(sb, ["new", "G-2", "--goal", "цель", ...extra]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--goal задаёт и процесс, и описание");
    }
    const empty = await runCli(sb, ["new", "G-3", "--goal", "   "]);
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("Цель не может быть пустой.");
  });

  it("в терминале: «Цель» в выборе процесса, сначала цель, название по умолчанию из неё", async () => {
    const sb = await sandbox(DED, { process: "dev" });
    const human = new ScriptedHumanIO([
      { select: "Цель — без процесса" },
      { input: "G-7" },
      { multiline: "Собери отчёт по продажам\nза октябрь" },
      { input: "" },
      { select: "Создать" },
    ]);
    expect(await runInteractive(testContext(sb, { human }), { execute: async () => 0 })).toBe(0);
    expect(human.remaining).toBe(0);
    expect(human.printed).toContain("Режим цели: задача без процесса");
    expect(human.printed).toContain("Начальный этап: Достижение цели (agent: performer)");
    expect(await state(sb, "G-7")).toMatchObject({ process: GOAL_PROCESS, title: "Собери отчёт по продажам" });
  });

  it("в терминале без своих процессов режим цели выбирается сам", async () => {
    const sb = await sandbox();
    await writeFile(path.join(sb.processesDir, "README.txt"), "не процесс");
    const human = new ScriptedHumanIO([{ input: "G-1" }, { multiline: "цель" }, { input: "" }, { select: "Создать" }]);
    expect(await runInteractive(testContext(sb, { human }), { execute: async () => 0 })).toBe(0);
    expect((await state(sb, "G-1")).process).toBe(GOAL_PROCESS);
  });
});

describe("движок на процессе цели", () => {
  it("агент достигает цели, supervisor проверяет коммит и завершает задачу", async () => {
    const h = await Harness.create({ policy: readFileSync(GOAL_FILE, "utf8") });
    await h.createTask("T-1", "Создай NOTES.md со строкой hello и закоммить его");
    h.fake
      .script(
        AGENT,
        turn.effect(async (c) => {
          await writeFile(path.join(c.cwd, "NOTES.md"), "hello\n");
          await h.git("add", "NOTES.md");
          await h.git("commit", "-qm", "notes");
        }),
        turn.tool("report_result", { summary: "NOTES.md закоммичен", evidence: [{ kind: "git", value: "HEAD" }] }),
      )
      .script(
        SUPERVISOR,
        turn.tool("inspect_git_commit", { ref: "HEAD" }),
        turn.tool("transition_stage", { expectedStateVersion: "$expectedStateVersion", to: "reached", reason: "коммит есть", evidenceRefs: ["git:HEAD"] }),
      );
    expect(await h.run()).toEqual({ kind: "terminal" });
    expect(await h.state()).toMatchObject({ stage: "reached", status: "terminal" });
    // Цель — описание задачи — дошла до агента, правила процесса — до supervisor-а
    expect(h.promptsTo("performer-001.jsonl")[0]).toContain("Создай NOTES.md со строкой hello и закоммить его");
    expect(h.promptsTo("supervisor.jsonl")[0]).toContain("→ reached «Цель достигнута»");
  });

  it("переход без доказательств отклоняется guard-ом", async () => {
    const h = await Harness.create({ policy: readFileSync(GOAL_FILE, "utf8") });
    await h.createTask("T-1", "цель");
    h.fake
      .script(AGENT, turn.tool("report_result", { summary: "готово" }))
      .script(
        SUPERVISOR,
        turn.tool("transition_stage", { expectedStateVersion: "$expectedStateVersion", to: "reached", reason: "агент сказал", evidenceRefs: [] }),
        turn.effect((c) => expect(c.lastToolResult?.content).toContain("EVIDENCE_REQUIRED")),
        turn.tool("block_task", { expectedStateVersion: "$expectedStateVersion", reason: "нет фактов", resolutionHint: "-" }),
      );
    expect(await h.run()).toEqual({ kind: "blocked", code: "SUPERVISOR_BLOCKED" });
  });
});
