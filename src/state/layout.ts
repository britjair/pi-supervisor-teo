// Пути внутри <project-root>/.sdlc, 02-storage.md §1. Все пути .sdlc вычисляются здесь.

import path from "node:path";

export const SDLC_DIR_NAME = ".sdlc";

export type ProjectLayout = {
  projectRoot: string;
  sdlcDir: string;
  gitignore: string;
  index: string;
  lock: string;
  debugLog: string;
  policiesDir: string;
  tasksDir: string;
};

export function projectLayout(projectRoot: string): ProjectLayout {
  const sdlcDir = path.join(projectRoot, SDLC_DIR_NAME);
  return {
    projectRoot,
    sdlcDir,
    gitignore: path.join(sdlcDir, ".gitignore"),
    index: path.join(sdlcDir, "index.json"),
    lock: path.join(sdlcDir, "project.lock.json"),
    debugLog: path.join(sdlcDir, "debug.log"),
    policiesDir: path.join(sdlcDir, "policies"),
    tasksDir: path.join(sdlcDir, "tasks"),
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
