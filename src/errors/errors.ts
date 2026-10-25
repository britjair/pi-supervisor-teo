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

export class LockConflictError extends SdlcError {
  readonly exitCode = ExitCode.lock;
  override name = "LockConflictError";
}

export class TaskNotFoundError extends SdlcError {
  readonly exitCode = ExitCode.task;
  override name = "TaskNotFoundError";
}

export class TaskCorruptedError extends SdlcError {
  readonly exitCode = ExitCode.task;
  override name = "TaskCorruptedError";
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
