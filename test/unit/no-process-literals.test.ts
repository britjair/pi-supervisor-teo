// Критерий приёмки 2: в исходниках нет названий этапов, агентов и графа конкретного процесса
// (06-implementation.md §4.4). Идентификаторы и названия берутся из всех valid-фикстур и examples/SDLC.md.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { agentList, stageList } from "../../src/domain/policy.js";
import { parsePolicyBytes } from "../../src/policy/policy-loader.js";
import { examplePolicy, repoRoot, validDir } from "../helpers/paths.js";

function processVocabulary(): { ids: Set<string>; titles: Set<string> } {
  const files = [...readdirSync(validDir).filter((f) => f.endsWith(".md")).map((f) => path.join(validDir, f)), examplePolicy];
  const ids = new Set<string>();
  const titles = new Set<string>();
  for (const file of files) {
    const { spec } = parsePolicyBytes(readFileSync(file), file);
    for (const stage of stageList(spec)) {
      ids.add(stage.id);
      titles.add(stage.title);
    }
    for (const agent of agentList(spec)) ids.add(agent.id);
  }
  return { ids, titles };
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

function literals(file: string): Array<{ text: string; line: number }> {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out: Array<{ text: string; line: number }> = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push({ text: node.text, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe("в коде нет конкретного процесса", () => {
  const { ids, titles } = processVocabulary();

  it("словарь процесса собран из фикстур", () => {
    expect(ids.size).toBeGreaterThan(10);
    expect(ids).toContain("code_review");
    expect(titles).toContain("Код-ревью");
  });

  it("ни один литерал в src/ не совпадает с id этапа или агента и не содержит название этапа", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(path.join(repoRoot, "src"))) {
      for (const { text, line } of literals(file)) {
        const rel = `${path.relative(repoRoot, file)}:${line}`;
        if (ids.has(text)) violations.push(`${rel} — id ${JSON.stringify(text)}`);
        for (const title of titles) {
          if (text.includes(title)) violations.push(`${rel} — название этапа ${JSON.stringify(title)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
