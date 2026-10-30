// Критерии готовности M1 (06-implementation.md §3): любая команда с невалидной Policy
// завершается с кодом 2 и не создаёт .teo; doctor печатает все ошибки с номерами строк.

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
  { name: "каталог вместо файла", setup: (sb) => mkdir(sb.policyPath).then(() => undefined) },
  { name: "пустой файл", setup: () => undefined, policy: "" },
  { name: "без front matter", setup: () => undefined, policy: fixture("POLICY_NO_FRONT_MATTER--no-opening") },
  { name: "битый YAML", setup: () => undefined, policy: fixture("POLICY_YAML") },
  { name: "ошибки схемы", setup: () => undefined, policy: fixture("POLICY_SCHEMA--values") },
  { name: "ошибки графа", setup: () => undefined, policy: fixture("POLICY_GRAPH--several") },
];

async function teoCreatedAnywhere(sb: Sandbox): Promise<boolean> {
  const walk = async (dir: string): Promise<boolean> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === ".teo") return true;
      if (e.isDirectory() && e.name !== ".git" && (await walk(path.join(dir, e.name)))) return true;
    }
    return false;
  };
  return walk(sb.root);
}

describe("невалидная Policy → exit 2, .teo не создан", () => {
  for (const bad of BAD_POLICIES) {
    it.each(COMMANDS.map((c) => [c.join(" ") || "(без аргументов)", c]))(`${bad.name}: teo %s`, async (_label, args) => {
      const sb = await sandbox(bad.policy);
      await bad.setup(sb);
      const r = await runCli(sb, args as string[]);
      expect(r.code, r.stdout + r.stderr).toBe(2);
      expect(await teoCreatedAnywhere(sb)).toBe(false);
      const out = r.stdout + r.stderr;
      expect(out.includes(sb.policyPath) || out.includes(sb.processesDir) || out.includes("~/.pi/teo")).toBe(true);
    });
  }
});

describe("сообщение об ошибке Policy", () => {
  it("своих процессов нет: new без --goal — каталог, причина и следующий шаг", async () => {
    const sb = await sandbox();
    const r = await runCli(sb, ["new", "T-1", "--title", "t", "--description", "d"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      [
        "Ошибка конфигурации процесса",
        "",
        `Каталог процессов: ${sb.processesDir}`,
        "В каталоге процессов нет ни одного процесса (файла <процесс>.md).",
        "",
        "Ничего не запущено, .teo не изменён.",
        "Добавьте процесс в ~/.pi/teo и повторите команду, например: cp examples/processes/dev.md ~/.pi/teo/dev.md",
        'Или поставьте задачу целью без процесса: teo new KEY --goal "…"',
        "",
      ].join("\n"),
    );
    expect(await teoCreatedAnywhere(sb)).toBe(false);
  });

  it("своих процессов нет: остальные команды работают в режиме цели (D35)", async () => {
    const sb = await sandbox();
    expect((await runCli(sb, ["status"])).code).toBe(0);
    const menu = await runCli(sb, []);
    expect(menu.code).toBe(0);
    expect(menu.stdout).toContain("Процессы: goal (встроенный: teo new --goal)");
    expect((await runCli(sb, ["resume", "T-1"])).code).toBe(4);
    const doctor = await runCli(sb, ["doctor"]);
    expect(doctor.stdout).toContain("· Своих процессов нет: в ~/.pi/teo нет ни одного файла <процесс>.md. Доступен режим цели (teo new --goal)");
    expect(doctor.stdout).toMatch(/^✓ Процесс goal \(встроенный, режим цели\)/m);
    expect(await teoCreatedAnywhere(sb)).toBe(false);
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
      "Исправьте ~/.pi/teo/test.md и повторите команду. Проверка: teo doctor",
    ]) {
      expect(r.stderr).toContain(line);
    }
    expect(r.stderr).not.toContain("\u001b[");
  });
});

describe("teo doctor", () => {
  it("валидная Policy без авторизации Pi: показывает ошибки моделей, ничего не создаёт", async () => {
    const sb = await sandbox(readFileSync(examplePolicy));
    const r = await runCli(sb, ["doctor"]);
    expect(r.code, r.stderr).toBe(1);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain("✓ Pi SDK 1.4.0 загружается");
    expect(r.stdout).toMatch(/^✓ Node.js \d+\.\d+\.\d+ \(нужно ≥ 22\.19\.0\)$/m);
    expect(r.stdout).toMatch(/^✓ Процесс test · ~\/\.pi\/teo\/test\.md · sha256:[0-9a-f]{4}…[0-9a-f]{2} · 8 этапов, 5 агентов$/m);
    expect(r.stdout).toContain(`✓ Проект ${sb.project} (корень git-репозитория)`);
    expect(r.stdout).toContain("✗ Модель default недоступна или не авторизована");
    expect(existsSync(path.join(sb.project, ".teo"))).toBe(false);
  });

  it("каждую ошибку Policy печатает с номером строки, exit 2", async () => {
    const sb = await sandbox(fixture("POLICY_SCHEMA--values"));
    const r = await runCli(sb, ["doctor"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("✗ Процесс test · ~/.pi/teo/test.md");
    expect(r.stdout).toContain("Policy невалидна (17 проблем):");
    const located = r.stdout.split("\n").filter((l) => /^\s+✗ \S+ \(строка \d+\)$/.test(l));
    expect(located).toHaveLength(17);
    // Вторая ошибка — модель встроенного процесса цели без авторизации Pi в песочнице
    expect(r.stdout).toContain("✗ Модель default недоступна или не авторизована");
    expect(r.stdout).toContain("Итог: 2 ошибки, 0 предупреждений.");
  });

  it("предупреждения Policy не превращаются в ошибки Policy; Pi проверяется отдельно", async () => {
    const text = readFileSync(path.join(validDir, "discover-execute-done.md"), "utf8").replace(
      "agents:\n",
      "agents:\n  spare:\n    instructions: запасной\n",
    );
    const sb = await sandbox(text);
    const r = await runCli(sb, ["doctor"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("! Процесс test: 1 предупреждение");
    expect(r.stdout).toMatch(/! agents\.spare \(строка \d+\)/);
    expect(r.stdout).toContain("✗ Модель default недоступна или не авторизована");
  });

  it("проект вне git — текущий каталог", async () => {
    const sb = await sandbox(readFileSync(examplePolicy), { git: false });
    const r = await runCli(sb, ["doctor"]);
    expect(r.stdout).toContain(`Проект ${sb.project} (текущий каталог, git-репозиторий не найден)`);
  });

  it("--fix без .teo: исправлять нечего, каталог не создаётся", async () => {
    const sb = await sandbox(readFileSync(examplePolicy));
    const r = await runCli(sb, ["doctor", "--fix"]);
    expect(r.stdout).toContain("Исправлять нечего.");
    expect(existsSync(path.join(sb.project, ".teo"))).toBe(false);
  });
});

describe("интерфейс CLI на русском", () => {
  it("справка", async () => {
    const sb = await sandbox();
    const r = await runCli(sb, ["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Использование: teo");
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
    expect(r.stderr).toBe("Неизвестная команда «resum». Возможно, имелась в виду «resume».\nСправка: teo --help\n");
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

  it("валидная Policy: resume отсутствующей задачи → exit 4 без создания .teo", async () => {
    const sb = await sandbox(readFileSync(examplePolicy));
    const r = await runCli(sb, ["resume", "T-1"]);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("Задача T-1 не найдена");
    expect(existsSync(path.join(sb.project, ".teo"))).toBe(false);
  });
});
