// Текущий движок получает первый сигнал; повторный сигнал обрабатывает cli.ts немедленно.
type Signal = "SIGINT" | "SIGTERM";
let current: ((signal: Signal) => void) | null = null;
export function setInterruptHandler(handler: (signal: Signal) => void): () => void {
  current = handler;
  return () => { if (current === handler) current = null; };
}
export function dispatchInterrupt(signal: Signal): boolean {
  if (!current) return false;
  current(signal);
  return true;
}
