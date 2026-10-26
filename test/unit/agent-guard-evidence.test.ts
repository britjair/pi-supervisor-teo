import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isValidGitRef, parseEvidenceRef, resolveEvidenceRef, type EvidenceContext } from "../../src/agents/evidence-refs.js";
import { guardToolCall } from "../../src/agents/guard.js";
import type { GuardConfig } from "../../src/agents/runtime.js";
import type { TaskEvent } from "../../src/domain/events.js";
import { tmpDir } from "../helpers/tmp.js";

async function directories() {
  const project = await tmpDir();
  const task = path.join(project, ".teo", "tasks", "TEST-1");
  const artifacts = path.join(task, "artifacts");
  await mkdir(artifacts, { recursive: true });
  return { project, task, artifacts };
}

function config(project: string, task: string, artifacts: string, role: "agent" | "supervisor", isReported = () => false): GuardConfig {
  return {
    role,
    projectRoot: project,
    taskDir: task,
    writableInsideTeo: [artifacts],
    readableRoots: [project],
    isReported,
  };
}

describe("ограничения доступа агента и supervisor", () => {
  it("агент может писать в проект и artifacts, но не в state; после отчёта блокируется всё", async () => {
    const { project, task, artifacts } = await directories();
    const guard = config(project, task, artifacts, "agent");
    expect(await guardToolCall(guard, "write", { path: "src/new.ts" }, project)).toEqual({ allow: true });
    expect(await guardToolCall(guard, "write", { path: "artifact.md" }, artifacts)).toEqual({ allow: true });
    expect(await guardToolCall(guard, "edit", { path: path.join(task, "state.json") }, project)).toMatchObject({ allow: false });
    expect(await guardToolCall(guard, "write", { path: path.join(task, "runs", "R.json") }, project)).toMatchObject({ allow: false });
    expect(await guardToolCall(config(project, task, artifacts, "agent", () => true), "read", {}, project)).toEqual({ allow: false, terminate: true, reason: expect.any(String) });
  });

  it("нормализует .. и symlink (включая ещё не созданный конечный файл)", async () => {
    const { project, task, artifacts } = await directories();
    await symlink(task, path.join(project, "alias"));
    await symlink(project, path.join(artifacts, "back"));
    const guard = config(project, task, artifacts, "agent");
    expect(await guardToolCall(guard, "write", { path: "alias/state.json" }, project)).toMatchObject({ allow: false });
    expect(await guardToolCall(guard, "write", { path: "back/.teo/tasks/TEST-1/state.json" }, artifacts)).toMatchObject({ allow: false });
    expect(await guardToolCall(guard, "write", { path: "../state.json" }, artifacts)).toMatchObject({ allow: false });
  });

  it("supervisor может читать только из проекта, включая защиту от symlink наружу", async () => {
    const { project, task, artifacts } = await directories();
    const outside = await tmpDir();
    await symlink(outside, path.join(project, "external"));
    const guard = config(project, task, artifacts, "supervisor");
    expect(await guardToolCall(guard, "read", { path: ".teo/tasks/TEST-1/state.json" }, project)).toEqual({ allow: true });
    expect(await guardToolCall(guard, "read", { path: "external/secret.txt" }, project)).toMatchObject({ allow: false });
    expect(await guardToolCall(guard, "grep", { path: outside }, project)).toMatchObject({ allow: false });
  });
});

describe("ссылки evidence", () => {
  it("отклоняет неизвестные схемы и опасные git refs", () => {
    expect(parseEvidenceRef("command:rm -rf /")).toBeNull();
    expect(parseEvidenceRef("note:готово")).toEqual({ scheme: "note", value: "готово" });
    expect(parseEvidenceRef("file: ")).toBeNull();
    expect(isValidGitRef("--upload-pack=evil")).toBe(false);
    expect(isValidGitRef("HEAD;touch /tmp/pwned")).toBe(false);
  });

  it("проверяет все схемы: файл+hash, artifact, git, human, event, run, url, note", async () => {
    const { project, artifacts } = await directories();
    const outside = await tmpDir();
    const file = path.join(project, "README.md");
    await writeFile(file, "Привет");
    await writeFile(path.join(artifacts, "result.md"), "Итог");
    await symlink(outside, path.join(project, "outside"));
    const hash = createHash("sha256").update("Привет").digest("hex");
    const event = { id: "01TEST", type: "human.responded" } as TaskEvent;
    const runId = "01J00000000000000000000000";
    const calls: string[][] = [];
    const ctx: EvidenceContext = {
      projectRoot: project,
      artifactsDir: artifacts,
      git: async (args) => (calls.push(args), { code: args[2] === "HEAD^{commit}" ? 0 : 1, stdout: "", stderr: "" }),
      findEvent: async (id) => id === event.id ? event : null,
      runExists: async (id) => id === runId,
    };
    for (const ref of [`file:README.md@${hash.slice(0, 8)}`, "artifact:result.md", "git:HEAD", `human:${event.id}`, `event:${event.id}`, `run:${runId}`, "url:https://example.org", "note:утверждено"]) {
      expect(await resolveEvidenceRef(ref, ctx), ref).toMatchObject({ ok: true });
    }
    expect(calls).toEqual([["cat-file", "-e", "HEAD^{commit}"]]);
    for (const ref of ["file:README.md@deadbee", "file:outside/nope", "artifact:../README.md", "git:bad;ref", "human:missing", "run:missing", "url:file:///etc/passwd", "unknown:x"]) {
      expect(await resolveEvidenceRef(ref, ctx), ref).toMatchObject({ ok: false });
    }
  });
});
