// X3 на настоящем Pi SDK и настоящих моделях: host-роль вызывает report_result,
// отдельный supervisor проверяет artifact и завершает задачу в той же пользовательской сессии.
// Запуск: scripts/e2e.sh test/e2e/extension-host.test.ts

import path from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { startCommand } from "../../src/app.js";
import { createTask } from "../../src/commands/new.js";
import type { TaskEvent } from "../../src/domain/events.js";
import type { TaskState } from "../../src/domain/task-state.js";
import { ExtensionHost } from "../../src/extension/host.js";
import { extensionAppContext } from "../../src/extension/run-command.js";
import { sandbox } from "../helpers/tmp.js";

const enabled = process.env.TEO_E2E === "1";

const POLICY = `---
schema: teo/v1
workflow:
  initialStage: verify
  stages:
    verify:
      title: Проверка доказательства
      agent: checker
      instructions: |
        Прочитай .teo/tasks/T-1/artifacts/proof.txt и сразу вызови report_result.
        В evidence укажи artifact:proof.txt. Ничего не изменяй.
      transitions:
        - to: done
          when: В artifacts/proof.txt находится строка X3-PROOF-OK.
          guards:
            evidence: required
    done:
      title: Проверено
      terminal: true
agents:
  checker:
    title: Проверяющий X3
    model: default
    askUser: false
    instructions: |
      Выполни инструкции этапа буквально. Обязательно заверши ход вызовом report_result,
      не отвечай обычным текстом вместо инструмента.
supervisor:
  model: default
  instructions: |
    Прочитай artifact proof.txt. Если там X3-PROOF-OK, вызови transition_stage в done
    с evidenceRefs ["artifact:proof.txt"].
runtime:
  policyChangeMode: latest
  maxCyclesPerStage: 3
  technicalRetries: 0
---
`;

describe.skipIf(!enabled)("ExtensionHost X3 e2e", () => {
  it("реальная host-модель → report_result → реальный supervisor → терминальный этап", async () => {
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    if (!agentDir) throw new Error("нужен PI_CODING_AGENT_DIR");

    const sb = await sandbox(POLICY, { process: "x3" });
    const { ctx: app } = extensionAppContext(sb.project, sb.home);
    const { store } = await startCommand(app);
    await createTask(store, { key: "T-1", title: "Проверка X3", description: "Проверь готовое доказательство", process: "x3" });
    const task = store.tasks.task("T-1");
    await mkdir(task.artifactsDir, { recursive: true });
    await writeFile(path.join(task.artifactsDir, "proof.txt"), "X3-PROOF-OK\n");

    const models = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      modelsStorePath: path.join(agentDir, "models-store.json"),
    });
    const settings = SettingsManager.create(sb.project, agentDir);
    const provider = settings.getDefaultProvider();
    const modelId = settings.getDefaultModel();
    const model = (provider && modelId ? models.getModel(provider, modelId) : undefined) ?? (await models.getAvailable())[0];
    if (!model) throw new Error("нет доступной модели");

    let host: ExtensionHost | undefined;
    const prompts: string[] = [];
    const toolInventory: string[][] = [];
    const activeInventory: string[][] = [];
    const providerTools: string[][] = [];
    const factory = (pi: ExtensionAPI) => {
      host = new ExtensionHost(pi, sb.home);
      host.register();
      pi.on("session_start", () => {
        toolInventory.push(pi.getAllTools().map((t) => t.name));
        activeInventory.push(pi.getActiveTools());
      });
      pi.registerCommand("teo-x3-resume", { description: "e2e", handler: async (_args, ctx) => host!.resume(ctx, "T-1") });
      pi.on("before_agent_start", (event) => {
        prompts.push(event.systemPromptOptions.sections["teo_stage"] ?? "");
      });
      pi.on("before_provider_request", (event) => {
        const payload = JSON.stringify(event.payload);
        providerTools.push(["read", "report_result", "report_blocker"].filter((name) => new RegExp(`"name"\\s*:\\s*"${name}"`).test(payload)));
      });
    };

    const loader = new DefaultResourceLoader({
      cwd: sb.project,
      agentDir,
      settingsManager: settings,
      noContextFiles: true,
      noSkills: true,
      noExtensions: true,
      extensionFactories: [{ name: "teo-x3-e2e", factory }],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: sb.project,
      agentDir,
      modelRuntime: models,
      model,
      // SDK embedding с явным tools использует его и как allowlist; имена extension tools нужно разрешить заранее.
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls", "report_result", "report_blocker"],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(sb.project),
      settingsManager: settings,
    });
    await session.bindExtensions({ mode: "print" });

    try {
      await session.prompt("/teo-x3-resume", { expandPromptTemplates: true });
      await session.waitForIdle();
      const state = JSON.parse(await readFile(task.state, "utf8")) as TaskState;
      const journal = (await readFile(task.events, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as TaskEvent);
      const diagnostic = `phase=${state.phase}, status=${state.status}, stage=${state.stage}, events=${journal.slice(-10).map((e) => e.type).join(",")}, allTools=${toolInventory[0]?.join(",")}, activeAtStart=${activeInventory[0]?.join(",")}`;

      expect(state, diagnostic).toMatchObject({ stage: "done", status: "terminal", phase: "halted", hostSession: null });
      expect(host?.boundKey).toBeNull();
      expect(prompts[0]).toContain("Твоя роль на этом этапе — «Проверяющий X3»");
      expect(prompts[0]).toContain("Обязательно заверши ход вызовом report_result");
      expect(providerTools[0]).toContain("read");
      expect(journal.some((e) => e.type === "agent.reported"), diagnostic).toBe(true);
      expect(journal.some((e) => e.type === "supervisor.started")).toBe(true);
      expect(journal.some((e) => e.type === "supervisor.decision" && e.payload.action === "transition_stage")).toBe(true);
      expect(journal.some((e) => e.type === "decision.applied")).toBe(true);
      expect(journal.at(-1)).toMatchObject({ type: "session.unbound", payload: { reason: "finished" } });
    } finally {
      await host?.detach();
      session.dispose();
    }
  }, 120_000);
});
