// Plain CLI → workflow engine на реальном Pi. Lock удерживается до исхода или остановки.
import path from "node:path";
import { PiAgentRuntime } from "../agents/pi/pi-agent-runtime.js";
import { startCommand, type AppContext } from "../app.js";
import { ExitCode, UsageError } from "../errors/errors.js";
import type { ProjectStore } from "../state/project-store.js";
import { PlainReporter } from "../ui/plain/plain-reporter.js";
import { codexResetProbe } from "../util/codex-usage.js";
import { setInterruptHandler } from "../util/interrupts.js";
import { Engine } from "../workflow/engine.js";
import { RECOVER_ONLY_CODES, unblockTask } from "../workflow/manual.js";
import { exitCodeFor } from "../workflow/outcome.js";

export async function executeTask(ctx: AppContext, store: ProjectStore, key: string, options: { noWait?: boolean; checkNow?: boolean } = {}): Promise<number> {
  // Процесс задачи проверяется до lock-а: его ошибка — exit 2 без изменений в .teo
  store.policyOf((await store.tasks.readState(key)).process);
  const pi = new PiAgentRuntime({ agentDir: ctx.env["PI_CODING_AGENT_DIR"] ?? path.join(ctx.homeDir, ".pi", "agent"), cwd: store.layout.projectRoot });
  try {
    return await store.withLock({ command: "resume", taskKey: key }, async (lock) => {
      const state = await store.tasks.load(key);
      if (state.status === "blocked" && RECOVER_ONLY_CODES.includes(state.statusReason?.code ?? "")) {
        throw new UsageError(`Задачу ${key} (${state.statusReason?.code}) можно восстановить только командой: teo recover ${key}`);
      }
      if (state.status === "blocked") {
        if (!ctx.human) {
          ctx.stdout.write(`Задача ${key} заблокирована: ${state.statusReason?.message ?? "причина неизвестна"}. Для разблокировки запустите teo resume ${key} в терминале.\n`);
          return ExitCode.waitingHuman;
        }
        ctx.human.print(`Задача ${key} заблокирована: ${state.statusReason?.message ?? "причина неизвестна"}`);
        const note = await ctx.human.multiline("Что изменилось?", { validate: (text) => text.trim() ? null : "Нужен комментарий." });
        await unblockTask(store, key, note);
      }
      const waitControl = ctx.human?.waitControl?.();
      const reporter = ctx.human?.reporter?.(key) ?? new PlainReporter(ctx.stdout, ctx.clock);
      reporter.context({
        key,
        stage: state.stage,
        stageTitle: store.stageTitle(state.process, state.stage) ?? state.stage,
        agent: state.currentRun ? `${state.currentRun.agentId}#${state.currentRun.attempt}` : null,
      });
      const engine = new Engine({
        key, store, runtime: pi, policy: store.policyOf(state.process), loadPolicy: () => ctx.processes.load(state.process),
        human: ctx.human,
        reporter,
        ...(waitControl ? { waitControl } : {}),
        clock: ctx.clock,
        ids: ctx.ids, exec: ctx.exec, style: ctx.style, faults: ctx.faults, lockSignal: lock.signal,
        providerReset: codexResetProbe(ctx.homeDir),
        options: { noWait: options.noWait ?? false, checkNow: options.checkNow ?? false },
        confirmPolicy: ctx.human ? async (change) => ctx.human!.confirm(`Policy изменилась (${change.fromHash} → ${change.toHash}). Применить новую версию?`, false) : null,
      });
      const clear = setInterruptHandler((signal) => engine.interrupt(signal));
      try { return exitCodeFor(await engine.run()); }
      finally { clear(); }
    });
  } finally {
    await pi.dispose();
  }
}

export async function runResume(ctx: AppContext, keyInput: string, opts: { noWait?: boolean; checkNow?: boolean }): Promise<number> {
  const { store } = await startCommand(ctx);
  const key = await store.requireKey(keyInput);
  await store.tasks.readState(key); // не создавать .teo и lock для несуществующей задачи
  return executeTask(ctx, store, key, opts);
}
