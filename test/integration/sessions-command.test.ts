import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../../src/agents/fake/fake-runtime.js";
import { createTask } from "../../src/commands/new.js";
import { runSessions } from "../../src/commands/sessions.js";
import { ExtensionHost } from "../../src/extension/host.js";
import { extensionAppContext } from "../../src/extension/run-command.js";
import { fakeCtx, FakePi } from "../helpers/fake-pi.js";
import { validDir } from "../helpers/paths.js";
import { sandbox, type Sandbox } from "../helpers/tmp.js";

const DED = readFileSync(path.join(validDir, "discover-execute-done.md"), "utf8");

async function setupProject(sb: Sandbox) {
  const pi = new FakePi();
  const host = new ExtensionHost(pi.api, sb.home, () => new FakeAgentRuntime());
  host.register();
  return { pi, host };
}

describe("Команды просмотра сессий и возобновления по номеру", () => {
  it("teo sessions выводит пронумерованный список в CLI", async () => {
    const sb = await sandbox(DED, { process: "dev" });
    const { ctx: app } = extensionAppContext(sb.project, sb.home);
    const { store } = await (await import("../../src/app.js")).startCommand(app);
    await createTask(store, { key: "TASK-ALPHA", title: "Первая задача", description: "Описание", process: "dev" });
    await createTask(store, { key: "TASK-BETA", title: "Вторая задача", description: "Описание", process: "dev" });

    const out: string[] = [];
    const appWithCapture = {
      ...app,
      stdout: { write: (s: string) => void out.push(s) } as never,
    };

    const code = await runSessions(appWithCapture, { json: false });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("Сессии teo (2):");
    expect(text).toContain("[1]");
    expect(text).toContain("TASK-");
    expect(text).toContain("[2]");
    expect(text).toContain("teo resume <номер>");
  });

  it("teo resume по номеру (teo resume 1) находит задачу", async () => {
    const sb = await sandbox(DED, { process: "dev" });
    const { ctx: app } = extensionAppContext(sb.project, sb.home);
    const { store } = await (await import("../../src/app.js")).startCommand(app);
    await createTask(store, { key: "KINOMAX-ALPHA", title: "Киномакс", description: "Описание", process: "dev" });

    // resume по "1" находит KINOMAX-ALPHA
    const resolved = await store.requireKey("1");
    expect(resolved).toBe("KINOMAX-ALPHA");
  });

  it("/teo sessions в Pi показывает интерактивный выбор и возобновляет задачу", async () => {
    const sb = await sandbox(DED, { process: "dev" });
    const { ctx: app } = extensionAppContext(sb.project, sb.home);
    const { store } = await (await import("../../src/app.js")).startCommand(app);
    await createTask(store, { key: "MY-TASK-1", title: "Тест 1", description: "Описание", process: "dev" });

    const { pi, host } = await setupProject(sb);
    const ctx = fakeCtx(pi, {
      cwd: sb.project,
      ui: {
        answers: ["[1] MY-TASK-1 · dev · Изучение задачи · ○ ждёт запуска агента · Тест 1"],
      },
    });

    await host.sessions(ctx);
    expect(host.boundKey).toBe("MY-TASK-1");
    await host.detach();
  });

  it("/teo resume без аргументов открывает список для выбора задачи", async () => {
    const sb = await sandbox(DED, { process: "dev" });
    const { ctx: app } = extensionAppContext(sb.project, sb.home);
    const { store } = await (await import("../../src/app.js")).startCommand(app);
    await createTask(store, { key: "MY-TASK-2", title: "Тест 2", description: "Описание", process: "dev" });

    const { pi, host } = await setupProject(sb);
    const ctx = fakeCtx(pi, {
      cwd: sb.project,
      ui: {
        answers: ["[1] MY-TASK-2 · dev · Изучение задачи · ○ ждёт запуска агента · Тест 2"],
      },
    });

    await host.resume(ctx, undefined);
    expect(host.boundKey).toBe("MY-TASK-2");
    await host.detach();
  });

  it("/teo resume 1 возобновляет первую задачу по номеру", async () => {
    const sb = await sandbox(DED, { process: "dev" });
    const { ctx: app } = extensionAppContext(sb.project, sb.home);
    const { store } = await (await import("../../src/app.js")).startCommand(app);
    await createTask(store, { key: "MY-TASK-3", title: "Тест 3", description: "Описание", process: "dev" });

    const { pi, host } = await setupProject(sb);
    const ctx = fakeCtx(pi, { cwd: sb.project });

    await host.resume(ctx, "1");
    expect(host.boundKey).toBe("MY-TASK-3");
    await host.detach();
  });
});
