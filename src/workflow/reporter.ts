// События движка для интерфейса (05-cli-ui.md §4–5). Строятся из state и RuntimeEvent, а не из текста модели.

export type EngineEvent =
  | { type: "agent.started"; stage: string; stageTitle: string; agentId: string; attempt: number; inputKind: string }
  | { type: "text"; actor: "agent" | "supervisor"; text: string }
  | { type: "tool.started"; actor: "agent" | "supervisor"; toolName: string; argsPreview: string }
  | { type: "tool.finished"; actor: "agent" | "supervisor"; toolName: string; ok: boolean }
  | { type: "agent.settled"; agentId: string; attempt: number; reason: string }
  | { type: "supervisor.started"; cycle: number; trigger: string | null }
  | { type: "decision"; cycle: number; action: string; summary: string }
  | { type: "decision.rejected"; action: string; code: string; message: string }
  | { type: "transition"; from: string; fromTitle: string; to: string; toTitle: string; reason: string; terminal: boolean }
  | { type: "waiting"; dueAt: string; minutes: number; number: number; maxCount: number; waitingFor: string }
  | { type: "waiting.tick"; minutesLeft: number }
  | { type: "policy.changed"; fromHash: string; toHash: string; mode: string }
  | { type: "info"; text: string }
  | { type: "warning"; text: string };

export interface EngineReporter {
  /** Текущий контекст для префиксов строк */
  context(ctx: { key: string; stage: string; agent: string | null }): void;
  emit(e: EngineEvent): void;
}

export const silentReporter: EngineReporter = { context: () => undefined, emit: () => undefined };

/** Для тестов: собирает события. */
export class CollectingReporter implements EngineReporter {
  readonly events: EngineEvent[] = [];
  context(): void {}
  emit(e: EngineEvent): void {
    this.events.push(e);
  }
}
