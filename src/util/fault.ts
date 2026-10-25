// FaultInjector, 06-implementation.md §2.1: сбой в именованной точке для тестов восстановления.
// В обычной работе — пустая функция. В процессе включается переменной окружения
// SDLC_FAULT=<точка>:<kill|throw>; так integration-тесты убивают настоящий процесс sdlc.

export const FAULT_POINTS = [
  /** state.json записан, события ещё не дописаны в журнал */
  "after-state-commit",
  /** события дописаны, index.json ещё не обновлён */
  "after-event-append",
] as const;
export type FaultPoint = (typeof FAULT_POINTS)[number];

export interface FaultInjector {
  check(point: FaultPoint): void;
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
