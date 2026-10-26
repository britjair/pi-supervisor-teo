import { expect, it } from "vitest";
import { sandbox, runCli } from "../helpers/tmp.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { validDir } from "../helpers/paths.js";

it("new запускает движок Pi; недоступная модель блокирует задачу без вызова API", async () => {
  const sb = await sandbox(await readFile(path.join(validDir, "discover-execute-done.md")));
  const r = await runCli(sb, ["new", "T-1", "--title", "тест", "--description", "данные", "--plain"]);
  expect(r.code).toBe(5);
  const state = JSON.parse(await readFile(path.join(sb.project, ".teo", "tasks", "T-1", "state.json"), "utf8"));
  expect(state.status).toBe("blocked");
  expect(state.statusReason.code).toBe("MODEL_UNAVAILABLE");
  const resumed = await runCli(sb, ["resume", "T-1", "--plain"]);
  expect(resumed.code).toBe(5);
});
