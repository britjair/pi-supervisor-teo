// Инструменты дочернего агента, 04-agents.md §4: report_result, report_blocker, ask_user.
// Инструментов изменения state и этапа нет (критерий приёмки 8).

import path from "node:path";
import { z } from "zod";
import type { AgentDef } from "../../domain/policy.js";
import type { AgentReport, ReportBlockerInput, ReportResultInput } from "../../domain/runs.js";
import type { HumanRequest } from "../../domain/task-state.js";
import { UserAbortError } from "../../errors/errors.js";
import { resolveWithin } from "../../util/paths.js";
import { sha256File } from "../evidence-refs.js";
import type { SdlcToolDefinition, ToolResult } from "../runtime.js";
import type { EngineCore } from "../../workflow/context.js";

const text = z.string().refine((s) => s.trim().length > 0, "строка не может быть пустой");

const reportResultSchema = z.object({
  summary: text.describe("Что сделано на этапе: только то, что действительно сделано и проверено"),
  evidence: z
    .array(z.object({ kind: text, value: text, description: z.string().optional() }))
    .optional()
    .describe("Проверяемые факты: SHA коммита, команда тестов и её результат, URL MR и т. п."),
  artifacts: z
    .array(z.object({ kind: text, pathOrUrl: text, description: z.string().optional() }))
    .optional()
    .describe("Файлы (пути внутри проекта) и ссылки, созданные на этапе"),
  notes: z.array(z.string()).optional(),
  externalWait: z
    .object({
      waitingFor: text.describe("Чего ждёт этап: «ответ ревьюера в треде <url>», «pipeline <url>»"),
      checkAgainInMinutes: z.int().positive().optional(),
    })
    .optional()
    .describe("Работа сделана, но этап ждёт внешнего события. Supervisor может запланировать перепроверку"),
});

const reportBlockerSchema = z.object({
  summary: text,
  details: text,
  requiresHuman: z.boolean().describe("Нужно решение человека. Вопрос задаст supervisor"),
  suggestedQuestion: z.string().optional(),
});

const askUserSchema = z.object({
  question: text,
  context: z.string().optional(),
  options: z.array(text).min(2).max(10).optional(),
  allowFreeText: z.boolean().optional(),
  attachments: z.array(text).optional().describe("Пути файлов внутри проекта, которые нужно показать пользователю"),
});

const toolError = (code: string, message: string, terminate = false): ToolResult => ({
  content: `${code}: ${message}`,
  isError: true,
  ...(terminate ? { terminate } : {}),
});

const isUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

/** Агент этой сессии сейчас выполняет run: иначе отчёт и вопрос не к месту. */
async function activeRun(core: EngineCore, sessionFile: string) {
  const state = await core.store.tasks.load(core.key);
  const rel = path.relative(core.task().dir, sessionFile);
  const run = state.currentRun;
  if (state.phase !== "agent_running" || !run || run.sessionFile !== rel || run.status !== "running") return null;
  return { state, run };
}

async function writeReport(core: EngineCore, sessionFile: string, report: AgentReport): Promise<ToolResult> {
  const active = await activeRun(core, sessionFile);
  if (!active) return toolError("NO_ACTIVE_RUN", "этот запуск агента уже завершён");
  const runs = core.runs();
  const record = await runs.read(active.run.runId);
  if (!record) return toolError("NO_ACTIVE_RUN", "запись запуска не найдена");
  if (record.report) {
    return toolError("ALREADY_REPORTED", "отчёт в этом цикле уже записан. Заверши ход.", true);
  }
  // Отчёт записывается до ответа модели: падение после него отчёт не теряет (02-storage.md §5)
  await runs.write({ ...record, report });
  core.reported.add(sessionFile);
  core.faults.check("in-agent-report");
  await core.store.tasks.commit(core.key, (s, c) => {
    c.emit("agent.reported", "agent", { runId: active.run.runId, kind: report.kind, summary: report.data.summary });
    return s;
  });
  return { content: "Отчёт записан. Supervisor проверит его независимо. Заверши ход.", terminate: true };
}

export function childTools(core: EngineCore, agent: AgentDef, sessionFile: string): SdlcToolDefinition[] {
  const projectRoot = core.store.layout.projectRoot;
  const now = () => core.clock.now().toISOString();

  const reportResult: SdlcToolDefinition<typeof reportResultSchema> = {
    name: "report_result",
    description:
      "Завершить ход отчётом о работе этапа. Отчёт — заявление: supervisor проверит его по git, файлам и транскрипту. После вызова заверши ход.",
    parameters: reportResultSchema,
    async execute(input) {
      const data = input as ReportResultInput;
      const artifacts: NonNullable<ReportResultInput["artifacts"]> = [];
      for (const a of data.artifacts ?? []) {
        if (isUrl(a.pathOrUrl)) {
          artifacts.push(a);
          continue;
        }
        const target = await resolveWithin([projectRoot], projectRoot, a.pathOrUrl);
        if (!target) return toolError("ARTIFACT_OUTSIDE_PROJECT", `путь ${a.pathOrUrl} вне проекта ${projectRoot}`);
        artifacts.push({ ...a, pathOrUrl: path.relative(projectRoot, target) || "." });
      }
      return writeReport(core, sessionFile, {
        kind: "result",
        at: now(),
        data: { ...data, ...(data.artifacts ? { artifacts } : {}) },
      });
    },
  };

  const reportBlocker: SdlcToolDefinition<typeof reportBlockerSchema> = {
    name: "report_blocker",
    description:
      "Завершить ход сообщением, что продолжить этап невозможно. requiresHuman — подсказка supervisor-у: вопрос человеку задаёт он.",
    parameters: reportBlockerSchema,
    execute: (input) => writeReport(core, sessionFile, { kind: "blocker", at: now(), data: input as ReportBlockerInput }),
  };

  const askUser: SdlcToolDefinition<typeof askUserSchema> = {
    name: "ask_user",
    description:
      "Задать вопрос пользователю и дождаться ответа. Ответ записывается в журнал задачи (human.responded) и возвращается с responseRef.",
    parameters: askUserSchema,
    async execute(input) {
      const human = core.human;
      if (!human) {
        return toolError(
          "HUMAN_UNAVAILABLE",
          "пользователь недоступен в неинтерактивном режиме; завершите работу через report_blocker с requiresHuman=true",
        );
      }
      const active = await activeRun(core, sessionFile);
      if (!active) return toolError("NO_ACTIVE_RUN", "этот запуск агента уже завершён");
      const attachments: HumanRequest["attachments"] = [];
      for (const p of input.attachments ?? []) {
        const target = await resolveWithin([projectRoot], projectRoot, p);
        if (!target) return toolError("ATTACHMENT_INVALID", `вложение ${p} вне проекта`);
        try {
          attachments.push({ path: path.relative(projectRoot, target), sha256: await sha256File(target) });
        } catch {
          return toolError("ATTACHMENT_INVALID", `вложение ${p} не найдено`);
        }
      }
      const requested = await core.store.tasks.commit(core.key, (s, c) => {
        const requestId = c.emit("human.requested", "agent", (id) => ({
          requestId: id,
          origin: "agent",
          runId: active.run.runId,
          question: input.question,
          options: input.options ?? null,
          attachments,
        }));
        const request: HumanRequest = {
          requestId,
          origin: "agent",
          runId: active.run.runId,
          question: input.question,
          context: input.context ?? null,
          options: input.options ?? null,
          allowFreeText: input.allowFreeText ?? true,
          attachments,
          requestedAt: c.now,
        };
        return { ...s, status: "waiting_human", pendingHumanRequest: request };
      });
      core.faults.check("in-ask-user");
      const request = requested.pendingHumanRequest;
      if (!request) throw new Error("pendingHumanRequest не записан");
      const answer = await askAgentQuestion(core, request).catch((err: unknown) => {
        if (err instanceof UserAbortError) {
          core.interrupt("SIGINT");
          return null;
        }
        throw err;
      });
      if (!answer) return toolError("INTERRUPTED", "вопрос прерван остановкой sdlc", true);
      let responseId = "";
      await core.store.tasks.commit(core.key, (s, c) => {
        responseId = c.emit("human.responded", "human", {
          requestId: request.requestId,
          answer: answer.answer,
          selectedOption: answer.selectedOption,
        });
        return { ...s, status: "active", pendingHumanRequest: null };
      });
      return {
        content: JSON.stringify({ answer: answer.answer, selectedOption: answer.selectedOption, responseRef: `human:${responseId}` }),
      };
    },
  };

  const tools: SdlcToolDefinition[] = [reportResult as SdlcToolDefinition, reportBlocker as SdlcToolDefinition];
  if (agent.askUser) tools.push(askUser as SdlcToolDefinition);
  return tools;
}

/** Показать вопрос агента (и при recovery — тот же вопрос снова). */
export async function askAgentQuestion(core: EngineCore, request: HumanRequest) {
  if (!core.human) return null;
  const state = await core.store.tasks.readState(core.key);
  const run = state.currentRun;
  const stageTitle = core.store.stageTitle(state.stage) ?? state.stage;
  return core.ask({
    header: `Вопрос от агента ${run?.agentId ?? ""} · ${core.key} · ${stageTitle}`,
    question: request.question,
    context: request.context,
    options: request.options,
    allowFreeText: request.allowFreeText,
    attachments: request.attachments,
  });
}
