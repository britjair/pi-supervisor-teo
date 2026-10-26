// X2 на настоящем Pi SDK и настоящей модели: привязка задачи, роль этапа, инструменты и журнал чата.
// Запуск: scripts/e2e.sh test/e2e/extension-host.test.ts

import path from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { startCommand } from "../../src/app.js";
import { createTask } from "../../src/commands/new.js";
import { ExtensionHost } from "../../src/extension/host.js";
import { extensionAppContext } from "../../src/extension/run-command.js";
import type { TaskEvent } from "../../src/domain/events.js";
import { validDir } from "../helpers/paths.js";
import { sandbox } from "../helpers/tmp.js";

const enabled = process.env.TEO_E2E === "1";

describe.skipIf(!enabled)("ExtensionHost e2e", () => {
  it("реальная модель получает роль этапа и инструменты; сообщение человека попадает в журнал", async () => {
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    if (!agentDir) throw new Error("нужен PI_CODING_AGENT_DIR");

    const base = await readFile(path.join(validDir, "discover-execute-done.md"), "utf8");
    const policy = base
      .replace("Изучи репозиторий и опиши в artifacts/notes-plan.md, что нужно сделать.", "Ответь ровно строкой X2-ROLE-OK. Не используй инструменты и ничего не меняй.")
      .replace("Ты изучаешь задачу и ничего не меняешь в репозитории, кроме artifacts/.", "Ты тестовая роль. В каждом ответе пиши ровно X2-ROLE-OK и не используй инструменты.");
    const sb = await sandbox(policy, { process: "dev" });
    const { ctx: app } = extensionAppContext(sb.project, sb.home);
    const { store } = await startCommand(app);
    await createTask(store, { key: "T-1", title: "Проверка роли", description: "Ответь контрольной строкой", process: "dev" });

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
    const providerTools: string[][] = [];
    const factory = (pi: ExtensionAPI) => {
      host = new ExtensionHost(pi, sb.home);
      host.register();
      // Тестовый фасад вызывает тот же публичный resume; продуктовая /teo-команда проверена extension-load.test.ts.
      pi.registerCommand("teo-x2-resume", { description: "e2e", handler: async (_args, ctx) => host!.resume(ctx, "T-1") });
      pi.on("before_agent_start", (event) => {
        prompts.push(event.systemPromptOptions.sections["teo_stage"] ?? "");
      });
      pi.on("before_provider_request", (event) => {
        const payload = JSON.stringify(event.payload);
        providerTools.push(["read", "bash", "edit", "write", "grep", "find", "ls"].filter((name) => new RegExp(`"name"\\s*:\\s*"${name}"`).test(payload)));
      });
    };

    const loader = new DefaultResourceLoader({
      cwd: sb.project,
      agentDir,
      settingsManager: settings,
      noContextFiles: true,
      noSkills: true,
      noExtensions: true,
      extensionFactories: [{ name: "teo-x2-e2e", factory }],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: sb.project,
      agentDir,
      modelRuntime: models,
      model,
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(sb.project),
      settingsManager: settings,
    });
    await session.bindExtensions({ mode: "print" });

    try {
      await session.prompt("/teo-x2-resume", { expandPromptTemplates: true });
      await session.waitForIdle();
      expect(host?.boundKey).toBe("T-1");
      expect(prompts[0]).toContain("Твоя роль на этом этапе — «Исследователь»");
      expect(prompts[0]).toContain("X2-ROLE-OK");
      expect(providerTools[0]?.sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);

      const answer = session.messages
        .filter((m) => m.role === "assistant")
        .at(-1)?.content.filter((b) => b.type === "text").map((b) => b.text).join("") ?? "";
      expect(answer).toContain("X2-ROLE-OK");

      await session.prompt("Подтверждаю результат X2-ROLE-OK.", { expandPromptTemplates: false, source: "interactive" });
      await session.waitForIdle();
      const task = store.tasks.task("T-1");
      const journal = (await readFile(task.events, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as TaskEvent);
      expect(journal).toContainEqual(expect.objectContaining({
        type: "human.responded",
        payload: { requestId: null, answer: "Подтверждаю результат X2-ROLE-OK.", selectedOption: null, channel: "chat" },
      }));
    } finally {
      await host?.detach();
      session.dispose();
    }
  }, 90_000);
});
