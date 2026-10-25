// Форматирование времени для интерфейса: локальное время процесса (TZ), «N мин назад».

import { plural } from "./strings.js";

const pad = (n: number) => String(n).padStart(2, "0");

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 2026-10-25 12:39:00 */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Сегодня — «12:39», иначе — «2026-10-24 12:39». С секундами — «12:39:00». */
export function formatWhen(iso: string, now: Date, seconds = false): string {
  const d = new Date(iso);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ""}`;
  if (sameLocalDay(d, now)) return time;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

/** 3 с, 5 мин, 2 ч 10 мин, 3 дн */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} ч ${m % 60} мин` : `${h} ч`;
  const d = Math.floor(h / 24);
  return `${d} ${plural(d, "день", "дня", "дней")}`;
}

export function formatAgo(iso: string, now: Date): string {
  return `${formatDuration(now.getTime() - new Date(iso).getTime())} назад`;
}
