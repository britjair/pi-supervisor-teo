// Ink-адаптер HumanIO и событий движка: один React root на всю интерактивную команду.
import type { Readable, Writable } from "node:stream";
import React from "react";
import { render, type Instance } from "ink";
import { UserAbortError } from "../../errors/errors.js";
import type { Choice, HumanAnswer, HumanIO, QuestionView, Validate } from "../human-io.js";
import type { EngineEvent, EngineReporter } from "../../workflow/reporter.js";
import type { WaitAction, WaitControl } from "../../workflow/wait-step.js";
import type { Clock } from "../../util/clock.js";
import { InkApp } from "./app.js";

export type SelectScreen = { kind: "select"; title: string; choices: ReadonlyArray<Choice<unknown>>; resolve: (index: number) => void; cancel: () => void };
export type InputScreen = { kind: "input" | "multiline"; title: string; initial?: string; validate?: Validate; resolve: (value: string) => void; cancel: () => void };
export type ConfirmScreen = { kind: "confirm"; title: string; defaultValue: boolean; resolve: (value: boolean) => void; cancel: () => void };
export type QuestionScreen = { kind: "question"; question: QuestionView; resolve: (answer: HumanAnswer) => void; cancel: () => void };
export type WaitScreenState = { kind: "wait"; dueAt: string; number: number; maxCount: number; waitingFor: string; resolve: (action: WaitAction) => void };
export type Screen = SelectScreen | InputScreen | ConfirmScreen | QuestionScreen | WaitScreenState | { kind: "run" };
export type UiState = {
  screen: Screen;
  log: string[];
  partial: string;
  title: string;
  key: string;
  stage: string;
  agent: string | null;
  attempt: number | null;
  cycle: number;
  activity: string;
  runStartedAtMs: number;
  activityStartedAtMs: number;
  partialActor: "agent" | "supervisor" | null;
  thinking: boolean;
  thinkingText: string;
  statusOverlay: boolean;
  stopConfirm: boolean;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
};

export class InkHumanIO implements HumanIO {
  private readonly listeners = new Set<() => void>();
  private instance: Instance | null = null;
  private snapshot: UiState = {
    screen: { kind: "run" }, log: [], partial: "", title: "SDLC Controller", key: "", stage: "", agent: null,
    attempt: null, cycle: 0, activity: "", runStartedAtMs: 0, activityStartedAtMs: 0, partialActor: null,
    thinking: false, thinkingText: "", statusOverlay: false, stopConfirm: false,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
  };
  private wait: { resolve: (a: WaitAction) => void; done: boolean } | null = null;

  constructor(
    private readonly stdin: Readable,
    private readonly stdout: Writable,
    private readonly stderr: Writable,
    private readonly clock: Clock,
  ) {}

  private start(): void {
    if (!this.instance) this.instance = render(<InkApp controller={this} />, {
      stdin: this.stdin, stdout: this.stdout, stderr: this.stderr, exitOnCtrlC: false,
    });
  }
  getSnapshot = (): UiState => this.snapshot;
  nowMs = (): number => this.clock.now().getTime();
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  update(patch: Partial<UiState>): void {
    this.start();
    this.snapshot = { ...this.snapshot, ...patch };
    for (const cb of this.listeners) cb();
  }
  print(text: string): void {
    const partial = this.snapshot.partial
      ? [`${this.snapshot.partialActor === "supervisor" ? "supervisor › " : ""}${this.snapshot.partial}`]
      : [];
    this.update({
      log: [...this.snapshot.log, ...partial, ...text.split("\n").filter((s) => s.trim() !== "")].slice(-2000),
      partial: "",
      partialActor: null,
    });
  }
  private ask<T>(screen: (resolve: (v: T) => void, cancel: () => void) => Screen): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.update({ screen: screen((value) => { this.update({ screen: { kind: "run" } }); resolve(value); }, () => {
        this.update({ screen: { kind: "run" } }); reject(new UserAbortError("Ввод отменён."));
      }) });
    });
  }
  select<T>(title: string, choices: ReadonlyArray<Choice<T>>): Promise<T> {
    return this.ask<number>((resolve, cancel) => ({ kind: "select", title, choices: choices as ReadonlyArray<Choice<unknown>>, resolve, cancel }))
      .then((index) => choices[index]!.value);
  }
  input(title: string, opts: { initial?: string; validate?: Validate } = {}): Promise<string> {
    return this.ask((resolve, cancel) => ({ kind: "input", title, ...opts, resolve, cancel }));
  }
  multiline(title: string, opts: { validate?: Validate } = {}): Promise<string> {
    return this.ask((resolve, cancel) => ({ kind: "multiline", title, ...opts, resolve, cancel }));
  }
  confirm(title: string, defaultValue: boolean): Promise<boolean> {
    return this.ask((resolve, cancel) => ({ kind: "confirm", title, defaultValue, resolve, cancel }));
  }
  askQuestion(question: QuestionView): Promise<HumanAnswer> {
    return this.ask((resolve, cancel) => ({ kind: "question", question, resolve, cancel }));
  }

  /** Отчётная лента видна и после окончания меню или вопроса. */
  reporter(key: string): EngineReporter {
    const now = this.nowMs();
    this.update({
      screen: { kind: "run" }, key, log: [], partial: "", partialActor: null,
      thinkingText: "", activity: "запуск задачи", runStartedAtMs: now, activityStartedAtMs: now,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: null },
    });
    return {
      context: (ctx) => {
        const match = ctx.agent?.match(/^(.*)#(\d+)$/);
        this.update({
          key: ctx.key,
          stage: ctx.stageTitle ?? ctx.stage,
          agent: match?.[1] ?? ctx.agent,
          attempt: match?.[2] ? Number(match[2]) : null,
        });
      },
      emit: (event) => this.engineEvent(event),
    };
  }
  private engineEvent(e: EngineEvent): void {
    const add = (text: string) => this.print(text);
    switch (e.type) {
      case "text": {
        const actorChanged = this.snapshot.partialActor !== null && this.snapshot.partialActor !== e.actor;
        const carried = actorChanged && this.snapshot.partial
          ? [`${this.snapshot.partialActor === "supervisor" ? "supervisor › " : ""}${this.snapshot.partial}`]
          : [];
        const base = actorChanged ? "" : this.snapshot.partial;
        const prefix = e.actor === "supervisor" ? "supervisor › " : "";
        const parts = (base + e.text).split("\n");
        const tail = parts.pop() ?? "";
        const done = [...carried, ...parts.map((x) => prefix + x)];
        this.update({ log: [...this.snapshot.log, ...done].slice(-2000), partial: tail, partialActor: tail ? e.actor : null });
        break;
      }
      case "thinking":
        this.update({ thinkingText: (this.snapshot.thinkingText + e.text).slice(-4000) });
        break;
      case "usage": {
        const previous = this.snapshot.usage;
        this.update({ usage: {
          inputTokens: previous.inputTokens + e.usage.inputTokens,
          outputTokens: previous.outputTokens + e.usage.outputTokens,
          costUsd: previous.costUsd === null && e.usage.costUsd === null
            ? null
            : (previous.costUsd ?? 0) + (e.usage.costUsd ?? 0),
        } });
        break;
      }
      case "agent.started": {
        const now = this.nowMs();
        this.update({ stage: e.stageTitle, agent: e.agentId, attempt: e.attempt, activity: `agent ${e.agentId} работает`, activityStartedAtMs: now });
        add(`▶ ${e.stageTitle}: ${e.agentId} (попытка ${e.attempt})`);
        break;
      }
      case "agent.settled": add(`✓ ${e.agentId}: ${e.reason}`); this.update({ activity: "supervisor проверяет результат", activityStartedAtMs: this.nowMs() }); break;
      case "supervisor.started": add(`supervisor › цикл ${e.cycle} (${e.trigger ?? "начало"})`); this.update({ agent: null, attempt: null, cycle: e.cycle, activity: "supervisor оценивает результат", activityStartedAtMs: this.nowMs() }); break;
      case "tool.started": add(`${e.actor === "supervisor" ? "supervisor › " : ""}▸ ${e.toolName} ${e.argsPreview}`); this.update({ activity: `${e.actor === "supervisor" ? "supervisor: " : ""}${e.toolName}`, activityStartedAtMs: this.nowMs() }); break;
      case "tool.finished": add(`${e.actor === "supervisor" ? "supervisor › " : ""}${e.ok ? "✓" : "✗"} ${e.toolName}`); break;
      case "decision": add(`supervisor › ${e.action}: ${e.summary}`); break;
      case "decision.rejected": add(`supervisor › отклонено ${e.action}: ${e.code}`); break;
      case "transition": add(`════════════════════════════════════════════════════════════\n✓ ${e.terminal ? `Задача ${this.snapshot.key} достигла этапа «${e.toTitle}»` : `${e.fromTitle} → ${e.toTitle}`}\n  Причина: ${e.reason}\n════════════════════════════════════════════════════════════`); this.update({ stage: e.toTitle, activity: e.terminal ? "задача завершена" : "переход к следующему этапу", activityStartedAtMs: this.nowMs() }); break;
      case "waiting": this.update({ screen: { kind: "wait", dueAt: e.dueAt, number: e.number, maxCount: e.maxCount, waitingFor: e.waitingFor, resolve: () => undefined }, activity: "ожидание", activityStartedAtMs: this.nowMs() }); break;
      case "waiting.tick": break;
      case "policy.changed": add(`Policy обновлена: ${e.mode}`); break;
      case "warning": case "info": add(e.text); break;
    }
  }

  waitControl(): WaitControl {
    return { next: (ms, signal) => new Promise<WaitAction>((resolve, reject) => {
      const info = this.snapshot.screen.kind === "wait" ? this.snapshot.screen : null;
      const finish = (a: WaitAction) => {
        if (this.wait?.done) return;
        if (this.wait) this.wait.done = true;
        clearTimeout(timer); signal.removeEventListener("abort", onAbort);
        this.wait = null;
        if (a.kind !== "tick") this.update({ screen: { kind: "run" } });
        resolve(a);
      };
      const onAbort = () => { clearTimeout(timer); this.wait = null; reject(signal.reason); };
      const timer = setTimeout(() => finish({ kind: "tick" }), ms);
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      this.wait = { resolve: finish, done: false };
      if (info) this.update({ screen: { ...info, resolve: finish } });
    }) };
  }
  async waitMessage(): Promise<void> {
    const waiting = this.wait;
    const waitScreen = this.snapshot.screen.kind === "wait" ? this.snapshot.screen : null;
    if (!waiting || !waitScreen) return;
    try {
      const message = await this.multiline("Сообщение supervisor-у", { validate: (v) => v.trim() ? null : "Введите сообщение." });
      waiting.resolve({ kind: "message", text: message.trim() });
    } catch {
      this.update({ screen: { ...waitScreen, resolve: waiting.resolve } });
    }
  }
  requestInterrupt(waiting = false): void {
    if (waiting || this.snapshot.stopConfirm) process.kill(process.pid, "SIGINT");
    else this.update({ stopConfirm: true });
  }
  confirmStop(yes: boolean): void {
    this.update({ stopConfirm: false });
    if (yes) process.kill(process.pid, "SIGINT");
  }
  toggleThinking(): void { this.update({ thinking: !this.snapshot.thinking }); }
  toggleStatus(): void { this.update({ statusOverlay: !this.snapshot.statusOverlay }); }
  close(): void { this.instance?.unmount(); this.instance = null; }
}
