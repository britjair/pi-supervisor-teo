import type { PolicyErrorCode, PolicyIssue } from "../domain/policy.js";

/** Коды выхода, 05-cli-ui.md §8. */
export const ExitCode = {
  ok: 0,
  runtime: 1,
  config: 2,
  lock: 3,
  task: 4,
  waitingHuman: 5,
  waitingRecheck: 6,
  sigint: 130,
  sigterm: 143,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export abstract class SdlcError extends Error {
  abstract readonly exitCode: ExitCode;
}

/** Policy не прошла preflight (01-policy.md §1.2). */
export class PolicyError extends SdlcError {
  readonly exitCode = ExitCode.config;

  /** Предупреждения графовой проверки: показываются вместе с ошибками POLICY_GRAPH. */
  readonly warnings: readonly PolicyIssue[];

  constructor(
    readonly code: PolicyErrorCode,
    readonly file: string,
    readonly issues: readonly PolicyIssue[],
    options?: { cause?: unknown; warnings?: readonly PolicyIssue[] },
  ) {
    super(`${code}: ${file}` + (issues.length ? ` (${issues.map((i) => i.code).join(", ")})` : ""), options);
    this.name = "PolicyError";
    this.warnings = options?.warnings ?? [];
  }
}

export class ModelResolutionError extends SdlcError {
  readonly exitCode = ExitCode.config;
  override name = "ModelResolutionError";
}

/** Владелец lock-а проекта, как его видит другой процесс (для сообщения об ошибке). */
export type LockHolder = {
  pid: number;
  hostname: string;
  taskKey: string | null;
  command: string;
  heartbeatAt: string;
} | null;

export class LockConflictError extends SdlcError {
  readonly exitCode = ExitCode.lock;
  override name = "LockConflictError";
  constructor(
    message: string,
    /** null — файл lock-а есть, но не разбирается (его как раз записывают) */
    readonly holder: LockHolder,
  ) {
    super(message);
  }
}

/** Lock проекта перехвачен другим процессом во время работы (02-storage.md §10.3). */
export class LockLostError extends SdlcError {
  readonly exitCode = ExitCode.lock;
  override name = "LockLostError";
}

export class TaskNotFoundError extends SdlcError {
  readonly exitCode = ExitCode.task;
  override name = "TaskNotFoundError";
}

export class TaskCorruptedError extends SdlcError {
  readonly exitCode = ExitCode.task;
  override name = "TaskCorruptedError";
  constructor(
    readonly taskKey: string,
    readonly file: string,
    readonly reason: string,
    /** Номер строки для повреждённого журнала */
    readonly line: number | null = null,
  ) {
    super(`Задача ${taskKey} повреждена: ${reason}\nФайл: ${file}${line !== null ? `, строка ${line}` : ""}`);
  }
}

export class StateVersionConflictError extends SdlcError {
  readonly exitCode = ExitCode.runtime;
  override name = "StateVersionConflictError";
}

export class UserAbortError extends SdlcError {
  readonly exitCode = ExitCode.sigint;
  override name = "UserAbortError";
}

/** Ошибка, текст которой уже подготовлен для пользователя. */
export class UsageError extends SdlcError {
  readonly exitCode = ExitCode.runtime;
  override name = "UsageError";
}
