// ANSI-стили для линейного вывода. Без цвета — тождественные функции.

export type Style = {
  red(s: string): string;
  yellow(s: string): string;
  green(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
};

const wrap = (open: number, close: number) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;
const id = (s: string) => s;

export function createStyle(enabled: boolean): Style {
  if (!enabled) return { red: id, yellow: id, green: id, dim: id, bold: id };
  return { red: wrap(31, 39), yellow: wrap(33, 39), green: wrap(32, 39), dim: wrap(2, 22), bold: wrap(1, 22) };
}

/** Цвет включён, если вывод — терминал, не задан NO_COLOR и не передан --no-color. */
export function colorEnabled(opts: { isTTY: boolean; env: Record<string, string | undefined>; flag: boolean }): boolean {
  if (!opts.flag) return false;
  if (opts.env["NO_COLOR"] !== undefined && opts.env["NO_COLOR"] !== "") return false;
  if (opts.env["FORCE_COLOR"] !== undefined && opts.env["FORCE_COLOR"] !== "0") return true;
  return opts.isTTY;
}
