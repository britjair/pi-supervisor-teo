// Критерии готовности M1 (06-implementation.md §3): любая команда с невалидной Policy
// завершается с кодом 2 и не создаёт .sdlc; doctor печатает все ошибки с номерами строк.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { examplePolicy, invalidDir, validDir } from "../helpers/paths.js";
import { runCli, sandbox, type Sandbox } from "../helpers/tmp.js";

const COMMANDS: string[][] = [
  [],
  ["new", "T-1", "--title", "t", "--description", "-"],
  ["new"],
  ["resume", "T-1"],
  ["resume", "T-1", "--now"],
  ["status"],
  ["status", "T-1", "--json"],
  ["history"],
  ["history", "T-1", "--all", "--json", "--limit", "5"],
  ["cancel", "T-1", "--reason", "r"],
  ["recover", "T-1", "--set-stage", "x"],
  ["doctor"],
  ["--plain", "-v", "status"],
];

const fixture = (name: string) => readFileSync(path.join(invalidDir, `${name}.md`));

const BAD_POLICIES: Array<{ name: string; setup: (sb: Sandbox) => Promise<void> | void; policy?: Uint8Array | string }> = [
  { name: "нет файла", setup: () => undefined },
  { name: "каталог вместо файла", setup: (sb) => mkdir(sb.policyPath).then(() => undefined) },
  { name: "пустой файл", setup: () => undefined, policy: "" },
  { name: "без front matter", setup: () => undefined, policy: fixture("POLICY_NO_FRONT_MATTER--no-opening") },
  { name: "битый YAML", setup: () => undefined, policy: fixture("POLICY_YAML") },
  { name: "ошибки схемы", setup: () => undefined, policy: fixture("POLICY_SCHEMA--values") },
  { name: "ошибки графа", setup: () => undefined, policy: fixture("POLICY_GRAPH--several") },
];

async function sdlcCreatedAnywhere(sb: Sandbox): Promise<boolean> {
  const walk = async (dir: string): Promise<boolean> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === ".sdlc") return true;
      if (e.isDirectory() && e.name !== ".git" && (await walk(path.join(dir, e.name)))) return true;
    }
    return false;
  };
  return walk(sb.root);
}

describe("невалидная Policy → exit 2, .sdlc не создан", () => {
  for (const bad of BAD_POLICIES) {
    it.each(COMMANDS.map((c) => [c.join(" ") || "(без аргументов)", c]))(`${bad.name}: sdlc %s`, async (_label, args) => {
      const sb = await sandbox(bad.policy);
      await bad.setup(sb);
      const r = await runCli(sb, args as string[]);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(await sdlcCreatedAnywhere(sb)).toBe(false);
      const out = r.stdout + r.stderr;
      expect(out.includes(sb.policyPath) || out.includes("~/.pi/SDLC.md")).toBe(true);
    });
  }
});

describe("сообщение об ошибке Policy", () => {
  it("нет файла: путь, причина и следующий шаг", async () => {
    const sb = await sandbox();
    const r = await runCli(sb, ["status"]);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      [
        "Ошибка конфигурации SDLC",
        "",
        `Файл: ${sb.policyPath}`,
        "Обязательный файл не найден.",
        "",
        "Ничего не запущено, .sdlc не изменён.",
        "Создайте ~/.pi/SDLC.md и повторите команду. Автоматически он не создаётся.",
        "",
      ].join("\n"),
    );
  });

  it("все ошибки с путями и номерами строк, затем предупреждения", async () => {
    const sb = await sandbox(fixture("POLICY_GRAPH--several"));
    const r = await runCli(sb, ["resume", "T-1"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Policy невалидна (4 проблемы):");
    for (const line of [
      "✗ workflow.stages.review.transitions[1].to (строка 19)",
      "Этап «qa_redy» не существует. Возможно, имелось в виду «qa_ready».",
      "✗ workflow.stages.fixing.agent (строка 23)",
      "✗ workflow.stages.qa_ready.agent (строка 29)",
      "✗ workflow.initialStage (строка 5)",
      "! workflow.stages.qa_ready (строка 27)",
      "Исправьте ~/.pi/SDLC.md и повторите команду. Проверка: sdlc doctor",
    ]) {
      expect(r.stderr).toContain(line);
    }
    expect(r.stderr).not.toContain("\u001b[");
  });
});

describe("sdlc doctor", () => {
  it("валидная Policy пользователя: всё ✓, exit 0, ничего не создаёт", async () => {
    const sb = await sandbox(readFileSync(examplePolicy));
    const r = await runCli(sb, ["doctor"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^✓ Node\.js \d+\.\d+\.\d+ \(нужно ≥ 22\.19\.0\)$/m);
    expect(r.stdout).toMatch(/^✓ Policy ~\/\.pi\/SDLC\.md · sha256:[0-9a-f]{4}…[0-9a-f]{2} · 8 этапов, 5 агентов$/m);
    expect(r.stdout).toContain(`✓ Project root ${sb.project} (корень git-репозитория)`);
    expect(r.stdout).toContain("Итог: проблем не найдено.");
    expect(existsSync(path.join(sb.project, ".sdlc"))).toBe(false);
  });

  it("каждую ошибку Policy печатает с номером строки, exit 2", async () => {
    const sb = await sandbox(fixture("POLICY_SCHEMA--values"));
    const r = await runCli(sb, ["doctor"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("✗ Policy ~/.pi/SDLC.md");
    expect(r.stdout).toContain("Policy невалидна (16 проблем):");
    const located = r.stdout.split("\n").filter((l) => /^\s+✗ \S+ \(строка \d+\)$/.test(l));
    expect(located).toHaveLength(16);
    expect(r.stdout).toContain("Итог: 1 ошибка, 0 предупреждений.");
  });

  it("предупреждения Policy не дают ошибки", async () => {
    const text = readFileSync(path.join(validDir, "discover-execute-done.md"), "utf8").replace(
      "agents:\n",
      "agents:\n  spare:\n    instructions: запасной\n",
    );
    const sb = await sandbox(text);
    const r = await runCli(sb, ["doctor"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("! 1 предупреждение");
    expect(r.stdout).toMatch(/! agents\.spare \(строка \d+\)/);
    expect(r.stdout).toContain("Итог: 0 ошибок, 1 предупреждение.");
  });

  it("проект вне git — текущий каталог", async () => {
    const sb = await sandbox(readFileSync(examplePolicy), { git: false });
    const r = await runCli(sb, ["doctor"]);
    expect(r.stdout).toContain(`Project root ${sb.project} (текущий каталог, git-репозиторий не найден)`);
  });

  it("--fix пока не реализован и ничего не меняет", async () => {
    const sb = await sandbox(readFileSync(examplePolicy));
    const r = await runCli(sb, ["doctor", "--fix"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("doctor --fix ещё не реализован");
  });
});

describe("интерфейс CLI на русском", () => {
  it("справка", async () => {
    const sb = await sandbox();
    const r = await runCli(sb, ["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Использование: sdlc");
    expect(r.stdout).toContain("Команды:");
    expect(r.stdout).toContain("диагностика окружения, Policy и хранилища");
    expect(r.stdout).not.toMatch(/Usage:|Options:|Commands:/);
  });

  it("справка по команде", async () => {
    const sb = await sandbox();
    const r = await runCli(sb, ["help", "resume"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Аргументы:");
    expect(r.stdout).toContain("--no-wait");
  });

  it("неизвестная команда с подсказкой", async () => {
    const sb = await sandbox();
    const r = await runCli(sb, ["resum", "T-1"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("Неизвестная команда «resum». Возможно, имелась в виду «resume».\nСправка: sdlc --help\n");
  });

  it("неизвестный параметр и отсутствующий аргумент", async () => {
    const sb = await sandbox();
    expect((await runCli(sb, ["status", "--jsn"])).stderr).toContain("Неизвестный параметр «--jsn». Возможно, имелся в виду «--json».");
    expect((await runCli(sb, ["resume"])).stderr).toContain("Не указан обязательный аргумент «KEY».");
  });

  it("версия", async () => {
    const sb = await sandbox();
    const r = await runCli(sb, ["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("валидная Policy: команды-заглушки честно сообщают, что не реализованы", async () => {
    const sb = await sandbox(readFileSync(examplePolicy));
    const r = await runCli(sb, ["status"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("Команда «status» ещё не реализована.\n");
    expect(existsSync(path.join(sb.project, ".sdlc"))).toBe(false);
  });
});
