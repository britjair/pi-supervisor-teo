// Несколько процессов в ~/.pi/teo/ (docs/07-extension-mode.md §3, D32, D41).

import { readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInteractive } from "../../src/commands/interactive.js";
import type { TaskState } from "../../src/domain/task-state.js";
import { ProcessCatalog } from "../../src/policy/process-catalog.js";
import { testContext } from "../helpers/context.js";
import { invalidDir, validDir } from "../helpers/paths.js";
import { ScriptedHumanIO } from "../helpers/scripted-human-io.js";
import { runCli, sandbox, type Sandbox } from "../helpers/tmp.js";

const DED = readFileSync(path.join(validDir, "discover-execute-done.md"));
const SDS = readFileSync(path.join(validDir, "sketch-deliver-shipped.md"));
const BROKEN = readFileSync(path.join(invalidDir, "POLICY_SCHEMA--values.md"));

/** Процесс dev (discover → execute → done) и delivery (sketch → deliver → shipped). */
async function twoProcesses(): Promise<Sandbox> {
  const sb = await sandbox(DED, { process: "dev" });
  await writeFile(path.join(sb.processesDir, "delivery.md"), SDS);
  return sb;
}

const newArgs = (key: string, process?: string) => [
  "new", key, "--title", `Задача ${key}`, "--description", "d", "--no-run", ...(process ? ["--process", process] : []),
];
const state = async (sb: Sandbox, key: string) =>
  JSON.parse(await readFile(path.join(sb.project, ".teo", "tasks", key, "state.json"), "utf8")) as TaskState;

describe("несколько процессов", () => {
  it("задача запоминает процесс; без терминала при нескольких процессах --process обязателен", async () => {
    const sb = await twoProcesses();
    const ambiguous = await runCli(sb, newArgs("A-1"));
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toContain("Процессов несколько, без терминала укажите --process: delivery, dev.");

    expect((await runCli(sb, newArgs("A-1", "dev"))).code).toBe(0);
    expect((await runCli(sb, newArgs("B-1", "delivery"))).code).toBe(0);
    expect(await state(sb, "A-1")).toMatchObject({ process: "dev", stage: "discover" });
    expect(await state(sb, "B-1")).toMatchObject({ process: "delivery", stage: "sketch" });
    const created = (await readFile(path.join(sb.project, ".teo", "tasks", "B-1", "events.jsonl"), "utf8")).split("\n")[0] ?? "";
    expect(JSON.parse(created).payload).toMatchObject({ process: "delivery", stage: "sketch" });
    expect(await readFile(path.join(sb.project, ".teo", "tasks", "B-1", "task.md"), "utf8")).toContain("Process: delivery");

    // Меню и сводка: процесс и этап из Policy своего процесса
    const menu = await runCli(sb, []);
    expect(menu.stdout).toContain("Процессы: delivery (3 этапа), dev (3 этапа), goal (встроенный: teo new --goal)");
    expect(menu.stdout).toMatch(/A-1\s+dev\s+Изучение задачи/);
    expect(menu.stdout).toMatch(/B-1\s+delivery\s+Набросок/);
    const status = await runCli(sb, ["status", "B-1"]);
    expect(status.stdout).toMatch(/^Процесс:\s+delivery$/m);
    expect(status.stdout).toContain("Набросок (sketch)");
    expect(JSON.parse((await runCli(sb, ["status", "B-1", "--json"])).stdout).policy).toMatchObject({ process: "delivery", matches: true });
  });

  it("единственный процесс выбирается сам; неизвестный --process — ошибка конфигурации", async () => {
    const sb = await sandbox(DED, { process: "dev" });
    expect((await runCli(sb, newArgs("A-1"))).code).toBe(0);
    expect((await state(sb, "A-1")).process).toBe("dev");
    const unknown = await runCli(sb, newArgs("A-2", "nope"));
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain(`Файл: ${path.join(sb.processesDir, "nope.md")}`);
  });

  it("в терминале процесс выбирается в форме", async () => {
    const sb = await twoProcesses();
    const human = new ScriptedHumanIO([
      { select: "delivery — начальный этап «Набросок»" },
      { input: "B-7" },
      { input: "Доставка" },
      { multiline: "описание" },
      { select: "Создать" },
    ]);
    const ctx = testContext(sb, { human });
    expect(await runInteractive(ctx, { execute: async () => 0 })).toBe(0);
    expect(human.remaining).toBe(0);
    expect(human.printed).toContain("Процесс: delivery");
    expect(human.printed).toContain("Начальный этап: Набросок (agent: drafter)");
    expect((await state(sb, "B-7")).process).toBe("delivery");
  });

  it("невалидный процесс: его задачи помечены, задачи других процессов работают (D41)", async () => {
    const sb = await twoProcesses();
    await runCli(sb, newArgs("A-1", "dev"));
    await runCli(sb, newArgs("B-1", "delivery"));
    await writeFile(path.join(sb.processesDir, "delivery.md"), BROKEN);

    const menu = await runCli(sb, []);
    expect(menu.code).toBe(0);
    expect(menu.stdout).toContain("delivery (⚠ ошибка Policy)");
    expect(menu.stdout).toMatch(/B-1\s+delivery\s+⚠ процесс «delivery» с ошибками/);
    expect(menu.stdout).toMatch(/A-1\s+dev\s+Изучение задачи/);
    expect((await runCli(sb, ["status"])).code).toBe(0);
    expect((await runCli(sb, ["status", "A-1"])).code).toBe(0);

    // Команды над задачей невалидного процесса — exit 2, state не меняется
    const before = await state(sb, "B-1");
    for (const args of [["status", "B-1"], ["history", "B-1"], ["resume", "B-1"], ["cancel", "B-1", "--reason", "r"], ["recover", "B-1", "--set-stage", "deliver"]]) {
      const r = await runCli(sb, args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr).toContain(path.join(sb.processesDir, "delivery.md"));
    }
    expect((await runCli(sb, newArgs("B-2", "delivery"))).code).toBe(2);
    expect(await state(sb, "B-1")).toEqual(before);
  });

  it("файл процесса удалён: задача помечена, команды над ней — exit 2", async () => {
    const sb = await twoProcesses();
    await runCli(sb, newArgs("B-1", "delivery"));
    await rm(path.join(sb.processesDir, "delivery.md"));
    expect((await runCli(sb, [])).stdout).toMatch(/B-1\s+delivery\s+⚠ процесс «delivery» не найден/);
    const r = await runCli(sb, ["status", "B-1"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Обязательный файл не найден.");
  });

  it("resume берёт Policy процесса задачи", async () => {
    const sb = await twoProcesses();
    await runCli(sb, newArgs("B-1", "delivery"));
    // Модель не авторизована: движок блокирует задачу на агенте её процесса, без вызова API
    const r = await runCli(sb, ["resume", "B-1", "--plain"]);
    expect(r.code).toBe(5);
    expect((await state(sb, "B-1")).statusReason?.message).toContain("агента drafter");
  });

  it("doctor проверяет каждый процесс и показывает файлы с недопустимым именем", async () => {
    const sb = await twoProcesses();
    await writeFile(path.join(sb.processesDir, "Bad Name.md"), DED);
    await writeFile(path.join(sb.processesDir, "broken.md"), BROKEN);
    const r = await runCli(sb, ["doctor"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/^✓ Процесс delivery · ~\/\.pi\/teo\/delivery\.md · sha256:\S+ · 3 этапа, 2 агента$/m);
    expect(r.stdout).toMatch(/^✓ Процесс dev · ~\/\.pi\/teo\/dev\.md/m);
    expect(r.stdout).toContain("✗ Процесс broken · ~/.pi/teo/broken.md");
    expect(r.stdout).toContain("! Файлы с недопустимым именем процесса пропущены (1)");
    expect(r.stdout).toContain("    Bad Name.md");
  });
});

describe("ProcessCatalog", () => {
  it("нет каталога — нет процессов; *.md с допустимым именем — процессы по алфавиту", async () => {
    const sb = await sandbox();
    expect(await new ProcessCatalog(path.join(sb.home, "nope"), null).loadAll()).toEqual([]);
    await writeFile(path.join(sb.processesDir, "zeta.md"), DED);
    await writeFile(path.join(sb.processesDir, "alpha.md"), "");
    await writeFile(path.join(sb.processesDir, "notes.txt"), "x");
    await writeFile(path.join(sb.processesDir, ".hidden.md"), DED);
    await writeFile(path.join(sb.processesDir, "UPPER.md"), DED);
    const catalog = new ProcessCatalog(sb.processesDir, null);
    expect(await catalog.scan()).toEqual({ names: ["alpha", "zeta"], badNames: ["UPPER.md"] });
    const all = await catalog.loadAll();
    expect(all.map((p) => [p.name, p.ok])).toEqual([["alpha", false], ["zeta", true]]);
    const [alpha] = all;
    expect(alpha?.ok === false && alpha.error.code).toBe("POLICY_EMPTY");
  });
});
