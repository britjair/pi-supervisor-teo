import { describe, expect, it } from "vitest";
import { splitFrontMatter } from "../../src/policy/front-matter.js";

describe("splitFrontMatter", () => {
  it("выделяет YAML и body, запоминает строки", () => {
    expect(splitFrontMatter("---\na: 1\nb: 2\n---\n# Body\ntext\n")).toEqual({
      yaml: "a: 1\nb: 2\n",
      yamlStartLine: 2,
      body: "# Body\ntext\n",
      bodyStartLine: 5,
    });
  });

  it("убирает BOM", () => {
    const r = splitFrontMatter("\uFEFF---\na: 1\n---\nbody");
    expect(r).toMatchObject({ yaml: "a: 1\n", body: "body" });
  });

  it("понимает CRLF и хвостовые пробелы разделителей", () => {
    const r = splitFrontMatter("---  \r\na: 1\r\n---\t\r\nbody\r\n");
    expect(r).toMatchObject({ yaml: "a: 1\r\n", body: "body\r\n", yamlStartLine: 2 });
  });

  it("принимает ... как закрывающий разделитель", () => {
    expect(splitFrontMatter("---\na: 1\n...\nbody")).toMatchObject({ yaml: "a: 1\n", body: "body" });
  });

  it("закрывает по первому разделителю: --- внутри body остаётся в body", () => {
    expect(splitFrontMatter("---\na: 1\n---\nx\n---\ny")).toMatchObject({ yaml: "a: 1\n", body: "x\n---\ny" });
  });

  it("пустой front matter", () => {
    expect(splitFrontMatter("---\n---\n")).toMatchObject({ yaml: "", body: "" });
  });

  it("без открывающего разделителя", () => {
    expect(splitFrontMatter("# Title\n---\na: 1\n---")).toEqual({ reason: "no_opening", line: 1 });
    expect(splitFrontMatter("----\na: 1\n---")).toEqual({ reason: "no_opening", line: 1 });
    expect(splitFrontMatter(" ---\na: 1\n---")).toEqual({ reason: "no_opening", line: 1 });
  });

  it("без закрывающего разделителя указывает на последнюю строку", () => {
    expect(splitFrontMatter("---\na: 1\nb: 2\n")).toEqual({ reason: "no_closing", line: 3 });
    expect(splitFrontMatter("---\na: 1")).toEqual({ reason: "no_closing", line: 2 });
  });
});
