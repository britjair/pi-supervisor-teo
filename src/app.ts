// Composition root: собирает сервисы и общий контекст команд. Решений не принимает.
// Ink сюда не импортируется: контекст нужен и расширению Pi, у которого свой интерфейс.
// Интерактивный HumanIO передаёт вызывающий код (cli.ts) фабрикой AppOptions.human.

import os from "node:os";
import type { Readable, Writable } from "node:stream";
import { ProcessCatalog, defaultProcessesDir, type ProcessEntry } from "./policy/process-catalog.js";
import { detectProjectRoot, type ProjectRoot } from "./project/project-root.js";
import { ProjectStore } from "./state/project-store.js";
import type { HumanIO } from "./ui/human-io.js";
import { createStyle, type Style } from "./ui/plain/style.js";
import { systemClock, type Clock } from "./util/clock.js";
import { execFileNoThrow, type Exec } from "./util/exec.js";
import { faultsFromEnv, type FaultInjector } from "./util/fault.js";
import { DebugLog } from "./util/debug-log.js";
import { createIdGenerator, type IdGenerator } from "./util/ids.js";

export type Output = { write(chunk: string): unknown; isTTY?: boolean };

export type ProcessInfo = { pid: number; hostname: string; startedAt: string };

export type AppContext = {
  cwd: string;
  homeDir: string;
  env: Record<string, string | undefined>;
  stdin: Readable;
  stdout: Output;
  stderr: Output;
  /** Терминал на входе и выходе: можно задавать вопросы; --plain выбирает линейный HumanIO. */
  interactive: boolean;
  /** null без терминала: команды, которым нужен ответ человека, требуют флагов */
  human: HumanIO | null;
  verbose: boolean;
  style: Style;
  clock: Clock;
  ids: IdGenerator;
  faults: FaultInjector;
  exec: Exec;
  process: ProcessInfo;
  nodeVersion: string;
  /** Каталог процессов ~/.pi/teo/ (D32) */
  processes: ProcessCatalog;
  /** .teo/debug.log: пишется всегда, в stderr — только с --verbose */
  debugLog: DebugLog;
  log(message: string): void;
};

export type AppOptions = {
  cwd?: string;
  /** Для embedding/tests; CLI и расширение по умолчанию используют домашний каталог процесса. */
  homeDir?: string;
  env?: Record<string, string | undefined>;
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable & { isTTY?: boolean };
  color: boolean;
  plain: boolean;
  verbose: boolean;
  /** Диалог с человеком в терминале; без фабрики — только неинтерактивный режим */
  human?: (io: { stdin: Readable; stdout: Writable; stderr: Writable; clock: Clock; style: Style; plain: boolean }) => HumanIO;
};

export type HumanFactory = NonNullable<AppOptions["human"]>;

export function createAppContext(o: AppOptions): AppContext {
  // os.homedir() учитывает HOME: так тесты подменяют каталог процессов ~/.pi/teo (01-policy.md §1.1)
  const homeDir = o.homeDir ?? os.homedir();
  const env = o.env ?? process.env;
  const style = createStyle(o.color);
  const interactive = o.stdin.isTTY === true && o.stdout.isTTY === true;
  const clock = systemClock;
  const debugLog = new DebugLog(() => clock.now());
  return {
    cwd: o.cwd ?? process.cwd(),
    homeDir,
    env,
    stdin: o.stdin,
    stdout: o.stdout,
    stderr: o.stderr,
    interactive,
    human: interactive && o.human ? o.human({ stdin: o.stdin, stdout: o.stdout, stderr: o.stderr, clock, style, plain: o.plain }) : null,
    verbose: o.verbose,
    style,
    clock,
    ids: createIdGenerator(clock),
    faults: faultsFromEnv(env["TEO_FAULT"]),
    exec: execFileNoThrow,
    process: { pid: process.pid, hostname: os.hostname(), startedAt: clock.now().toISOString() },
    nodeVersion: process.versions.node,
    processes: new ProcessCatalog(defaultProcessesDir(homeDir)),
    debugLog,
    log: (message) => {
      debugLog.write(message);
      if (o.verbose) o.stderr.write(style.dim(`[teo] ${message}`) + "\n");
    },
  };
}

export type Preflight = { project: ProjectRoot; processes: ProcessEntry[] };

/**
 * Общий старт команд (05-cli-ui.md §1): project root (только чтение), затем preflight всех процессов.
 * - Своих процессов нет — не ошибка: доступен встроенный режим цели (D35). Ошибку даёт только
 *   `teo new` без `--goal` (chooseProcess).
 * - Свои процессы есть, но ни один не валиден → PolicyError (exit 2) до любой записи в .teo:
 *   сломанный файл процесса — ошибка конфигурации, её нельзя пропустить молча.
 * - Невалидный процесс при наличии валидных не мешает (D41): его задачи помечаются,
 *   а команда над такой задачей получает ошибку процесса через store.policyOf().
 */
export async function preflight(ctx: AppContext): Promise<Preflight> {
  const project = await detectProjectRoot(ctx.cwd, ctx.exec);
  const processes = await ctx.processes.loadAll();
  const own = processes.filter((p) => !p.builtin);
  const broken = own.find((p) => !p.ok);
  if (broken && !broken.ok && !own.some((p) => p.ok)) throw broken.error;
  // Встроенный процесс невалиден — это ошибка сборки пакета, а не конфигурации пользователя
  const builtinBroken = processes.find((p) => p.builtin && !p.ok);
  if (builtinBroken && !builtinBroken.ok) throw builtinBroken.error;
  return { project, processes };
}

/** Хранилище проекта. Ничего не создаёт: .teo появляется при первой mutating-операции. */
export function openProject(ctx: AppContext, pf: { project: ProjectRoot; processes: readonly ProcessEntry[] }): ProjectStore {
  const store = new ProjectStore({
    projectRoot: pf.project.root,
    processes: pf.processes,
    processesDir: ctx.processes.dir,
    clock: ctx.clock,
    ids: ctx.ids,
    faults: ctx.faults,
    hostname: ctx.process.hostname,
    pid: ctx.process.pid,
    processStartedAt: ctx.process.startedAt,
    log: ctx.log,
  });
  ctx.debugLog.attach(store.layout.debugLog);
  return store;
}

/** preflight + хранилище проекта: начало любой команды, кроме doctor. */
export async function startCommand(ctx: AppContext): Promise<Preflight & { store: ProjectStore }> {
  const pf = await preflight(ctx);
  return { ...pf, store: openProject(ctx, pf) };
}
