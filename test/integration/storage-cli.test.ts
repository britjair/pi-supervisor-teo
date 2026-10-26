// Критерии готовности M2 (06-implementation.md §3): две задачи видны в меню; второй процесс
// получает exit 3 на mutating-команду и выполняет status; убийство процесса между записью state
// и append события не теряет событие (outbox).

import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runInteractive } from "../../src/commands/interactive.js";
import type { TaskState } from "../../src/domain/task-state.js";
import { LockManager } from "../../src/state/lock-manager.js";
import { projectLayout } from "../../src/state/layout.js";
import { systemClock } from "../../src/util/clock.js";
import { testContext } from "../helpers/context.js";
import { deadPid } from "../helpers/dead-pid.js";
import { validDir } from "../helpers/paths.js";
import { ScriptedHumanIO } from "../helpers/scripted-human-io.js";
import { runCli, sandbox, type Sandbox } from "../helpers/tmp.js";

const POLICY = readFileSync(path.join(validDir, "discover-execute-done.md"));

const newArgs = (key: string, title = `Задача ${key}`) => ["new", key, "--title", title, "--description", `Описание ${key}`, "--no-run"];

async function withTasks(...keys: string[]): Promise<Sandbox> {
  const sb = await sandbox(POLICY);
  for (const key of keys) {
    const r = await runCli(sb, newArgs(key));
    expect(r.code, r.stderr).toBe(0);
  }
  return sb;
}

const taskDir = (sb: Sandbox, key: string) => path.join(sb.project, ".teo", "tasks", key);
const readState = async (sb: Sandbox, key: string) =>
  JSON.parse(await readFile(path.join(taskDir(sb, key), "state.json"), "utf8")) as TaskState;
const journal = async (sb: Sandbox, key: string) =>
  (await readFile(path.join(taskDir(sb, key), "events.jsonl"), "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { id: string; type: string });

function holdLock(sb: Sandbox, taskKey: string | null) {
  return new LockManager({
    file: projectLayout(sb.project).lock,
    clock: systemClock,
    hostname: os.hostname(),
    pid: process.pid,
    processStartedAt: systemClock.now().toISOString(),
  }).acquire({ command: "resume", taskKey });
}

describe("создание задач и меню", () => {
  it("две задачи создаются и видны в меню без терминала, в status и history", async () => {
    const sb = await withTasks("PAY-142", "AUTH-77");
    const menu = await runCli(sb, []);
    expect(menu.code).toBe(0);
    expect(menu.stdout).toContain("Задачи в работе: 2");
    expect(menu.stdout).toMatch(/AUTH-77\s+test\s+Изучение задачи\s+○ ждёт запуска агента\s+Задача AUTH-77/);
    expect(menu.stdout).toMatch(/PAY-142\s+test\s+Изучение задачи/);
    expect(menu.stdout).toContain("teo new KEY --title T --description-file F");
    expect((await runCli(sb, ["status"])).stdout).toContain("Задачи в работе: 2");
    expect((await runCli(sb, ["history"])).stdout).toContain("Задачи проекта: 2");

    const status = await runCli(sb, ["status", "pay-142"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("PAY-142 · Задача PAY-142");
    expect(status.stdout).toContain("Следующее действие: запустить agent explorer");
    const json = JSON.parse((await runCli(sb, ["status", "PAY-142", "--json"])).stdout) as {
      state: TaskState;
      policy: { matches: boolean };
      nextAction: { kind: string; text: string };
    };
    expect(json.state.version).toBe(1);
    expect(json.policy.matches).toBe(true);
    expect(json.nextAction).toMatchObject({ kind: "start_agent", agentId: "explorer", text: "запустить agent explorer" });
  });

  it("меню в терминале: обе задачи в списке, создание третьей через форму", async () => {
    const sb = await withTasks("PAY-142", "AUTH-77");
    const human = new ScriptedHumanIO([
      { select: "Создать новую задачу" },
      { select: "test — начальный этап" },
      { input: "CRM-12" },
      { input: "Экспорт заказов в CSV" },
      { multiline: "Выгрузка заказов\nза период" },
      { select: "Создать" },
    ]);
    const ctx = testContext(sb, { human });
    const execute = vi.fn(async () => 0);
    expect(await runInteractive(ctx, { execute })).toBe(0);
    expect(execute).toHaveBeenCalledWith(ctx, expect.anything(), "CRM-12");
    expect(human.remaining).toBe(0);
    const [firstMenu] = human.printed.split("Новая задача");
    expect(firstMenu).toContain("PAY-142");
    expect(firstMenu).toContain("AUTH-77");
    expect(human.printed).toContain("Начальный этап: Изучение задачи (agent: explorer)");
    expect(human.printed).toContain("✓ Задача CRM-12 создана");
    expect(await readFile(path.join(taskDir(sb, "CRM-12"), "task.md"), "utf8")).toContain("Выгрузка заказов\nза период");
    expect((await runCli(sb, ["status"])).stdout).toContain("Задачи в работе: 3");
  });

  it("меню: дубликат ключа без учёта регистра отклоняется в форме", async () => {
    const sb = await withTasks("PAY-142");
    const human = new ScriptedHumanIO([{ select: "Создать новую задачу" }, { select: "test — начальный этап" }, { input: "pay-142" }]);
    await expect(runInteractive(testContext(sb, { human }))).rejects.toThrow(/уже есть в проекте/);
  });

  it("пустой проект: сразу форма, «Отмена» возвращает в меню, .teo не создан", async () => {
    const sb = await sandbox(POLICY);
    const human = new ScriptedHumanIO([
      { select: "test — начальный этап" },
      { input: "T-1" },
      { input: "t" },
      { multiline: "d" },
      { select: "Отмена" },
      { select: "Выход" },
    ]);
    expect(await runInteractive(testContext(sb, { human }))).toBe(0);
    expect(existsSync(path.join(sb.project, ".teo"))).toBe(false);
  });

  it("меню: отмена задачи, завершённые задачи в подменю", async () => {
    const sb = await withTasks("T-1", "T-2");
    const human = new ScriptedHumanIO([
      { select: "T-1" },
      { select: "Отменить задачу" },
      { input: "Больше не нужна" },
      { confirm: true },
      { select: "Показать завершённые задачи (1)" },
      { select: "T-1" },
      { select: "Показать историю" },
      { select: "Назад" },
      { select: "Выход" },
    ]);
    expect(await runInteractive(testContext(sb, { human }))).toBe(0);
    expect(human.printed).toContain("✓ Задача T-1 отменена.");
    expect(human.printed).toMatch(/task\.cancelled\s+отменена \(human\): Больше не нужна/);
    expect((await readState(sb, "T-1")).status).toBe("cancelled");
    expect((await readState(sb, "T-2")).status).toBe("active");
  });

  it("new из stdin и из файла; ошибки ввода без терминала", async () => {
    const sb = await sandbox(POLICY);
    expect((await runCli(sb, ["new", "A-1", "--title", "a", "--description", "-", "--no-run"], { input: "из stdin\n" })).code).toBe(0);
    expect(await readFile(path.join(taskDir(sb, "A-1"), "task.md"), "utf8")).toContain("## Описание\n\nиз stdin\n");
    await writeFile(path.join(sb.project, "d.txt"), "из файла");
    expect((await runCli(sb, ["new", "A-2", "--title", "b", "--description-file", "d.txt", "--no-run"])).code).toBe(0);

    const bad = async (args: string[]) => {
      const r = await runCli(sb, args);
      expect(r.code).toBe(1);
      return r.stderr;
    };
    expect(await bad(["new", "a-1", "--title", "x", "--description", "y"])).toContain("уже есть в проекте");
    expect(await bad(["new", "../x", "--title", "x", "--description", "y"])).toContain("Ключ: латинские буквы");
    expect(await bad(["new", "A-3", "--description", "y"])).toContain("Не указано: --title");
    expect(await bad(["new", "A-3", "--title", "x", "--description", "-"])).toContain("Описание не может быть пустым.");
    expect(await bad(["new", "A-3", "--title", "x", "--description-file", "nope.txt"])).toContain("Не удалось прочитать файл описания");
    expect(await bad(["new", "A-3", "--title", "x", "--description", "y", "--description-file", "d.txt"])).toMatch(/нельзя|одновременно|cannot/i);
    expect((await runCli(sb, ["status"])).stdout).toContain("Задачи в работе: 2");
  });
});

describe("второй процесс", () => {
  it("lock держит живой процесс: mutating-команды → exit 3, status/history/doctor работают", async () => {
    const sb = await withTasks("T-1", "T-2");
    const before = await readState(sb, "T-1");
    const lock = await holdLock(sb, "T-1");
    try {
      for (const args of [newArgs("T-3"), ["cancel", "T-1", "--reason", "r"]]) {
        const r = await runCli(sb, args);
        expect(r.code, r.stderr).toBe(3);
        expect(r.stderr).toContain("Проект занят другим процессом teo");
        expect(r.stderr).toContain(`PID ${process.pid} на ${os.hostname()}, задача T-1, команда resume`);
        expect(r.stderr).toContain("Посмотреть состояние: teo status T-1");
      }
      expect(existsSync(taskDir(sb, "T-3"))).toBe(false);
      expect(await readState(sb, "T-1")).toEqual(before);

      const status = await runCli(sb, ["status", "T-1"]);
      expect(status.code).toBe(0);
      expect(status.stdout).toMatch(new RegExp(`Lock:\\s+PID ${process.pid} на .+ · задача T-1 · heartbeat`));
      expect((await runCli(sb, ["status"])).code).toBe(0);
      expect((await runCli(sb, ["history", "T-1"])).code).toBe(0);
      const doctor = await runCli(sb, ["doctor"]);
      expect(doctor.code).toBe(1); // нет авторизации Pi в изолированном HOME
      expect(doctor.stdout).toContain("✗ Модель default недоступна или не авторизована");
      expect(doctor.stdout).toContain(`· Проект занят: PID ${process.pid}`);
    } finally {
      await lock.release();
    }
    expect((await runCli(sb, ["cancel", "T-1", "--reason", "r"])).code).toBe(0);
    expect(existsSync(projectLayout(sb.project).lock)).toBe(false);
  });

  it("одновременные процессы: каждый либо создал задачу, либо получил exit 3; хранилище целое", async () => {
    const sb = await sandbox(POLICY);
    const keys = ["P-1", "P-2", "P-3", "P-4", "P-5", "P-6"];
    const results = await Promise.all(keys.map((k) => runCli(sb, newArgs(k))));
    for (const r of results) expect([0, 3], r.stderr).toContain(r.code);
    const created = keys.filter((_, i) => results[i]?.code === 0);
    expect(created.length).toBeGreaterThan(0);
    expect((await readdir(path.join(sb.project, ".teo", "tasks"))).sort()).toEqual(created.sort());
    const doctor = await runCli(sb, ["doctor"]);
    expect(doctor.code, doctor.stdout).toBe(1); // хранение исправно, Pi без авторизации
    expect(doctor.stdout).toContain("✓ Журналы событий целы, outbox доставлен");
    expect(doctor.stdout).toContain("✗ Модель default недоступна или не авторизована");
  });

  it("протухший lock умершего процесса забирается автоматически", async () => {
    const sb = await withTasks("T-1");
    await writeFile(
      projectLayout(sb.project).lock,
      JSON.stringify({
        pid: await deadPid(),
        hostname: os.hostname(),
        processStartedAt: "2026-10-25T09:00:00.000Z",
        taskKey: "T-1",
        command: "resume",
        acquiredAt: "2026-10-25T09:00:00.000Z",
        heartbeatAt: "2026-10-25T09:00:00.000Z",
        nonce: "dead",
      }),
    );
    expect((await runCli(sb, ["doctor"])).stdout).toContain("! Протухший lock");
    const r = await runCli(sb, ["cancel", "T-1", "--reason", "r"]);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(projectLayout(sb.project).lock)).toBe(false);
  });
});

describe("убийство процесса между записью state и append события", () => {
  it("создание: событие task.created доставляется из outbox следующей mutating-командой", async () => {
    const sb = await sandbox(POLICY);
    const killed = await runCli(sb, newArgs("T-1"), { env: { TEO_FAULT: "after-state-commit:kill" } });
    expect(killed.signal).toBe("SIGKILL");

    const state = await readState(sb, "T-1");
    expect(state.outbox.map((e) => e.type)).toEqual(["task.created"]);
    expect(await journal(sb, "T-1")).toEqual([]);
    // Lock остался от убитого процесса
    expect(existsSync(projectLayout(sb.project).lock)).toBe(true);

    // Только чтение: журнал не меняется, недоставленное видно
    expect((await runCli(sb, ["status", "T-1"])).stdout).toMatch(/Последнее событие:\s+\S+ task\.created \(ещё не в журнале\)/);
    expect((await runCli(sb, ["history", "T-1"])).stdout).toMatch(/task\.created\s+создана: .*\(ещё не в журнале\)/);
    const doctor = await runCli(sb, ["doctor"]);
    expect(doctor.stdout).toContain("T-1: 1 событие outbox не доставлено в журнал");
    expect(doctor.stdout).toContain("! Протухший lock");
    expect(await journal(sb, "T-1")).toEqual([]);

    // Отмена тоже убита после записи state: сначала под lock-ом доставлен task.created,
    // затем записан state отмены, а его события остались в outbox
    const killedCancel = await runCli(sb, ["cancel", "T-1", "--reason", "дубль"], { env: { TEO_FAULT: "after-state-commit:kill" } });
    expect(killedCancel.signal).toBe("SIGKILL");
    expect((await journal(sb, "T-1")).map((e) => e.type)).toEqual(["task.created"]);
    expect((await readState(sb, "T-1")).status).toBe("cancelled");

    // Отменённую задачу mutating-команды не загружают: повторная отмена отказывает до lock-а
    const again = await runCli(sb, ["cancel", "T-1", "--reason", "ещё раз"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("уже отменена");
    expect((await journal(sb, "T-1")).map((e) => e.type)).toEqual(["task.created"]);

    // Любая mutating-команда под lock-ом доставляет outbox всех задач проекта
    expect((await runCli(sb, newArgs("T-2"))).code).toBe(0);
    const events = await journal(sb, "T-1");
    expect(events.map((e) => e.type)).toEqual(["task.created", "human.responded", "task.cancelled"]);
    expect(new Set(events.map((e) => e.id)).size).toBe(3);
    expect([...events.map((e) => e.id)].sort()).toEqual(events.map((e) => e.id));
    expect((await runCli(sb, ["doctor"])).stdout).toContain("✓ Журналы событий целы, outbox доставлен");
  });

  it("после append, до index: событие не дублируется, index перестраивается", async () => {
    const sb = await withTasks("T-1");
    const killed = await runCli(sb, ["cancel", "T-1", "--reason", "r"], { env: { TEO_FAULT: "after-event-append:kill" } });
    expect(killed.signal).toBe("SIGKILL");
    expect((await runCli(sb, ["doctor"])).stdout).toContain("! .teo/index.json расходится с задачами");
    await runCli(sb, newArgs("T-2"));
    expect((await journal(sb, "T-1")).map((e) => e.type)).toEqual(["task.created", "human.responded", "task.cancelled"]);
    expect((await runCli(sb, ["doctor"])).stdout).toContain("✓ .teo/index.json согласован с задачами");
  });
});

describe("хранилище", () => {
  it(".teo игнорирует сам себя: git status проекта чистый", async () => {
    const sb = await withTasks("T-1");
    expect(await readFile(path.join(sb.project, ".teo", ".gitignore"), "utf8")).toBe("*\n");
    const { runProcess } = await import("../helpers/tmp.js");
    expect((await runProcess("git", ["status", "--porcelain"], sb.project)).stdout).toBe("");
    expect(await readdir(path.join(sb.project, ".teo", "policies"))).toHaveLength(1);
  });

  it("осиротевшие временные файлы умерших процессов видны в doctor и удаляются под lock-ом", async () => {
    const sb = await withTasks("T-1");
    const pid = await deadPid();
    const tmpFile = path.join(taskDir(sb, "T-1"), `.state.json.${pid}.abcdef.tmp`);
    const tmpNew = path.join(sb.project, ".teo", "tasks", `.new-${pid}-abcd-T-9`);
    await writeFile(tmpFile, "{}");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(tmpNew);
    const doctor = await runCli(sb, ["doctor"]);
    expect(doctor.stdout).toContain("· Осиротевших временных файлов: 2");
    await runCli(sb, newArgs("T-2"));
    expect(existsSync(tmpFile)).toBe(false);
    expect(existsSync(tmpNew)).toBe(false);
  });

  it("повреждённая задача: ⚠ в списке, exit 4 при обращении, ошибка в doctor", async () => {
    const sb = await withTasks("T-1", "T-2");
    await writeFile(path.join(taskDir(sb, "T-2"), "state.json"), "{");
    expect((await runCli(sb, ["status"])).stdout).toContain("⚠ T-2 повреждена");
    const r = await runCli(sb, ["status", "T-2"]);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("Задача T-2 повреждена: state.json не разбирается как JSON");
    const doctor = await runCli(sb, ["doctor"]);
    expect(doctor.code).toBe(1);
    expect(doctor.stdout).toContain("✗ Повреждённых задач: 1");

    await writeFile(path.join(taskDir(sb, "T-1"), "events.jsonl"), "{битая\n" + (await readFile(path.join(taskDir(sb, "T-1"), "events.jsonl"), "utf8")));
    const h = await runCli(sb, ["history", "T-1"]);
    expect(h.code).toBe(4);
    expect(h.stderr).toContain("строка 1");
  });

  it("history: лимит, --all, --json", async () => {
    const sb = await withTasks("T-1");
    await runCli(sb, ["cancel", "T-1", "--reason", "r"]);
    expect((await runCli(sb, ["history", "T-1", "--limit", "1"])).stdout).toContain("Журнал T-1: последние 1 из 3");
    expect((await runCli(sb, ["history", "T-1", "--all"])).stdout).toContain("Журнал T-1: 3 события");
    const json = JSON.parse((await runCli(sb, ["history", "T-1", "--json"])).stdout) as Array<{ type: string; undelivered: boolean }>;
    expect(json.map((e) => [e.type, e.undelivered])).toEqual([
      ["task.created", false],
      ["human.responded", false],
      ["task.cancelled", false],
    ]);
    expect((await runCli(sb, ["history", "T-1", "--limit", "0"])).code).toBe(1);
  });
});
