// Линейный вывод хода задачи из событий движка, а не из текста модели.
import type { Clock } from "../../util/clock.js";
import type { EngineEvent, EngineReporter } from "../../workflow/reporter.js";

export class PlainReporter implements EngineReporter {
  private current = { key: "", stage: "", agent: null as string | null };
  constructor(private readonly output: { write(text: string): unknown }, private readonly clock: Clock) {}

  context(value: { key: string; stage: string; agent: string | null }): void { this.current = value; }

  emit(event: EngineEvent): void {
    const actor = "actor" in event ? event.actor : event.type.startsWith("supervisor") || event.type.startsWith("decision") ? "supervisor" : "task";
    const prefix = `[${this.clock.now().toISOString()}][${this.current.key}][${actor === "agent" ? `${this.current.stage}${this.current.agent ? `/${this.current.agent}` : ""}` : actor}]`;
    const line = (text: string) => this.output.write(`${prefix} ${text}\n`);
    switch (event.type) {
      case "text":
        for (const text of event.text.split("\n")) if (text) line(text);
        break;
      case "agent.started": line(`агент ${event.agentId} (попытка ${event.attempt}), этап «${event.stageTitle}»`); break;
      case "agent.settled": line(`агент ${event.agentId}: ${event.reason}`); break;
      case "supervisor.started": line(`цикл ${event.cycle}: ${event.trigger ?? "начало"}`); break;
      case "tool.started": line(`▸ ${event.toolName} ${event.argsPreview}`); break;
      case "tool.finished": line(`${event.ok ? "✓" : "✗"} ${event.toolName}`); break;
      case "decision": line(`решение ${event.action}: ${event.summary}`); break;
      case "decision.rejected": line(`отклонено ${event.action}: ${event.code} — ${event.message}`); break;
      case "transition": line(`переход ${event.fromTitle} → ${event.toTitle}: ${event.reason}`); break;
      case "waiting": line(`ожидание до ${event.dueAt}: ${event.waitingFor}`); break;
      case "waiting.tick": line(`ожидание, осталось ${event.minutesLeft} мин`); break;
      case "policy.changed": line(`Policy изменилась (${event.mode})`); break;
      case "info": case "warning": line(event.text); break;
    }
  }
}
