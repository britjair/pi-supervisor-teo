// Инструменты чтения и проверки supervisor-а, 04-agents.md §5.2. Ничего не исполняют,
// кроме фиксированных read-only вызовов git. Все тексты обрезаются с явной пометкой.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { TaskEvent } from "../../domain/events.js";
import { isPolicyHash } from "../../policy/policy-hash.js";
import { argsPreview, redact, truncate } from "../../util/redact.js";
import { resolveWithin } from "../../util/paths.js";
import type { EngineCore } from "../../workflow/context.js";
import { sha256File } from "../evidence-refs.js";
import type { SdlcToolDefinition, ToolResult } from "../runtime.js";
import { GitInspector } from "./git-inspect.js";

const MAX_TEXT = 64 * 1024;
const MAX_DIFF = 200 * 1024;

const ok = (content: string, max = MAX_TEXT): ToolResult => ({ content: truncate(content, max) });
const fail = (code: string, message: string): ToolResult => ({ content: `${code}: ${message}`, isError: true });
const json = (value: unknown, max = MAX_TEXT) => ok(JSON.stringify(redact(value), null, 2), max);

function tool<S extends z.ZodType>(def: SdlcToolDefinition<S>): SdlcToolDefinition {
  return def as unknown as SdlcToolDefinition;
}

/** Простой glob: **, *, ? */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? "";
    if (ch === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

async function walk(root: string, dir: string, out: string[], max: number): Promise<void> {
  if (out.length >= max) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= max) return;
    if (e.name === ".git" || e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(root, full, out, max);
    else out.push(path.relative(root, full));
  }
}

export async function listArtifacts(artifactsDir: string): Promise<Array<{ path: string; size: number; mtime: string; sha256: string }>> {
  const files: string[] = [];
  await walk(artifactsDir, artifactsDir, files, 2000);
  const out = [];
  for (const f of files) {
    const full = path.join(artifactsDir, f);
    const st = await stat(full);
    out.push({ path: f, size: st.size, mtime: st.mtime.toISOString(), sha256: await sha256File(full) });
  }
  return out;
}

function eventLine(e: TaskEvent): string {
  return `${e.timestamp} ${e.id} ${e.type} ${argsPreview(e.payload, 300)}`;
}

export function supervisorReadTools(core: EngineCore): SdlcToolDefinition[] {
  const root = core.store.layout.projectRoot;
  const git = new GitInspector(core.exec, root);
  const t = () => core.task();

  const runFor = async (runId: string | undefined) => {
    const state = await core.store.tasks.load(core.key);
    const id = runId ?? state.currentRun?.runId;
    if (!id) return null;
    try {
      return await core.runs().read(id);
    } catch {
      return null;
    }
  };

  return [
    tool({
      name: "read_policy",
      description: "Текст Policy (SDLC.md) и её hash: текущей или сохранённого снимка по hash",
      parameters: z.object({ hash: z.string().optional() }),
      async execute({ hash }) {
        if (!hash || hash === core.policy.hash) return ok(`hash: ${core.policy.hash}\n\n${core.policy.raw}`, 256 * 1024);
        if (!isPolicyHash(hash)) return fail("INVALID_INPUT", "hash должен иметь вид sha256:<64 hex>");
        const text = await core.store.snapshots.read(hash);
        return text === null ? fail("NOT_FOUND", `снимка ${hash} нет`) : ok(`hash: ${hash}\n\n${text}`, 256 * 1024);
      },
    }),
    tool({
      name: "read_state",
      description: "state.json задачи",
      parameters: z.object({}),
      execute: async () => json(await core.store.tasks.load(core.key)),
    }),
    tool({
      name: "read_task_description",
      description: "task.md: описание задачи от пользователя",
      parameters: z.object({}),
      execute: async () => ok(await readFile(t().taskMd, "utf8")),
    }),
    tool({
      name: "list_artifacts",
      description: "Файлы каталога artifacts/ задачи: путь, размер, mtime, sha256",
      parameters: z.object({}),
      execute: async () => json(await listArtifacts(t().artifactsDir)),
    }),
    tool({
      name: "read_artifact",
      description: "Содержимое файла из artifacts/ и его sha256. offset и limit — в строках",
      parameters: z.object({ path: z.string().min(1), offset: z.int().min(0).optional(), limit: z.int().min(1).optional() }),
      async execute({ path: p, offset, limit }) {
        const target = await resolveWithin([t().artifactsDir], t().artifactsDir, p);
        if (!target) return fail("PATH_OUTSIDE", `${p} вне artifacts/`);
        try {
          const lines = (await readFile(target, "utf8")).split("\n");
          const from = offset ?? 0;
          const slice = lines.slice(from, limit ? from + limit : undefined);
          return ok(`sha256: ${await sha256File(target)}\nстроки ${from + 1}–${from + slice.length} из ${lines.length}\n\n${slice.join("\n")}`);
        } catch {
          return fail("NOT_FOUND", `${p} не найден`);
        }
      },
    }),
    tool({
      name: "read_agent_result",
      description: "Запись run агента: вход, отчёт, причина завершения, ошибка, хвост последнего ответа. По умолчанию — текущий run",
      parameters: z.object({ runId: z.string().optional() }),
      async execute({ runId }) {
        const record = await runFor(runId);
        return record ? json(record) : fail("NOT_FOUND", "run не найден");
      },
    }),
    tool({
      name: "read_agent_transcript",
      description:
        "Сжатая лента сессии агента: текст ассистента, вызовы инструментов и их результаты. Показывает, что агент действительно запускал",
      parameters: z.object({ runId: z.string().optional(), tail: z.int().min(1).max(200).optional() }),
      async execute({ runId, tail }) {
        const record = await runFor(runId);
        if (!record) return fail("NOT_FOUND", "run не найден");
        const entries = await core.runtime.readTranscript(path.join(t().dir, record.sessionFile), { tail: tail ?? 30 });
        const lines = entries.map((e) => {
          switch (e.kind) {
            case "user":
              return `[user] ${truncate(e.text, 2000)}`;
            case "assistant":
              return `[assistant] ${truncate(e.text, 4000)}`;
            case "tool_call":
              return `[tool ${e.toolCallId}] ${e.toolName} ${e.argsPreview}`;
            case "tool_result":
              return `[result ${e.toolCallId}] ${e.toolName} ${e.ok ? "ok" : "error"}: ${e.preview}`;
          }
        });
        return ok(`run ${record.runId}, сессия ${record.sessionFile}\n\n${lines.map((l) => redact(l)).join("\n")}`);
      },
    }),
    tool({
      name: "read_recent_events",
      description: "События журнала задачи, новые в конце",
      parameters: z.object({
        limit: z.int().min(1).max(200).optional(),
        types: z.array(z.string()).optional(),
        sinceEventId: z.string().optional(),
      }),
      async execute({ limit, types, sinceEventId }) {
        let events = await core.events();
        if (sinceEventId) events = events.filter((e) => e.id > sinceEventId);
        if (types?.length) events = events.filter((e) => types.includes(e.type));
        return ok(events.slice(-(limit ?? 20)).map(eventLine).join("\n") || "Событий нет.");
      },
    }),
    tool({
      name: "inspect_git_status",
      description: "Ветка, HEAD, upstream и ahead/behind, изменённые и неотслеживаемые файлы (без .sdlc), незавершённый merge/rebase",
      parameters: z.object({}),
      execute: async () => json(await git.status()),
    }),
    tool({
      name: "inspect_git_commit",
      description: "Существует ли коммит, sha, subject, автор, дата, --stat, входит ли в текущую ветку",
      parameters: z.object({ ref: z.string().min(1) }),
      execute: async ({ ref }) => json(await git.commit(ref)),
    }),
    tool({
      name: "inspect_git_diff",
      description: "git diff (или --stat) между ссылками или рабочим деревом, без .sdlc",
      parameters: z.object({
        base: z.string().optional(),
        head: z.string().optional(),
        paths: z.array(z.string()).optional(),
        stat: z.boolean().optional(),
      }),
      async execute(input) {
        const r = await git.diff({
          ...(input.base ? { base: input.base } : {}),
          ...(input.head ? { head: input.head } : {}),
          ...(input.paths ? { paths: input.paths } : {}),
          ...(input.stat ? { stat: input.stat } : {}),
        });
        return r.ok ? ok(r.text || "Изменений нет.", MAX_DIFF) : fail("GIT_ERROR", r.text);
      },
    }),
    tool({
      name: "inspect_file",
      description: "Содержимое и sha256 файла внутри проекта; startLine и endLine — с 1",
      parameters: z.object({ path: z.string().min(1), startLine: z.int().min(1).optional(), endLine: z.int().min(1).optional() }),
      async execute({ path: p, startLine, endLine }) {
        const target = await resolveWithin([root], root, p);
        if (!target) return fail("PATH_OUTSIDE", `${p} вне проекта`);
        try {
          const lines = (await readFile(target, "utf8")).split("\n");
          const from = (startLine ?? 1) - 1;
          const slice = lines.slice(from, endLine ?? undefined);
          return ok(`sha256: ${await sha256File(target)}\nстроки ${from + 1}–${from + slice.length} из ${lines.length}\n\n${slice.join("\n")}`);
        } catch {
          return fail("NOT_FOUND", `${p} не найден`);
        }
      },
    }),
    tool({
      name: "list_files",
      description: "Файлы проекта с учётом .gitignore",
      parameters: z.object({ path: z.string().optional(), glob: z.string().optional(), maxEntries: z.int().min(1).max(2000).optional() }),
      async execute({ path: p, glob, maxEntries }) {
        const max = maxEntries ?? 500;
        const base = await resolveWithin([root], root, p ?? ".");
        if (!base) return fail("PATH_OUTSIDE", `${p} вне проекта`);
        const relBase = path.relative(root, base);
        let files = (await git.listFiles()) ?? (await (async () => {
          const out: string[] = [];
          await walk(root, root, out, 20_000);
          return out;
        })());
        if (relBase) files = files.filter((f) => f === relBase || f.startsWith(relBase + "/"));
        if (glob) {
          const re = globToRegExp(glob);
          files = files.filter((f) => re.test(f) || re.test(path.basename(f)));
        }
        const shown = files.slice(0, max);
        return ok(shown.join("\n") + (files.length > max ? `\n…[показано ${max} из ${files.length}]` : "") || "Файлов нет.");
      },
    }),
    tool({
      name: "record_note",
      description: "Записать заметку в журнал задачи (supervisor.note). Не управляющий: цикл не завершает",
      parameters: z.object({ text: z.string().min(1) }),
      async execute({ text }) {
        await core.store.tasks.appendDirect(core.key, "supervisor.note", "supervisor", { cycle: core.cycle?.cycle ?? 0, text: redact(text) });
        return ok("Заметка записана.");
      },
    }),
  ];
}
