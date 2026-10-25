// Идентификаторы: монотонные ULID (02-storage.md §6.1). Время берётся из Clock.

import { randomBytes } from "node:crypto";
import { decodeTime, isValid, monotonicFactory } from "ulid";
import type { Clock } from "./clock.js";

export interface IdGenerator {
  /**
   * Новый ULID. Если передан `after`, результат строго больше него: журнал задачи
   * мог писать другой процесс, а id событий сравниваются лексикографически (outbox, §7.3).
   */
  next(after?: string | null): string;
}

export function createIdGenerator(clock: Clock): IdGenerator {
  const factory = monotonicFactory();
  return {
    next(after) {
      let time = clock.now().getTime();
      if (after && isValid(after)) time = Math.max(time, decodeTime(after));
      let id = factory(time);
      // В ту же миллисекунду, что и `after` из чужого процесса: сдвиг на 1 мс вперёд
      if (after && id <= after) id = factory(decodeTime(after) + 1);
      return id;
    },
  };
}

/** Случайный hex: nonce lock-а, имена временных файлов. */
export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
