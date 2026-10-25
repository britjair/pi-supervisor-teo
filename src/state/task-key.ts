// Ключ задачи — имя каталога в .sdlc/tasks, 02-storage.md §2.

export const TASK_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const WINDOWS_RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

export type TaskKeyProblem = "empty" | "format" | "dots" | "trailing_dot" | "reserved";

/** null — ключ допустим. */
export function taskKeyProblem(key: string): TaskKeyProblem | null {
  if (key === "") return "empty";
  if (key === "." || key === "..") return "dots";
  if (!TASK_KEY_RE.test(key)) return "format";
  if (key.endsWith(".")) return "trailing_dot";
  // Windows резервирует имя и с любым расширением: CON.txt
  const base = key.split(".")[0] ?? key;
  if (WINDOWS_RESERVED.has(base.toUpperCase())) return "reserved";
  return null;
}

/** Ключ, совпадающий с `key` без учёта регистра (macOS: PAY-1 и pay-1 — один каталог). */
export function findCaseInsensitive(key: string, existing: Iterable<string>): string | null {
  const lower = key.toLowerCase();
  for (const k of existing) if (k.toLowerCase() === lower) return k;
  return null;
}
