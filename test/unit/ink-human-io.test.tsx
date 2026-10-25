// InkHumanIO целиком: один root, экран вопроса и лента событий движка.
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { InkHumanIO } from "../../src/ui/ink/ink-human-io.js";
import { FakeClock } from "../helpers/fake-clock.js";

const DOWN = "\u001B[B";
const settle = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "");

class FakeStdout extends EventEmitter {
  readonly frames: string[] = [];
  columns = 80;
  rows = 24;
  isTTY = true;
  write = (frame: string) => {
    this.frames.push(frame);
    return true;
  };
  text = () => plain(this.frames.join(""));
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write(data: string) {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  }
  read = () => {
    const d = this.data;
    this.data = null;
    return d;
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
}

let io: InkHumanIO | null = null;
afterEach(() => {
  io?.close();
  io = null;
});

function setup() {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const stderr = new FakeStdout();
  io = new InkHumanIO(stdin as unknown as Readable, stdout as unknown as Writable, stderr as unknown as Writable, new FakeClock(), {
    patchConsole: false,
  });
  return { io, stdin, stdout };
}

describe("InkHumanIO", () => {
  it("задаёт вопрос на Ink-экране и предупреждает о записи ответа в журнал", async () => {
    const { io, stdin, stdout } = setup();
    const answer = io.askQuestion({
      header: "Вопрос от supervisor · PAY-142 · Ревью",
      question: "Какой стенд использовать?",
      context: null,
      options: ["ft1", "ft2"],
      allowFreeText: false,
      attachments: [],
    });
    await settle();
    expect(stdout.text()).toContain("Какой стенд использовать?");
    expect(stdout.text()).toContain("Ответ сохраняется в журнал задачи дословно.");
    stdin.write(DOWN);
    await settle();
    stdin.write("\r");
    expect(await answer).toEqual({ answer: "ft2", selectedOption: "ft2" });
  });

  it("при длинном стриме шапка и подвал остаются в последнем кадре", async () => {
    const { io, stdout } = setup();
    const reporter = io.reporter("PAY-142");
    reporter.context({ key: "PAY-142", stage: "review", stageTitle: "Ревью", agent: "reviewer#2" });
    reporter.emit({ type: "agent.started", stage: "review", stageTitle: "Ревью", agentId: "reviewer", attempt: 2, inputKind: "initial" });
    for (let i = 0; i < 300; i++) reporter.emit({ type: "text", actor: "agent", text: `строка ${i} ${"x".repeat(i % 120)}\n` });
    reporter.emit({ type: "text", actor: "agent", text: "недописанная" });
    await settle(50);
    // Последний кадр с содержимым: после него Ink пишет только управляющие последовательности
    const last = stdout.frames.map(plain).filter((f) => f.trim() !== "").at(-1) ?? "";
    expect(last).toContain("PAY-142 · Ревью · agent: reviewer · attempt 2");
    expect(last).toContain("SDLC: Ревью");
    expect(last).toContain("Ctrl+C — остановить");
    expect(last).toContain("недописанная");
  });
});
