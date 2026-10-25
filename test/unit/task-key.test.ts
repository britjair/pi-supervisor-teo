import { describe, expect, it } from "vitest";
import { findCaseInsensitive, taskKeyProblem } from "../../src/state/task-key.js";

describe("task-key", () => {
  it.each(["PAY-142", "a", "0", "APD-1195", "x.y_z-1", "A".repeat(100), "con-1", "CONSOLE", "NUL_1"])("%s допустим", (k) => {
    expect(taskKeyProblem(k)).toBeNull();
  });

  it.each([
    ["", "empty"],
    [".", "dots"],
    ["..", "dots"],
    ["-x", "format"],
    ["_x", "format"],
    [".hidden", "format"],
    ["a/b", "format"],
    ["a b", "format"],
    ["../x", "format"],
    ["ключ", "format"],
    ["a\nb", "format"],
    ["A".repeat(101), "format"],
    ["x.", "trailing_dot"],
    ["CON", "reserved"],
    ["nul", "reserved"],
    ["Com1", "reserved"],
    ["LPT9.log", "reserved"],
  ])("%j → %s", (k, problem) => {
    expect(taskKeyProblem(k)).toBe(problem);
  });

  it("дубликат ищется без учёта регистра", () => {
    expect(findCaseInsensitive("pay-1", ["PAY-1", "X"])).toBe("PAY-1");
    expect(findCaseInsensitive("PAY-2", ["PAY-1"])).toBeNull();
  });
});
