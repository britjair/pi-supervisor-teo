// Запускать только с TEO_E2E=1 и PI_CODING_AGENT_DIR=<временная копия учётных данных Pi>.
// Содержимое auth.json не выводится. Тест не читает пользовательский ~/.pi напрямую.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cliPath, validDir } from "../helpers/paths.js";
import { runCli, runProcess, sandbox } from "../helpers/tmp.js";

const enabled = process.env.TEO_E2E === "1";

describe.skipIf(!enabled)("Pi e2e", () => {
  // Две Policy с разными этапами, агентами и файлами — один и тот же dist/cli.js (критерии 3 и 17);
  // режим цели — встроенный процесс без своей Policy (G1, D35)
  const TASK = ["--title", "Тест", "--description", "Выполни этапы Policy"];
  it.each([
    { fixture: "discover-execute-done", terminal: "done", file: "NOTES.md", args: TASK, transitions: 2 },
    { fixture: "sketch-deliver-shipped", terminal: "shipped", file: "HELLO.md", args: TASK, transitions: 2 },
    {
      fixture: "goal",
      terminal: "reached",
      file: "GOAL.md",
      args: ["--goal", "Создай в корне проекта файл GOAL.md с одной строкой «готово» и закоммить его в текущую ветку."],
      transitions: 1,
    },
  ])("$fixture: агент создаёт $file, supervisor подтверждает коммит", async ({ fixture, terminal, file, args, transitions }) => {
    const auth = process.env.PI_CODING_AGENT_DIR;
    if (!auth) throw new Error("Для e2e укажите PI_CODING_AGENT_DIR на временную копию каталога Pi.");
    // Для режима цели свой процесс в песочнице тоже есть: --goal выбирает встроенный явно
    const policy = await readFile(path.join(validDir, `${fixture === "goal" ? "discover-execute-done" : fixture}.md`));
    const sb = await sandbox(policy);
    await runProcess("git", ["config", "user.name", "TEO Test"], sb.project);
    await runProcess("git", ["config", "user.email", "teo-test@example.invalid"], sb.project);
    const doctor = await runCli(sb, ["doctor"], { env: { PI_CODING_AGENT_DIR: auth } });
    expect(doctor.code).toBe(0);
    expect(doctor.stdout).toContain("✓ Pi SDK 1.4.0 загружается");
    const result = await new Promise<{ code: number | null }>((resolve) => {
      execFile(process.execPath, [cliPath, "new", "T-1", ...args, "--plain"],
        { cwd: sb.project, timeout: 80_000, killSignal: "SIGKILL", maxBuffer: 4_000_000, env: { ...process.env, HOME: sb.home, PI_CODING_AGENT_DIR: auth, NO_COLOR: "1" } },
        (error) => resolve({ code: error ? (typeof error.code === "number" ? error.code : null) : 0 }),
      );
    });
    const dir = path.join(sb.project, ".teo", "tasks", "T-1");
    const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    // При сбое выводим только фазу и типы событий, никогда stdout/stderr модели или credentials.
    const events = (await readFile(path.join(dir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const sessionFiles = await (await import("node:fs/promises")).readdir(path.join(dir, "sessions"));
    const inspected = await Promise.all(sessionFiles.map(async (name) => {
      const { inspectPiSessionFile } = await import("../../src/agents/pi/session-inspector.js");
      const info = await inspectPiSessionFile(path.join(dir, "sessions", name));
      return `${name}:${info.messageCount}:${info.lastEntry?.kind ?? "none"}${info.lastEntry?.kind === "assistant" ? `/${info.lastEntry.stopReason}` : ""}`;
    }));
    expect(result.code, `phase=${state.phase}, status=${state.status}, events=${events.slice(-8).map((e) => e.type).join(",")}, sessions=${inspected.join(",")}`).toBe(0);
    expect(state).toMatchObject({ stage: terminal, status: "terminal" });
    expect(await readFile(path.join(sb.project, file), "utf8")).toBeTruthy();
    expect(events.filter((e) => e.type === "stage.transitioned")).toHaveLength(transitions);
    expect(events.some((e) => e.type === "supervisor.protocol_error")).toBe(false);
  }, 100_000);

  it("guard реальной Pi-сессии отклоняет write в state.json", async () => {
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    if (!agentDir) throw new Error("Для e2e укажите временную копию PI_CODING_AGENT_DIR.");
    const { PiAgentRuntime } = await import("../../src/agents/pi/pi-agent-runtime.js");
    const sb = await sandbox();
    const task = path.join(sb.project, ".teo", "tasks", "T-1");
    await mkdir(path.join(task, "artifacts"), { recursive: true });
    const stateFile = path.join(task, "state.json");
    await writeFile(stateFile, "не менять");
    const runtime = new PiAgentRuntime({ agentDir, cwd: sb.project });
    const model = await runtime.resolveModel({ ref: "default", thinking: null, extensions: false });
    const handle = await runtime.openSession({
      file: path.join(task, "sessions", "guard.jsonl"), cwd: sb.project, role: "agent", model,
      systemPromptAppend: "Ты проверяешь разрешения инструмента. Выполни ровно один вызов write по указанному пути. Не используй другие инструменты.",
      builtinTools: ["write"], customTools: [],
      piResources: { contextFiles: false, extensions: false, skills: false },
      guard: { role: "agent", projectRoot: sb.project, taskDir: task, writableInsideTeo: [path.join(task, "artifacts")], readableRoots: [sb.project], isReported: () => false },
    });
    let rejected = false;
    const unsubscribe = handle.subscribe((e) => { if (e.type === "tool.finished" && e.toolName === "write" && !e.ok) rejected = true; });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 45_000);
    try {
      await handle.run(`Проверь запрет: вызови write с path=${stateFile} и content=подмена. После ошибки остановись.`, { signal: abort.signal });
    } finally {
      clearTimeout(timer);
      unsubscribe();
      handle.dispose();
      await runtime.dispose();
    }
    expect(rejected).toBe(true);
    expect(await readFile(stateFile, "utf8")).toBe("не менять");
  }, 60_000);
});
