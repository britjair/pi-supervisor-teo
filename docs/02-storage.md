# 02. Хранилище: layout, модели данных, атомарность, блокировки

Детализирует разделы 5.3, 9, 11, 18 [SDLC_CLI_SPEC.md](../SDLC_CLI_SPEC.md).

## 1. Layout `.teo/`

```text
<project-root>/.teo/
├── .gitignore                  # содержимое: "*" — каталог игнорирует сам себя
├── index.json                  # кэш для меню, не источник истины
├── project.lock.json           # существует, пока жив mutating-процесс
├── debug.log                   # debug-лог последнего процесса (ротация: 1 файл, ≤ 5 MB)
├── policies/
│   └── <sha256-hex>.md         # снимки Policy, см. 01-policy.md §4.2
└── tasks/
    └── <task-key>/
        ├── state.json          # источник истины по задаче
        ├── events.jsonl        # append-only журнал
        ├── runtime.json        # живая телеметрия процесса, не источник истины
        ├── task.md             # описание задачи от пользователя (пишет только CLI)
        ├── artifacts/          # рабочие документы агентов (план, отчёты ревью и т.п.)
        ├── runs/
        │   └── <runId>.json    # запись одного agent run: вход, отчёт, итог
        └── sessions/
            ├── supervisor.jsonl
            └── <agentId>-<NNN>.jsonl
```

Отличия от исходной спецификации:

| Было | Стало | Почему |
|---|---|---|
| `plan.md` в корне задачи | `artifacts/` (свободная структура) | «План» — понятие конкретного процесса. CLI не должен знать, что он существует. Policy сама говорит агентам, например, «сохрани план в `artifacts/plan.md`» |
| — | `runs/`, `policies/`, `.teo/.gitignore` | Нужны для recovery, проверки отчётов и diff политик |
| «рекомендуется добавить `.teo/` в `.gitignore` проекта» | CLI сам создаёт `.teo/.gitignore` с `*` | Не нужно трогать файлы проекта, и `git status` у агентов остаётся чистым |

`.teo/` создаётся лениво — только при первой mutating-операции (создание задачи), и только после успешного preflight Policy.

## 2. `task-key`

```ts
const TASK_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
```

Дополнительно запрещены:

- `.` и `..` целиком (regex их и так не пропускает, проверка оставлена явной для читаемости);
- окончание на `.` (проблемы с файловыми системами);
- зарезервированные имена Windows (`CON`, `NUL`, …) — для будущей переносимости, проверка без учёта регистра.

Уникальность проверяется без учёта регистра: на macOS файловая система по умолчанию case-insensitive, и `PAY-1` и `pay-1` иначе попали бы в один каталог.

## 3. `state.json`

### 3.1. Схема

```ts
type TaskState = {
  schemaVersion: 1;

  // идентичность
  key: string;
  title: string;
  projectRoot: string;           // абсолютный путь
  workspacePath: string | null;  // задел под worktree; в MVP всегда null → используется projectRoot
  createdAt: string;             // ISO 8601 UTC
  updatedAt: string;

  // версия для optimistic concurrency
  version: number;               // +1 на каждую запись

  // Policy
  policyHash: `sha256:${string}`;
  policySchema: "teo/v1";

  // этап процесса (строка из Policy, не enum)
  stage: string;
  stageEnteredAt: string;
  stageEntryEventId: string;     // id события task.created или stage.transitioned, открывшего этап
  stageCycles: number;           // сколько supervisor-циклов прошло в этом входе в этап (без циклов после перепроверки)
  stageRechecks: {               // отложенные перепроверки в этом входе в этап; сбрасывается при transition
    count: number;               // сколько schedule_recheck применено
    waitedMinutes: number;       // суммарное фактическое ожидание
    firstScheduledAt: string | null;
  };

  // технический статус движка
  status: "active" | "waiting_human" | "interrupted" | "blocked" | "terminal" | "cancelled";
  statusReason: { code: string; message: string; at: string } | null;

  // фаза цикла (см. 03-engine.md §2)
  phase: Phase;

  // агенты
  currentRun: AgentRunRef | null;
  agentRunCounters: Record<string, number>; // agentId -> последний выданный NNN
  consecutiveRestarts: number;              // сбрасывается при transition
  nextAgentInput: AgentInput | null;        // что отправить агенту при phase=agent_pending

  // отложенная перепроверка (см. 03-engine.md §12)
  wait: WaitState | null;                   // не null ⇔ phase = waiting

  // supervisor
  supervisor: {
    sessionFile: string;                    // "sessions/supervisor.jsonl"
    cycle: number;                          // сквозной номер цикла оценки
    trigger: SupervisorTrigger | null;      // почему нужен следующий цикл
    lastPolicyHashShown: string | null;     // какую версию Policy supervisor видел целиком
  };

  // решения
  pendingDecision: Decision | null;         // принято, но ещё не применено
  lastAppliedDecisionId: string | null;
  lastDecision: { decisionId: string; action: string; summary: string; at: string } | null;

  // человек
  pendingHumanRequest: HumanRequest | null;

  // outbox журнала (см. §6)
  lastEventId: string;
  outbox: TaskEvent[];                      // события, созданные этой записью state
};
```

```ts
type Phase =
  | "agent_pending"       // нужно запустить или продолжить агента: см. nextAgentInput
  | "agent_running"       // агент выполняется (или процесс упал во время выполнения)
  | "supervisor_pending"  // нужен цикл оценки: см. supervisor.trigger
  | "supervisor_running"  // supervisor выполняется
  | "decision_pending"    // решение записано, не применено
  | "human_pending"       // ждём ответ человека на pendingHumanRequest
  | "waiting"             // ждём срока отложенной перепроверки: см. wait
  | "halted";             // status ∈ {terminal, cancelled, blocked}

type AgentRunRef = {
  runId: string;           // ULID
  agentId: string;
  attempt: number;         // NNN из имени файла сессии: порядковый номер запуска агента в задаче
  stage: string;           // этап, в котором run создан
  sessionFile: string;     // относительно каталога задачи
  sessionMode: "fresh" | "reuse" | "restart";
  status: "pending" | "running" | "settled" | "failed";
  settleReason: SettleReason | null;
  promptsSent: string[];   // id отправленных промптов, см. 03-engine.md §5.2
  startedAt: string | null;
  finishedAt: string | null;
};

type SettleReason =
  | "reported_result"     // вызван report_result
  | "reported_blocker"    // вызван report_blocker
  | "unstructured_settle" // сессия завершилась без отчёта
  | "aborted"             // прерван пользователем или сигналом
  | "timeout"             // превышен agents.<id>.timeoutMinutes
  | "runtime_error"       // ошибка модели/провайдера после ретраев Pi
  | "interrupted";        // процесс умер, восстановлено при recovery

type AgentInput = {
  kind: "initial" | "continue" | "restart" | "recovery" | "recheck";
  message: string | null;  // текст supervisor (continue/restart/recheck) или служебный текст recovery
  decisionId: string | null;
};

type SupervisorTrigger = {
  kind: "agent_settled" | "recheck_settled" | "human_responded" | "policy_changed" | "unblocked" | "recovered" | "reevaluate";
  ref: string | null;      // runId или eventId
};

type WaitState = {
  decisionId: string;      // решение schedule_recheck, открывшее ожидание
  number: number;          // = stageRechecks.count после применения
  waitingFor: string;      // что ожидается, от supervisor
  message: string;         // поручение агенту на момент пробуждения
  delayMinutes: number;
  scheduledAt: string;
  dueAt: string;           // scheduledAt + delayMinutes, ISO 8601 UTC
};

type HumanRequest = {
  requestId: string;       // = eventId события human.requested
  origin: "supervisor" | "agent";
  runId: string | null;    // для origin=agent
  question: string;
  context: string | null;
  options: string[] | null;
  allowFreeText: boolean;
  attachments: Array<{ path: string; sha256: string }>;
  requestedAt: string;
};
```

`stage` — обычная строка. В коде нет enum этапов.

### 3.2. Инварианты (проверяются при каждой загрузке)

| Инвариант | При нарушении |
|---|---|
| `status ∈ {terminal, cancelled, blocked}` ⇔ `phase = halted` | `TaskCorruptedError` (exit 4) |
| `status = waiting_human` ⇔ `pendingHumanRequest ≠ null` | то же |
| `phase = human_pending` ⇒ `status = waiting_human` и `pendingHumanRequest.origin = supervisor` | то же |
| `status = waiting_human` и `phase ≠ human_pending` ⇒ `phase = agent_running` и `origin = agent` (вопрос `ask_user` внутри run, см. 03-engine.md §4.4) | то же |
| `phase = decision_pending` ⇔ `pendingDecision ≠ null` | то же |
| `phase = agent_pending` ⇒ `nextAgentInput ≠ null` | то же |
| `phase = agent_running` ⇒ `currentRun ≠ null` | то же |
| `phase = waiting` ⇔ `wait ≠ null` | то же |
| `phase = waiting` ⇒ `status ∈ {active, interrupted}` и `currentRun ≠ null` | то же |
| `currentRun.sessionFile` не выходит за каталог задачи | то же |
| `key` совпадает с именем каталога | то же |

`status = interrupted` допустим с любой нетерминальной фазой: он означает «процесс остановился, фаза показывает где».

## 4. `task.md`

Пишет только CLI при создании задачи; агенты получают его в промпте и через `read_task_description`.

```md
# PAY-142: Добавить оплату через СБП

Created: 2026-10-24T10:00:00.000Z
Project: /Users/user/Projects/cms

## Описание

<текст, введённый пользователем, без изменений>
```

Изменение описания после создания в MVP не поддерживается. Уточнения идут через диалог с агентом и попадают в журнал как `human.responded`.

## 5. `runs/<runId>.json`

Полная запись одного agent run. `state.currentRun` хранит только ссылку и статус.

```ts
type AgentRunRecord = {
  runId: string;
  agentId: string;
  attempt: number;
  stage: string;
  sessionFile: string;
  sessionMode: "fresh" | "reuse" | "restart";
  input: AgentInput;
  prompts: Array<{ promptId: string; kind: AgentInput["kind"]; sentAt: string }>;
  report:
    | { kind: "result"; at: string; data: ReportResultInput }
    | { kind: "blocker"; at: string; data: ReportBlockerInput }
    | null;
  reportsHistory: Array<NonNullable<AgentRunRecord["report"]>>; // отчёты прошлых prompt-циклов (continue, recheck)
  settleReason: SettleReason | null;
  error: string | null;            // для runtime_error / timeout
  lastAssistantText: string | null; // хвост последнего ответа (≤ 4 KB) для unstructured_settle
  toolStats: Record<string, { calls: number; errors: number }>;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null } | null;
  startedAt: string | null;
  finishedAt: string | null;
};
```

Отчёт агента (`report`) записывается **в момент вызова** `report_result` / `report_blocker`, до возврата результата модели. Поэтому падение процесса после отчёта не теряет его (см. [03-engine.md](03-engine.md#recovery)).

## 6. `events.jsonl`

### 6.1. Формат записи

```ts
type TaskEvent = {
  id: string;           // монотонный ULID (ulid monotonicFactory)
  timestamp: string;
  taskKey: string;
  type: EventType;
  stateVersion: number; // версия state, с которой событие записано; для событий без изменения state — текущая
  actor: "cli" | "supervisor" | "agent" | "human";
  payload: Record<string, unknown>;
};
```

### 6.2. Каталог событий

Исходный минимальный список расширен событиями, без которых не работают recovery и `status`.

| Тип | Меняет state | Payload | Новое? |
|---|---|---|---|
| `task.created` | да | `title, stage, policyHash, projectRoot` | |
| `task.resumed` | нет | `fromStatus, phase, pid` | |
| `task.cancelled` | да | `reason, humanResponseRef \| null, by` | |
| `task.blocked` | да | `code, message, by: "supervisor" \| "cli"` | |
| `task.unblocked` | да | `note, by: "human"` | ✓ |
| `task.terminal` | да | `stage` | |
| `policy.changed` | да | `fromHash, toHash, mode, diff` | |
| `agent.started` | да | `runId, agentId, attempt, sessionFile, sessionMode, stage` | |
| `agent.prompted` | да | `runId, promptId, kind` | ✓ |
| `agent.output` | нет | `runId, text` — **выключено по умолчанию**, полный поток есть в сессии Pi | |
| `agent.reported` | да | `runId, kind: "result" \| "blocker", summary` | ✓ |
| `agent.settled` | да | `runId, reason: SettleReason` | |
| `agent.failed` | да | `runId, reason, error` | |
| `agent.continued` | да | `runId, decisionId` | |
| `agent.restarted` | да | `previousRunId, runId, decisionId, consecutiveRestarts` | |
| `supervisor.started` | да | `cycle, trigger` | |
| `supervisor.decision` | да | `decisionId, cycle, action, input` (с редактированием) | |
| `supervisor.decision_rejected` | нет | `cycle, action, code, message` | ✓ |
| `supervisor.protocol_error` | да | `cycle, retriesUsed` | ✓ |
| `supervisor.note` | нет | `cycle, text` | ✓ (`record_note`) |
| `decision.applied` | да | `decisionId, action` | ✓ |
| `human.requested` | да | `requestId, origin, runId, question, options, attachments` | |
| `human.responded` | да | `requestId \| null, answer, selectedOption \| null`. `requestId = null` — сообщение по инициативе человека: комментарий при разблокировке, сообщение во время ожидания | |
| `stage.transitioned` | да | `from, to, reason, evidenceRefs, decisionId, handoff` | |
| `wait.scheduled` | да | `decisionId, number, maxCount, waitingFor, delayMinutes, dueAt` | ✓ |
| `wait.finished` | да | `decisionId, reason: "due" \| "skipped_by_human" \| "human_message", waitedMinutes, responseRef \| null` | ✓ |
| `runtime.interrupted` | да | `signal \| null, phase, runId \| null` | |
| `runtime.recovered` | да | `phase, action, details` | |

События с «Меняет state = да» пишутся только через outbox (§7.3). Остальные дописываются напрямую.

### 6.3. Редактирование секретов

Перед записью любого payload выполняется `redact()` (см. [04-agents.md](04-agents.md#redaction)). Ответы человека (`human.responded.answer`) **не** редактируются: это доказательство approval. Пользователь предупреждается в UI, что ответы сохраняются в журнал.

### 6.4. Чтение и восстановление журнала

- Чтение построчное. Последняя строка без `\n` или с невалидным JSON считается обрывом записи: она переносится в `events.jsonl.corrupt-<timestamp>`, файл обрезается до последней целой строки, пишется `runtime.recovered { action: "truncated_event_tail" }`.
- Невалидная строка **в середине** файла — `TaskCorruptedError` (exit 4). Автоматического ремонта нет, `teo doctor` показывает номер строки.
- `read_recent_events` читает с конца файла блоками по 64 KB, не загружая весь журнал.

## 7. Атомарная запись

### 7.1. `writeFileAtomic(path, data)`

```ts
async function writeFileAtomic(target: string, data: string): Promise<void> {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomHex(6)}.tmp`);
  const fh = await fs.open(tmp, "wx", 0o600);
  try {
    await fh.writeFile(data, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, target);
  await fsyncDir(dir); // открыть каталог O_RDONLY, fsync, закрыть; ошибки EISDIR/EPERM/EINVAL игнорируются
}
```

При старте процесса осиротевшие `*.tmp` в каталогах задач удаляются (только с чужим или мёртвым PID в имени).

### 7.2. `appendLine(path, line)`

```ts
const fh = await fs.open(path, "a", 0o600);
await fh.write(line + "\n");
await fh.sync();
await fh.close();
```

Одна строка — один вызов `write`. Конкурентной записи нет: её исключает project lock.

### 7.3. Транзакция state + events (outbox)

Исходная последовательность «state → index → event» оставляла окно, в котором state изменён, а события нет. Решение — transactional outbox внутри `state.json`:

```text
commit(mutator):
  1. state  = load()                         # с проверкой инвариантов
  2. events = mutator(state)                 # чистая функция: новые поля + список событий
  3. next.version  = state.version + 1
     next.outbox   = events                  # каждому событию проставлен stateVersion = next.version
     next.lastEventId = events.at(-1)?.id ?? state.lastEventId
  4. writeFileAtomic(state.json, next)       # ← точка коммита
  5. for e in events: appendLine(events.jsonl, e)
  6. writeFileAtomic(index.json, …)          # best effort, ошибка только логируется
```

Восстановление при каждой загрузке state:

```text
ensureOutboxFlushed(state):
  tailIds = id последних N событий журнала (N = 64)
  for e in state.outbox:
    if e.id not in tailIds and e.id > maxId(journal): appendLine(e)
```

Монотонные ULID позволяют сравнивать id лексикографически. Outbox не очищается отдельной записью: следующий `commit` его перезаписывает.

Так закрыта строка таблицы recovery «Transition записан в state, но отсутствует в events → восстановить событие» — без эвристик.

### 7.4. Optimistic concurrency

`commit` принимает опциональный `expectedVersion`. При несовпадении — `StateVersionConflictError`, без записи. В пределах одного процесса и одной задачи конфликт означает ошибку логики. Между процессами конфликт исключает lock, а версия остаётся страховкой.

Управляющие tools supervisor передают `expectedStateVersion`. Значение, которое он видит в промпте цикла, — это версия **после** записи `supervisor.started`; во время цикла state задачи никто не меняет.

### 7.5. Обнаружение подмены state

Дочерние агенты имеют `bash` и физически могут изменить `.teo/`. Запись через `write` и `edit` блокируется guard-расширением (см. [04-agents.md](04-agents.md#guard-extension)), для `bash` это невозможно. Поэтому:

- после каждого `commit` процесс хранит в памяти `sha256(state.json)`;
- перед каждым `load()` hash сверяется;
- при несовпадении задача переводится в `blocked` с кодом `STATE_TAMPERED`, событие `task.blocked`, а копия изменённого файла сохраняется рядом как `state.json.tampered-<timestamp>`.

## 8. `index.json`

```ts
type ProjectIndex = {
  schemaVersion: 1;
  generatedAt: string;
  tasks: Array<{
    key: string;
    title: string;
    stage: string;
    stageTitle: string | null; // из Policy на момент записи; null, если этапа нет в Policy
    status: TaskState["status"];
    phase: Phase;
    dueAt: string | null;      // wait.dueAt при phase = waiting
    updatedAt: string;
    stateVersion: number;
  }>;
};
```

- При каждом запуске меню index сверяется с `tasks/*/state.json` по `(key, stateVersion)`. При расхождении он перестраивается из state-файлов и перезаписывается, если процесс держит lock.
- Процесс без lock строит меню из state-файлов в памяти и index не пишет.
- Каталог задачи без `state.json` или с невалидным state показывается в меню как `⚠ <key> повреждена` и не открывается. `teo doctor` выводит подробности.

## 9. `runtime.json`

Живая телеметрия для TUI, для `teo status` из второго процесса и для диагностики. Не источник истины, не участвует в recovery.

```ts
type RuntimeInfo = {
  pid: number;
  hostname: string;
  startedAt: string;
  heartbeatAt: string;
  phase: Phase;
  actor: "agent" | "supervisor" | "human" | "cli";
  agentId: string | null;
  attempt: number | null;
  activity: string;            // «Запускаю tool bash: npm test», «Ожидаю ответ пользователя», «Перепроверка в 15:40»
  currentTool: string | null;
  phaseStartedAt: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
};
```

Пишется `writeFileAtomic` не чаще раза в секунду и при каждой смене фазы. При штатном выходе удаляется.

## 10. Project lock

### 10.1. Файл

```ts
type ProjectLock = {
  pid: number;
  hostname: string;          // os.hostname()
  processStartedAt: string;
  taskKey: string | null;    // null, пока процесс в меню
  command: string;           // "interactive" | "new" | "resume" | "recover" | "cancel"
  acquiredAt: string;
  heartbeatAt: string;
  nonce: string;             // случайный id владельца
};
```

### 10.2. Захват

```text
acquire():
  try:
    open(project.lock.json, "wx") → записать JSON → fsync → close
    return Lock
  catch EEXIST:
    existing = read lock (при ошибке разбора считать протухшим, если mtime старше staleAfter)
    if isStale(existing): takeover(existing)
    else throw LockConflictError(existing)          # exit 3
```

`isStale(lock)`:

| Условие | Результат |
|---|---|
| `hostname` = текущий и `process.kill(pid, 0)` даёт `ESRCH` | протухший |
| `hostname` = текущий и PID жив | **не** протухший, даже при старом heartbeat. PID мог быть переиспользован: тогда пользователь снимает lock вручную через `teo doctor` |
| `hostname` ≠ текущий | никогда не протухший автоматически (каталог может лежать на сетевом диске) |

`takeover(existing)`:

```text
  rename(project.lock.json, project.lock.json.stale-<pid>-<nonce>)  # атомарно; проиграл гонку → ENOENT → повторить acquire один раз
  open(project.lock.json, "wx") …
  удалить stale-файл
```

`rename` гарантирует, что из двух процессов, одновременно увидевших протухший lock, его заберёт только один.

### 10.3. Heartbeat и освобождение

- Heartbeat: `writeFileAtomic` раз в 5 секунд, `setInterval(…).unref()`. Перед записью процесс сверяет `nonce` в файле со своим. Если файл чужой, lock потерян: исполнение останавливается, задача помечается `interrupted`, exit 3.
- Освобождение: проверить `nonce`, удалить файл. Вызывается в `finally` основного цикла и в обработчиках `SIGINT`/`SIGTERM`.

### 10.4. Какие операции требуют lock

| Операция | Lock |
|---|---|
| Меню `teo` до выбора действия | не нужен (только чтение) |
| Создание задачи, продолжение, `resume`, `recover`, `cancel`, `doctor --fix` | нужен |
| `status`, `history`, `doctor` | не нужен; показывают, кто держит lock |

Если в меню выбрано mutating-действие, а lock занят:

```text
Project is locked by another teo process
  PID 18432 on macbook, task PAY-142, heartbeat 4s ago

You can view status: teo status PAY-142
```

Пользователь возвращается в меню; если запрошена неинтерактивная команда — exit 3.
