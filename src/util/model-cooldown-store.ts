// Дисковое хранилище cooldown-ов моделей (docs/08-model-profiles.md §5).
// Файл глобальный, а не внутри .teo: лимиты принадлежат аккаунту провайдера, а не репозиторию,
// и несколько проектов должны видеть один и тот же cooldown.
// Повреждённый файл не ошибка: трактуется как отсутствие cooldown-ов.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defaultProcessesDir } from "../policy/process-catalog.js";
import type { CooldownPersistence, CooldownRecord } from "./model-exhaustion.js";
import { redactString, truncate } from "./redact.js";

export const COOLDOWN_FILE_NAME = "model-cooldowns.json";

/** `~/.pi/teo/model-cooldowns.json` */
export function cooldownFilePath(homeDir: string): string {
  return path.join(defaultProcessesDir(homeDir), COOLDOWN_FILE_NAME);
}

const recordSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1).nullable(),
  exhaustedUntil: z.number().finite(),
  attempt: z.number().int().nonnegative(),
  reason: z.string(),
  recordedAt: z.number().finite(),
  resetKnown: z.boolean().optional(),
  resetDetail: z.string().nullable().optional(),
  lastProbeAt: z.number().finite().nullable().optional(),
  nextProbeAt: z.number().finite().nullable().optional(),
});

const fileSchema = z.object({
  schema: z.literal(1),
  records: z.array(recordSchema),
});

export class FileCooldownStore implements CooldownPersistence {
  constructor(private readonly file: string) {}

  load(): CooldownRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    try {
      const parsed = fileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return [];
      return parsed.data.records.map((r) => ({
        provider: r.provider,
        modelId: r.modelId,
        exhaustedUntil: r.exhaustedUntil,
        attempt: r.attempt,
        reason: r.reason,
        recordedAt: r.recordedAt,
        ...(r.resetKnown !== undefined ? { resetKnown: r.resetKnown } : {}),
        ...(r.resetDetail !== undefined ? { resetDetail: r.resetDetail } : {}),
        ...(r.lastProbeAt !== undefined ? { lastProbeAt: r.lastProbeAt } : {}),
        ...(r.nextProbeAt !== undefined ? { nextProbeAt: r.nextProbeAt } : {}),
      }));
    } catch {
      return [];
    }
  }

  save(records: readonly CooldownRecord[]): void {
    // Причина — текст ошибки провайдера: редактируем, чтобы в файл не попали токены.
    const payload = {
      schema: 1 as const,
      records: records.map((r) => ({ ...r, reason: truncate(redactString(r.reason), 300) })),
    };
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // Нет доступа к каталогу — cooldown просто не переживёт перезапуск, работу это не ломает.
    }
  }
}
