// Пути внутри <project-root>/.teo, 02-storage.md §1. Все пути .teo вычисляются здесь.

import path from "node:path";

export const TEO_DIR_NAME = ".teo";

export type ProjectLayout = {
  projectRoot: string;
  teoDir: string;
  gitignore: string;
  index: string;
  lock: string;
  debugLog: string;
  policiesDir: string;
  tasksDir: string;
};

export function projectLayout(projectRoot: string): ProjectLayout {
  const teoDir = path.join(projectRoot, TEO_DIR_NAME);
  return {
    projectRoot,
    teoDir,
    gitignore: path.join(teoDir, ".gitignore"),
    index: path.join(teoDir, "index.json"),
    lock: path.join(teoDir, "project.lock.json"),
    debugLog: path.join(teoDir, "debug.log"),
    policiesDir: path.join(teoDir, "policies"),
    tasksDir: path.join(teoDir, "tasks"),
  };
}

/**
 * Путь `relative` внутри `root` или null, если он выходит наружу.
 * Только лексическая проверка; симлинки проверяет вызывающий код через realpath.
 */
export function resolveInside(root: string, relative: string): string | null {
  const resolved = path.resolve(root, relative);
  const rel = path.relative(root, resolved);
  if (rel === "") return resolved;
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return resolved;
}

export type TaskLayout = {
  key: string;
  dir: string;
  state: string;
  events: string;
  runtime: string;
  taskMd: string;
  artifactsDir: string;
  runsDir: string;
  sessionsDir: string;
};

/** Пути задачи. `key` должен быть проверен taskKeyProblem(): здесь он только подставляется. */
export function taskLayout(project: ProjectLayout, key: string): TaskLayout {
  const dir = path.join(project.tasksDir, key);
  return {
    key,
    dir,
    state: path.join(dir, "state.json"),
    events: path.join(dir, "events.jsonl"),
    runtime: path.join(dir, "runtime.json"),
    taskMd: path.join(dir, "task.md"),
    artifactsDir: path.join(dir, "artifacts"),
    runsDir: path.join(dir, "runs"),
    sessionsDir: path.join(dir, "sessions"),
  };
}

export const GITIGNORE_CONTENT = "*\n";
