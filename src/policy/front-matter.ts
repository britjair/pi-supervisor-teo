// Выделение YAML front matter, 01-policy.md §1.3.
// gray-matter не используется: он кэширует результат и теряет номера строк.

export type FrontMatterSplit = {
  yaml: string;
  /** Номер строки файла, с которой начинается YAML (с 1). */
  yamlStartLine: number;
  body: string;
  /** Номер строки файла, с которой начинается body (с 1). */
  bodyStartLine: number;
};

export type FrontMatterFailure = { reason: "no_opening" | "no_closing"; line: number };

const OPENING_RE = /^---[ \t]*\r?$/;
const CLOSING_RE = /^(---|\.\.\.)[ \t]*\r?$/;

export function splitFrontMatter(text: string): FrontMatterSplit | FrontMatterFailure {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const lines = source.split("\n");

  if (!OPENING_RE.test(lines[0] ?? "")) return { reason: "no_opening", line: 1 };

  for (let i = 1; i < lines.length; i++) {
    if (CLOSING_RE.test(lines[i] ?? "")) {
      return {
        // У каждой строки YAML остаётся свой перевод строки: иначе «\r» последней строки
        // CRLF-файла попал бы в значение
        yaml: lines.slice(1, i).map((l) => l + "\n").join(""),
        yamlStartLine: 2,
        body: lines.slice(i + 1).join("\n"),
        bodyStartLine: i + 2,
      };
    }
  }
  // Последняя строка файла (без пустого хвоста после завершающего перевода строки)
  return { reason: "no_closing", line: lines.at(-1) === "" ? lines.length - 1 : lines.length };
}

export function isFrontMatterFailure(r: FrontMatterSplit | FrontMatterFailure): r is FrontMatterFailure {
  return "reason" in r;
}
