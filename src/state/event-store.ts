// Журнал events.jsonl, 02-storage.md §6.4: чтение целиком и с хвоста, ремонт оборванного хвоста.

import { open, readFile, stat, truncate } from "node:fs/promises";
import type { TaskEvent } from "../domain/events.js";
import { TaskCorruptedError } from "../errors/errors.js";
import { appendLine, writeFileAtomic } from "./atomic-file.js";
import { taskEventSchema } from "./state-schema.js";

const NEWLINE = 0x0a;
const BLOCK_SIZE = 64 * 1024;

/** Оборванная последняя запись: строка без перевода строки или с невалидным JSON. */
export type BrokenTail = {
  /** С какого байта начинается оборванная строка: до этого места файл цел */
  offset: number;
  bytes: Buffer;
};

export type JournalTail = {
  /** Последние целые события, по порядку */
  events: TaskEvent[];
  broken: BrokenTail | null;
};

function parseLine(line: Buffer): TaskEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
  const parsed = taskEventSchema.safeParse(value);
  return parsed.success ? (parsed.data as TaskEvent) : null;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/** Разбить буфер на строки по \n. Последний элемент — хвост после последнего \n (может быть пустым). */
function splitLines(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === NEWLINE) {
      out.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  out.push(buf.subarray(start));
  return out;
}

export class EventJournal {
  constructor(
    readonly file: string,
    readonly taskKey: string,
  ) {}

  /**
   * Весь журнал. Невалидная строка в середине — TaskCorruptedError с номером строки;
   * оборванная последняя строка возвращается отдельно, чтобы её можно было отремонтировать.
   */
  async readAll(): Promise<JournalTail> {
    let buf: Buffer;
    try {
      buf = await readFile(this.file);
    } catch (err) {
      if (isEnoent(err)) return { events: [], broken: null };
      throw err;
    }
    const lines = splitLines(buf);
    const rest = lines.pop() ?? Buffer.alloc(0);
    const events: TaskEvent[] = [];
    let offset = 0;
    let broken: BrokenTail | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? Buffer.alloc(0);
      const event = parseLine(line);
      if (event) {
        events.push(event);
      } else if (i === lines.length - 1 && rest.length === 0) {
        broken = { offset, bytes: buf.subarray(offset) };
      } else {
        throw new TaskCorruptedError(this.taskKey, this.file, "невалидная запись в журнале событий", i + 1);
      }
      offset += line.length + 1;
    }
    if (rest.length > 0) broken = { offset, bytes: buf.subarray(offset) };
    return { events, broken };
  }

  /**
   * Последние `limit` целых событий, без чтения всего файла: блоками по 64 KB с конца.
   * Битые строки внутри прочитанного хвоста — TaskCorruptedError (номер строки неизвестен).
   */
  async readTail(limit: number): Promise<JournalTail> {
    let fh;
    try {
      fh = await open(this.file, "r");
    } catch (err) {
      if (isEnoent(err)) return { events: [], broken: null };
      throw err;
    }
    try {
      const size = (await fh.stat()).size;
      let start = size;
      let chunk = Buffer.alloc(0);
      let newlines = 0;
      // Нужно limit + 2 перевода строки: limit строк, возможный битый хвост и граница начала
      while (start > 0 && newlines < limit + 2) {
        const len = Math.min(BLOCK_SIZE, start);
        start -= len;
        const block = Buffer.alloc(len);
        await fh.read(block, 0, len, start);
        for (const b of block) if (b === NEWLINE) newlines++;
        chunk = Buffer.concat([block, chunk]);
      }
      const lines = splitLines(chunk);
      const rest = lines.pop() ?? Buffer.alloc(0);
      // Первая строка блока может быть обрезана началом чтения
      if (start > 0) lines.shift();
      let broken: BrokenTail | null = null;
      if (rest.length > 0) {
        broken = { offset: size - rest.length, bytes: Buffer.from(rest) };
      } else if (lines.length > 0 && parseLine(lines.at(-1) ?? Buffer.alloc(0)) === null) {
        const last = lines.pop() ?? Buffer.alloc(0);
        broken = { offset: size - last.length - 1, bytes: Buffer.from(chunk.subarray(chunk.length - last.length - 1)) };
      }
      const events: TaskEvent[] = [];
      for (const line of lines.slice(-limit)) {
        const event = parseLine(line);
        if (!event) throw new TaskCorruptedError(this.taskKey, this.file, "невалидная запись в журнале событий");
        events.push(event);
      }
      return { events, broken };
    } finally {
      await fh.close();
    }
  }

  async append(events: readonly TaskEvent[]): Promise<void> {
    for (const e of events) await appendLine(this.file, JSON.stringify(e));
  }

  /**
   * Перенести оборванный хвост в events.jsonl.corrupt-<stamp> и обрезать файл до последней целой строки.
   * Возвращает путь к файлу с хвостом.
   */
  async cutBrokenTail(broken: BrokenTail, stamp: string): Promise<string> {
    const current = await stat(this.file);
    if (current.size < broken.offset) throw new Error(`Журнал ${this.file} короче ожидаемого`);
    const target = `${this.file}.corrupt-${stamp}`;
    await writeFileAtomic(target, broken.bytes);
    await truncate(this.file, broken.offset);
    return target;
  }
}

/** Метка времени для имён файлов: 2026-10-25T12-00-00-000Z */
export function fileStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
