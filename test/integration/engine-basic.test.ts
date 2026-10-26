import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { turn } from "../../src/agents/fake/fake-runtime.js";
import { Harness } from "../helpers/engine.js";

const ART = ".teo/tasks/T-1/artifacts/notes-plan.md";

export function happyPath(h: Harness) {
  h.fake
    .script(
      "sessions/explorer-001.jsonl",
      turn.text("Изучаю репозиторий"),
      turn.tool("write", { path: ART, content: "Создать NOTES.md со строкой hello" }),
      turn.tool("report_result", { summary: "План записан", artifacts: [{ kind: "file", pathOrUrl: ART }] }),
    )
    .script(
      "sessions/supervisor.jsonl",
      turn.tool("list_artifacts", {}),
      turn.tool("transition_stage", {
        expectedStateVersion: "$expectedStateVersion",
        to: "execute",
        reason: "план есть",
        evidenceRefs: ["artifact:notes-plan.md"],
        handoff: "План в artifacts/notes-plan.md",
      }),
    )
    .script(
      "sessions/executor-001.jsonl",
      turn.effect(async (c) => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path.join(c.cwd, "NOTES.md"), "hello\n");
        await h.git("add", "NOTES.md");
        await h.git("commit", "-qm", "notes");
      }),
      turn.tool("report_result", { summary: "NOTES.md закоммичен", evidence: [{ kind: "git", value: "HEAD" }] }),
    )
    .script(
      "sessions/supervisor.jsonl",
      turn.tool("inspect_git_commit", { ref: "HEAD" }),
      turn.tool("transition_stage", {
        expectedStateVersion: "$expectedStateVersion",
        to: "done",
        reason: "коммит есть",
        evidenceRefs: ["git:HEAD"],
      }),
    );
}

describe("движок: discover → execute → done", () => {
  it("проходит до терминального этапа без человека", async () => {
    const h = await Harness.create();
    await h.createTask();
    happyPath(h);
    const outcome = await h.run();
    expect(outcome).toEqual({ kind: "terminal" });
    const s = await h.state();
    expect(s).toMatchObject({ stage: "done", status: "terminal", phase: "halted" });
    const types = await h.types();
    expect(types.filter((t) => t === "stage.transitioned")).toHaveLength(2);
    expect(types).not.toContain("supervisor.protocol_error");
    expect(types).toContain("task.terminal");
    expect(await readFile(path.join(h.project, "NOTES.md"), "utf8")).toBe("hello\n");
    // handoff попал в initial prompt агента нового этапа
    expect(h.promptsTo("executor-001.jsonl")[0]).toContain("План в artifacts/notes-plan.md");
    expect(h.promptsTo("explorer-001.jsonl")[0]).toMatch(/^\[teo:prompt id=[0-9A-Z]{26} kind=initial run=[0-9A-Z]{26}\]/);
    expect(h.fake.remaining("sessions/supervisor.jsonl")).toBe(0);
  });
});
