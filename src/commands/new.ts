// teo new [KEY] [--title T] [--description-file F | --description -] (05-cli-ui.md §2, §3.2).
// Создание задачи — один commit в новом каталоге; затем движок (если не --no-run).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { startCommand, type AppContext } from "../app.js";
import { getAgent, getStage, type LoadedPolicy } from "../domain/policy.js";
import { SUPERVISOR_SESSION_FILE, TASK_STATE_SCHEMA_VERSION, type TaskState } from "../domain/task-state.js";
import { ExitCode, LockConflictError, UsageError } from "../errors/errors.js";
import { gitSummary } from "../project/project-root.js";
import { holderOf } from "../state/lock-manager.js";
import type { ProjectStore } from "../state/project-store.js";
import { findCaseInsensitive, taskKeyProblem } from "../state/task-key.js";
import type { HumanIO } from "../ui/human-io.js";
import { msg } from "../ui/messages.js";
import { executeTask } from "./run-task.js";

export type NewOptions = { key?: string; title?: string; descriptionFile?: string; description?: string; process?: string; noRun?: boolean };
export type NewTaskInput = { key: string; title: string; description: string; process: string };

export const TITLE_MAX = 200;

export function keyError(key: string, existing: readonly string[]): string | null {
  const problem = taskKeyProblem(key);
  if (problem) return msg.newTask.keyProblem(problem, key);
  const dup = findCaseInsensitive(key, existing);
  return dup ? msg.newTask.keyProblem("duplicate", key, dup) : null;
}

export function titleError(title: string): string | null {
  const t = title.trim();
  if (t === "") return msg.newTask.titleEmpty;
  if (/[\r\n]/.test(t)) return msg.newTask.titleMultiline;
  if ([...t].length > TITLE_MAX) return msg.newTask.titleTooLong(TITLE_MAX);
  return null;
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

async function descriptionFromFlags(ctx: AppContext, opts: NewOptions): Promise<string | undefined> {
  if (opts.descriptionFile !== undefined && opts.description !== undefined) throw new UsageError(msg.newTask.descriptionConflict);
  if (opts.descriptionFile !== undefined) {
    const file = path.resolve(ctx.cwd, opts.descriptionFile);
    try {
      return await readFile(file, "utf8");
    } catch (err) {
      throw new UsageError(msg.newTask.descriptionFileUnreadable(file, (err as NodeJS.ErrnoException).code ?? "UNKNOWN"));
    }
  }
  if (opts.description === "-") return readStream(ctx.stdin);
  return opts.description;
}

/** Без терминала: все поля из флагов. */
async function inputFromFlags(ctx: AppContext, store: ProjectStore, opts: NewOptions): Promise<NewTaskInput> {
  const description = (await descriptionFromFlags(ctx, opts))?.trim();
  const missing = [
    opts.key === undefined ? "KEY" : null,
    opts.title === undefined ? "--title" : null,
    description === undefined ? "--description-file или --description" : null,
  ].filter((x): x is string => x !== null);
  if (missing.length > 0) throw new UsageError(msg.newTask.missingFields(missing));
  const key = opts.key ?? "";
  const title = (opts.title ?? "").trim();
  const problem = keyError(key, await store.tasks.listKeys()) ?? titleError(title) ?? (description ? null : msg.newTask.descriptionEmpty);
  if (problem) throw new UsageError(problem);
  return { key, title, description: description ?? "", process: await chooseProcess(null, store, opts.process) };
}

/**
 * Процесс новой задачи (D32): флаг --process; единственный валидный процесс выбирается сам;
 * несколько — меню в терминале, без терминала флаг обязателен. Невалидный процесс → PolicyError (exit 2).
 */
export async function chooseProcess(human: HumanIO | null, store: ProjectStore, flag: string | undefined): Promise<string> {
  if (flag !== undefined) {
    store.policyOf(flag);
    return flag;
  }
  const valid = store.processes.flatMap((p) => (p.ok ? [p] : []));
  const [only] = valid;
  if (valid.length === 1 && only) return only.name;
  if (!human) throw new UsageError(msg.newTask.processRequired(valid.map((p) => p.name)));
  return human.select(
    msg.newTask.chooseProcess,
    valid.map((p) => ({ label: msg.newTask.processChoice(p.name, initialStageTitle(p.policy), Object.keys(p.policy.spec.workflow.stages).length), value: p.name })),
  );
}

/** Проект занят живым процессом — сообщить до заполнения формы. */
async function assertNotLocked(store: ProjectStore): Promise<void> {
  const lock = await store.locks.inspect();
  if (lock.kind !== "none" && !lock.stale) throw new LockConflictError(msg.lock.conflictTitle, holderOf(lock));
}

/** Форма создания задачи (05-cli-ui.md §3.2). null — пользователь выбрал «Отмена». */
export async function newTaskForm(
  ctx: AppContext,
  human: HumanIO,
  store: ProjectStore,
  opts: NewOptions,
): Promise<NewTaskInput | null> {
  await assertNotLocked(store);
  const existing = await store.tasks.listKeys();
  const git = await gitSummary(store.layout.projectRoot, ctx.exec);
  human.print(
    [
      ctx.style.bold(msg.newTask.title),
      msg.newTask.projectRoot(store.layout.projectRoot, git ? msg.newTask.gitSummary(git.branch, git.clean) : null),
      "",
    ].join("\n"),
  );

  const flagDescription = (await descriptionFromFlags(ctx, opts))?.trim();
  let key = opts.key !== undefined && keyError(opts.key, existing) === null ? opts.key : undefined;
  let title = opts.title !== undefined && titleError(opts.title) === null ? opts.title.trim() : undefined;
  let description = flagDescription ? flagDescription : undefined;
  if (opts.key !== undefined && key === undefined) human.print(ctx.style.yellow(`  ${keyError(opts.key, existing)}`));

  const process = await chooseProcess(human, store, opts.process);
  human.print(`${msg.newTask.process}: ${process}`);
  const initial = initialStageLine(store.policyOf(process));
  for (let editing = false; ; editing = true) {
    if (key === undefined || editing) {
      key = await human.input(msg.newTask.key, { ...(key !== undefined ? { initial: key } : {}), validate: (k) => keyError(k, existing) });
    } else {
      human.print(`${msg.newTask.key}: ${key}`);
    }
    if (title === undefined || editing) {
      title = await human.input(msg.newTask.taskTitle, { ...(title !== undefined ? { initial: title } : {}), validate: titleError });
    } else {
      human.print(`${msg.newTask.taskTitle}: ${title}`);
    }
    if (description === undefined || editing) {
      const previous: string | undefined = description;
      const typed = await human.multiline(msg.newTask.description, {
        validate: (d) => (d === "" && previous === undefined ? msg.newTask.descriptionEmpty : null),
      });
      description = typed === "" && previous !== undefined ? previous : typed;
    }
    human.print(["", initial, ""].join("\n"));
    const action = await human.select(msg.newTask.summary(key, title), [
      { label: msg.newTask.create, value: "create" as const },
      { label: msg.newTask.edit, value: "edit" as const },
      { label: msg.newTask.cancel, value: "cancel" as const, key: "q" },
    ]);
    if (action === "create") return { key, title, description, process };
    if (action === "cancel") return null;
  }
}

function initialStageTitle(policy: LoadedPolicy): string {
  return getStage(policy.spec, policy.spec.workflow.initialStage)?.title ?? policy.spec.workflow.initialStage;
}

function initialStageLine(policy: LoadedPolicy): string {
  const stage = getStage(policy.spec, policy.spec.workflow.initialStage);
  const agent = stage?.kind === "work" ? stage.agent : "";
  return msg.newTask.initialStage(stage?.title ?? policy.spec.workflow.initialStage, agent);
}

export function renderTaskMd(input: NewTaskInput, createdAt: string, projectRoot: string): string {
  return [
    `# ${input.key}: ${input.title}`,
    "",
    `Created: ${createdAt}`,
    `Project: ${projectRoot}`,
    `Process: ${input.process}`,
    "",
    "## Описание",
    "",
    input.description,
    "",
  ].join("\n");
}

/** Создать задачу под lock-ом проекта. Policy уже прошла preflight. */
export async function createTask(store: ProjectStore, input: NewTaskInput): Promise<TaskState> {
  const policy = store.policyOf(input.process);
  const stageId = policy.spec.workflow.initialStage;
  const projectRoot = store.layout.projectRoot;
  return store.withLock({ command: "new", taskKey: input.key, create: true }, async (lock) => {
    const dup = keyError(input.key, await store.tasks.listKeys());
    if (dup) throw new UsageError(dup);
    await store.snapshots.save(policy);
    lock.signal.throwIfAborted();
    return store.tasks.create(
      input.key,
      (c) => {
        const createdId = c.emit("task.created", "human", { title: input.title, process: input.process, stage: stageId, policyHash: policy.hash, projectRoot });
        return {
          schemaVersion: TASK_STATE_SCHEMA_VERSION,
          key: input.key,
          title: input.title,
          projectRoot,
          workspacePath: null,
          createdAt: c.now,
          process: input.process,
          policyHash: policy.hash,
          policySchema: policy.schema,
          stage: stageId,
          stageEnteredAt: c.now,
          stageEntryEventId: createdId,
          stageCycles: 0,
          stageRechecks: { count: 0, waitedMinutes: 0, firstScheduledAt: null },
          status: "active",
          statusReason: null,
          phase: "agent_pending",
          currentRun: null,
          agentRunCounters: {},
          consecutiveRestarts: 0,
          nextAgentInput: { kind: "initial", message: null, decisionId: null },
          wait: null,
          supervisor: { sessionFile: SUPERVISOR_SESSION_FILE, cycle: 0, trigger: null, lastPolicyHashShown: null },
          pendingDecision: null,
          lastAppliedDecisionId: null,
          lastDecision: null,
          pendingHumanRequest: null,
        };
      },
      // Время в task.md совпадает с createdAt state: оба берутся из одного commit-а
      { taskMd: (now: string) => renderTaskMd(input, now, projectRoot) },
    );
  });
}

export function createdText(store: ProjectStore, state: TaskState): string {
  const policy = store.policyOf(state.process);
  const stage = getStage(policy.spec, state.stage);
  const agentId = stage?.kind === "work" ? stage.agent : "";
  const agent = getAgent(policy.spec, agentId);
  return [msg.newTask.created(state.key, stage?.title ?? state.stage, agent?.id ?? agentId), msg.newTask.notStarted(state.key)].join(
    "\n",
  );
}

export async function runNew(ctx: AppContext, opts: NewOptions): Promise<number> {
  const { store } = await startCommand(ctx);
  const input = ctx.human ? await newTaskForm(ctx, ctx.human, store, opts) : await inputFromFlags(ctx, store, opts);
  if (!input) return ExitCode.ok;
  const state = await createTask(store, input);
  const created = (opts.noRun ? createdText(store, state) : createdText(store, state).split("\n")[0]) + "\n";
  if (ctx.human) ctx.human.print(created);
  else ctx.stdout.write(created);
  return opts.noRun ? ExitCode.ok : executeTask(ctx, store, state.key);
}
