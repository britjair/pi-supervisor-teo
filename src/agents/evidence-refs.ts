// Ссылки на доказательства, 04-agents.md §6. Проверки технические и дешёвые;
// достаточность доказательств оценивает supervisor.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { TaskEvent } from "../domain/events.js";
import type { ExecResult } from "../util/exec.js";
import { resolveWithin } from "../util/paths.js";

export const EVIDENCE_SCHEMES = ["git", "file", "artifact", "human", "event", "run", "url", "note"] as const;
export type EvidenceScheme = (typeof EVIDENCE_SCHEMES)[number];

export type ParsedRef = { scheme: EvidenceScheme; value: string };

export const GIT_REF_RE = /^[A-Za-z0-9._/@^~{}-]{1,200}$/;

export function parseEvidenceRef(ref: string): ParsedRef | null {
  const i = ref.indexOf(":");
  if (i <= 0) return null;
  const scheme = ref.slice(0, i);
  const value = ref.slice(i + 1);
  if (!(EVIDENCE_SCHEMES as readonly string[]).includes(scheme) || value.trim() === "") return null;
  return { scheme: scheme as EvidenceScheme, value };
}

export function isValidGitRef(ref: string): boolean {
  return GIT_REF_RE.test(ref) && !ref.startsWith("-");
}

export type EvidenceContext = {
  projectRoot: string;
  artifactsDir: string;
  git: (args: string[]) => Promise<ExecResult>;
  findEvent: (id: string) => Promise<TaskEvent | null>;
  runExists: (runId: string) => Promise<boolean>;
};

export type EvidenceResult = { ok: true; ref: ParsedRef; event?: TaskEvent } | { ok: false; message: string };

export async function sha256File(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function checkFile(roots: string[], cwd: string, value: string, label: string): Promise<string | null> {
  const at = value.lastIndexOf("@");
  const [p, prefix] = at > 0 && /^[0-9a-f]{7,64}$/.test(value.slice(at + 1)) ? [value.slice(0, at), value.slice(at + 1)] : [value, null];
  const target = await resolveWithin(roots, cwd, p);
  if (!target) return `${label} ${p} вне допустимого каталога`;
  if (!(await stat(target).then((s) => s.isFile(), () => false))) return `${label} ${p} не существует`;
  if (prefix && !(await sha256File(target)).startsWith(prefix)) return `sha256 файла ${p} не начинается с ${prefix}: файл изменился`;
  return null;
}

export async function resolveEvidenceRef(ref: string, ctx: EvidenceContext): Promise<EvidenceResult> {
  const parsed = parseEvidenceRef(ref);
  if (!parsed) return { ok: false, message: `«${ref}»: неизвестная схема ссылки. Допустимые: ${EVIDENCE_SCHEMES.map((s) => `${s}:`).join(", ")}` };
  const fail = (message: string): EvidenceResult => ({ ok: false, message: `«${ref}»: ${message}` });
  const { scheme, value } = parsed;
  switch (scheme) {
    case "git": {
      if (!isValidGitRef(value)) return fail("недопустимое имя git-ссылки");
      const r = await ctx.git(["cat-file", "-e", `${value}^{commit}`]);
      return r.code === 0 ? { ok: true, ref: parsed } : fail("коммит не найден в репозитории");
    }
    case "file": {
      const problem = await checkFile([ctx.projectRoot], ctx.projectRoot, value, "файл");
      return problem ? fail(problem) : { ok: true, ref: parsed };
    }
    case "artifact": {
      const problem = await checkFile([ctx.artifactsDir], ctx.artifactsDir, value, "артефакт");
      return problem ? fail(problem) : { ok: true, ref: parsed };
    }
    case "human": {
      const event = await ctx.findEvent(value);
      return event?.type === "human.responded" ? { ok: true, ref: parsed, event } : fail("нет события human.responded с таким id");
    }
    case "event": {
      const event = await ctx.findEvent(value);
      return event ? { ok: true, ref: parsed, event } : fail("нет события с таким id");
    }
    case "run":
      return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value) && (await ctx.runExists(value)) ? { ok: true, ref: parsed } : fail("нет такого run");
    case "url":
      try {
        const u = new URL(value);
        return u.protocol === "https:" || u.protocol === "http:" ? { ok: true, ref: parsed } : fail("ожидается http(s)-URL");
      } catch {
        return fail("некорректный URL");
      }
    case "note":
      return { ok: true, ref: parsed };
  }
}

export function relativeTo(root: string, p: string): string {
  return path.relative(root, p) || ".";
}
