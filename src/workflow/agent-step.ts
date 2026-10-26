// Agent step, 03-engine.md §4: agent_pending → agent_running → supervisor_pending.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { continuePrompt, initialPrompt, recheckPrompt, recoveryMessages, type PreviousResult } from "../agents/prompts/agent-prompts.js";
import { ModelUnavailableError } from "../agents/runtime.js";
import { agentModelRef, agentSessionSpec, taskDirDisplay } from "../agents/session-spec.js";
import { listArtifacts } from "../agents/tools/supervisor-read-tools.js";
import { getAgent, getStage, type WorkStage } from "../domain/policy.js";
import type { AgentRunRecord } from "../domain/runs.js";
import { haltedState, type AgentInput, type AgentRunRef, type SettleReason, type TaskState } from "../domain/task-state.js";
import type { EngineCore } from "./context.js";
import type { ExitOutcome } from "./outcome.js";
import { InterruptRequest } from "./outcome.js";

const pad3 = (n: number) => String(n).padStart(3, "0");
const LAST_TEXT_MAX = 4 * 1024;

export function sessionFileFor(agentId: string, attempt: number): string {
  return `sessions/${agentId}-${pad3(attempt)}.jsonl`;
}

/** Описание задачи из task.md: всё после «## Описание». */
export async function readTaskDescription(file: string): Promise<string> {
  const text = await readFile(file, "utf8");
  const i = text.indexOf("## Описание");
  return (i >= 0 ? text.slice(i + "## Описание".length) : text).trim();
}

async function blockTask(core: EngineCore, state: TaskState, code: string, message: string): Promise<ExitOutcome> {
  await core.store.tasks.commit(core.key, (s, c) => {
    c.emit("task.blocked", "cli", { code, message, by: "cli" });
    return haltedState(s, "blocked", { code, message, at: c.now });
  }, { expectedVersion: state.version });
  return { kind: "blocked", code };
}

/** Последние результаты агентов задачи (до 5, новые первыми) для initial prompt. */
async function previousResults(core: EngineCore, excludeRunId: string | null): Promise<PreviousResult[]> {
  const started = (await core.events()).filter((e) => e.type === "agent.started").reverse();
  const out: PreviousResult[] = [];
  for (const e of started) {
    if (out.length >= 5) break;
    const runId = (e.payload as { runId: string }).runId;
    if (runId === excludeRunId) continue;
    const r = await core.runs().read(runId).catch(() => null);
    if (!r) continue;
    const report = r.report ?? r.reportsHistory.at(-1) ?? null;
    out.push({
      agentId: r.agentId,
      attempt: r.attempt,
      stageTitle: getStage(core.policy.spec, r.stage)?.title ?? r.stage,
      settleReason: r.settleReason,
      summary: report?.data.summary ?? r.lastAssistantText?.slice(0, 300) ?? "отчёта нет",
      artifacts: report?.kind === "result" ? (report.data.artifacts ?? []).map((a) => a.pathOrUrl) : [],
    });
  }
  return out;
}

async function decisionInput(core: EngineCore, decisionId: string | null): Promise<Record<string, unknown> | null> {
  if (!decisionId) return null;
  const e = (await core.events()).find((x) => x.type === "supervisor.decision" && (x.payload as { decisionId: string }).decisionId === decisionId);
  return (e?.payload as { input?: Record<string, unknown> } | undefined)?.input ?? null;
}

async function buildPrompt(
  core: EngineCore,
  state: TaskState,
  stage: WorkStage,
  agentId: string,
  input: AgentInput,
  run: { runId: string; previousRunId: string | null },
  promptId: string,
  record: AgentRunRecord | null,
): Promise<string> {
  const t = core.task();
  const agent = getAgent(core.policy.spec, agentId);
  if (!agent) throw new Error(`агента ${agentId} нет в Policy`);
  switch (input.kind) {
    case "initial":
    case "restart": {
      const d = await decisionInput(core, input.decisionId);
      return initialPrompt({
        promptId,
        runId: run.runId,
        kind: input.kind,
        task: { key: state.key, title: state.title, description: await readTaskDescription(t.taskMd) },
        spec: core.policy.spec,
        stage,
        agent,
        handoff: input.kind === "initial" ? input.message : null,
        previousResults: await previousResults(core, run.runId),
        artifacts: (await listArtifacts(t.artifactsDir)).map((a) => ({ path: a.path, size: a.size, mtime: a.mtime })),
        taskDirDisplay: taskDirDisplay(core),
        ...(input.kind === "restart"
          ? {
              restart: {
                previousRunId: run.previousRunId ?? "нет",
                reason: typeof d?.["reason"] === "string" ? d["reason"] : "причина не указана",
                message: input.message ?? "",
              },
            }
          : {}),
      });
    }
    case "continue":
    case "recovery":
      return continuePrompt({ promptId, runId: run.runId, kind: input.kind, stageTitle: stage.title, message: input.message ?? "" });
    case "recheck": {
      const lastReport = record?.report ?? record?.reportsHistory.at(-1) ?? null;
      const scheduled = (await core.events()).find(
        (e) => e.type === "wait.scheduled" && (e.payload as { decisionId: string }).decisionId === input.decisionId,
      );
      return recheckPrompt({
        promptId,
        runId: run.runId,
        stageTitle: stage.title,
        number: state.stageRechecks.count,
        maxCount: stage.recheck?.maxCount ?? state.stageRechecks.count,
        minutesSinceReport: lastReport ? Math.round((core.clock.now().getTime() - new Date(lastReport.at).getTime()) / 60_000) : null,
        waitingFor: (scheduled?.payload as { waitingFor?: string } | undefined)?.waitingFor ?? "",
        message: input.message ?? "",
      });
    }
  }
}

/** agent_pending → agent_running: commit до отправки prompt-а (03-engine.md §4.1). */
export async function startAgent(core: EngineCore, state: TaskState): Promise<ExitOutcome | void> {
  const input = state.nextAgentInput;
  if (!input) throw new Error("phase=agent_pending без nextAgentInput");
  const stage = getStage(core.policy.spec, state.stage);
  if (!stage || stage.kind !== "work") return blockTask(core, state, "POLICY_STAGE_MISSING", `этапа ${state.stage} нет в Policy`);

  const fresh = input.kind === "initial" || input.kind === "restart";
  const prev = state.currentRun;
  const agentId = fresh ? stage.agent : (prev?.agentId ?? stage.agent);
  const agent = getAgent(core.policy.spec, agentId);
  if (!agent) return blockTask(core, state, "AGENT_MISSING", `агента ${agentId} нет в Policy`);

  let model;
  try {
    model = await core.runtime.resolveModel(agentModelRef(agent));
  } catch (err) {
    if (!(err instanceof ModelUnavailableError)) throw err;
    const hint = agent.piResources.extensions === "none" ? " Модель может предоставляться расширением; уберите extensions: none." : "";
    return blockTask(core, state, "MODEL_UNAVAILABLE", `модель ${agent.model} агента ${agentId} недоступна: ${err.message}.${hint}`);
  }

  // Первый prompt нового run не был доставлен до падения: run уже создан, используем его (без дубликата)
  const reusePending = fresh && prev?.status === "pending" && prev.stage === state.stage && prev.agentId === agentId;
  const newRun = fresh && !reusePending;
  const now = core.clock.now().toISOString();
  let run: AgentRunRef;
  if (newRun) {
    const counter = state.agentRunCounters[agentId] ?? 0;
    const reuse = input.kind === "initial" && stage.session === "reuse" && counter > 0;
    const attempt = reuse ? counter : counter + 1;
    run = {
      runId: core.ids.next(state.lastEventId),
      agentId,
      attempt,
      stage: state.stage,
      sessionFile: sessionFileFor(agentId, attempt),
      sessionMode: input.kind === "restart" ? "restart" : reuse ? "reuse" : "fresh",
      status: "running",
      settleReason: null,
      promptsSent: [],
      startedAt: now,
      finishedAt: null,
    };
  } else {
    if (!prev) throw new Error(`nextAgentInput.kind=${input.kind} без currentRun`);
    run = { ...prev, status: "running", settleReason: null, finishedAt: null };
  }

  const runs = core.runs();
  const promptId = core.ids.next();
  const existing = newRun ? null : await runs.read(run.runId);
  const prompt = await buildPrompt(core, state, stage, agentId, input, { runId: run.runId, previousRunId: prev?.runId ?? null }, promptId, existing);

  // runs/<runId>.json пишется до state: recovery восстанавливает по нему вход run-а
  const record: AgentRunRecord = existing
    ? {
        ...existing,
        input,
        prompts: [...existing.prompts.filter((p) => run.promptsSent.includes(p.promptId)), { promptId, kind: input.kind, sentAt: now }],
        report: null,
        reportsHistory: existing.report ? [...existing.reportsHistory, existing.report] : existing.reportsHistory,
        settleReason: null,
        finishedAt: null,
      }
    : {
        runId: run.runId,
        agentId,
        attempt: run.attempt,
        stage: state.stage,
        sessionFile: run.sessionFile,
        sessionMode: run.sessionMode,
        input,
        prompts: [{ promptId, kind: input.kind, sentAt: now }],
        report: null,
        reportsHistory: [],
        settleReason: null,
        error: null,
        lastAssistantText: null,
        toolStats: {},
        usage: null,
        startedAt: now,
        finishedAt: null,
      };
  await runs.write(record);

  const file = path.join(core.task().dir, run.sessionFile);
  core.reported.delete(file);
  await core.store.tasks.commit(
    core.key,
    (s, c) => {
      if (newRun) {
        c.emit("agent.started", "cli", {
          runId: run.runId,
          agentId,
          attempt: run.attempt,
          sessionFile: run.sessionFile,
          sessionMode: run.sessionMode,
          stage: s.stage,
        });
        if (input.kind === "restart" && prev) {
          c.emit("agent.restarted", "cli", {
            previousRunId: prev.runId,
            runId: run.runId,
            decisionId: input.decisionId,
            consecutiveRestarts: s.consecutiveRestarts + 1,
          });
        }
      } else if (input.kind === "continue" || input.kind === "recheck") {
        c.emit("agent.continued", "cli", { runId: run.runId, decisionId: input.decisionId });
      }
      c.emit("agent.prompted", "cli", { runId: run.runId, promptId, kind: input.kind });
      return {
        ...s,
        phase: "agent_running",
        nextAgentInput: null,
        currentRun: { ...run, promptsSent: [...run.promptsSent, promptId] },
        agentRunCounters: newRun ? { ...s.agentRunCounters, [agentId]: run.attempt } : s.agentRunCounters,
        consecutiveRestarts: newRun && input.kind === "restart" ? s.consecutiveRestarts + 1 : s.consecutiveRestarts,
      };
    },
    { expectedVersion: state.version },
  );
  core.faults.check("before-agent-prompt");

  if (input.kind === "restart" && prev) core.pool.close(path.join(core.task().dir, prev.sessionFile));
  const handle = await core.pool.open(agentSessionSpec(core, agent, file, model));
  core.reporter.context({ key: core.key, stage: state.stage, stageTitle: stage.title, agent: `${agentId}#${run.attempt}` });
  core.reporter.emit({ type: "agent.started", stage: state.stage, stageTitle: stage.title, agentId, attempt: run.attempt, inputKind: input.kind });
  core.pool.start(run.runId, handle, prompt, {
    parent: core.signal,
    timeoutMs: agent.timeoutMinutes !== null ? agent.timeoutMinutes * 60_000 : null,
  });
}

/** Settle run-а: запись run-файла, затем state → supervisor_pending (03-engine.md §4.2). */
export async function settleRun(
  core: EngineCore,
  state: TaskState,
  reason: SettleReason,
  details: { error?: string | null; lastAssistantText?: string | null; recovered?: string } = {},
): Promise<void> {
  const run = state.currentRun;
  if (!run) throw new Error("settle без currentRun");
  const runs = core.runs();
  const record = await runs.read(run.runId);
  const now = core.clock.now().toISOString();
  const lastKind = record?.prompts.at(-1)?.kind;
  if (record) {
    await runs.write({
      ...record,
      settleReason: reason,
      error: details.error ?? record.error,
      lastAssistantText: details.lastAssistantText !== undefined && details.lastAssistantText !== null ? details.lastAssistantText.slice(-LAST_TEXT_MAX) : record.lastAssistantText,
      finishedAt: now,
    });
  }
  const failed = reason === "runtime_error";
  await core.store.tasks.commit(
    core.key,
    (s, c) => {
      if (failed) c.emit("agent.failed", "cli", { runId: run.runId, reason, error: details.error ?? "" });
      else c.emit("agent.settled", "cli", { runId: run.runId, reason });
      if (details.recovered) c.emit("runtime.recovered", "cli", { phase: s.phase, action: details.recovered, details: { runId: run.runId } });
      return {
        ...s,
        status: s.pendingHumanRequest ? "waiting_human" : "active",
        phase: "supervisor_pending",
        currentRun: { ...run, status: failed ? "failed" : "settled", settleReason: reason, finishedAt: now },
        supervisor: { ...s.supervisor, trigger: { kind: lastKind === "recheck" ? "recheck_settled" : reason === "interrupted" ? "recovered" : "agent_settled", ref: run.runId } },
      };
    },
    { expectedVersion: state.version },
  );
  core.reported.delete(path.join(core.task().dir, run.sessionFile));
  core.reporter.emit({ type: "agent.settled", agentId: run.agentId, attempt: run.attempt, reason });
}

/** agent_running: дождаться хода в живой сессии. Без живой сессии — это recovery (вызывается при открытии). */
export async function awaitAgent(core: EngineCore, state: TaskState): Promise<ExitOutcome | void> {
  const run = state.currentRun;
  if (!run) throw new Error("phase=agent_running без currentRun");
  const active = core.pool.take(run.runId);
  if (!active) throw new Error(`нет живого хода run ${run.runId}: recovery должен был обработать эту фазу`);
  const outcome = await active.promise;
  if (outcome.kind === "aborted" && !active.timedOut && core.signal.aborted) {
    throw core.signal.reason instanceof Error ? core.signal.reason : new InterruptRequest("SIGINT");
  }
  const current = await core.store.tasks.load(core.key);
  // Задача остановилась во время хода (подмена state, решение другого пути): не «размораживать» её
  if (current.phase !== "agent_running" || current.currentRun?.runId !== run.runId) return;
  const record = await core.runs().read(run.runId);
  if (record?.report) return settleRun(core, current, record.report.kind === "result" ? "reported_result" : "reported_blocker");

  if (outcome.kind === "error") {
    const limits = core.policy.spec.runtime;
    const used = (await core.events()).filter(
      (e) => e.type === "agent.failed" && e.payload.runId === run.runId && e.payload.retrying === true,
    ).length;
    if (used < limits.technicalRetries) {
      if (record) await core.runs().write({ ...record, error: outcome.message });
      await core.sleep(limits.technicalRetryDelaySeconds * 1000);
      await core.store.tasks.commit(
        core.key,
        (s, c) => {
          c.emit("agent.failed", "cli", { runId: run.runId, reason: "runtime_error", error: outcome.message, retrying: true });
          return { ...s, phase: "agent_pending", nextAgentInput: { kind: "recovery", message: recoveryMessages.providerError, decisionId: null } };
        },
        { expectedVersion: current.version },
      );
      return;
    }
    return settleRun(core, current, "runtime_error", { error: outcome.message });
  }
  if (outcome.kind === "aborted") return settleRun(core, current, active.timedOut ? "timeout" : "aborted", active.timedOut ? { error: "превышен timeoutMinutes агента" } : {});
  return settleRun(core, current, "unstructured_settle", {
    lastAssistantText: outcome.kind === "completed" ? outcome.lastAssistantText : null,
  });
}
