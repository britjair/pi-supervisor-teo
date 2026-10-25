// Действия при остановке процесса по сигналу (освобождение lock-а). Вызывает cli.ts.

type Cleanup = () => Promise<void> | void;
const handlers = new Set<Cleanup>();

export function onCleanup(fn: Cleanup): () => void {
  handlers.add(fn);
  return () => handlers.delete(fn);
}

export async function runCleanup(): Promise<void> {
  const all = [...handlers].reverse();
  handlers.clear();
  for (const fn of all) {
    try {
      await fn();
    } catch {
      // процесс всё равно завершается
    }
  }
}
