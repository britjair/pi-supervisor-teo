// sdlc doctor, 05-cli-ui.md §7. Часть M1: окружение, Policy, project root.
// Pi SDK, модели и пробная сессия — M4; хранилище .sdlc — M2. Без --fix ничего не меняет.

import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import type { AppContext } from "../app.js";
import { agentList, type LoadedPolicy } from "../domain/policy.js";
import { ExitCode, PolicyError, UsageError } from "../errors/errors.js";
import { detectProjectRoot } from "../project/project-root.js";
import { projectLayout } from "../state/layout.js";
import { msg } from "../ui/messages.js";
import { issueLines, policyProblemLines } from "../ui/plain/policy-report.js";
import { tildify } from "../util/strings.js";

export type CheckLevel = "ok" | "info" | "warning" | "error" | "skipped";

export type DoctorCheck = {
  id: string;
  level: CheckLevel;
  title: string;
  details: string[];
  /** Сколько проблем в проверке, если больше одной (предупреждения Policy). */
  count?: number;
};

export const MIN_NODE_VERSION = "22.19.0";

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** Какие modelRef используются и кем: «default (analyst, developer, supervisor)». */
function modelUsage(policy: LoadedPolicy): string {
  const users = new Map<string, string[]>();
  const add = (ref: string, who: string) => users.set(ref, [...(users.get(ref) ?? []), who]);
  for (const agent of agentList(policy.spec)) add(agent.thinking ? `${agent.model} [${agent.thinking}]` : agent.model, agent.id);
  const sv = policy.spec.supervisor;
  add(sv.thinking ? `${sv.model} [${sv.thinking}]` : sv.model, "supervisor");
  return [...users].map(([ref, who]) => msg.doctor.modelsUsage(ref, who)).join("; ");
}

export async function collectDoctorChecks(ctx: AppContext): Promise<{ checks: DoctorCheck[]; policyValid: boolean }> {
  const checks: DoctorCheck[] = [];
  const s = ctx.style;

  // Node.js
  checks.push({
    id: "node",
    level: compareVersions(ctx.nodeVersion, MIN_NODE_VERSION) >= 0 ? "ok" : "error",
    title: msg.doctor.node(ctx.nodeVersion, MIN_NODE_VERSION),
    details: [],
  });

  // Policy
  const display = tildify(ctx.policyLoader.path, ctx.homeDir);
  let policy: LoadedPolicy | null = null;
  try {
    policy = await ctx.policyLoader.loadAndValidate();
    checks.push({
      id: "policy",
      level: "ok",
      title: msg.doctor.policyOk(
        display,
        policy.hash,
        Object.keys(policy.spec.workflow.stages).length,
        Object.keys(policy.spec.agents).length,
      ),
      details: [],
    });
    if (policy.warnings.length > 0) {
      checks.push({
        id: "policy.warnings",
        level: "warning",
        title: msg.doctor.policyWarnings(policy.warnings.length),
        count: policy.warnings.length,
        details: policy.warnings.flatMap((w) => issueLines(w, "warning", s, "")),
      });
    }
    checks.push({ id: "policy.models", level: "info", title: msg.doctor.models(modelUsage(policy)), details: [] });
  } catch (err) {
    if (!(err instanceof PolicyError)) throw err;
    checks.push({
      id: "policy",
      level: "error",
      title: msg.doctor.policyFailed(display),
      details: policyProblemLines(err, s, ""),
    });
  }

  checks.push({ id: "pi", level: "skipped", title: msg.doctor.piSkipped, details: [] });

  // Project root
  const project = await detectProjectRoot(ctx.cwd, ctx.exec);
  checks.push({ id: "project.root", level: "ok", title: msg.doctor.projectRoot(project.root, project.source), details: [] });
  try {
    await access(project.root, constants.R_OK | constants.W_OK);
    checks.push({ id: "project.access", level: "ok", title: msg.doctor.projectAccess, details: [] });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
    checks.push({ id: "project.access", level: "error", title: msg.doctor.projectAccessFailed(code), details: [] });
  }

  // Хранилище
  const layout = projectLayout(project.root);
  const sdlcExists = await stat(layout.sdlcDir).then(
    (st) => st.isDirectory(),
    () => false,
  );
  checks.push(
    sdlcExists
      ? { id: "storage", level: "skipped", title: msg.doctor.sdlcSkipped, details: [] }
      : { id: "storage", level: "info", title: msg.doctor.sdlcAbsent, details: [] },
  );

  return { checks, policyValid: policy !== null };
}

export function renderDoctor(ctx: AppContext, checks: readonly DoctorCheck[]): string {
  const s = ctx.style;
  const mark: Record<CheckLevel, string> = {
    ok: s.green("✓"),
    info: s.dim("·"),
    warning: s.yellow("!"),
    error: s.red("✗"),
    skipped: s.dim("–"),
  };
  const lines = [s.bold(msg.doctor.title), ""];
  for (const c of checks) {
    const title = c.level === "skipped" ? s.dim(c.title) : c.title;
    lines.push(`${mark[c.level]} ${title}`);
    for (const d of c.details) lines.push(d ? `    ${d}` : "");
  }
  const errors = checks.filter((c) => c.level === "error").length;
  const warnings = checks.filter((c) => c.level === "warning").reduce((n, c) => n + (c.count ?? 1), 0);
  lines.push("", msg.doctor.summary(errors, warnings));
  return lines.join("\n") + "\n";
}

export async function runDoctor(ctx: AppContext, opts: { fix: boolean }): Promise<number> {
  if (opts.fix) throw new UsageError(msg.doctor.fixNotImplemented);
  const { checks, policyValid } = await collectDoctorChecks(ctx);
  ctx.stdout.write(renderDoctor(ctx, checks));
  if (!policyValid) return ExitCode.config;
  return checks.some((c) => c.level === "error") ? ExitCode.runtime : ExitCode.ok;
}
