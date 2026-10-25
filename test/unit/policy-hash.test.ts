import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPolicyBytes, isPolicyHash, policyHashHex } from "../../src/policy/policy-hash.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("policy-hash", () => {
  it("sha256 от байтов файла", () => {
    const bytes = enc("---\nschema: sdlc/v1\n---\nbody\n");
    expect(hashPolicyBytes(bytes)).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  });

  it("изменение только Markdown-части меняет hash", () => {
    expect(hashPolicyBytes(enc("---\na: 1\n---\nbody"))).not.toBe(hashPolicyBytes(enc("---\na: 1\n---\nbody!")));
  });

  it("без нормализации: CRLF, BOM и хвостовой пробел дают другой hash", () => {
    const base = hashPolicyBytes(enc("---\na: 1\n---\n"));
    expect(hashPolicyBytes(enc("---\r\na: 1\r\n---\r\n"))).not.toBe(base);
    expect(hashPolicyBytes(enc("\uFEFF---\na: 1\n---\n"))).not.toBe(base);
    expect(hashPolicyBytes(enc("---\na: 1 \n---\n"))).not.toBe(base);
  });

  it("hex для имени снимка", () => {
    const h = hashPolicyBytes(enc("x"));
    expect(isPolicyHash(h)).toBe(true);
    expect(policyHashHex(h)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => policyHashHex("sha256:../../etc" as never)).toThrow();
  });
});
