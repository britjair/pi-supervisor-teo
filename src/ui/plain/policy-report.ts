// Вывод ошибок Policy, 01-policy.md §3.3.

import type { PolicyIssue } from "../../domain/policy.js";
import type { PolicyError } from "../../errors/errors.js";
import { tildify } from "../../util/strings.js";
import { msg, policyErrorHeadline, policyIssueText } from "../messages.js";
import type { Style } from "./style.js";

/** Строки одной проблемы: «✗ путь (строка N)» и текст с отступом. */
export function issueLines(issue: PolicyIssue, mark: "error" | "warning", style: Style, indent = "  "): string[] {
  const sign = mark === "error" ? style.red("✗") : style.yellow("!");
  const line = issue.line !== null ? msg.line(issue.line) : null;
  const where = issue.path ? (line ? `${issue.path} (${line})` : issue.path) : (line ?? "");
  const text = policyIssueText(issue);
  if (!where) return [`${indent}${sign} ${text}`];
  return [`${indent}${sign} ${where}`, `${indent}  ${text}`];
}

/** Блок «что не так с Policy»: заголовок шага и все проблемы. Используется и doctor-ом. */
export function policyProblemLines(err: PolicyError, style: Style, indent = "  "): string[] {
  const lines = [policyErrorHeadline(err.code, err.issues.length)];
  const listed = err.issues.length > 1 || err.code === "POLICY_SCHEMA" || err.code === "POLICY_GRAPH" || err.code === "POLICY_YAML";
  if (listed) {
    lines.push("");
    for (const issue of err.issues) lines.push(...issueLines(issue, "error", style, indent), "");
    lines.pop();
  } else if (err.issues[0]) {
    const issue = err.issues[0];
    const text = policyIssueText(issue);
    // Для отсутствующего файла код errno уже выражен заголовком
    if (!(err.code === "POLICY_NOT_FOUND" && (issue.code === "ENOENT" || issue.code === "ENOTDIR"))) {
      lines.push(issue.line !== null ? `${capitalize(msg.line(issue.line))}: ${text}` : text);
    }
  }
  if (err.warnings.length > 0) {
    lines.push("", msg.warningsTitle(err.warnings.length));
    for (const w of err.warnings) lines.push(...issueLines(w, "warning", style, indent));
  }
  return lines;
}

export function renderPolicyError(err: PolicyError, opts: { homeDir: string; style: Style }): string {
  const { style } = opts;
  const display = tildify(err.file, opts.homeDir);
  const out = [style.bold(msg.policyErrorTitle), "", msg.file(err.file), ...policyProblemLines(err, style), ""];
  out.push(msg.nothingStarted);
  out.push(err.code === "POLICY_NOT_FOUND" ? msg.createPolicy(display) : msg.fixPolicy(display));
  return out.join("\n") + "\n";
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
