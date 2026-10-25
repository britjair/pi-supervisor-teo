// Чем закончился запуск задачи и какой это код выхода (05-cli-ui.md §8).

import { ExitCode } from "../errors/errors.js";

export type ExitOutcome =
  | { kind: "terminal" }
  | { kind: "cancelled" }
  | { kind: "blocked"; code: string | null }
  | { kind: "waiting_human" }
  | { kind: "waiting_recheck"; dueAt: string }
  | { kind: "policy_declined" }
  | { kind: "policy_unconfirmed" }
  | { kind: "policy_pinned" }
  | { kind: "recovery_declined" }
  | { kind: "interrupted"; signal: "SIGINT" | "SIGTERM" };

export function exitCodeFor(o: ExitOutcome): number {
  switch (o.kind) {
    case "terminal":
    case "cancelled":
    case "policy_declined":
    case "recovery_declined":
      return ExitCode.ok;
    case "blocked":
    case "waiting_human":
    case "policy_unconfirmed":
    case "policy_pinned":
      return ExitCode.waitingHuman;
    case "waiting_recheck":
      return ExitCode.waitingRecheck;
    case "interrupted":
      return o.signal === "SIGINT" ? ExitCode.sigint : ExitCode.sigterm;
  }
}

/** Причина abort-а движка: сигнал пользователя или потеря lock-а. */
export class InterruptRequest extends Error {
  override name = "InterruptRequest";
  constructor(readonly signal: "SIGINT" | "SIGTERM") {
    super(`interrupted by ${signal}`);
  }
}
