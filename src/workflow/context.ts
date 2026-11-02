// Общий контекст движка для шагов и tools. Реализация — Engine (engine.ts).

import type { AgentRuntime } from "../agents/runtime.js";
import type { SessionPool } from "../agents/session-pool.js";
import type { TaskEvent } from "../domain/events.js";
import type { LoadedPolicy } from "../domain/policy.js";
import type { ProjectStore } from "../state/project-store.js";
import type { RunStore } from "../state/run-store.js";
import type { TaskLayout } from "../state/layout.js";
import type { HumanAnswer, HumanIO, QuestionView } from "../ui/human-io.js";
import type { Style } from "../ui/plain/style.js";
import type { Clock } from "../util/clock.js";
import type { Exec } from "../util/exec.js";
import type { FaultInjector } from "../util/fault.js";
import type { IdGenerator } from "../util/ids.js";
import type { EngineReporter } from "./reporter.js";
import type { WaitControl } from "./wait-step.js";

export type EngineOptions = {
  /** resume --no-wait: не ждать срока перепроверки */
  noWait: boolean;
  /** resume --now: перепроверить сразу */
  checkNow: boolean;
};

/**
 * Точный срок сброса лимита провайдера, если его можно узнать помимо текста ошибки.
 * null — неизвестно, тогда работает график проб (docs/08-model-profiles.md §5).
 */
export type ProviderResetProbe = (provider: string, now: number) => Promise<{ ms: number; detail: string } | null>;

/** Состояние текущего цикла supervisor-а в памяти процесса (03-engine.md §5.3, §5.5). */
export type CycleMemory = {
  cycle: number;
  decisionRecorded: boolean;
  invalidCount: number;
  protocolRetriesUsed: number;
  technicalRetriesUsed: number;
  /** Последний отправленный prompt цикла: повтор при ошибке провайдера */
  version: number;
  modelUsed?: string;
  modelChain?: string[];
  modelChainIndex?: number;
  lastPrompt?: string;
};

export interface EngineCore {
  readonly key: string;
  readonly store: ProjectStore;
  readonly runtime: AgentRuntime;
  readonly pool: SessionPool;
  readonly human: HumanIO | null;
  readonly waitControl: WaitControl;
  readonly reporter: EngineReporter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly faults: FaultInjector;
  readonly exec: Exec;
  readonly options: EngineOptions;
  readonly style: Style;
  /** Проба точного срока сброса лимита; null — недоступна (тесты, оффлайн) */
  readonly providerReset: ProviderResetProbe | null;
  /** Ctrl+C, SIGTERM, потеря lock-а */
  readonly signal: AbortSignal;
  /** Текущая Policy: обновляется policy gate */
  policy: LoadedPolicy;
  cycle: CycleMemory | null;
  /** Файлы сессий, в которых агент уже отчитался в текущем prompt-цикле (guard «после отчёта») */
  readonly reported: Set<string>;

  task(): TaskLayout;
  runs(): RunStore;
  /** Пауза с учётом signal; в тестах продвигает FakeClock */
  sleep(ms: number): Promise<void>;
  /** Задать вопрос человеку. UserAbortError (Ctrl+C) пробрасывается. */
  ask(view: QuestionView): Promise<HumanAnswer>;
  /** Остановить движок, как по сигналу (Ctrl+C внутри вопроса человеку) */
  interrupt(signal: "SIGINT" | "SIGTERM"): void;
  /** Все события задачи (журнал; outbox уже доставлен загрузкой под lock-ом) */
  events(): Promise<TaskEvent[]>;
}
