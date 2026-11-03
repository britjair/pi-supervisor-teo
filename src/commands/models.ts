// teo models cooldown / teo models reset: ручное управление cooldown-ами лимитов
// (docs/08-model-profiles.md §5). Команды не трогают .teo и не требуют lock-а проекта:
// cooldown-ы глобальные, в ~/.pi/teo/model-cooldowns.json.

import type { AppContext } from "../app.js";
import { ExitCode, UsageError } from "../errors/errors.js";
import { msg } from "../ui/messages.js";
import { table } from "../ui/plain/task-views.js";
import { cooldownFilePath } from "../util/model-cooldown-store.js";
import { defaultCooldownTracker, PROBE_SCHEDULE_MS } from "../util/model-exhaustion.js";

function remainingText(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч ${minutes % 60} мин`;
  return `${Math.floor(hours / 24)} сут ${hours % 24} ч`;
}

/** Разобрать `provider` или `provider/model`. */
function parseTarget(input: string | undefined): { provider?: string; modelId?: string } {
  if (!input) return {};
  const trimmed = input.trim();
  if (!trimmed) return {};
  const slash = trimmed.indexOf("/");
  if (slash === -1) return { provider: trimmed };
  const provider = trimmed.slice(0, slash);
  const modelId = trimmed.slice(slash + 1);
  if (!provider || !modelId) throw new UsageError(msg.models.badTarget(trimmed));
  return { provider, modelId };
}

export async function runModelsCooldown(ctx: AppContext, opts: { json?: boolean } = {}): Promise<number> {
  const now = ctx.clock.now().getTime();
  const records = defaultCooldownTracker.list(now);
  if (opts.json) {
    ctx.stdout.write(
      `${JSON.stringify(
        {
          file: cooldownFilePath(ctx.homeDir),
          records: records.map((r) => ({
            provider: r.provider,
            modelId: r.modelId,
            scope: r.modelId === null ? "provider" : "model",
            resetAt: new Date(r.exhaustedUntil).toISOString(),
            remainingMs: Math.max(0, r.exhaustedUntil - now),
            attempt: r.attempt,
            probeSteps: PROBE_SCHEDULE_MS.length,
            reason: r.reason,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return ExitCode.ok;
  }
  if (records.length === 0) {
    ctx.stdout.write(`${msg.models.noCooldowns}\n`);
    return ExitCode.ok;
  }
  const rows = [[msg.models.colTarget, msg.models.colScope, msg.models.colUntil, msg.models.colRemaining, msg.models.colAttempt]];
  for (const r of records) {
    rows.push([
      r.modelId === null ? `${r.provider}/*` : `${r.provider}/${r.modelId}`,
      r.modelId === null ? msg.models.scopeProvider : msg.models.scopeModel,
      new Date(r.exhaustedUntil).toISOString(),
      remainingText(r.exhaustedUntil - now),
      `${r.attempt}/${PROBE_SCHEDULE_MS.length}`,
    ]);
  }
  for (const line of table(rows)) ctx.stdout.write(`${line}\n`);
  ctx.stdout.write(`\n${msg.models.cooldownFile(cooldownFilePath(ctx.homeDir))}\n`);
  return ExitCode.ok;
}

export async function runModelsReset(ctx: AppContext, target: string | undefined, opts: { all?: boolean } = {}): Promise<number> {
  const { provider, modelId } = parseTarget(target);
  if (!provider && !opts.all) throw new UsageError(msg.models.resetNeedsTarget);
  if (provider && opts.all) throw new UsageError(msg.models.resetAllConflict);
  const removed = defaultCooldownTracker.reset(provider, modelId, ctx.clock.now().getTime());
  ctx.stdout.write(`${removed === 0 ? msg.models.resetNothing : msg.models.resetDone(removed)}\n`);
  return ExitCode.ok;
}
