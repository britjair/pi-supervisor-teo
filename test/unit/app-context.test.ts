import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createAppContext } from "../../src/app.js";
import { InkHumanIO } from "../../src/ui/ink/ink-human-io.js";
import { PlainHumanIO } from "../../src/ui/plain/plain-human-io.js";

function ttyStream(): PassThrough & { isTTY: boolean } {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean };
  stream.isTTY = true;
  return stream;
}

describe("createAppContext", () => {
  it("выбирает Ink в TTY и PlainHumanIO с --plain", () => {
    const ink = createAppContext({
      stdin: ttyStream(), stdout: ttyStream(), stderr: ttyStream(), color: false, plain: false, verbose: false,
    });
    const plain = createAppContext({
      stdin: ttyStream(), stdout: ttyStream(), stderr: ttyStream(), color: false, plain: true, verbose: false,
    });

    expect(ink.interactive).toBe(true);
    expect(ink.human).toBeInstanceOf(InkHumanIO);
    expect(plain.interactive).toBe(true);
    expect(plain.human).toBeInstanceOf(PlainHumanIO);
    ink.human?.close();
    plain.human?.close();
  });

  it("не создаёт HumanIO для pipe", () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const ctx = createAppContext({ stdin, stdout, stderr, color: false, plain: false, verbose: false });
    expect(ctx.interactive).toBe(false);
    expect(ctx.human).toBeNull();
  });
});
