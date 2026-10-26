// Пакет как расширение Pi (X1, S6): настоящий загрузчик Pi 1.4.0 читает манифест package.json,
// грузит dist/extension.js и выполняет /teo через сессию SDK. Модель не вызывается.

import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { repoRoot, validDir } from "../helpers/paths.js";
import { runCli, runProcess, sandbox, type Sandbox } from "../helpers/tmp.js";

type Note = { message: string; type: string };

const UI_METHODS = [
  "addAutocompleteProvider", "confirm", "custom", "editor", "getAllThemes", "getEditorComponent", "getEditorText", "getTheme",
  "getToolsExpanded", "input", "onTerminalInput", "pasteToEditor", "select", "setEditorComponent", "setEditorText", "setFooter",
  "setHeader", "setHiddenThinkingLabel", "setStatus", "setTheme", "setTitle", "setToolsExpanded", "setWidget",
  "setWorkingIndicator", "setWorkingMessage", "setWorkingVisible",
];

/** UI Pi без терминала: notify записывается, остальное — заглушки. Pi копирует методы, Proxy не подходит. */
function recordingUi(notes: Note[]): ExtensionUIContext {
  const ui: Record<string, unknown> = Object.fromEntries(UI_METHODS.map((m) => [m, () => undefined]));
  ui["notify"] = (message: string, type = "info") => void notes.push({ message, type });
  return ui as unknown as ExtensionUIContext;
}

const savedHome = process.env["HOME"];
afterEach(() => {
  process.env["HOME"] = savedHome;
});

async function piWithTeo(sb: Sandbox) {
  const agentDir = path.join(sb.root, "pi-agent");
  await mkdir(agentDir, { recursive: true });
  // Расширение берёт каталог процессов из HOME, как CLI
  process.env["HOME"] = sb.home;
  const settings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: sb.project, agentDir, settingsManager: settings, noSkills: true, noContextFiles: true, noPromptTemplates: true,
    additionalExtensionPaths: [repoRoot],
  });
  await loader.reload();
  const models = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
  });
  const { session } = await createAgentSession({
    cwd: sb.project, agentDir, modelRuntime: models, tools: [], resourceLoader: loader,
    sessionManager: SessionManager.inMemory(sb.project), settingsManager: settings,
  });
  const notes: Note[] = [];
  const errors: string[] = [];
  await session.bindExtensions({ mode: "tui", uiContext: recordingUi(notes), onError: (e) => void errors.push(JSON.stringify(e)) });
  const run = async (command: string) => {
    notes.length = 0;
    await session.prompt(command);
    if (errors.length > 0) throw new Error(`ошибка расширения: ${errors.join("; ")}`);
    return [...notes];
  };
  return { loader, session, run };
}

describe("расширение Pi", () => {
  it("манифест: SDK и typebox — peerDependencies \"*\", а не dependencies", () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as Record<string, Record<string, string>>;
    expect(pkg["pi"]).toEqual({ extensions: ["./dist/extension.js"] });
    expect(pkg["peerDependencies"]).toEqual({ "@earendil-works/pi-coding-agent": "*", typebox: "*" });
    expect(Object.keys(pkg["dependencies"] ?? {})).not.toContain("@earendil-works/pi-coding-agent");
    expect(Object.keys(pkg["dependencies"] ?? {})).not.toContain("typebox");
  });

  it("бандл самодостаточен: без Ink, React и своей копии Pi SDK", () => {
    const code = readFileSync(path.join(repoRoot, "dist", "extension.js"), "utf8");
    const imports = [...code.matchAll(/^import .* from "([^"]+)";?$/gm)].map((m) => m[1] ?? "");
    for (const spec of imports) expect(spec, spec).toMatch(/^(node:|fs|path|url|os|crypto|stream|child_process|module|@earendil-works\/|typebox$)/);
    expect(code).not.toMatch(/from "(ink|react|@inkjs\/ui)"/);
  });

  it("Pi загружает пакет без ошибок и предупреждений и регистрирует /teo", async () => {
    const sb = await sandbox(readFileSync(path.join(validDir, "discover-execute-done.md")), { process: "dev" });
    const { loader, session } = await piWithTeo(sb);
    try {
      const result = loader.getExtensions();
      const ours = (p: string) => p.startsWith(repoRoot);
      expect(result.errors.filter((e) => ours(e.path))).toEqual([]);
      expect((result.warnings ?? []).filter((w) => ours(w.path))).toEqual([]);
      expect(result.extensions.some((e) => ours(e.path) && e.commands.has("teo"))).toBe(true);
    } finally {
      session.dispose();
    }
  });

  it("/teo status и history показывают задачи проекта средствами Pi", async () => {
    const sb = await sandbox(readFileSync(path.join(validDir, "discover-execute-done.md")), { process: "dev" });
    expect((await runCli(sb, ["new", "T-1", "--title", "Первая", "--description", "d", "--no-run"])).code).toBe(0);
    const { session, run } = await piWithTeo(sb);
    try {
      const summary = await run("/teo status");
      expect(summary).toHaveLength(1);
      expect(summary[0]?.type).toBe("info");
      expect(summary[0]?.message).toMatch(/T-1\s+dev\s+Изучение задачи/);

      const one = await run("/teo status t-1");
      expect(one[0]?.message).toContain("T-1 · Первая");
      expect(one[0]?.message).toMatch(/^Процесс:\s+dev$/m);

      expect((await run("/teo history T-1"))[0]?.message).toContain("task.created");
      expect((await run("/teo"))[0]?.message).toContain("/teo status [KEY]");
      expect(await run("/teo start")).toEqual([{ message: expect.stringContaining("/teo start появится на следующих этапах"), type: "warning" }]);
      expect((await run("/teo nope"))[0]).toMatchObject({ type: "warning", message: expect.stringContaining("Неизвестная подкоманда") });

      const missing = await run("/teo status X-9");
      expect(missing[0]).toMatchObject({ type: "error", message: expect.stringContaining("Задача X-9 не найдена") });
      // Команды расширения не попадают в контекст модели
      expect(session.messages).toEqual([]);
    } finally {
      session.dispose();
    }
  });

  it("критерий X1: `pi -e <пакет>` загружает расширение без предупреждений; /teo отвечает в print-режиме", async () => {
    const sb = await sandbox(readFileSync(path.join(validDir, "discover-execute-done.md")), { process: "dev" });
    expect((await runCli(sb, ["new", "T-1", "--title", "Первая", "--description", "d", "--no-run"])).code).toBe(0);
    const agentDir = path.join(sb.root, "pi-agent");
    await mkdir(agentDir, { recursive: true });
    const pi = path.join(repoRoot, "node_modules", ".bin", "pi");
    const r = await runProcess(pi, ["-e", repoRoot, "-p", "/teo status T-1"], sb.project, { HOME: sb.home, PI_CODING_AGENT_DIR: agentDir, NO_COLOR: "1" });
    expect(r.code, r.stderr).toBe(0);
    // stdout print-режима Pi — только ответ модели; сообщения расширения идут в stderr
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("T-1 · Первая");
    expect(r.stderr).toMatch(/^Процесс:\s+dev$/m);
    // Ни предупреждений загрузчика о манифесте, ни других диагностик
    expect(r.stderr.split("\n").filter((l) => l && !/^(T-1 ·|Проект|Процесс|Этап|Статус|Агент|Последн|Следующее|Policy|Lock)/.test(l))).toEqual([]);
  });
});
