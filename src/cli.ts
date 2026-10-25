// Точка входа: разбор аргументов (commander), маппинг ошибок в exit codes (05-cli-ui.md §8).
// Единственное место, где разрешены process.exit и выбор кода выхода процесса.

import { Command, CommanderError, Option } from "commander";
import { createAppContext, type AppContext } from "./app.js";
import { runCancel } from "./commands/cancel.js";
import { runDoctor } from "./commands/doctor.js";
import { runHistory } from "./commands/history.js";
import { runInteractive } from "./commands/interactive.js";
import { runNew } from "./commands/new.js";
import { runRecover } from "./commands/recover.js";
import { runResume } from "./commands/run-task.js";
import { runStatus } from "./commands/status.js";
import { ExitCode, SdlcError } from "./errors/errors.js";
import { msg } from "./ui/messages.js";
import { renderError } from "./ui/plain/errors.js";
import { colorEnabled } from "./ui/plain/style.js";
import { runCleanup } from "./util/cleanup.js";
import { dispatchInterrupt } from "./util/interrupts.js";
import { closestMatch } from "./util/strings.js";

type GlobalOptions = { color?: boolean; plain?: boolean; verbose?: boolean };

function contextFor(cmd: Command): AppContext {
  const g = cmd.optsWithGlobals<GlobalOptions>();
  const tty = process.stdout.isTTY === true && process.stderr.isTTY === true;
  return createAppContext({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    color: colorEnabled({ isTTY: tty, env: process.env, flag: g.color !== false }),
    plain: g.plain === true,
    verbose: g.verbose === true,
  });
}

function reportError(ctx: AppContext, err: unknown): number {
  if (!(err instanceof SdlcError)) ctx.debugLog.write(`непредвиденная ошибка: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  ctx.stderr.write(
    renderError(err, { homeDir: ctx.homeDir, style: ctx.style, now: ctx.clock.now(), verbose: ctx.verbose, debugLogPath: ctx.debugLog.path }),
  );
  return err instanceof SdlcError ? err.exitCode : ExitCode.runtime;
}

/** Ошибки разбора аргументов commander → русский текст. */
function commanderErrorText(err: CommanderError): string {
  const text = err.message.replace(/^error:\s*/, "");
  const hint = (m: RegExpExecArray) => m[2]?.split(",")[0]?.trim() ?? null;
  const e = msg.cli.errors;
  let m: RegExpExecArray | null;
  if ((m = /unknown command '([^']+)'(?:\s*\(Did you mean (?:one of )?([^?]+)\?\))?/.exec(text))) {
    return e.unknownCommand(m[1] ?? "", hint(m));
  }
  if ((m = /unknown option '([^']+)'(?:\s*\(Did you mean (?:one of )?([^?]+)\?\))?/.exec(text))) {
    return e.unknownOption(m[1] ?? "", hint(m));
  }
  if ((m = /missing required argument '([^']+)'/.exec(text))) return e.missingArgument(m[1] ?? "");
  if ((m = /option '([^']+)' argument missing/.exec(text))) return e.optionMissingArgument(m[1] ?? "");
  if (err.code === "commander.excessArguments") return e.excessArguments;
  if (err.code === "commander.invalidArgument") return e.invalidArgument(text);
  return text;
}

export async function main(argv: readonly string[]): Promise<number> {
  let exitCode: number = ExitCode.ok;
  const run = (fn: (ctx: AppContext, cmd: Command) => Promise<number>) => async (...args: unknown[]) => {
    const cmd = args.at(-1) as Command;
    const ctx = contextFor(cmd);
    try {
      exitCode = await fn(ctx, cmd);
    } catch (err) {
      exitCode = reportError(ctx, err);
    } finally {
      ctx.human?.close();
    }
  };

  const program = new Command("sdlc")
    .description(msg.cli.description)
    .version(__SDLC_VERSION__, "-V, --version", msg.cli.version)
    .helpOption("-h, --help", msg.cli.help)
    .helpCommand("help [command]", msg.cli.helpCommand)
    .configureHelp({ styleTitle: (title) => msg.cli.helpTitles[title] ?? title })
    .configureOutput({ outputError: () => undefined })
    .showSuggestionAfterError(true)
    .exitOverride()
    .option("--no-color", msg.cli.noColor)
    .option("--plain", msg.cli.plain)
    .option("-v, --verbose", msg.cli.verbose)
    // Без команды — интерактивное меню. Лишние слова — это опечатка в имени команды:
    // commander в таком случае жалуется на лишние аргументы, а не на неизвестную команду.
    .allowExcessArguments(true)
    .action(async (_opts: unknown, cmd: Command) => {
      const [first] = cmd.args;
      if (first !== undefined) {
        const names = cmd.commands.map((c) => c.name());
        process.stderr.write(`${msg.cli.errors.unknownCommand(first, closestMatch(first, names))}\n${msg.cli.errors.seeHelp}\n`);
        exitCode = ExitCode.runtime;
        return;
      }
      await run((ctx) => runInteractive(ctx))(cmd);
    });

  program
    .command("new")
    .description(msg.cli.cmdNew)
    .argument("[KEY]", msg.cli.argKey)
    .option("--title <title>", msg.cli.optTitle)
    .addOption(new Option("--description-file <file>", msg.cli.optDescriptionFile).conflicts("description"))
    .option("--description <text>", msg.cli.optDescription)
    .option("--no-run", "создать задачу без запуска workflow")
    .action(
      run((ctx, cmd) => {
        const o = cmd.opts<{ title?: string; descriptionFile?: string; description?: string; run?: boolean }>();
        const key = cmd.args[0];
        return runNew(ctx, {
          ...(key !== undefined ? { key } : {}),
          ...(o.title !== undefined ? { title: o.title } : {}),
          ...(o.descriptionFile !== undefined ? { descriptionFile: o.descriptionFile } : {}),
          ...(o.description !== undefined ? { description: o.description } : {}),
          ...(o.run === false ? { noRun: true } : {}),
        });
      }),
    );

  program
    .command("resume")
    .description(msg.cli.cmdResume)
    .argument("<KEY>", msg.cli.argKey)
    .option("--now", msg.cli.optNow)
    .option("--no-wait", msg.cli.optNoWait)
    .action(run((ctx, cmd) => {
      const o = cmd.opts<{ now?: boolean; wait?: boolean }>();
      return runResume(ctx, cmd.args[0] ?? "", { checkNow: o.now === true, noWait: o.wait === false });
    }));

  program
    .command("status")
    .description(msg.cli.cmdStatus)
    .argument("[KEY]", msg.cli.argKey)
    .option("--json", msg.cli.json)
    .action(run((ctx, cmd) => runStatus(ctx, cmd.args[0], { json: cmd.opts<{ json?: boolean }>().json === true })));

  program
    .command("history")
    .description(msg.cli.cmdHistory)
    .argument("[KEY]", msg.cli.argKey)
    .option("--all", msg.cli.optAll)
    .option("--json", msg.cli.json)
    .option("--limit <n>", msg.cli.optLimit)
    .action(
      run((ctx, cmd) => {
        const o = cmd.opts<{ all?: boolean; json?: boolean; limit?: string }>();
        return runHistory(ctx, cmd.args[0], {
          all: o.all === true,
          json: o.json === true,
          ...(o.limit !== undefined ? { limit: o.limit } : {}),
        });
      }),
    );

  program
    .command("cancel")
    .description(msg.cli.cmdCancel)
    .argument("<KEY>", msg.cli.argKey)
    .option("--reason <reason>", msg.cli.optReason)
    .action(
      run((ctx, cmd) => {
        const reason = cmd.opts<{ reason?: string }>().reason;
        return runCancel(ctx, cmd.args[0] ?? "", reason !== undefined ? { reason } : {});
      }),
    );

  program
    .command("recover")
    .description(msg.cli.cmdRecover)
    .argument("<KEY>", msg.cli.argKey)
    .option("--set-stage <stage>", msg.cli.optSetStage)
    .option("--accept-policy", msg.cli.optAcceptPolicy)
    .action(
      run((ctx, cmd) => {
        const o = cmd.opts<{ setStage?: string; acceptPolicy?: boolean }>();
        return runRecover(ctx, cmd.args[0] ?? "", {
          ...(o.setStage !== undefined ? { setStage: o.setStage } : {}),
          ...(o.acceptPolicy === true ? { acceptPolicy: true } : {}),
        });
      }),
    );

  program
    .command("doctor")
    .description(msg.cli.cmdDoctor)
    .option("--fix", msg.cli.optFix)
    .action(run((ctx, cmd) => runDoctor(ctx, { fix: cmd.opts<{ fix?: boolean }>().fix === true })));

  try {
    await program.parseAsync([...argv]);
  } catch (err) {
    if (!(err instanceof CommanderError)) throw err;
    if (err.code === "commander.helpDisplayed" || err.code === "commander.help" || err.code === "commander.version") {
      return ExitCode.ok;
    }
    process.stderr.write(`${commanderErrorText(err)}\n${msg.cli.errors.seeHelp}\n`);
    return ExitCode.runtime;
  }
  return exitCode;
}

/** Остановка по сигналу: освободить lock и выйти (03-engine.md §9). Повторный сигнал — немедленный выход. */
let stopping = false;
for (const [signal, code] of [
  ["SIGINT", ExitCode.sigint],
  ["SIGTERM", ExitCode.sigterm],
  ["SIGHUP", ExitCode.sigterm],
] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(code);
    stopping = true;
    if (dispatchInterrupt(signal === "SIGINT" ? "SIGINT" : "SIGTERM")) return;
    void runCleanup().finally(() => process.exit(code));
  });
}

main(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(msg.unexpectedError(err instanceof Error ? (err.stack ?? err.message) : String(err)) + "\n");
    process.exit(ExitCode.runtime);
  },
);
