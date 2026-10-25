// Recovery при открытии задачи, 03-engine.md §8. Вызывается до основного цикла, под lock-ом.
// Фазы *_pending, decision_pending, human_pending и waiting идемпотентны и не требуют действий;
// *_running без живого владельца — это прерывание, и его разбирает таблица §8.3.

import path from "node:path";
import { recoveryMessages } from "../agents/prompts/agent-prompts.js";
import { askAgentQuestion } from "../agents/tools/child-tools.js";
import { haltedState, type TaskState } from "../domain/task-state.js";
import { UserAbortError } from "../errors/errors.js";
import { settleRun } from "./agent-step.js";
import type { EngineCore } from "./context.js";
import type { ExitOutcome } from "./outcome.js";
import { InterruptRequest } from "./outcome.js";

const restoredStatus = (s: TaskState) => (s.pendingHumanRequest ? "waiting_human" : "active") as TaskState["status"];

export async function recoverOnOpen(core: EngineCore): Promise<ExitOutcome | null> {
  const state = await core.store.tasks.load(core.key);
  if (state.phase === "halted") return null;
  if (state.phase === "agent_running") return recoverAgentRun(core, state);
  if (state.phase === "supervisor_running") {
    // Supervisor только читает и решает: повтор цикла безопасен
    await core.store.tasks.commit(
      core.key,
      (s, c) => {
        c.emit("runtime.recovered", "cli", { phase: s.phase, action: "reevaluate", details: { cycle: s.supervisor.cycle } });
        return { ...s, status: "active", phase: "supervisor_pending", supervisor: { ...s.supervisor, trigger: { kind: "reevaluate", ref: null } } };
      },
      { expectedVersion: state.version },
    );
    return null;
  }
  const pid = process.pid;
  if (state.status === "interrupted") {
    await core.store.tasks.commit(
      core.key,
      (s, c) => {
        c.emit("task.resumed", "cli", { fromStatus: s.status, phase: s.phase, pid });
        return { ...s, status: restoredStatus(s) };
      },
      { expectedVersion: state.version },
    );
  } else {
    await core.store.tasks.appendDirect(core.key, "task.resumed", "cli", { fromStatus: state.status, phase: state.phase, pid });
  }
  return null;
}

async function recoverAgentRun(core: EngineCore, state: TaskState): Promise<ExitOutcome | null> {
  const run = state.currentRun;
  if (!run) throw new Error("phase=agent_running без currentRun");
  const record = await core.runs().read(run.runId);

  // Агент ждал ответа человека: спросить тот же вопрос и продолжить сессию ответом
  const request = state.pendingHumanRequest;
  if (request?.origin === "agent") {
    if (!core.human) return { kind: "waiting_human" };
    let answer;
    try {
      answer = await askAgentQuestion(core, request);
    } catch (err) {
      if (err instanceof UserAbortError) throw new InterruptRequest("SIGINT");
      throw err;
    }
    if (!answer) return { kind: "waiting_human" };
    await core.store.tasks.commit(
      core.key,
      (s, c) => {
        c.emit("human.responded", "human", { requestId: request.requestId, answer: answer.answer, selectedOption: answer.selectedOption });
        c.emit("runtime.recovered", "cli", { phase: s.phase, action: "reask_agent_question", details: { requestId: request.requestId } });
        return {
          ...s,
          status: "active",
          pendingHumanRequest: null,
          phase: "agent_pending",
          nextAgentInput: { kind: "recovery", message: recoveryMessages.questionInterrupted(answer.answer), decisionId: null },
        };
      },
      { expectedVersion: state.version },
    );
    return null;
  }

  // Агент фактически отчитался: settle с сохранённой причиной
  if (record?.report) {
    await settleRun(core, state, record.report.kind === "result" ? "reported_result" : "reported_blocker", { recovered: "settle_reported" });
    return null;
  }

  const info = await core.runtime.inspectSessionFile(path.join(core.task().dir, run.sessionFile));
  if (!info.valid) return ambiguous(core, state, info.parseError ?? "файл сессии не разбирается");

  const lastPrompt = run.promptsSent.at(-1);
  if (!lastPrompt || !info.promptIds.includes(lastPrompt)) {
    // Prompt не доставлен: агент ничего не делал, отправить заново тот же вход
    const input = record?.input ?? { kind: "recovery" as const, message: recoveryMessages.providerError, decisionId: null };
    const firstPrompt = run.promptsSent.length <= 1 && (input.kind === "initial" || input.kind === "restart");
    await core.store.tasks.commit(
      core.key,
      (s, c) => {
        c.emit("runtime.recovered", "cli", { phase: s.phase, action: "resend_prompt", details: { runId: run.runId, promptId: lastPrompt ?? null } });
        return {
          ...s,
          status: "active",
          phase: "agent_pending",
          nextAgentInput: input,
          currentRun: { ...run, status: firstPrompt ? "pending" : "running", promptsSent: run.promptsSent.filter((p) => p !== lastPrompt) },
        };
      },
      { expectedVersion: state.version },
    );
    return null;
  }

  const last = info.lastEntry;
  if (last?.kind === "assistant" && last.stopReason === "stop") {
    await settleRun(core, state, "unstructured_settle", { lastAssistantText: last.text, recovered: "settle_unstructured" });
    return null;
  }
  // Ход прерван посередине: внешний мир неизвестен. Не продолжать автоматически — решает supervisor (D9)
  await settleRun(core, state, "interrupted", { recovered: "handoff_to_supervisor" });
  return null;
}

/** Неоднозначный случай (03-engine.md §8.4): выбор человека. */
async function ambiguous(core: EngineCore, state: TaskState, reason: string): Promise<ExitOutcome | null> {
  const run = state.currentRun;
  core.reporter.emit({
    type: "warning",
    text: `Задача ${core.key} не может быть восстановлена автоматически: файл сессии ${run?.sessionFile ?? ""} повреждён (${reason}).`,
  });
  if (!core.human) return { kind: "waiting_human" };
  type Choice = "restart" | "supervisor" | "block" | "exit";
  const labels: Record<Choice, string> = {
    restart: "Перезапустить агента этапа с новой сессией (restart)",
    supervisor: "Передать supervisor для решения",
    block: "Заблокировать задачу",
    exit: "Выйти без изменений",
  };
  let choice: Choice;
  try {
    choice = await core.human.select<Choice>(
      "Как восстановить задачу?",
      (Object.keys(labels) as Choice[]).map((value) => ({ label: labels[value], value, ...(value === "exit" ? { key: "q" } : {}) })),
    );
  } catch (err) {
    if (err instanceof UserAbortError) throw new InterruptRequest("SIGINT");
    throw err;
  }
  if (choice === "exit") return { kind: "recovery_declined" };
  await core.store.tasks.commit(
    core.key,
    (s, c) => {
      c.emit("human.responded", "human", { requestId: null, answer: labels[choice], selectedOption: labels[choice] });
      c.emit("runtime.recovered", "cli", { phase: s.phase, action: `ambiguous_${choice}`, details: { reason } });
      if (choice === "block") {
        c.emit("task.blocked", "cli", { code: "SESSION_CORRUPTED", message: reason, by: "cli" });
        return haltedState(s, "blocked", { code: "SESSION_CORRUPTED", message: `файл сессии повреждён: ${reason}`, at: c.now });
      }
      if (choice === "restart") {
        return {
          ...s,
          status: "active",
          phase: "agent_pending",
          nextAgentInput: { kind: "restart", message: "Файл сессии предыдущей попытки повреждён. Начни этап заново.", decisionId: null },
        };
      }
      return {
        ...s,
        status: "active",
        phase: "supervisor_pending",
        currentRun: s.currentRun ? { ...s.currentRun, status: "failed", settleReason: "interrupted" } : null,
        supervisor: { ...s.supervisor, trigger: { kind: "recovered", ref: s.currentRun?.runId ?? null } },
      };
    },
    { expectedVersion: state.version },
  );
  return choice === "block" ? { kind: "blocked", code: "SESSION_CORRUPTED" } : null;
}
