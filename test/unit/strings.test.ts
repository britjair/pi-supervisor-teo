import { describe, expect, it } from "vitest";
import { closestMatch, plural, shortHash, tildify } from "../../src/util/strings.js";

describe("strings", () => {
  it("plural", () => {
    const f = (n: number) => plural(n, "проблема", "проблемы", "проблем");
    expect([0, 1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map(f)).toEqual([
      "проблем", "проблема", "проблемы", "проблемы", "проблем", "проблем", "проблем", "проблем",
      "проблема", "проблемы", "проблем", "проблема", "проблем",
    ]);
  });

  it("closestMatch находит опечатку, но не случайное слово", () => {
    expect(closestMatch("qa_redy", ["review", "qa_ready"])).toBe("qa_ready");
    expect(closestMatch("transition", ["title", "transitions"])).toBe("transitions");
    expect(closestMatch("zzz", ["review", "qa_ready"])).toBeNull();
  });

  it("tildify и shortHash", () => {
    expect(tildify("/Users/u/.pi/SDLC.md", "/Users/u")).toBe("~/.pi/SDLC.md");
    expect(tildify("/Users/uu/.pi/SDLC.md", "/Users/u")).toBe("/Users/uu/.pi/SDLC.md");
    expect(shortHash("sha256:9b7e00000000000000000041")).toBe("sha256:9b7e…41");
  });
});
