// teo models cooldown / teo models reset: ручное управление cooldown-ами лимитов.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COOLDOWN_FILE_NAME } from "../../src/util/model-cooldown-store.js";
import type { CooldownRecord } from "../../src/util/model-exhaustion.js";
import { runCli, sandbox } from "../helpers/tmp.js";

const cooldownFile = (home: string) => path.join(home, ".pi", "teo", COOLDOWN_FILE_NAME);

/** cooldown-ы на час вперёд от текущего времени: CLI запускается в отдельном процессе. */
async function seed(home: string, records: CooldownRecord[]): Promise<void> {
  await mkdir(path.dirname(cooldownFile(home)), { recursive: true });
  await writeFile(cooldownFile(home), JSON.stringify({ schema: 1, records }, null, 2));
}

const hourAhead = () => Date.now() + 60 * 60 * 1000;

describe("teo models", () => {
  it("cooldown показывает пустой список, когда лимитов нет", async () => {
    const sb = await sandbox();
    const r = await runCli(sb, ["models", "cooldown"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Активных cooldown-ов нет");
  });

  it("cooldown показывает область, срок и номер пробы", async () => {
    const sb = await sandbox();
    await seed(sb.home, [
      { provider: "openai-codex", modelId: null, exhaustedUntil: hourAhead(), attempt: 3, reason: "usage limit", recordedAt: Date.now() },
      { provider: "antigravity", modelId: "gemini-3.8-flash-high", exhaustedUntil: hourAhead(), attempt: 1, reason: "429", recordedAt: Date.now() },
    ]);

    const r = await runCli(sb, ["models", "cooldown"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("openai-codex/*");
    expect(r.stdout).toContain("провайдер");
    expect(r.stdout).toContain("antigravity/gemini-3.8-flash-high");
    expect(r.stdout).toContain("модель");
    expect(r.stdout).toContain("3/7");
    expect(r.stdout).toContain(COOLDOWN_FILE_NAME);
  });

  it("cooldown --json отдаёт машинный вид", async () => {
    const sb = await sandbox();
    await seed(sb.home, [
      { provider: "openai-codex", modelId: null, exhaustedUntil: hourAhead(), attempt: 2, reason: "usage limit", recordedAt: Date.now() },
    ]);

    const r = await runCli(sb, ["models", "cooldown", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { records: Array<{ provider: string; scope: string; attempt: number }> };
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({ provider: "openai-codex", scope: "provider", attempt: 2 });
  });

  it("reset снимает cooldown провайдера и пишет это на диск", async () => {
    const sb = await sandbox();
    await seed(sb.home, [
      { provider: "openai-codex", modelId: null, exhaustedUntil: hourAhead(), attempt: 2, reason: "usage limit", recordedAt: Date.now() },
      { provider: "antigravity", modelId: "gemini-3.8-flash-high", exhaustedUntil: hourAhead(), attempt: 1, reason: "429", recordedAt: Date.now() },
    ]);

    const r = await runCli(sb, ["models", "reset", "openai-codex"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Снято cooldown-ов: 1");

    const stored = JSON.parse(await readFile(cooldownFile(sb.home), "utf8")) as { records: CooldownRecord[] };
    expect(stored.records.map((x) => x.provider)).toEqual(["antigravity"]);

    expect((await runCli(sb, ["models", "cooldown"])).stdout).not.toContain("openai-codex");
  });

  it("reset --all снимает всё, а без цели требует аргумент", async () => {
    const sb = await sandbox();
    await seed(sb.home, [
      { provider: "openai-codex", modelId: null, exhaustedUntil: hourAhead(), attempt: 2, reason: "usage limit", recordedAt: Date.now() },
    ]);

    const noTarget = await runCli(sb, ["models", "reset"]);
    expect(noTarget.code).not.toBe(0);
    expect(noTarget.stderr).toContain("--all");

    const all = await runCli(sb, ["models", "reset", "--all"]);
    expect(all.code).toBe(0);
    expect(all.stdout).toContain("Снято cooldown-ов: 1");
    expect((await runCli(sb, ["models", "cooldown"])).stdout).toContain("Активных cooldown-ов нет");
  });

  it("reset конкретной модели не трогает остальные записи провайдера", async () => {
    const sb = await sandbox();
    await seed(sb.home, [
      { provider: "antigravity", modelId: "gemini-3.8-flash-high", exhaustedUntil: hourAhead(), attempt: 1, reason: "429", recordedAt: Date.now() },
      { provider: "antigravity", modelId: "gemini-3.8-pro", exhaustedUntil: hourAhead(), attempt: 1, reason: "429", recordedAt: Date.now() },
    ]);

    const r = await runCli(sb, ["models", "reset", "antigravity/gemini-3.8-pro"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Снято cooldown-ов: 1");

    const out = (await runCli(sb, ["models", "cooldown"])).stdout;
    expect(out).toContain("gemini-3.8-flash-high");
    expect(out).not.toContain("gemini-3.8-pro");
  });
});
