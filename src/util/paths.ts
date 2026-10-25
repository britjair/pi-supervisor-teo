// Нормализация путей от модели: path.resolve + realpath существующего префикса (симлинки наружу ловятся).

import { realpath } from "node:fs/promises";
import path from "node:path";

/** realpath самого длинного существующего префикса, остаток пути приклеивается как есть. */
export async function realpathLoose(p: string): Promise<string> {
  let current = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...rest.reverse());
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/** Путь от модели внутри одного из корней (после realpath обеих сторон); null — снаружи. */
export async function resolveWithin(roots: readonly string[], cwd: string, p: string): Promise<string | null> {
  const target = await realpathLoose(path.resolve(cwd, p));
  for (const root of roots) {
    if (isInside(await realpathLoose(root), target)) return target;
  }
  return null;
}
