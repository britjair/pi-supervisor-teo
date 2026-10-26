// Снимки Policy в .teo/policies/<sha256-hex>.md, 01-policy.md §4.2.
// Каталог .teo создаёт вызывающая mutating-операция: здесь создаётся только policies/.

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { LoadedPolicy, PolicyHash } from "../domain/policy.js";
import { writeFileAtomic } from "../state/atomic-file.js";
import { hashPolicyBytes, policyHashHex } from "./policy-hash.js";

export class PolicySnapshotError extends Error {
  override name = "PolicySnapshotError";
}

export class PolicySnapshotStore {
  constructor(readonly dir: string) {}

  pathFor(hash: PolicyHash): string {
    return path.join(this.dir, `${policyHashHex(hash)}.md`);
  }

  /** Сохранить снимок, если его ещё нет. Возвращает путь к снимку. */
  async save(policy: Pick<LoadedPolicy, "hash" | "raw">): Promise<string> {
    const bytes = new TextEncoder().encode(policy.raw);
    if (hashPolicyBytes(bytes) !== policy.hash) {
      throw new PolicySnapshotError(`Текст Policy не соответствует hash ${policy.hash}`);
    }
    const file = this.pathFor(policy.hash);
    if ((await this.read(policy.hash)) !== null) return file;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(file, bytes);
    return file;
  }

  /** Текст снимка или null, если его нет. Повреждённый снимок (hash не совпадает) — ошибка. */
  async read(hash: PolicyHash): Promise<string | null> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(this.pathFor(hash));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    if (hashPolicyBytes(bytes) !== hash) {
      throw new PolicySnapshotError(`Снимок Policy ${this.pathFor(hash)} повреждён: hash не совпадает`);
    }
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  }
}
