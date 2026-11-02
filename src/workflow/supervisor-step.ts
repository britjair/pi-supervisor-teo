// Supervisor step, 03-engine.md §5: supervisor_pending → supervisor_running → decision_pending.

import path from "node:path";
import { evaluationPrompt, protocolRetryPrompt, providerRetryPrompt, type TriggerData } from "../agents/prompts/supervisor-prompts.js";
import { ModelUnavailableError, type ModelRef, type ResolvedModel } from "../agents/runtime.js";
import { supervisorSessionSpec } from "../agents/session-spec.js";
import type { TaskEvent } from "../domain/events.js";
import { getStage } from "../domain/policy.js";
import { haltedState, type TaskState } from "../domain/task-state.js";
import { argsPreview } from "../util/redact.js";
import { resolveModelChain } from "../policy/models-config.js";
import {
  defaultCooldownTracker,
  exhaustionScope,
  isModelExhaustedError,
  parseResetCooldownMs,
  PROBE_SCHEDULE_MS,
} from "../util/model-exhaustion.js";
import type { EngineCore } from "./context.js";
import type { ExitOutcome } from "./outcome.js";
import { InterruptRequest } from "./outcome.js";

const RECENT_EVENTS = 10;

export const supervisorRunKey = (cycle: number) => `supervisor:${cycle}`;

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

type ModelSelection =
  | { kind: "selected"; model: ResolvedModel; index: number; ref: string }
  | { kind: "exhausted"; earliestResetMs: number }
  | { kind: "unavailable"; error: string };

async function selectSupervisorModel(core: EngineCore, chain: string[]): Promise<ModelSelection> {
  let hasExhausted = false;
  let lastError = "Нет доступных моделей для supervisor-а";
  const now = core.clock.now().getTime();
  const checkedModels: Array<{ provider: string; modelId: string }> = [];

  for (let i = 0; i < chain.length; i++) {
    const refStr = chain[i];
    if (!refStr) continue;
    try {
      const resolved = await core.runtime.resolveModel(supervisorModelRef(core, refStr));
      const [provider = "unknown", modelId = "unknown"] = resolved.id.split("/");
      checkedModels.push({ provider, modelId });
      if (defaultCooldownTracker.isExhausted(provider, modelId, now)) {
        hasExhausted = true;
        continue;
      }
      return { kind: "selected", model: resolved, index: i, ref: refStr };
    } catch (err) {
      if (err instanceof ModelUnavailableError) {
        lastError = err.message;
        continue;
      }
      throw err;
    }
  }

  if (hasExhausted) {
    const earliest = defaultCooldownTracker.getEarliestResetMs(checkedModels, now) ?? PROBE_SCHEDULE_MS[0] ?? 0;
    return { kind: "exhausted", earliestResetMs: earliest };
  }
  return { kind: "unavailable", error: lastError };
}

/**
 * Срок cooldown: сначала точная проба провайдера, затем текст ошибки, иначе null —
 * и тогда трекер берёт следующий шаг графика проб.
 */
async function resolveCooldownMs(core: EngineCore, provider: string, message: string): Promise<{ ms: number | null; detail: string | null }> {
  const now = core.clock.now().getTime();
  const probed = await core.providerReset?.(provider, now).catch(() => null);
  if (probed && probed.ms > 0) return { ms: probed.ms, detail: probed.detail };
  const parsed = parseResetCooldownMs(message, now);
  return { ms: parsed, detail: parsed === null ? null : "срок из ответа провайдера" };
}

const supervisorSessionFile = (core: EngineCore) => path.join(core.task().dir, "sessions", "supervisor.jsonl");

/**
 * Ожидание сброса лимита. `detail` — откуда взят срок (окно провайдера, ответ провайдера)
 * или null, когда срок неизвестен и дата — всего лишь следующая проба: врать про отсчёт нельзя.
 */
async function scheduleSupervisorExhaustionWait(
  core: EngineCore,
  state: TaskState,
  dueAt: string,
  delayMs: number,
  info: { what?: string; detail?: string | null } = {},
): Promise<void> {
  const delayMinutes = Math.max(1, Math.ceil(delayMs / 60_000));
  const resetKnown = info.detail !== null && info.detail !== undefined;
  const what = info.what ?? "модели supervisor-а";
  const waitingFor = `сброс лимита ${what}`;
  const message = info.detail
    ? `Лимит ${what} исчерпан (${info.detail}). Ожидание сброса лимита.`
    : `Лимит ${what} исчерпан. Срок сброса провайдером не сообщён, следующая проверка по графику проб.`;
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
  if (selection.kind === "unavailable") {
    return block(core, state, "MODEL_UNAVAILABLE", `модель supervisor-а ${core.policy.spec.supervisor.model} недоступна: ${selection.error}`);
  }
  if (selection.kind === "exhausted") {
    const dueAt = new Date(core.clock.now().getTime() + selection.earliestResetMs).toISOString();
    await scheduleSupervisorExhaustionWait(core, state, dueAt, selection.earliestResetMs);
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
  core.pool.start(supervisorRunKey(cycle), handle, prompt, { parent: core.signal, timeoutMs: limits.supervisorTimeoutMinutes * 60_000 });
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
    core.pool.start(key, active.handle, prompt, { parent: core.signal, timeoutMs: limits.supervisorTimeoutMinutes * 60_000 });
  };
  if (outcome.kind === "error") {
    if (isModelExhaustedError(outcome.message)) {
      // Что реально ответило ошибкой — модель открытой сессии, а не то, что мы собирались использовать.
      const ranWith = core.pool.openedModel(supervisorSessionFile(core)) ?? mem.modelUsed ?? "";
      const [provider = "unknown", modelId = "unknown"] = ranWith.split("/");
      const scope = exhaustionScope(outcome.message);
      const { ms, detail } = await resolveCooldownMs(core, provider, outcome.message);
      const record = defaultCooldownTracker.recordExhausted(provider, modelId, ms, outcome.message, core.clock.now().getTime(), { scope });
      const resetAt = new Date(record.exhaustedUntil).toISOString();
      await core.store.tasks.appendDirect(core.key, "model.exhausted", "cli", {
        provider,
        modelId,
        scope,
        resetAt,
        resetKnown: ms !== null,
        ...(detail ? { resetDetail: detail } : {}),
        attempt: record.attempt,
        reason: outcome.message,
      });

      const chain = mem.modelChain ?? [core.policy.spec.supervisor.model];
      const remainingChain = chain.slice((mem.modelChainIndex ?? 0) + 1);
      const fallbackSelection = await selectSupervisorModel(core, remainingChain);
      if (fallbackSelection.kind === "selected") {
        const nextModel = fallbackSelection.model;
        const spec = supervisorSessionSpec(core, nextModel);
        // Сессия кешируется по файлу: без переоткрытия запрос ушёл бы в прежнюю исчерпанную модель.
        const handle = await core.pool.reopen(spec);
        const applied = core.pool.openedModel(spec.file) === nextModel.id;
        await core.store.tasks.appendDirect(core.key, "model.fallback", "cli", {
          role: "supervisor",
          fromModel: ranWith || "unknown",
          toModel: nextModel.id,
          applied,
          reason: outcome.message,
        });
        if (!applied) {
          core.cycle = null;
          return block(core, after, "MODEL_SWITCH_FAILED", `не удалось переключить supervisor на резервную модель ${nextModel.id}`);
        }
        core.reporter.emit({
          type: "info",
          text: `Переключение supervisor-а на резервную модель ${nextModel.id} (лимит ${ranWith} исчерпан)`,
        });
        mem.modelUsed = nextModel.id;
        mem.modelChainIndex = (mem.modelChainIndex ?? 0) + 1 + fallbackSelection.index;
        mem.technicalRetriesUsed = 0;
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
        core.pool.start(key, handle, prompt, { parent: core.signal, timeoutMs: limits.supervisorTimeoutMinutes * 60_000 });
        return;
      }

      core.cycle = null;
      const waitMs = Math.max(0, record.exhaustedUntil - core.clock.now().getTime());
      await scheduleSupervisorExhaustionWait(core, after, resetAt, waitMs, {
        what: scope === "provider" ? `провайдера ${provider}` : `модели ${ranWith || provider}`,
        detail,
      });
      return { kind: "waiting_recheck", dueAt: resetAt };
    }

    if (mem.technicalRetriesUsed < limits.technicalRetries) {
      mem.technicalRetriesUsed++;
      await core.sleep(limits.technicalRetryDelaySeconds * 1000);
      return resend(providerRetryPrompt({ promptId: core.ids.next(), cycle: mem.cycle, version: after.version }));
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
