// Решения guard-расширения, 04-agents.md §3. Без типов Pi: адаптер в src/agents/pi/ только вызывает их.
// Guard защищает от ошибок модели, а не от злонамеренного агента: bash не ограничивается.

import path from "node:path";
import { TEO_DIR_NAME } from "../state/layout.js";
import { isInside, realpathLoose, resolveWithin } from "../util/paths.js";
import type { GuardConfig } from "./runtime.js";

export type GuardVerdict = { allow: true } | { allow: false; reason: string; terminate: boolean };

const WRITE_TOOLS = new Set(["write", "edit"]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** Аргумент пути у встроенных tools Pi. */
function pathArg(args: unknown): string | null {
  if (args === null || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath"]) if (typeof a[key] === "string") return a[key];
  return null;
}

export async function guardToolCall(config: GuardConfig, toolName: string, args: unknown, cwd: string): Promise<GuardVerdict> {
  if (config.role === "agent") {
    if (config.isReported()) {
      return { allow: false, reason: "Отчёт этого запуска уже записан. Заверши ход.", terminate: true };
    }
    if (WRITE_TOOLS.has(toolName)) {
      const p = pathArg(args);
      if (p === null) return { allow: true };
      const target = await realpathLoose(path.resolve(cwd, p));
      const teoDir = await realpathLoose(path.join(config.projectRoot, TEO_DIR_NAME));
      if (!isInside(teoDir, target)) return { allow: true };
      for (const dir of config.writableInsideTeo) {
        if (isInside(await realpathLoose(dir), target)) return { allow: true };
      }
      return {
        allow: false,
        reason: `Запись в ${p} запрещена: внутри .teo агент может писать только в ${path.relative(config.projectRoot, config.writableInsideTeo[0] ?? config.taskDir)}/.`,
        terminate: false,
      };
    }
    return { allow: true };
  }

  if (READ_TOOLS.has(toolName)) {
    const p = pathArg(args) ?? ".";
    if ((await resolveWithin(config.readableRoots, cwd, p)) === null) {
      return { allow: false, reason: `Путь ${p} вне каталога проекта: supervisor читает только внутри него.`, terminate: false };
    }
    return { allow: true };
  }
  return { allow: true };
}
