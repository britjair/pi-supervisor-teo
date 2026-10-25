// Чтение настоящего JSONL Pi 1.4.0 без запуска модели. Учитываем system messages
// и другие служебные записи, которые могут идти после последнего хода.

import { readFile } from "node:fs/promises";
import { promptIdsIn, type SessionFileInfo, type TranscriptEntry } from "../runtime.js";
import { argsPreview, redactString, truncate } from "../../util/redact.js";

type Entry = { type: string; message?: Record<string, unknown> };

async function entries(file: string): Promise<{ exists: boolean; rows: Entry[]; error: string | null }> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, rows: [], error: null };
    throw err;
  }
  const rows: Entry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]?.trim()) continue;
    try {
      const row: unknown = JSON.parse(lines[i] ?? "");
      if (!row || typeof row !== "object" || typeof (row as Entry).type !== "string") throw new Error("нет типа записи");
      rows.push(row as Entry);
    } catch {
      return { exists: true, rows, error: `строка ${i + 1}: некорректная запись JSONL` };
    }
  }
  if (rows.length > 0 && rows[0]?.type !== "session") return { exists: true, rows, error: "нет заголовка сессии" };
  return { exists: true, rows, error: null };
}

function blocks(message: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(message.content) ? message.content.filter((b): b is Record<string, unknown> => b !== null && typeof b === "object") : [];
}

function textOf(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  return blocks(message).filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n");
}

export async function inspectPiSessionFile(file: string): Promise<SessionFileInfo> {
  const { exists, rows, error } = await entries(file);
  const messages = rows.filter((r) => r.type === "message" && r.message && typeof r.message.role === "string").map((r) => r.message!);
  const promptIds = messages.filter((m) => m.role === "user").flatMap((m) => promptIdsIn(textOf(m)));
  const last = [...messages].reverse().find((m) => m.role === "assistant" || m.role === "user" || m.role === "toolResult");
  // Пачка tools может оборваться после одного toolResult: показываем незавершённые вызовы
  // последнего ответа, даже если последней строкой файла стал результат другого инструмента.
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const results = new Set(messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
  const dangling = lastAssistant ? blocks(lastAssistant).filter((b) => b.type === "toolCall" && !results.has(b.id)) : [];
  let lastEntry: SessionFileInfo["lastEntry"] = null;
  if (lastAssistant && (last?.role === "assistant" || (last?.role === "toolResult" && dangling.length > 0))) {
    lastEntry = {
      kind: "assistant",
      stopReason: typeof lastAssistant.stopReason === "string" ? lastAssistant.stopReason : "unknown",
      text: textOf(lastAssistant) || null,
      danglingToolCalls: dangling.map((c) => ({
        toolCallId: String(c.id ?? ""), toolName: String(c.name ?? ""), argsPreview: argsPreview(c.arguments),
      })),
    };
  } else if (last) lastEntry = { kind: last.role === "user" ? "user" : "toolResult" };
  return { exists, valid: error === null, parseError: error, promptIds, lastEntry, messageCount: messages.length };
}

export async function readPiTranscript(file: string, opts: { tail: number }): Promise<TranscriptEntry[]> {
  const { rows, error } = await entries(file);
  if (error) throw new Error(`Файл сессии повреждён: ${error}`);
  const result: TranscriptEntry[] = [];
  for (const row of rows) {
    if (row.type !== "message" || !row.message) continue;
    const m = row.message;
    if (m.role === "user") result.push({ kind: "user", text: redactString(truncate(textOf(m), 4000)) });
    if (m.role === "assistant") {
      const text = textOf(m);
      if (text) result.push({ kind: "assistant", text: redactString(truncate(text, 4000)) });
      for (const b of blocks(m).filter((b) => b.type === "toolCall")) result.push({
        kind: "tool_call", toolCallId: String(b.id ?? ""), toolName: String(b.name ?? ""), argsPreview: argsPreview(b.arguments),
      });
    }
    if (m.role === "toolResult") result.push({
      kind: "tool_result", toolCallId: String(m.toolCallId ?? ""), toolName: String(m.toolName ?? ""),
      ok: m.isError !== true, preview: redactString(truncate(textOf(m), 1000)),
    });
  }
  return result.slice(-Math.max(0, opts.tail));
}
