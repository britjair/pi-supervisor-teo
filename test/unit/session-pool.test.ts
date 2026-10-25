import { expect, it, vi } from "vitest";
import { SessionPool } from "../../src/agents/session-pool.js";
import type { AgentRuntime, AgentSessionHandle, RunOutcome, SessionSpec } from "../../src/agents/runtime.js";
import { ZERO_USAGE } from "../../src/agents/runtime.js";

it("остановка прерывает ход после take(), даже если его уже ждёт await-обработчик", async () => {
  let finish: ((outcome: RunOutcome) => void) | undefined;
  const abort = vi.fn(async () => finish?.({ kind: "aborted", usage: ZERO_USAGE }));
  const handle: AgentSessionHandle = {
    sessionFile: "/tmp/fake.jsonl",
    role: "agent",
    run: () => new Promise((resolve) => { finish = resolve; }),
    steer: async () => undefined,
    abort,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  };
  const runtime = { openSession: async () => handle } as unknown as AgentRuntime;
  const pool = new SessionPool(runtime);
  const spec = { file: handle.sessionFile } as SessionSpec;
  const session = await pool.open(spec);
  pool.start("run", session, "test", { parent: new AbortController().signal, timeoutMs: null });
  const active = pool.take("run");
  expect(active).not.toBeNull();
  await pool.abortAll();
  expect(abort).toHaveBeenCalledOnce();
  await expect(active?.promise).resolves.toMatchObject({ kind: "aborted" });
  await pool.dispose();
});
