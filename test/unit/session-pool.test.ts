import { expect, it, vi } from "vitest";
import { SessionPool } from "../../src/agents/session-pool.js";
import type { AgentRuntime, AgentSessionHandle, ResolvedModel, RunOutcome, SessionSpec } from "../../src/agents/runtime.js";
import { ZERO_USAGE } from "../../src/agents/runtime.js";

const SESSION_FILE = "/tmp/fake-supervisor.jsonl";

function model(id: string): ResolvedModel {
  return { id, thinking: null, providedBy: null, handle: {} };
}

/** Сессия, помнящая, с какой моделью её открыли. */
function trackingRuntime() {
  const opened: string[] = [];
  const disposed: string[] = [];
  const runtime = {
    openSession: async (spec: SessionSpec) => {
      const id = spec.model.id;
      opened.push(id);
      return {
        sessionFile: spec.file,
        role: spec.role,
        run: async () => ({ kind: "completed", lastAssistantText: id, usage: ZERO_USAGE }) as RunOutcome,
        steer: async () => undefined,
        abort: async () => undefined,
        subscribe: () => () => undefined,
        dispose: () => void disposed.push(id),
      } satisfies AgentSessionHandle;
    },
  } as unknown as AgentRuntime;
  return { runtime, opened, disposed };
}

const specFor = (id: string) =>
  ({ file: SESSION_FILE, role: "supervisor", model: model(id) }) as SessionSpec;

it("open переоткрывает сессию при смене модели: fallback не должен уходить в прежнюю модель", async () => {
  const { runtime, opened, disposed } = trackingRuntime();
  const pool = new SessionPool(runtime);

  const first = await pool.open(specFor("openai-codex/gpt-5.6-sol"));
  expect(pool.openedModel(SESSION_FILE)).toBe("openai-codex/gpt-5.6-sol");

  // Та же модель — та же живая сессия, переоткрытия нет
  expect(await pool.open(specFor("openai-codex/gpt-5.6-sol"))).toBe(first);
  expect(opened).toEqual(["openai-codex/gpt-5.6-sol"]);

  // Другая модель — новая сессия на том же файле, старая закрыта
  const second = await pool.open(specFor("claude-bridge/claude-opus-5-5"));
  expect(second).not.toBe(first);
  expect(second.sessionFile).toBe(SESSION_FILE);
  expect(opened).toEqual(["openai-codex/gpt-5.6-sol", "claude-bridge/claude-opus-5-5"]);
  expect(disposed).toEqual(["openai-codex/gpt-5.6-sol"]);
  expect(pool.openedModel(SESSION_FILE)).toBe("claude-bridge/claude-opus-5-5");

  // Запрос реально уходит в новую модель
  await expect(second.run("prompt", { signal: new AbortController().signal })).resolves.toMatchObject({
    lastAssistantText: "claude-bridge/claude-opus-5-5",
  });

  await pool.dispose();
});

it("смена уровня thinking тоже переоткрывает сессию", async () => {
  const { runtime, opened } = trackingRuntime();
  const pool = new SessionPool(runtime);
  const base = { file: SESSION_FILE, role: "supervisor" } as const;

  await pool.open({ ...base, model: { ...model("p/m"), thinking: "low" } } as SessionSpec);
  await pool.open({ ...base, model: { ...model("p/m"), thinking: "high" } } as SessionSpec);

  expect(opened).toEqual(["p/m", "p/m"]);
  await pool.dispose();
});

it("reopen закрывает текущую сессию файла и открывает новую", async () => {
  const { runtime, opened, disposed } = trackingRuntime();
  const pool = new SessionPool(runtime);

  await pool.open(specFor("p/m"));
  await pool.reopen(specFor("p/m"));

  expect(opened).toEqual(["p/m", "p/m"]);
  expect(disposed).toEqual(["p/m"]);
  expect(pool.openedModel(SESSION_FILE)).toBe("p/m");
  expect(pool.openedModel("/tmp/other.jsonl")).toBeNull();
  await pool.dispose();
});

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
