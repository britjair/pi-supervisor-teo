// Supervisor step, 03-engine.md §5: supervisor_pending → supervisor_running → decision_pending.

import path from "node:path";
import { evaluationPrompt, protocolRetryPrompt, providerRetryPrompt, type TriggerData } from "../agents/prompts/supervisor-prompts.js";
import { servesExtensionlessSession } from "../agents/pi/provider-traits.js";
import { ModelUnavailableError, type ModelRef, type ResolvedModel } from "../agents/runtime.js";
import { supervisorSessionSpec } from "../agents/session-spec.js";
import type { TaskEvent } from "../domain/events.js";
import { getStage } from "../domain/policy.js";
import { haltedState, type TaskState } from "../domain/task-state.js";
import { argsPreview, redactString, truncate } from "../util/redact.js";
import { resolveModelChain } from "../policy/models-config.js";
import {
  defaultCooldownTracker,
  exhaustionScope,
  isModelExhaustedError,
  parseResetCooldownMs,
} from "../util/model-exhaustion.js";
import type { EngineCore } from "./context.js";
import type { ExitOutcome } from "./outcome.js";
import { InterruptRequest } from "./outcome.js";

const RECENT_EVENTS = 10;

export const supervisorRunKey = (cycle: number) => `supervisor:${cycle}`;

function supervisorModelTimeoutMs(core: EngineCore): number {
  const runtime = core.policy.spec.runtime;
  return Math.min(runtime.supervisorTimeoutMinutes, runtime.supervisorModelTimeoutMinutes) * 60_000;
}

async function block(core: EngineCore, state: TaskState, code: string, message: string): Promise<ExitOutcome> {
  await core.store.tasks.commit(core.key, (s, c) => {
    c.emit("task.blocked", "cli", { code, message, by: "cli" });
    return haltedState(s, "blocked", { code, message, at: c.now });
  }, { expectedVersion: state.version });
  return { kind: "blocked", code };
}

function supervisorModelRef(core: EngineCore, refString?: string): ModelRef {
  const sv = core.policy.spec.supervisor;
  return { ref: refString ?? sv.model, thinking: sv.thinking, extensions: sv.piResources.extensions === "inherit" };
}

export type SupervisorModelCheck = {
  ref: string;
  resolvedModel: string | null;
  status: "selected" | "cooldown" | "unavailable" | "incompatible" | "unusable" | "canary";
  reason: string;
  cooldown?: {
    scope: "provider" | "model";
    resetAt: string;
    remainingMs: number;
    resetKnown: boolean;
    resetDetail: string | null;
    nextProbeAt: string;
  };
};

type ModelSelection =
  | { kind: "selected"; model: ResolvedModel; index: number; ref: string; checks: SupervisorModelCheck[]; canary: boolean }
  | { kind: "exhausted"; earliestResetMs: number; resetKnown: boolean; resetDetail: string | null; checks: SupervisorModelCheck[] }
  | { kind: "unavailable"; error: string; checks: SupervisorModelCheck[] };

/**
 * Модели, которые в этом процессе не смогли обслужить supervisor не из-за лимита.
 * Типичный случай — провайдер-расширение вроде claude-bridge: он проецирует системный промпт,
 * записанный в before_agent_start хост-сессии Pi, а сессия supervisor-а создаётся отдельно и всегда
 * без расширений — капчи нет, и мост отказывается работать.
 * Набор живёт в памяти процесса: это свойство связки «провайдер + роль», а не состояние аккаунта,
 * поэтому на диск он не пишется и сбрасывается перезапуском.
 */
const unusableForSupervisor = new Map<string, string>();

/** Только для тестов и повторных прогонов в одном процессе. */
export function resetUnusableSupervisorModels(): void {
  unusableForSupervisor.clear();
}

async function selectSupervisorModel(core: EngineCore, chain: string[]): Promise<ModelSelection> {
  let lastError = "Нет доступных моделей для supervisor-а";
  const now = core.clock.now().getTime();
  const checks: SupervisorModelCheck[] = [];
  const cooldownCandidates: Array<{ model: ResolvedModel; index: number; ref: string; provider: string; modelId: string; record: NonNullable<ReturnType<typeof defaultCooldownTracker.activeRecord>> }> = [];

  for (let i = 0; i < chain.length; i++) {
    const refStr = chain[i];
    if (!refStr) continue;
    try {
      const resolved = await core.runtime.resolveModel(supervisorModelRef(core, refStr));
      const [provider = "unknown", modelId = "unknown"] = resolved.id.split("/");
      if (!servesExtensionlessSession(provider)) {
        lastError = `${resolved.id} не обслуживает сессию supervisor-а без расширений Pi`;
        checks.push({ ref: refStr, resolvedModel: resolved.id, status: "incompatible", reason: lastError });
        continue;
      }
      const unusable = unusableForSupervisor.get(resolved.id);
      if (unusable) {
        lastError = `${resolved.id} не обслуживает supervisor: ${unusable}`;
        checks.push({ ref: refStr, resolvedModel: resolved.id, status: "unusable", reason: truncate(redactString(lastError), 300) });
        continue;
      }
      const record = defaultCooldownTracker.activeRecord(provider, modelId, now);
      if (record) {
        const resetKnown = defaultCooldownTracker.isResetKnown(record);
        const nextProbeAt = defaultCooldownTracker.probeDueAt(record);
        const scope = record.modelId === null ? "provider" : "model";
        checks.push({
          ref: refStr,
          resolvedModel: resolved.id,
          status: "cooldown",
          reason: `${scope === "provider" ? "cooldown провайдера" : "cooldown модели"}: ${truncate(redactString(record.reason), 200)}`,
          cooldown: {
            scope,
            resetAt: new Date(record.exhaustedUntil).toISOString(),
            remainingMs: Math.max(0, record.exhaustedUntil - now),
            resetKnown,
            resetDetail: record.resetDetail ?? null,
            nextProbeAt: new Date(nextProbeAt).toISOString(),
          },
        });
        cooldownCandidates.push({ model: resolved, index: i, ref: refStr, provider, modelId, record });
        continue;
      }
      checks.push({ ref: refStr, resolvedModel: resolved.id, status: "selected", reason: "модель доступна" });
      return { kind: "selected", model: resolved, index: i, ref: refStr, checks, canary: false };
    } catch (err) {
      if (err instanceof ModelUnavailableError) {
        lastError = truncate(redactString(err.message), 300);
        checks.push({ ref: refStr, resolvedModel: null, status: "unavailable", reason: lastError });
        continue;
      }
      throw err;
    }
  }

  // Если без cooldown цепочка полностью остановилась, разрешаем одну контролируемую проверку.
  // claimProbe бронирует её до запуска запроса и не даёт задачам процесса дублировать canary.
  const seenCooldowns = new Set<string>();
  for (const candidate of cooldownCandidates) {
    const key = candidate.record.modelId === null ? `${candidate.provider.toLowerCase()}/*` : `${candidate.provider.toLowerCase()}/${candidate.modelId.toLowerCase()}`;
    if (seenCooldowns.has(key)) continue;
    seenCooldowns.add(key);
    if (!defaultCooldownTracker.claimProbe(candidate.record, now)) continue;
    const check = checks.find((item) => item.ref === candidate.ref && item.resolvedModel === candidate.model.id);
    if (check) {
      check.status = "canary";
      check.reason = "наступил срок контролируемой проверки cooldown";
    }
    return { kind: "selected", model: candidate.model, index: candidate.index, ref: candidate.ref, checks, canary: true };
  }

  if (cooldownCandidates.length > 0) {
    const unique = [...new Map(cooldownCandidates.map((c) => [c.record.modelId === null ? `${c.provider.toLowerCase()}/*` : `${c.provider.toLowerCase()}/${c.modelId.toLowerCase()}`, c.record])).values()];
    const dueAt = Math.min(...unique.map((r) => Math.min(r.exhaustedUntil, defaultCooldownTracker.probeDueAt(r))));
    const dueRecord = unique.find((r) => Math.min(r.exhaustedUntil, defaultCooldownTracker.probeDueAt(r)) === dueAt) ?? unique[0]!;
    const wakeAtReset = dueAt >= dueRecord.exhaustedUntil;
    return {
      kind: "exhausted",
      earliestResetMs: Math.max(0, dueAt - now),
      resetKnown: wakeAtReset && defaultCooldownTracker.isResetKnown(dueRecord),
      resetDetail: wakeAtReset ? (dueRecord.resetDetail ?? null) : null,
      checks,
    };
  }
  return { kind: "unavailable", error: lastError, checks };
}

/**
 * Срок cooldown: сначала точная проба провайдера, затем текст ошибки, иначе null —
 * и тогда трекер берёт следующий шаг графика проб.
 */
async function recordModelChecks(core: EngineCore, checks: SupervisorModelCheck[]): Promise<void> {
  await core.store.tasks.appendDirect(core.key, "supervisor.models_checked", "cli", { role: "supervisor", checks });
}

function modelChecksSummary(checks: SupervisorModelCheck[]): string {
  const lines = checks.map((check) => {
    const model = check.resolvedModel ? `${check.ref} → ${check.resolvedModel}` : check.ref;
    if (check.status === "cooldown" && check.cooldown) {
      const minutes = Math.max(1, Math.ceil(check.cooldown.remainingMs / 60_000));
      return `• ${model} — ${check.cooldown.scope === "provider" ? "cooldown провайдера" : "cooldown модели"}, осталось ${minutes} мин`;
    }
    return `• ${model} — ${check.reason}`;
  });
  return `Supervisor не нашёл доступную модель:\n${lines.join("\n")}`;
}

async function resolveCooldownMs(core: EngineCore, provider: string, message: string): Promise<{ ms: number | null; detail: string | null }> {
  const now = core.clock.now().getTime();
  const probed = await core.providerReset?.(provider, now).catch(() => null);
  if (probed && probed.ms > 0) return { ms: probed.ms, detail: probed.detail };
  const parsed = parseResetCooldownMs(message, now);
  return { ms: parsed, detail: parsed === null ? null : "срок из ответа провайдера" };
}

const supervisorSessionFile = (core: EngineCore) => path.join(core.task().dir, "sessions", "supervisor.jsonl");

type SwitchResult = { kind: "switched" } | { kind: "exhausted"; error: string } | { kind: "not_applied"; model: string };

/**
 * Перейти на следующую модель цепочки и повторить тот же цикл на ней.
 * Общий путь для двух причин: исчерпание лимита и прочая ошибка провайдера после технических повторов.
 */
async function switchToNextModel(
  core: EngineCore,
  after: TaskState,
  mem: NonNullable<EngineCore["cycle"]>,
  runKey: string,
  fromModel: string,
  cause: "exhausted" | "provider_error",
  reason: string,
): Promise<SwitchResult> {
  const chain = mem.modelChain ?? [core.policy.spec.supervisor.model];
  const remainingChain = chain.slice((mem.modelChainIndex ?? 0) + 1);
  const selection = await selectSupervisorModel(core, remainingChain);
  await recordModelChecks(core, selection.checks);
  if (selection.kind !== "selected") {
    return {
      kind: "exhausted",
      error: selection.kind === "unavailable" ? selection.error : modelChecksSummary(selection.checks),
    };
  }
  const nextModel = selection.model;
  const spec = supervisorSessionSpec(core, nextModel);
  // Сессия кешируется по файлу: без переоткрытия запрос ушёл бы в прежнюю нерабочую модель.
  const handle = await core.pool.reopen(spec);
  const applied = core.pool.openedModel(spec.file) === nextModel.id;
  await core.store.tasks.appendDirect(core.key, "model.fallback", "cli", {
    role: "supervisor",
    fromModel: fromModel || "unknown",
    toModel: nextModel.id,
    applied,
    cause,
    reason,
  });
  if (!applied) return { kind: "not_applied", model: nextModel.id };

  core.reporter.emit({
    type: "info",
    text:
      cause === "exhausted"
        ? `Переключение supervisor-а на резервную модель ${nextModel.id} (лимит ${fromModel} исчерпан)`
        : `Переключение supervisor-а на резервную модель ${nextModel.id} (${fromModel} не обслуживает supervisor)`,
  });
  mem.modelUsed = nextModel.id;
  mem.modelChainIndex = (mem.modelChainIndex ?? 0) + 1 + selection.index;
  mem.modelAttemptStartedAtMs = core.clock.now().getTime();
  delete mem.lastProviderError;
  mem.technicalRetriesUsed = 0;

  const limits = core.policy.spec.runtime;
  const events = await core.events();
  const stage = getStage(core.policy.spec, after.stage);
  if (!stage || stage.kind !== "work") throw new Error("нет рабочего этапа для supervisor prompt");
  const fullPolicy = after.supervisor.lastPolicyHashShown !== after.policyHash;
  const prompt = evaluationPrompt({
    promptId: core.ids.next(),
    cycle: mem.cycle,
    key: after.key,
    title: after.title,
    version: after.version,
    now: core.clock.now(),
    policyHash: after.policyHash,
    policyRaw: fullPolicy ? core.policy.raw : null,
    spec: core.policy.spec,
    stage,
    stageEnteredAt: after.stageEnteredAt,
    stageCycles: after.stageCycles,
    consecutiveRestarts: after.consecutiveRestarts,
    maxRestarts: limits.maxConsecutiveRestarts,
    rechecks: stage.recheck ? { count: after.stageRechecks.count, waitedMinutes: after.stageRechecks.waitedMinutes } : null,
    trigger: await triggerData(core, after, events),
    recentEvents: events.slice(-RECENT_EVENTS).map(eventLine),
  });
  core.pool.start(runKey, handle, prompt, { parent: core.signal, timeoutMs: supervisorModelTimeoutMs(core) });
  return { kind: "switched" };
}

/**
 * Ожидание сброса лимита. `detail` — откуда взят срок (окно провайдера, ответ провайдера)
 * или null, когда срок неизвестен и дата — всего лишь следующая проба: врать про отсчёт нельзя.
 */
async function scheduleSupervisorExhaustionWait(
  core: EngineCore,
  state: TaskState,
  dueAt: string,
  delayMs: number,
  info: { what?: string; waitingFor?: string; detail?: string | null; resetKnown?: boolean; checks?: SupervisorModelCheck[] } = {},
): Promise<void> {
  const delayMinutes = Math.max(1, Math.ceil(delayMs / 60_000));
  const resetKnown = info.resetKnown ?? (info.detail !== null && info.detail !== undefined);
  const what = info.what ?? "модели supervisor-а";
  const waitingFor = info.waitingFor ?? `сброс лимита ${what}`;
  const baseMessage = info.detail
    ? `Лимит ${what} исчерпан (${info.detail}). Ожидание сброса лимита.`
    : `Нет доступной модели supervisor-а. Срок сброса провайдером не сообщён; следующая контролируемая проверка назначена по графику.`;
  const message = info.checks?.length ? `${modelChecksSummary(info.checks)}\n\n${baseMessage}` : baseMessage;
  await core.store.tasks.commit(
    core.key,
    (s, c) => {
      const decisionId = core.ids.next();
      c.emit("wait.scheduled", "cli", {
        decisionId,
        number: 1,
        maxCount: 999,
        waitingFor,
        delayMinutes,
        dueAt,
        resetKnown,
      });
      return {
        ...s,
        status: "active",
        phase: "waiting",
        wait: {
          decisionId,
          number: 1,
          waitingFor,
          message,
          delayMinutes,
          scheduledAt: c.now,
          dueAt,
          targetPhase: "supervisor_pending",
          resetKnown,
        },
      };
    },
    { expectedVersion: state.version },
  );
}

function eventLine(e: TaskEvent): string {
  return `- ${e.timestamp} ${e.id} ${e.type} ${argsPreview(e.payload, 240)}`;
}

/** Данные триггера цикла для evaluation prompt (04-agents.md §7.5). */
async function triggerData(core: EngineCore, state: TaskState, events: TaskEvent[]): Promise<TriggerData> {
  const trigger = state.supervisor.trigger;
  if (!trigger) return { kind: "none" };
  const byId = (id: string | null) => (id ? (events.find((e) => e.id === id) ?? null) : null);
  switch (trigger.kind) {
    case "agent_settled":
    case "recheck_settled": {
      const runId = trigger.ref ?? state.currentRun?.runId ?? "";
      const record = runId ? await core.runs().read(runId).catch(() => null) : null;
      let recheck: { number: number; waitedMinutes: number; waitingFor: string } | undefined;
      if (trigger.kind === "recheck_settled") {
        const finished = events.filter((e) => e.type === "wait.finished").at(-1);
        const decisionId = (finished?.payload as { decisionId?: string } | undefined)?.decisionId;
        const scheduled = events.find((e) => e.type === "wait.scheduled" && (e.payload as { decisionId: string }).decisionId === decisionId);
        recheck = {
          number: state.stageRechecks.count,
          waitedMinutes: (finished?.payload as { waitedMinutes?: number } | undefined)?.waitedMinutes ?? 0,
          waitingFor: (scheduled?.payload as { waitingFor?: string } | undefined)?.waitingFor ?? "",
        };
      }
      return {
        kind: trigger.kind,
        agentId: record?.agentId ?? state.currentRun?.agentId ?? "?",
        attempt: record?.attempt ?? state.currentRun?.attempt ?? 0,
        runId,
        settleReason: record?.settleReason ?? state.currentRun?.settleReason ?? null,
        report: record?.report ?? null,
        lastAssistantText: record?.lastAssistantText ?? null,
        error: record?.error ?? null,
        ...(recheck ? { recheck } : {}),
      };
    }
    case "human_responded": {
      const response = byId(trigger.ref);
      const p = (response?.payload ?? {}) as { requestId?: string | null; answer?: string };
      const request = byId(p.requestId ?? null);
      return {
        kind: "human_responded",
        requestId: p.requestId ?? null,
        question: (request?.payload as { question?: string } | undefined)?.question ?? null,
        answer: p.answer ?? "",
        eventId: response?.id ?? trigger.ref ?? "",
      };
    }
    case "unblocked": {
      const response = byId(trigger.ref);
      return { kind: "unblocked", note: (response?.payload as { answer?: string } | undefined)?.answer ?? "", eventId: trigger.ref ?? "" };
    }
    case "recovered": {
      const run = state.currentRun;
      const info = run ? await core.runtime.inspectSessionFile(path.join(core.task().dir, run.sessionFile)) : null;
      const last = info?.lastEntry;
      return {
        kind: "recovered",
        agentId: run?.agentId ?? null,
        runId: run?.runId ?? null,
        danglingTools: last?.kind === "assistant" ? last.danglingToolCalls.map((c) => `${c.toolName} ${c.argsPreview}`) : [],
        lastEntry: last ? (last.kind === "assistant" ? `ответ ассистента (stopReason ${last.stopReason})` : last.kind) : "нет",
      };
    }
    case "policy_changed": {
      const changed = events.filter((e) => e.type === "policy.changed").at(-1);
      return { kind: "policy_changed", fromHash: (changed?.payload as { fromHash?: string } | undefined)?.fromHash ?? null };
    }
    case "reevaluate":
      return { kind: "reevaluate" };
  }
}

/** supervisor_pending → supervisor_running (03-engine.md §5.1). */
export async function startSupervisor(core: EngineCore, state: TaskState): Promise<ExitOutcome | void> {
  const stage = getStage(core.policy.spec, state.stage);
  if (!stage || stage.kind !== "work") return block(core, state, "POLICY_STAGE_MISSING", `этапа ${state.stage} нет в Policy`);
  const limits = core.policy.spec.runtime;
  const counts = state.supervisor.trigger?.kind !== "recheck_settled";
  if (limits.maxCyclesPerStage !== null && counts && state.stageCycles + 1 > limits.maxCyclesPerStage) {
    return block(core, state, "STAGE_CYCLE_LIMIT", `на этапе «${stage.title}» исчерпан лимит циклов supervisor-а (${limits.maxCyclesPerStage})`);
  }
  const chain = resolveModelChain({
    role: "supervisor",
    configuredModel: core.policy.spec.supervisor.model,
    modelsConfig: core.store.modelsConfig,
  });
  const selection = await selectSupervisorModel(core, chain);
  await recordModelChecks(core, selection.checks);
  if (selection.kind === "unavailable") {
    return block(core, state, "MODEL_UNAVAILABLE", `${modelChecksSummary(selection.checks)}\nПоследняя ошибка: ${selection.error}`);
  }
  if (selection.kind === "exhausted") {
    const dueAt = new Date(core.clock.now().getTime() + selection.earliestResetMs).toISOString();
    const hasUnavailable = selection.checks.some((c) => c.status !== "cooldown");
    await scheduleSupervisorExhaustionWait(core, state, dueAt, selection.earliestResetMs, {
      what: "моделей supervisor-а",
      ...(hasUnavailable ? { waitingFor: "доступную модель supervisor-а" } : {}),
      detail: selection.resetKnown ? selection.resetDetail : null,
      resetKnown: selection.resetKnown,
      checks: selection.checks,
    });
    return { kind: "waiting_recheck", dueAt };
  }
  const model = selection.model;
  const spec = supervisorSessionSpec(core, model);
  const fullPolicy = state.supervisor.lastPolicyHashShown !== state.policyHash || core.pool.takeCompacted(spec.file);
  const cycle = state.supervisor.cycle + 1;
  const next = await core.store.tasks.commit(
    core.key,
    (s, c) => {
      c.emit("supervisor.started", "cli", { cycle, trigger: s.supervisor.trigger });
      return {
        ...s,
        status: "active",
        phase: "supervisor_running",
        stageCycles: counts ? s.stageCycles + 1 : s.stageCycles,
        supervisor: { ...s.supervisor, cycle, lastPolicyHashShown: fullPolicy ? s.policyHash : s.supervisor.lastPolicyHashShown },
      };
    },
    { expectedVersion: state.version },
  );
  // Версия после записи supervisor.started — и есть expectedStateVersion цикла
  core.cycle = {
    cycle,
    decisionRecorded: false,
    invalidCount: 0,
    protocolRetriesUsed: 0,
    technicalRetriesUsed: 0,
    version: next.version,
    modelUsed: model.id,
    modelChain: chain,
    modelChainIndex: selection.index,
    modelAttemptStartedAtMs: core.clock.now().getTime(),
  };
  const events = await core.events();
  const prompt = evaluationPrompt({
    promptId: core.ids.next(),
    cycle,
    key: next.key,
    title: next.title,
    version: next.version,
    now: core.clock.now(),
    policyHash: next.policyHash,
    policyRaw: fullPolicy ? core.policy.raw : null,
    spec: core.policy.spec,
    stage,
    stageEnteredAt: next.stageEnteredAt,
    stageCycles: next.stageCycles,
    consecutiveRestarts: next.consecutiveRestarts,
    maxRestarts: limits.maxConsecutiveRestarts,
    rechecks: stage.recheck ? { count: next.stageRechecks.count, waitedMinutes: next.stageRechecks.waitedMinutes } : null,
    trigger: await triggerData(core, next, events),
    recentEvents: events.slice(-RECENT_EVENTS).map(eventLine),
  });
  const handle = await core.pool.open(spec);
  core.reporter.context({ key: core.key, stage: next.stage, stageTitle: stage.title, agent: null });
  core.reporter.emit({ type: "supervisor.started", cycle, trigger: next.supervisor.trigger?.kind ?? null });
  core.pool.start(supervisorRunKey(cycle), handle, prompt, { parent: core.signal, timeoutMs: supervisorModelTimeoutMs(core) });
}

/** supervisor_running: дождаться решения (03-engine.md §5.3, §5.5). */
export async function awaitSupervisor(core: EngineCore, state: TaskState): Promise<ExitOutcome | void> {
  const mem = core.cycle;
  const key = supervisorRunKey(state.supervisor.cycle);
  const active = core.pool.take(key);
  if (!active || !mem || mem.cycle !== state.supervisor.cycle) {
    throw new Error(`нет живого цикла supervisor ${state.supervisor.cycle}: recovery должен был обработать эту фазу`);
  }
  const outcome = await active.promise;
  if (outcome.kind === "aborted" && !active.timedOut && core.signal.aborted) {
    throw core.signal.reason instanceof Error ? core.signal.reason : new InterruptRequest("SIGINT");
  }
  // Модель ответила — снимаем cooldown и сбрасываем график проб.
  if (outcome.kind === "completed" || outcome.kind === "terminated_by_tool") {
    const [p, m] = (core.pool.openedModel(supervisorSessionFile(core)) ?? mem.modelUsed ?? "").split("/");
    if (p && m) defaultCooldownTracker.recordSuccess(p, m, core.clock.now().getTime());
  }
  const after = await core.store.tasks.load(core.key);
  if (mem.decisionRecorded || after.phase !== "supervisor_running") {
    core.cycle = null;
    return;
  }
  const limits = core.policy.spec.runtime;
  if (mem.invalidCount > limits.maxInvalidDecisionsPerCycle) {
    core.cycle = null;
    return block(core, after, "SUPERVISOR_INVALID_DECISIONS", `supervisor ${mem.invalidCount} раз подряд предложил невалидное решение в цикле ${mem.cycle}`);
  }
  const resend = async (prompt: string) => {
    mem.modelAttemptStartedAtMs = core.clock.now().getTime();
    delete mem.lastProviderError;
    core.pool.start(key, active.handle, prompt, { parent: core.signal, timeoutMs: supervisorModelTimeoutMs(core) });
  };
  if (outcome.kind === "aborted" && active.timedOut) {
    const failedWith = core.pool.openedModel(supervisorSessionFile(core)) ?? mem.modelUsed ?? "";
    const timeoutMinutes = Math.min(limits.supervisorTimeoutMinutes, limits.supervisorModelTimeoutMinutes);
    const reason = `модель не завершила обращение за ${timeoutMinutes} мин${mem.lastProviderError ? `; последний retry: ${truncate(redactString(mem.lastProviderError), 240)}` : ""}`;
    if (failedWith) unusableForSupervisor.set(failedWith, reason);
    await core.store.tasks.appendDirect(core.key, "model.unusable", "cli", {
      role: "supervisor",
      model: failedWith || "unknown",
      retriesUsed: mem.technicalRetriesUsed,
      reason,
    });
    const switched = await switchToNextModel(core, after, mem, key, failedWith, "provider_error", reason);
    if (switched.kind === "switched") return;
    if (switched.kind === "not_applied") {
      core.cycle = null;
      return block(core, after, "MODEL_SWITCH_FAILED", `не удалось переключить supervisor на резервную модель ${switched.model}`);
    }
    core.cycle = null;
    return block(core, after, "SUPERVISOR_MODEL_TIMEOUT", `${reason}. ${switched.error}`);
  }
  if (outcome.kind === "error") {
    if (isModelExhaustedError(outcome.message)) {
      // Что реально ответило ошибкой — модель открытой сессии, а не то, что мы собирались использовать.
      const ranWith = core.pool.openedModel(supervisorSessionFile(core)) ?? mem.modelUsed ?? "";
      const [provider = "unknown", modelId = "unknown"] = ranWith.split("/");
      const scope = exhaustionScope(outcome.message);
      const { ms, detail } = await resolveCooldownMs(core, provider, outcome.message);
      const record = defaultCooldownTracker.recordExhausted(provider, modelId, ms, outcome.message, core.clock.now().getTime(), { scope, resetDetail: detail });
      const resetAt = new Date(record.exhaustedUntil).toISOString();
      await core.store.tasks.appendDirect(core.key, "model.exhausted", "cli", {
        provider,
        modelId,
        role: "supervisor",
        scope,
        resetAt,
        resetKnown: ms !== null,
        ...(detail ? { resetDetail: detail } : {}),
        attempt: record.attempt,
        reason: outcome.message,
      });

      const switched = await switchToNextModel(core, after, mem, key, ranWith, "exhausted", outcome.message);
      if (switched.kind === "switched") return;
      if (switched.kind === "not_applied") {
        core.cycle = null;
        return block(core, after, "MODEL_SWITCH_FAILED", `не удалось переключить supervisor на резервную модель ${switched.model}`);
      }

      core.cycle = null;
      const waitMs = Math.max(0, record.exhaustedUntil - core.clock.now().getTime());
      await scheduleSupervisorExhaustionWait(core, after, resetAt, waitMs, {
        what: scope === "provider" ? `провайдера ${provider}` : `модели ${ranWith || provider}`,
        detail,
        resetKnown: ms !== null,
      });
      return { kind: "waiting_recheck", dueAt: resetAt };
    }

    if (mem.technicalRetriesUsed < limits.technicalRetries) {
      mem.technicalRetriesUsed++;
      await core.sleep(limits.technicalRetryDelaySeconds * 1000);
      return resend(providerRetryPrompt({ promptId: core.ids.next(), cycle: mem.cycle, version: after.version }));
    }

    // Технические повторы исчерпаны: ошибка не случайная, эта модель роль не обслуживает.
    // Блокировать задачу, пока в цепочке есть живые модели, нельзя.
    const failedWith = core.pool.openedModel(supervisorSessionFile(core)) ?? mem.modelUsed ?? "";
    if (failedWith) unusableForSupervisor.set(failedWith, outcome.message);
    await core.store.tasks.appendDirect(core.key, "model.unusable", "cli", {
      role: "supervisor",
      model: failedWith || "unknown",
      retriesUsed: mem.technicalRetriesUsed,
      reason: outcome.message,
    });
    const switched = await switchToNextModel(core, after, mem, key, failedWith, "provider_error", outcome.message);
    if (switched.kind === "switched") return;
    if (switched.kind === "not_applied") {
      core.cycle = null;
      return block(core, after, "MODEL_SWITCH_FAILED", `не удалось переключить supervisor на резервную модель ${switched.model}`);
    }
  }
  if (outcome.kind !== "error" && mem.protocolRetriesUsed < limits.supervisorProtocolRetries) {
    mem.protocolRetriesUsed++;
    return resend(protocolRetryPrompt({ promptId: core.ids.next(), cycle: mem.cycle, version: after.version }));
  }
  core.cycle = null;
  const code = "SUPERVISOR_NO_DECISION";
  const message =
    outcome.kind === "error"
      ? `supervisor завершился ошибкой провайдера без решения: ${outcome.message}`
      : `supervisor завершил цикл ${mem.cycle} без управляющего решения (повторов: ${mem.protocolRetriesUsed})`;
  await core.store.tasks.commit(
    core.key,
    (s, c) => {
      c.emit("supervisor.protocol_error", "cli", { cycle: mem.cycle, retriesUsed: mem.protocolRetriesUsed });
      c.emit("task.blocked", "cli", { code, message, by: "cli" });
      return haltedState(s, "blocked", { code, message, at: c.now });
    },
    { expectedVersion: after.version },
  );
  return { kind: "blocked", code };
}
