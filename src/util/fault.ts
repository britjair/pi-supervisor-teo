// FaultInjector, 06-implementation.md §2.1: сбой в именованной точке для тестов восстановления.
// В обычной работе — пустая функция. В процессе включается переменной окружения
// TEO_FAULT=<точка>:<kill|throw>; так integration-тесты убивают настоящий процесс teo.

export const FAULT_POINTS = [
  /** state.json записан, события ещё не дописаны в журнал */
  "after-state-commit",
  /** события дописаны, index.json ещё не обновлён */
  "after-event-append",
  /** агент перешёл в agent_running, prompt ещё не отправлен */
  "before-agent-prompt",
  /** отчёт агента записан в runs/, событие agent.reported ещё нет */
  "in-agent-report",
  /** вопрос агента записан (human.requested), человек ещё не ответил */
  "in-ask-user",
  /** решение supervisor-а записано в state, tool ещё не вернул ответ модели */
  "in-control-tool",
  /** решение загружено из state, эффекты ещё не применены */
  "before-decision-apply",
] as const;
export type FaultPoint = (typeof FAULT_POINTS)[number];

/** Что происходит в точке: типы событий записи state (для точного выбора момента в тестах). */
export type FaultInfo = { events?: readonly string[] };

export interface FaultInjector {
  check(point: FaultPoint, info?: FaultInfo): void;
}

export class InjectedFault extends Error {
  override name = "InjectedFault";
  constructor(readonly point: FaultPoint) {
    super(`Injected fault at ${point}`);
  }
}

export const noFaults: FaultInjector = { check: () => undefined };

export function faultsFromEnv(value: string | undefined): FaultInjector {
  if (!value) return noFaults;
  const [point, mode = "throw"] = value.split(":");
  if (!FAULT_POINTS.includes(point as FaultPoint) || (mode !== "kill" && mode !== "throw")) return noFaults;
  return {
    check(p) {
      if (p !== point) return;
      if (mode === "kill") process.kill(process.pid, "SIGKILL");
      throw new InjectedFault(p);
    },
  };
}

/** Бросает при n-м (с 1) прохождении точки. */
export function throwingAtOccurrence(point: FaultPoint, n: number): FaultInjector & { hits: () => number } {
  let seen = 0;
  return {
    check(p) {
      if (p !== point) return;
      seen++;
      if (seen === n) throw new InjectedFault(p);
    },
    hits: () => seen,
  };
}

/** Для unit-тестов: бросает в заданной точке нужное число раз. */
export function throwingAt(point: FaultPoint, times = 1): FaultInjector {
  let left = times;
  return {
    check(p) {
      if (p === point && left > 0) {
        left--;
        throw new InjectedFault(p);
      }
    },
  };
}

/** Бросает в точке, когда условие выполнено (первый раз). */
export function throwingWhen(point: FaultPoint, when: (info: FaultInfo) => boolean): FaultInjector & { fired: () => boolean } {
  let fired = false;
  return {
    check(p, info = {}) {
      if (p !== point || fired || !when(info)) return;
      fired = true;
      throw new InjectedFault(p);
    },
    fired: () => fired,
  };
}

/** Считает прохождения точек, ничего не бросая. */
export function countingFaults(): FaultInjector & { counts: Map<FaultPoint, number> } {
  const counts = new Map<FaultPoint, number>();
  return { counts, check: (p) => void counts.set(p, (counts.get(p) ?? 0) + 1) };
}
