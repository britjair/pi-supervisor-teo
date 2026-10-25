import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hashPolicyBytes } from "../../src/policy/policy-hash.js";
import { PolicySnapshotError, PolicySnapshotStore } from "../../src/policy/snapshot-store.js";
import { tmpDir } from "../helpers/tmp.js";

const policy = (raw: string) => ({ raw, hash: hashPolicyBytes(new TextEncoder().encode(raw)) });

describe("PolicySnapshotStore", () => {
  it("сохраняет снимок по hash байт в байт, включая BOM и CRLF", async () => {
    const dir = path.join(await tmpDir(), ".sdlc", "policies");
    const store = new PolicySnapshotStore(dir);
    const p = policy("\uFEFF---\r\nschema: sdlc/v1\r\n---\r\nтело\r\n");
    const file = await store.save(p);
    expect(path.basename(file)).toBe(`${p.hash.slice("sha256:".length)}.md`);
    expect(hashPolicyBytes(await readFile(file))).toBe(p.hash);
    expect(await store.read(p.hash)).toBe(p.raw);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("повторное сохранение не переписывает файл", async () => {
    const store = new PolicySnapshotStore(await tmpDir());
    const p = policy("x");
    const file = await store.save(p);
    const before = (await stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await store.save(p);
    expect((await stat(file)).mtimeMs).toBe(before);
  });

  it("нет снимка — null; повреждённый снимок — ошибка", async () => {
    const store = new PolicySnapshotStore(await tmpDir());
    const p = policy("y");
    expect(await store.read(p.hash)).toBeNull();
    await store.save(p);
    await writeFile(store.pathFor(p.hash), "подмена");
    await expect(store.read(p.hash)).rejects.toBeInstanceOf(PolicySnapshotError);
  });

  it("текст не соответствует hash — ошибка", async () => {
    const store = new PolicySnapshotStore(await tmpDir());
    await expect(store.save({ raw: "a", hash: policy("b").hash })).rejects.toBeInstanceOf(PolicySnapshotError);
  });
});
