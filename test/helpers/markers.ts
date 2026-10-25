// Маркеры ожидаемых проблем в фикстурах Policy:
//   «# expect: CODE»           — ошибка CODE сообщается именно на этой строке;
//   «# expect-unlocated: CODE» — ошибка CODE без номера строки;
//   «# warn: CODE»             — предупреждение CODE на этой строке.

export type Expectation = { code: string; line: number | null };

export function readMarkers(text: string, kind: "expect" | "warn"): Expectation[] {
  const out: Expectation[] = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(new RegExp(`\\b${kind}(-unlocated)?: ([A-Z0-9_]+)`, "g"))) {
      out.push({ code: m[2] ?? "", line: m[1] ? null : i + 1 });
    }
  });
  return out;
}

export const sortExpectations = (items: Expectation[]) =>
  [...items].sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || a.code.localeCompare(b.code));
