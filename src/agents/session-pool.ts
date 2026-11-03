// Живые сессии процесса, 04-agents.md §2.3. Prompt отправляется в start-обработчике фазы,
// а дожидается в await-обработчике следующей итерации: идущий ход хранится здесь.
// После рестарта процесса пул пуст — это и есть сигнал для recovery.

import type { AgentRuntime, AgentSessionHandle, RunOutcome, RuntimeEvent, SessionSpec } from "./runtime.js";

export type ActiveRun = {
  /** runId агента или «supervisor:<cycle>» */
  key: string;
  handle: AgentSessionHandle;
  promise: Promise<RunOutcome>;
  controller: AbortController;
  /** Ход прерван по таймауту (а не пользователем) */
  timedOut: boolean;
  timer: NodeJS.Timeout | null;
};

/** Чем открыта сессия: смена модели требует переоткрытия, иначе запрос уйдёт в прежнюю модель. */
const openedWith = (spec: SessionSpec) => `${spec.model?.id ?? ""}#${spec.model?.thinking ?? "-"}`;

export class SessionPool {
  private readonly sessions = new Map<string, AgentSessionHandle>();
  /** file → модель, с которой сессия реально открыта */
  private readonly models = new Map<string, string>();
  private readonly runs = new Map<string, ActiveRun>();
  /** Взятый через take() ход остаётся живым до завершения promise: stop обязан вызвать handle.abort(). */
  private readonly inFlight = new Set<ActiveRun>();
  /** Supervisor-сессии, пережившие compaction: им снова нужен полный текст Policy */
  private readonly compacted = new Set<string>();

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly onEvent: (file: string, role: "agent" | "supervisor", e: RuntimeEvent) => void = () => undefined,
  ) {}

  has(file: string): boolean {
    return this.sessions.has(file);
  }

  /**
   * Живая сессия для файла. Кеш учитывает модель: при её смене (fallback по цепочке) старая
   * сессия закрывается и открывается новая на том же файле — транскрипт на диске сохраняется,
   * как и при перезапуске процесса. Без этого spec.model молча игнорировался бы.
   */
  async open(spec: SessionSpec): Promise<AgentSessionHandle> {
    const existing = this.sessions.get(spec.file);
    if (existing) {
      if (this.models.get(spec.file) === openedWith(spec)) return existing;
      this.close(spec.file);
    }
    const handle = await this.runtime.openSession(spec);
    handle.subscribe((e) => {
      if (e.type === "compaction" && e.phase === "end") this.compacted.add(spec.file);
      this.onEvent(spec.file, spec.role, e);
    });
    this.sessions.set(spec.file, handle);
    this.models.set(spec.file, openedWith(spec));
    return handle;
  }

  /** Принудительно переоткрыть сессию файла (например, после ошибки модели). */
  async reopen(spec: SessionSpec): Promise<AgentSessionHandle> {
    this.close(spec.file);
    return this.open(spec);
  }

  /** Модель, с которой сейчас открыта сессия файла. */
  openedModel(file: string): string | null {
    const key = this.models.get(file);
    return key ? (key.split("#")[0] ?? null) : null;
  }

  /** Сбросить флаг compaction: полный текст Policy снова показан. */
  takeCompacted(file: string): boolean {
    return this.compacted.delete(file);
  }

  /** Отправить prompt, не дожидаясь конца хода. */
  start(key: string, handle: AgentSessionHandle, prompt: string, opts: { parent: AbortSignal; timeoutMs: number | null }): ActiveRun {
    const controller = new AbortController();
    const onParent = () => controller.abort(opts.parent.reason);
    opts.parent.addEventListener("abort", onParent, { once: true });
    const run: ActiveRun = { key, handle, controller, timedOut: false, timer: null, promise: Promise.resolve(null as never) };
    if (opts.timeoutMs !== null) {
      run.timer = setTimeout(() => {
        run.timedOut = true;
        controller.abort();
        void handle.abort();
      }, opts.timeoutMs);
      run.timer.unref();
    }
    this.inFlight.add(run);
    try {
      run.promise = handle.run(prompt, { signal: controller.signal }).finally(() => {
        if (run.timer) clearTimeout(run.timer);
        opts.parent.removeEventListener("abort", onParent);
        this.inFlight.delete(run);
      });
    } catch (err) {
      if (run.timer) clearTimeout(run.timer);
      opts.parent.removeEventListener("abort", onParent);
      this.inFlight.delete(run);
      throw err;
    }
    // Отказ промиса без ожидающего (процесс умирает) не должен становиться unhandled rejection раньше await
    run.promise.catch(() => undefined);
    this.runs.set(key, run);
    return run;
  }

  take(key: string): ActiveRun | null {
    const run = this.runs.get(key) ?? null;
    this.runs.delete(key);
    return run;
  }

  /** Прервать все идущие ходы и дождаться их (не дольше timeoutMs). */
  async abortAll(timeoutMs = 5_000): Promise<void> {
    const runs = [...this.inFlight];
    for (const r of runs) r.controller.abort();
    await Promise.race([
      Promise.allSettled([
        ...runs.map((r) => r.handle.abort().catch(() => undefined)),
        ...runs.map((r) => r.promise),
      ]),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
  }

  close(file: string): void {
    this.sessions.get(file)?.dispose();
    this.sessions.delete(file);
    this.models.delete(file);
  }

  async dispose(): Promise<void> {
    for (const h of this.sessions.values()) h.dispose();
    this.sessions.clear();
    this.models.clear();
    this.runs.clear();
    this.inFlight.clear();
  }
}
