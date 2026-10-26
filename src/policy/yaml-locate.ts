// Номера строк для путей в front matter: ошибки ссылаются на строки файла процесса (01-policy.md §3.3).

import { isAlias, isMap, isScalar, isSeq, type Document, type LineCounter, type Node } from "yaml";

type Segment = string | number;

export type Locator = (path: readonly Segment[]) => number | null;

export function formatPath(path: readonly Segment[]): string | null {
  if (path.length === 0) return null;
  let out = "";
  for (const seg of path) out += typeof seg === "number" ? `[${seg}]` : out ? `.${seg}` : seg;
  return out;
}

/**
 * Строка узла по пути. Если пути в документе нет (обязательный ключ отсутствует),
 * возвращается строка ближайшего существующего предка, а для корня — null.
 * Для значения в mapping берётся строка его ключа: у блочных значений (`|`, вложенный mapping)
 * содержимое начинается ниже, а ключ — то, что автор ищет глазами.
 */
export function createLocator(doc: Document, lineCounter: LineCounter, firstLine: number): Locator {
  const lineOf = (offset: number | undefined): number | null =>
    offset === undefined ? null : lineCounter.linePos(offset).line + firstLine - 1;

  const resolve = (node: unknown): unknown => (isAlias(node) ? node.resolve(doc) : node);

  return (path) => {
    let node: unknown = resolve(doc.contents);
    // Отсутствующий ключ верхнего уровня не привязан к строке
    let line: number | null = null;
    for (const seg of path) {
      if (isMap(node)) {
        const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === String(seg));
        if (!pair) return line;
        line = lineOf((pair.key as Node).range?.[0]) ?? line;
        node = resolve(pair.value);
      } else if (isSeq(node) && typeof seg === "number") {
        const item = resolve(node.items[seg]);
        if (item === undefined) return line;
        line = lineOf((item as Node | null)?.range?.[0]) ?? line;
        node = item;
      } else {
        return line;
      }
    }
    return line;
  };
}
