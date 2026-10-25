import { createHash } from "node:crypto";
import type { PolicyHash } from "../domain/policy.js";

/** Hash от исходных байтов файла без нормализации (01-policy.md §1.4). */
export function hashPolicyBytes(bytes: Uint8Array): PolicyHash {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

const HASH_RE = /^sha256:([0-9a-f]{64})$/;

export function isPolicyHash(value: string): value is PolicyHash {
  return HASH_RE.test(value);
}

/** sha256:abcd… → abcd… (имя снимка в .sdlc/policies/). */
export function policyHashHex(hash: PolicyHash): string {
  const m = HASH_RE.exec(hash);
  if (!m?.[1]) throw new Error(`Некорректный hash Policy: ${hash}`);
  return m[1];
}
