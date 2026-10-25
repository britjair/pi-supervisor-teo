// Линейный вывод хода задачи из событий движка, а не из текста модели (05-cli-ui.md §5).
import type { Clock } from "../../util/clock.js";
import type { EngineEvent, EngineReporter } from "../../workflow/reporter.js";

export class PlainReporter implements EngineReporter {
  private current = { key: "", stage: "", agent: null as string | null };
  private partial: { actor: "agent" | "supervisor"; text: string } | null = null;

  constructor(private readonly output: { write(text: string): unknown }, private readonly clock: Clock) {}

  context(value: { key: string; stage: string; stageTitle?: string; agent: string | null }): void {
    this.flushPartial();
    this.current = value;
  }

  emit(event: EngineEvent): void {
    if (event.type === "text") {
      this.text(event.actor, event.text);
      return;
    }
    // Thinking в plain-режиме скрыт, usage видна в status.
    if (event.type === "thinking" || event.type === "usage") return;

    this.flushPartial();
    switch (event.type) {
      case "agent.started":
        this.write([event.stage, `${event.agentId}#${event.attempt}`], "started");
        break;
      case "agent.settled":
        this.write([this.current.stage, `${event.agentId}#${event.attempt}`], `settled: ${event.reason}`);
        break;
      case "supervisor.started":
        this.write(["supervisor"], `cycle ${event.cycle} started (${event.trigger ?? "initial"})`);
        break;
      case "tool.started":
        this.write(this.actorParts(event.actor), `tool ${event.toolName}: ${event.argsPreview}`);
        break;
      case "tool.finished":
        this.write(this.actorParts(event.actor), `tool ${event.toolName} ${event.ok ? "ok" : "failed"}`);
        break;
      case "decision": {
        const summary = event.action === "transition_stage" ? (event.summary.split(" → ").at(-1) ?? event.summary) : event.summary;
        this.write(["supervisor"], `decision ${event.action} → ${summary}`);
        break;
      }
      case "decision.rejected":
        this.write(["supervisor"], `decision ${event.action} rejected: ${event.code} — ${event.message}`);
        break;
      case "transition":
        this.write([], `transition ${event.from} → ${event.to}`);
        break;
      case "waiting":
        this.write([], `waiting until ${event.dueAt} (${event.minutes} min, ${event.number}/${event.maxCount}): ${event.waitingFor}`);
        break;
      case "waiting.tick":
        this.write([], `still waiting, ${event.minutesLeft} min left`);
        break;
      case "policy.changed":
        this.write([], `policy changed ${event.fromHash} → ${event.toHash} (${event.mode})`);
        break;
      case "warning":
        this.write([], `warning: ${event.text}`);
        break;
      case "info":
        this.write([], event.text);
        break;
    }
  }

  private actorParts(actor: "agent" | "supervisor"): string[] {
    if (actor === "supervisor") return ["supervisor"];
    return [this.current.stage, ...(this.current.agent ? [this.current.agent] : [])];
  }

  private text(actor: "agent" | "supervisor", delta: string): void {
    if (this.partial && this.partial.actor !== actor) this.flushPartial();
    const combined = (this.partial?.text ?? "") + delta;
    const lines = combined.split("\n");
    const tail = lines.pop() ?? "";
    for (const line of lines) this.write(this.actorParts(actor), line);
    this.partial = tail ? { actor, text: tail } : null;
  }

  private flushPartial(): void {
    if (!this.partial) return;
    this.write(this.actorParts(this.partial.actor), this.partial.text);
    this.partial = null;
  }

  private write(parts: string[], text: string): void {
    const suffix = parts.filter(Boolean).map((part) => `[${part}]`).join("");
    this.output.write(`[${this.clock.now().toISOString()}][${this.current.key}]${suffix} ${text}\n`);
  }
}
