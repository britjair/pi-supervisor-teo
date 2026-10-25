// Read-only вызовы git для supervisor-а, 04-agents.md §5.2: execFile без shell, фиксированные команды.

import { stat } from "node:fs/promises";
import path from "node:path";
import { GIT_ENV } from "../../project/project-root.js";
import type { Exec, ExecResult } from "../../util/exec.js";
import { isValidGitRef } from "../evidence-refs.js";

export class GitInspector {
  constructor(
    private readonly exec: Exec,
    private readonly cwd: string,
  ) {}

  run(args: string[]): Promise<ExecResult> {
    return this.exec("git", args, { cwd: this.cwd, env: GIT_ENV, timeoutMs: 30_000 });
  }

  async isRepo(): Promise<boolean> {
    return (await this.run(["rev-parse", "--is-inside-work-tree"]).catch(() => null))?.code === 0;
  }

  async status(): Promise<Record<string, unknown>> {
    if (!(await this.isRepo())) return { repository: false };
    const [branch, head, upstream, porcelain, gitDir] = await Promise.all([
      this.run(["rev-parse", "--abbrev-ref", "HEAD"]),
      this.run(["rev-parse", "HEAD"]),
      this.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
      this.run(["status", "--porcelain=v1", "--", ".", ":(exclude).sdlc"]),
      this.run(["rev-parse", "--git-dir"]),
    ]);
    let aheadBehind: { ahead: number; behind: number } | null = null;
    if (upstream.code === 0) {
      const ab = await this.run(["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
      const [ahead, behind] = ab.stdout.trim().split(/\s+/).map(Number);
      if (ab.code === 0) aheadBehind = { ahead: ahead ?? 0, behind: behind ?? 0 };
    }
    const dir = gitDir.stdout.trim();
    const inProgress: string[] = [];
    for (const [name, file] of [
      ["merge", "MERGE_HEAD"],
      ["rebase", "rebase-merge"],
      ["rebase", "rebase-apply"],
      ["cherry-pick", "CHERRY_PICK_HEAD"],
    ] as const) {
      const r = await this.run(["rev-parse", "--git-path", file]);
      if (r.code === 0 && (await stat(path.resolve(this.cwd, r.stdout.trim())).then(() => true, () => false))) inProgress.push(name);
    }
    const files = porcelain.stdout.split("\n").filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));
    return {
      repository: true,
      gitDir: dir,
      branch: branch.code === 0 ? branch.stdout.trim() : null,
      head: head.code === 0 ? head.stdout.trim() : null,
      upstream: upstream.code === 0 ? upstream.stdout.trim() : null,
      aheadBehind,
      clean: files.length === 0,
      changes: files,
      inProgress: [...new Set(inProgress)],
    };
  }

  async commit(ref: string): Promise<Record<string, unknown>> {
    if (!isValidGitRef(ref)) return { ref, exists: false, error: "недопустимое имя ссылки" };
    const show = await this.run(["show", "-s", "--format=%H%n%s%n%an <%ae>%n%aI", `${ref}^{commit}`, "--"]);
    if (show.code !== 0) return { ref, exists: false };
    const [sha, subject, author, date] = show.stdout.split("\n");
    const stat = await this.run(["show", "--stat", "--format=", sha ?? ref]);
    const ancestor = await this.run(["merge-base", "--is-ancestor", sha ?? ref, "HEAD"]);
    return { ref, exists: true, sha, subject, author, date, stat: stat.stdout.trim(), inCurrentBranch: ancestor.code === 0 };
  }

  async diff(opts: { base?: string; head?: string; paths?: string[]; stat?: boolean }): Promise<{ ok: boolean; text: string }> {
    for (const r of [opts.base, opts.head]) if (r !== undefined && !isValidGitRef(r)) return { ok: false, text: `Недопустимое имя ссылки: ${r}` };
    const args = ["diff", "--no-color", "--no-ext-diff"];
    if (opts.stat) args.push("--stat");
    if (opts.base) args.push(opts.base);
    if (opts.head) args.push(opts.head);
    args.push("--", ...(opts.paths?.length ? opts.paths : ["."]), ":(exclude).sdlc");
    const r = await this.run(args);
    return { ok: r.code === 0, text: r.code === 0 ? r.stdout : r.stderr };
  }

  /** Файлы с учётом .gitignore. */
  async listFiles(): Promise<string[] | null> {
    if (!(await this.isRepo())) return null;
    const r = await this.run(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    return r.code === 0 ? r.stdout.split("\0").filter(Boolean) : null;
  }
}
