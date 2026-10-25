// Атомарная запись файлов, 02-storage.md §7.1–7.2.

import { randomBytes } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";

/** fsync каталога после rename. На части файловых систем не поддерживается — это не ошибка. */
export async function fsyncDir(dir: string): Promise<void> {
  let fh;
  try {
    fh = await open(dir, "r");
    await fh.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EISDIR" && code !== "EPERM" && code !== "EINVAL" && code !== "EBADF") throw err;
  } finally {
    await fh?.close();
  }
}

export function tmpPathFor(target: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
}

export async function writeFileAtomic(target: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(target);
  const tmp = tmpPathFor(target);
  const fh = await open(tmp, "wx", 0o600);
  try {
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  await fsyncDir(dir);
}

/** Одна строка — один вызов write. Конкурентную запись исключает project lock. */
export async function appendLine(target: string, line: string): Promise<void> {
  const fh = await open(target, "a", 0o600);
  try {
    await fh.write(line + "\n");
    await fh.sync();
  } finally {
    await fh.close();
  }
}
