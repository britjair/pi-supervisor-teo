// ПРОТОТИП режима расширения (не входит в продукт). Проверяет на реальной модели Pi 1.4.0:
// 1) роль этапа через секцию системного промпта, смена роли между ходами одной сессии;
// 2) setActiveTools между ходами;
// 3) вложенная сессия supervisor-а внутри agent_before_settle и продолжение хода (continue: true).
// Запуск: scripts/e2e.sh test/e2e/spike-extension-host.test.ts
import path from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { tmpDir } from "../helpers/tmp.js";

const enabled = process.env.TEO_E2E === "1";

describe.skipIf(!enabled)("прототип: supervisor как расширение пользовательской сессии", () => {
  it("роль этапа, инструменты, вложенный supervisor и продолжение хода", async () => {
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    if (!agentDir) throw new Error("нужен PI_CODING_AGENT_DIR");
    const cwd = await tmpDir();
    const models = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      modelsStorePath: path.join(agentDir, "models-store.json"),
    });
    const settings = SettingsManager.create(cwd, agentDir);
    const provider = settings.getDefaultProvider();
    const modelId = settings.getDefaultModel();
    const model = (provider && modelId ? models.getModel(provider, modelId) : undefined) ?? (await models.getAvailable())[0];
    if (!model) throw new Error("нет модели");

    const log: string[] = [];
    let role = "РОЛЬ-А";
    let steered = false;
    let supervisorVerdict = "";
    const promptsSeen: string[] = [];
    const toolsSeen: string[][] = [];
    const providerTools: string[][] = [];
    const stageTools: Record<string, string[]> = { "РОЛЬ-А": ["read", "ls"], "РОЛЬ-Б": ["read", "ls", "grep"] };

    // Вложенная сессия supervisor-а: только чтение, без инструментов, в памяти
    const supervise = async (agentText: string): Promise<string> => {
      const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true, noContextFiles: true });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd, agentDir, modelRuntime: models, model, tools: [], resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory(),
      });
      try {
        await session.prompt(`Ты supervisor. Ответ агента:\n«${agentText}»\nОтветь ровно одним словом: ПРОДОЛЖИТЬ.`, { expandPromptTemplates: false });
        const last = session.messages.filter((m) => m.role === "assistant").at(-1);
        return last?.content.filter((b) => b.type === "text").map((b) => b.text).join("") ?? "";
      } finally {
        session.dispose();
      }
    };

    const host = (pi: ExtensionAPI) => {
      pi.on("before_provider_request", (event) => {
        // Формат payload зависит от провайдера: ищем объявления инструментов по имени
        const text = JSON.stringify(event.payload);
        providerTools.push(["read", "ls", "grep"].filter((n) => new RegExp(`"name"\\s*:\\s*"${n}"`).test(text)));
      });
      pi.on("before_agent_start", (event) => {
        pi.setActiveTools(stageTools[role] ?? []);
        event.systemPromptOptions.sections["teo_stage"] = `Твоя роль на этом этапе: ${role}. Каждый свой ответ начинай со слова ${role}.`;
        promptsSeen.push(event.systemPrompt);
        toolsSeen.push(pi.getActiveTools());
      });
      pi.on("agent_before_settle", async (event) => {
        if (steered) return;
        steered = true;
        const agentText = event.context.llmMessages
          .filter((m) => m.role === "assistant")
          .map((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("") : ""))
          .at(-1) ?? "";
        supervisorVerdict = await supervise(agentText);
        log.push(`canContinue=${event.context.canContinue}`);
        return {
          entries: [{ type: "custom_message", customType: "teo-supervisor", display: true, content: "Замечание supervisor: допиши в конце ответа слово КОДОВОЕ-СЛОВО-42." }],
          continue: true,
        };
      });
    };

    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager: settings, noContextFiles: true, noSkills: true, noExtensions: true,
      extensionFactories: [{ name: "teo-host-spike", factory: host }],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd, agentDir, modelRuntime: models, model, tools: ["read", "ls", "grep"], resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd), settingsManager: settings,
    });
    await session.bindExtensions({ mode: "print" });
    const texts = () => session.messages.filter((m) => m.role === "assistant").map((m) => m.content.filter((b) => b.type === "text").map((b) => b.text).join(""));

    try {
      await session.prompt("Представься одной короткой фразой. Инструменты не используй.", { expandPromptTemplates: false });
      const afterFirst = texts();

      // Переход на следующий этап в той же сессии: другая роль и другой набор инструментов
      role = "РОЛЬ-Б";
      await session.prompt("Ещё раз представься одной короткой фразой. Инструменты не используй.", { expandPromptTemplates: false });
      const afterSecond = texts();

      const report = {
        firstRunAnswers: afterFirst.map((t) => t.slice(0, 120)),
        secondAnswer: afterSecond.at(-1)?.slice(0, 120),
        supervisorVerdict: supervisorVerdict.slice(0, 60),
        promptHasRoleA: promptsSeen[0]?.includes("РОЛЬ-А"),
        promptHasRoleB: promptsSeen.at(-1)?.includes("РОЛЬ-Б"),
        toolsSeen,
        providerTools,
        log,
      };
      console.log(JSON.stringify(report, null, 2));

      expect(report.promptHasRoleA).toBe(true);
      expect(report.promptHasRoleB).toBe(true);
      expect(supervisorVerdict.toUpperCase()).toContain("ПРОДОЛЖИТЬ");
      // После замечания supervisor-а агент продолжил тот же ход и выполнил его
      expect(afterFirst.length).toBeGreaterThanOrEqual(2);
      expect(afterFirst.at(-1)).toContain("КОДОВОЕ-СЛОВО-42");
      expect(afterFirst[0]).toContain("РОЛЬ-А");
      expect(afterSecond.at(-1)).toContain("РОЛЬ-Б");
      // Набор инструментов этапа доходит до провайдера в том же ходе
      expect(providerTools[0]?.sort()).toEqual(["ls", "read"]);
      expect(providerTools.at(-1)?.sort()).toEqual(["grep", "ls", "read"]);
    } finally {
      session.dispose();
    }
  }, 120_000);
});
