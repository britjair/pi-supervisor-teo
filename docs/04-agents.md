# 04. Агенты, Pi SDK, инструменты и промпты

Детализирует разделы 12–15 и 24 [SDLC_CLI_SPEC.md](../SDLC_CLI_SPEC.md).

Опорная версия: `@earendil-works/pi-coding-agent` **1.4.0** — та же, что у локального Pi CLI из Homebrew (API ниже проверено по исходникам 1.4.0). Pi выпускает breaking changes в минорных версиях, поэтому версия фиксируется точно (`"1.4.0"`, без `^`), а весь доступ к SDK идёт через адаптер. SDK и локальный CLI обновляются вместе: оба работают с общим `~/.pi/agent`.

## 1. Факты о Pi SDK, на которые опирается дизайн

| Факт | Следствие для sdlc |
|---|---|
| `SessionManager.open(path, sessionDir?, cwdOverride?)` для несуществующего `path` создаёт новую сессию и сохраняет её **по этому пути** | Сессии лежат в `.sdlc/tasks/<KEY>/sessions/<agentId>-<NNN>.jsonl`, а не в `~/.pi/agent/sessions` |
| Файл сессии создаётся при первом user-сообщении (с 1.x), затем append-only JSONL | Наличие `promptId` в файле = prompt доставлен (recovery, [03-engine.md §8](03-engine.md#recovery)) |
| `session.prompt(text)` резолвится после завершения всего хода, включая tool calls и встроенные ретраи | Отдельный `waitForIdle` не нужен |
| Ошибки провайдера не бросаются, а завершают ход сообщением с `stopReason: "error" \| "aborted"` и `errorMessage` | `RunOutcome` строится по последнему assistant-сообщению |
| `AgentToolResult.terminate = true` останавливает агента после текущей пачки tools, если `terminate` вернули все tools пачки | Отчётные и управляющие tools завершают ход; guard блокирует остальные tools пачки |
| `DefaultResourceLoader({ appendSystemPrompt, agentsFilesOverride, extensionFactories, … })` | Свой system prompt, фильтр `AGENTS.md`, guard-расширение без файлов на диске |
| `createAgentSession({ tools, excludeTools, customTools, model, thinkingLevel, modelRuntime, sessionManager, settingsManager })` | Allowlist tools по Policy, свои tools, модель по Policy |
| `resolveCliModel({ cliModel, modelRuntime })` разбирает `provider/id[:thinking]` | Разрешение `modelRef` из Policy |
| Extension-событие `tool_call` может вернуть `{ block: true, reason, terminate? }` | Guard путей и «после отчёта больше ничего» |
| Auto-compaction включена по умолчанию; события `compaction_start/end` | Повторная подача полного текста Policy supervisor-у после compaction |
| Пакет требует Node `>= 22.19.0` | `engines.node` у sdlc такой же |

Pi CLI и SDK внутри sdlc читают общий `~/.pi/agent` (`auth.json`, `settings.json`, `models-store.json`), поэтому их версии должны совпадать. `sdlc doctor` сравнивает версию SDK с `pi --version` и предупреждает о расхождении.

## 2. Интерфейс `AgentRuntime`

Интерфейс из раздела 12.3 исходной спецификации уточнён под реальное поведение Pi: `prompt` и `waitForIdle` объединены в `run`, добавлены операции, нужные для recovery и `doctor`.

```ts
export interface AgentRuntime {
  /** Разрешить ссылку на модель из Policy. Бросает ModelResolutionError. */
  resolveModel(ref: ModelRef): Promise<ResolvedModel>;

  /** Открыть существующую или создать новую сессию по явному пути. */
  openSession(spec: SessionSpec): Promise<AgentSessionHandle>;

  /** Прочитать файл сессии без запуска модели (recovery, status, read_agent_transcript). */
  inspectSessionFile(file: string): Promise<SessionFileInfo>;

  /** Самопроверка для doctor: SDK загружается, есть модели с авторизацией, временная in-memory сессия создаётся. */
  probe(): Promise<RuntimeProbeResult>;

  dispose(): Promise<void>;
}

export interface AgentSessionHandle {
  readonly sessionFile: string;
  readonly role: "agent" | "supervisor";
  /** Отправить prompt и дождаться конца хода. Не бросает при ошибке модели — возвращает outcome. */
  run(prompt: string, opts: { signal: AbortSignal }): Promise<RunOutcome>;
  /** Сообщение в идущий ход (steer). В MVP используется только для ручного вмешательства пользователя (post-MVP). */
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (e: RuntimeEvent) => void): () => void;
  dispose(): void;
}

export type SessionSpec = {
  file: string;                       // абсолютный путь .jsonl
  cwd: string;                        // projectRoot или workspacePath
  role: "agent" | "supervisor";
  model: ResolvedModel;
  systemPromptAppend: string;         // см. §6
  builtinTools: string[];             // итоговый allowlist встроенных tools Pi
  customTools: SdlcToolDefinition[];  // §4, §5 — независимы от Pi-типов
  piResources: { contextFiles: boolean; extensions: boolean; skills: boolean };
  guard: GuardConfig;                 // §3
};

export type RunOutcome =
  | { kind: "completed"; lastAssistantText: string | null; usage: Usage }
  | { kind: "terminated_by_tool"; toolName: string; usage: Usage }
  | { kind: "aborted"; usage: Usage }
  | { kind: "error"; message: string; usage: Usage };

export type SessionFileInfo = {
  exists: boolean;
  valid: boolean;
  parseError: string | null;
  promptIds: string[];                // извлечены из маркеров [sdlc:prompt id=…]
  lastEntry:
    | { kind: "assistant"; stopReason: string; text: string | null; danglingToolCalls: ToolCallSummary[] }
    | { kind: "user" | "toolResult" | "other" }
    | null;
  messageCount: number;
};
```

`SdlcToolDefinition` — собственный тип sdlc (имя, описание, JSON Schema параметров через `typebox`, `execute`). `PiAgentRuntime` конвертирует его в `ToolDefinition` Pi через `defineTool`. Бизнес-логика не импортирует ничего из `@earendil-works/*`; это проверяется правилом линтера (`no-restricted-imports` везде, кроме `src/agents/pi/`).

### 2.1. `PiAgentRuntime.openSession`

```ts
const modelRuntime = await ModelRuntime.create();           // один на процесс, в конструкторе runtime

const sessionManager = SessionManager.open(spec.file, path.dirname(spec.file), spec.cwd);
const settingsManager = SettingsManager.create(spec.cwd);  // глобальные + проектные настройки Pi
const loader = new DefaultResourceLoader({
  cwd: spec.cwd,
  agentDir: getAgentDir(),
  settingsManager,
  appendSystemPrompt: [spec.systemPromptAppend],
  agentsFilesOverride: spec.piResources.contextFiles ? undefined : () => ({ agentsFiles: [] }),
  extensionsOverride: spec.piResources.extensions ? undefined : (base) => ({ ...base, extensions: [] }),
  skillsOverride: spec.piResources.skills ? undefined : (base) => ({ skills: [], diagnostics: base.diagnostics }),
  extensionFactories: [{ name: "sdlc-guard", factory: createGuardExtension(spec.guard) }],
});
await loader.reload();

const { session } = await createAgentSession({
  cwd: spec.cwd,
  model: spec.model.model,
  thinkingLevel: spec.model.thinking,
  modelRuntime,
  tools: [...spec.builtinTools, ...spec.customTools.map((t) => t.name)],
  customTools: spec.customTools.map(toPiTool),
  resourceLoader: loader,
  sessionManager,
  settingsManager,
});
```

Точные сигнатуры overrides сверяются с `dist/core/resource-loader.d.ts` установленной версии; при расхождении меняется только этот файл.

### 2.2. Маппинг событий Pi → `RuntimeEvent`

| Событие Pi | `RuntimeEvent` |
|---|---|
| `message_update` + `text_delta` | `{ type: "text", delta }` |
| `message_update` + `thinking_delta` | `{ type: "thinking", delta }` (UI по умолчанию скрывает) |
| `tool_execution_start` | `{ type: "tool.started", toolCallId, toolName, argsPreview }` (`argsPreview` — после `redact`, ≤ 200 символов) |
| `tool_execution_end` | `{ type: "tool.finished", toolCallId, toolName, ok: !isError }` |
| `auto_retry_start` / `auto_retry_end` | `{ type: "retry", attempt, reason }` |
| `compaction_start` / `compaction_end` | `{ type: "compaction", phase }` |
| `turn_end` | `{ type: "usage", usage }` (накопительно) |
| `agent_end` | `{ type: "settled" }` |

`RuntimeEvent` превращается в `UiEvent` (раздел 20.4 исходной спецификации) в `ui/event-adapter.ts`, где добавляются task/stage/agent из state.

### 2.3. `SessionPool`

Хранит открытые `AgentSessionHandle` по `sessionFile` в пределах процесса. Supervisor-сессия задачи открывается один раз и живёт до выхода. Сессия агента закрывается (`dispose`) при переходе этапа или рестарте. При `continue` используется открытая сессия; если её нет (новый процесс), открывается заново через `SessionManager.open` — Pi восстанавливает историю из файла.

### 2.4. `FakeAgentRuntime`

Для unit- и integration-тестов. Сценарий — список «ходов» на каждый `sessionFile`:

```ts
const fake = new FakeAgentRuntime({
  "sessions/discover-001.jsonl": [
    turn.text("Изучаю задачу…"),
    turn.tool("ask_user", { question: "Какая БД?" }),        // вызывает настоящий execute
    turn.tool("report_result", { summary: "Готово", evidence: [{ kind: "file", value: "artifacts/plan.md" }] }),
  ],
  "sessions/supervisor.jsonl": [
    turn.tool("inspect_file", { path: ".sdlc/tasks/T-1/artifacts/plan.md" }),
    turn.tool("transition_stage", (ctx) => ({ expectedStateVersion: ctx.stateVersion, to: "execute", reason: "ok" })),
  ],
});
```

- `turn.*` вызывает **настоящие** `execute` зарегистрированных tools, поэтому тестируются валидация, `terminate` и запись state.
- Fake пишет собственный JSONL с маркерами `promptId`, чтобы recovery-тесты проверяли ту же логику `inspectSessionFile`.
- `turn.crash()` бросает исключение внутри хода; `turn.hang()` никогда не завершается (проверка таймаутов и `abort`).

<a id="guard-extension"></a>

## 3. Guard-расширение

Inline-расширение Pi, подключается к каждой сессии. Обрабатывает `tool_call` до исполнения.

```ts
type GuardConfig = {
  role: "agent" | "supervisor";
  projectRoot: string;
  taskDir: string;                    // .sdlc/tasks/<KEY>
  writableInsideSdlc: string[];       // для агента: [taskDir/artifacts]
  readableRoots: string[];            // для supervisor: [projectRoot]
  isReported: () => boolean;          // для агента: отчёт уже записан в этом prompt-цикле
};
```

Правила:

| Роль | Tool | Правило |
|---|---|---|
| agent | любой, после отчёта | `{ block: true, reason: "Run already reported; end your turn.", terminate: true }` |
| agent | `write`, `edit` | Путь нормализуется (`path.resolve(cwd, p)` + `fs.realpath` существующего префикса). Внутри `<projectRoot>/.sdlc/`, но не внутри `writableInsideSdlc` → block |
| agent | `bash` | Не блокируется. Подмена state обнаруживается по hash ([02-storage.md §7.5](02-storage.md#75-обнаружение-подмены-state)) |
| supervisor | `read`, `grep`, `find`, `ls` | Путь после нормализации обязан быть внутри `readableRoots` |
| supervisor | всё прочее встроенное | Не выдаётся вовсе (allowlist, §5.1) |

Guard защищает от ошибок модели, а не от злонамеренного агента: дочерний агент с `bash` остаётся полноценным процессом пользователя. Это граница MVP; она прописана в разделе «Безопасность» [README](README.md).

## 4. Инструменты дочернего агента

### 4.1. Набор

- Встроенные tools Pi: `agents.<id>.tools`, если задан; иначе default Pi (`read`, `bash`, `edit`, `write`) плюс `grep`, `find`, `ls`. Затем вычитается `excludeTools`.
- Свои: `report_result`, `report_blocker`; `ask_user`, если `askUser ≠ false`.
- Инструментов изменения state и этапа нет (критерий 8).

### 4.2. `report_result`

Схема — из раздела 13 исходной спецификации, плюс необязательное поле `externalWait`:

```ts
type ReportResultInput = {
  summary: string;
  evidence?: Array<{ kind: string; value: string; description?: string }>;
  artifacts?: Array<{ kind: string; pathOrUrl: string; description?: string }>;
  notes?: string[];
  externalWait?: {               // работа сделана, но этап ждёт внешнего события
    waitingFor: string;          // «ответ ревьюера в треде <url>», «pipeline <url>»
    checkAgainInMinutes?: number;
  };
};
```

`externalWait` — подсказка supervisor-у, а не команда: решение о `schedule_recheck` и задержке принимает он ([03-engine.md §12](03-engine.md#12-отложенная-перепроверка)). Поле есть в схеме всегда: набор tools и system prompt фиксируются при создании Pi-сессии, а при `session: reuse` сессия переходит на следующий этап. Когда ожидание уместно, агенту объясняет prompt этапа (§7.2).

Поведение `execute`:

1. Если отчёт в этом prompt-цикле уже есть → ошибка `ALREADY_REPORTED`.
2. Нормализовать `artifacts[].pathOrUrl`: относительные пути — от `cwd`, пути вне project root отклоняются ошибкой (агент исправит).
3. Записать `runs/<runId>.json.report` и выполнить `commit` с `agent.reported`.
4. Вернуть `{ content: "Отчёт записан. Supervisor проверит его независимо. Заверши ход.", terminate: true }`.

### 4.3. `report_blocker`

Аналогично, `report.kind = "blocker"`. Флаг `requiresHuman` — подсказка supervisor-у, а не команда: вопрос человеку задаёт supervisor через `ask_human`.

### 4.4. `ask_user`

```ts
type AskUserInput = {
  question: string;
  context?: string;
  options?: string[];      // 2..10
  allowFreeText?: boolean; // default true
  attachments?: string[];  // пути внутри project root
};
type AskUserOutput = { answer: string; selectedOption: string | null; responseRef: string }; // responseRef = "human:<eventId>"
```

Семантика — [03-engine.md §4.4](03-engine.md#44-ask_user-внутри-run). В не-TTY окружении tool возвращает ошибку `HUMAN_UNAVAILABLE`: «пользователь недоступен в неинтерактивном режиме; завершите работу через report_blocker с requiresHuman=true». Агент не зависает.

## 5. Инструменты supervisor

### 5.1. Набор

- Встроенные Pi: только `read`, `grep`, `find`, `ls`, под guard путей. `bash`, `edit`, `write` не выдаются.
- Инструменты расширений не выдаются, даже при `extensions: inherit`: в `createAgentSession` передаётся точный allowlist `tools`. Расширения нужны supervisor-у только как провайдеры моделей (см. [01-policy.md §2.7](01-policy.md#27-piresourcesextensions-и-провайдеры-моделей)).
- Свои — ниже. Все чтения возвращают текст, обрезанный до лимита, с явной пометкой об обрезке.

### 5.2. Чтение и проверка

| Tool | Параметры | Возвращает |
|---|---|---|
| `read_policy` | `hash?` | Текст Policy (текущей или снимка из `.sdlc/policies/`) и hash |
| `read_state` | — | `state.json` (с `redact`) |
| `read_task_description` | — | `task.md` |
| `list_artifacts` | — | Файлы `artifacts/`: путь, размер, mtime, sha256 |
| `read_artifact` | `path`, `offset?`, `limit?` | Содержимое и sha256. Заменяет `read_plan` исходной спецификации |
| `read_agent_result` | `runId?` (default — `currentRun`) | `runs/<runId>.json`: вход, отчёт, settle reason, ошибка, хвост последнего ответа |
| `read_agent_transcript` | `runId?`, `tail?` (default 30 сообщений, max 200) | Сжатая лента сессии агента: текст ассистента, tool calls (имя + args preview) и их статус. Позволяет проверить, что агент *действительно* запускал тесты, а не только заявил об этом |
| `read_recent_events` | `limit?` (default 20, max 200), `types?: string[]`, `sinceEventId?` | События журнала |
| `inspect_git_status` | — | Ветка, HEAD sha, upstream и ahead/behind, список изменённых/неотслеживаемых файлов (без `.sdlc/`), наличие незавершённого merge/rebase |
| `inspect_git_commit` | `ref` | Существует ли, полный sha, subject, author, date, `--stat`, входит ли в текущую ветку (`merge-base --is-ancestor`) |
| `inspect_git_diff` | `base?`, `head?`, `paths?`, `stat?: boolean` | Diff или stat, ≤ 200 KB |
| `inspect_file` | `path`, `startLine?`, `endLine?` | Содержимое и sha256 файла внутри project root |
| `list_files` | `path?`, `glob?`, `maxEntries?` (≤ 2000) | Список с учётом `.gitignore` |
| `record_note` | `text` | Пишет `supervisor.note`. **Не** управляющий и не завершает цикл (в исходной спецификации он был в списке управляющих — противоречие с «ровно одно управляющее действие» снято) |

Git-инструменты вызывают `git` через `execFile` (без shell), с `cwd = projectRoot`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` и таймаутом 30 с. Аргумент `ref` валидируется: `^[A-Za-z0-9._/@^~{}-]{1,200}$` и не начинается с `-`.

### 5.3. Управляющие

Схемы (все с `expectedStateVersion: number`):

```ts
type TransitionStageInput   = { expectedStateVersion: number; to: string; reason: string; evidenceRefs?: string[]; handoff?: string };
type ContinueAgentInput     = { expectedStateVersion: number; message: string };
type RestartAgentInput      = { expectedStateVersion: number; reason: string; message: string };
type AskHumanInput          = { expectedStateVersion: number; question: string; context?: string; options?: string[]; allowFreeText?: boolean; attachments?: string[] };
type BlockTaskInput         = { expectedStateVersion: number; reason: string; resolutionHint: string };
type CancelTaskInput        = { expectedStateVersion: number; reason: string; humanResponseRef: string };
type ScheduleRecheckInput   = { expectedStateVersion: number; delayMinutes: number; waitingFor: string; message: string; evidenceRefs?: string[] };
```

`schedule_recheck` — отложенный `continue_current_agent`: через `delayMinutes` CLI сам продолжит агента этапа с текстом `message` ([03-engine.md §12](03-engine.md#12-отложенная-перепроверка)). `waitingFor` описывает ожидаемое событие для человека (меню, `status`) и для следующего цикла supervisor-а. Tool регистрируется всегда, а на этапе без `recheck` отклоняется с `RECHECK_NOT_ALLOWED`. Так набор tools не меняется от этапа к этапу, и сессия supervisor-а остаётся одной.

`handoff` в `transition_stage` — новое поле: инструкции supervisor-а агенту следующего этапа (например, «ревьюер нашёл 3 замечания, они в `artifacts/review-002.md`»). Он попадает в initial prompt нового run.

Валидация и эффекты — [03-engine.md §5.4, §7.2](03-engine.md#control-actions).

### 5.4. Запуск команд

У supervisor-а нет tools, которые что-либо исполняют, кроме фиксированных read-only вызовов `git` внутри git-инструментов (§5.2). `run_verification_command` из исходной спецификации не реализуется ([01-policy.md §2.6](01-policy.md#26-supervisor-не-запускает-команды)). Проверку, которая требует запуска, supervisor поручает агенту этапа и затем читает его транскрипт (`read_agent_transcript`): там видны сама команда, её вывод и код выхода.

<a id="evidence-refs"></a>

## 6. Evidence refs

| Формат | Разрешимость (проверяет CLI) |
|---|---|
| `git:<sha-or-ref>` | `git cat-file -e <ref>^{commit}` |
| `file:<path>` или `file:<path>@<sha256-prefix>` | файл существует внутри project root; если указан hash — префикс совпадает с текущим sha256 |
| `artifact:<path>` | то же внутри `artifacts/` |
| `human:<eventId>` | событие `human.responded` этой задачи |
| `event:<eventId>` | событие этой задачи |
| `run:<runId>` | существует `runs/<runId>.json` |
| `url:<https-url>` | только синтаксис (CLI не ходит в сеть) |
| `note:<text>` | всегда разрешима; явная пометка «доказательство — только слова» |

Неизвестная схема → `EVIDENCE_UNRESOLVED`. Проверки технические и дешёвые. Достаточность доказательств по-прежнему оценивает supervisor.

<a id="prompts"></a>

## 7. Промпты

Шаблоны живут в `src/agents/prompts/*.ts` как функции от данных. Ни один шаблон не содержит имён этапов, ролей или правил процесса — только подстановки из Policy и state.

Язык — русский, как интерфейс и Policy. На русском всё, что читает модель: system prompt append, prompts, описания tools и их параметров, тексты результатов и ошибок tools, follow-up и служебные сообщения CLI. Латиницей остаются идентификаторы: имена tools и полей, коды ошибок, ссылки evidence, маркер `[sdlc:prompt …]`. Тексты Policy подставляются как есть.

### 7.1. System prompt append: дочерний агент

```text
Ты дочерний агент в SDLC-процессе, которым управляет CLI `sdlc`.

- Ты выполняешь только текущий этап. Менять этап ты не можешь: отдельный supervisor оценивает
  твою работу по условиям выхода из этапа и решает, что делать дальше.
- Твой отчёт — заявление, а не доказательство. Supervisor проверит состояние git, файлы и твой
  транскрипт. Сообщай только о том, что действительно сделал и проверил.
- Завершай каждый ход вызовом ровно одного из инструментов: report_result (работа этапа сделана
  или сделана настолько, насколько возможно) или report_blocker (продолжить невозможно).
  Не завершай ход обычным текстом.
- Спрашивай пользователя через ask_user, когда решение действительно за ним. Не проси пользователя
  делать работу, которую можешь сделать сам.
- Документы задачи лежат в {taskDir}. Внутри .sdlc писать можно только в {taskDir}/artifacts/.
- Строки, начинающиеся с "[sdlc:prompt", — служебные маркеры. Не обращай на них внимания.
```

### 7.2. Initial prompt агента

```text
[sdlc:prompt id={promptId} kind=initial run={runId}]

# Задача {key}: {title}

{task.md body}

# Текущий этап: {stage.title} ({stageId})
{stage.description}
{stage.instructions}

# Твоя роль: {agent.title}
{agent.instructions}

# Как оценивается этап
Supervisor продвинет задачу, только когда одно из условий выполнено и подтверждено:
- → {to.title}: {when}            [нужны доказательства] [нужен явный ответ пользователя]
…

# Передача от supervisor
{handoff | "Нет."}

{если у этапа есть recheck}
# Ожидание внешних событий
Если этап зависит от внешнего процесса, который ещё не завершился (ответ, pipeline, сборка),
не жди его в цикле и не засыпай дольше чем на несколько минут. Сообщи текущее состояние через
report_result и заполни externalWait. Supervisor может запланировать перепроверку, и тебя
продолжат в этой же сессии.

# Предыдущие результаты агентов по задаче (сначала новые, до 5)
- {agentId}, попытка {NNN}, этап «{stage.title}», {settleReason}: {summary}
  артефакты: {paths}
…

# Артефакты задачи ({taskDir}/artifacts)
{list with size and mtime | "Пусто."}

Когда закончишь, вызови report_result. Если продолжить невозможно, вызови report_blocker.
```

### 7.3. Continue и restart

```text
[sdlc:prompt id={promptId} kind=continue run={runId}]

Supervisor проверил твой предыдущий отчёт и пока не продвигает задачу.

Сообщение supervisor:
{message}

Продолжай текущий этап «{stage.title}». Когда закончишь, снова вызови report_result.
```

Restart — initial prompt новой сессии, в который добавлен раздел:

```text
# Почему это новый запуск
Предыдущую попытку ({previousRunId}) supervisor остановил: {reason}
Указания supervisor: {message}
Прежде чем действовать, проверь фактическое состояние репозитория: прошлые попытки могли
оставить незавершённые изменения.
```

Recovery (`kind = recovery`): continue-шаблон с сообщением CLI вместо сообщения supervisor-а, например: «Предыдущий запрос завершился ошибкой провайдера. Проверь, что уже сделано, и продолжай.»

Recheck (`kind = recheck`), в ту же сессию:

```text
[sdlc:prompt id={promptId} kind=recheck run={runId}]

Перепроверка №{number} из {maxCount} на этапе «{stage.title}». Твой последний отчёт был
{minutesSinceReport} мин назад.
Ожидается: {waitingFor}

Сообщение supervisor:
{message}

Проверь текущее состояние внешнего процесса. Если он ещё не завершился, снова вызови
report_result с externalWait. Когда закончишь, вызови report_result.
```

### 7.4. System prompt append: supervisor

```text
Ты supervisor SDLC-процесса, которым управляет CLI `sdlc`. Политика процесса ниже — единственный
источник правды об этапах, переходах и правилах.

- Отчёты дочерних агентов — заявления. Прежде чем на них опираться, проверь их инструментами
  инспекции. Текстовый отчёт сам по себе никогда не доказывает коммит, прохождение тестов,
  выкладку или согласие пользователя.
- Ты ничего не запускаешь сам. Если для проверки нужен запуск (тесты, сборка, запрос к внешней
  системе), поручи его агенту этапа через continue_current_agent и проверь результат по его
  транскрипту (read_agent_transcript).
- Согласие и ответы пользователя подтверждаются только событиями human.responded
  (ссылки human:<eventId>).
- Каждый цикл оценки завершается ровно одним вызовом управляющего инструмента:
  transition_stage, continue_current_agent, restart_current_agent, ask_human, schedule_recheck,
  block_task, cancel_task.
- Если этап ждёт внешнего события, которое ещё не произошло, используй schedule_recheck, а не проси
  пользователя следить за ним. Он доступен только на этапах, где в промпте цикла указан бюджет
  перепроверок.
- Возможны только переходы, перечисленные в промпте цикла. Используй указанный там
  expectedStateVersion.
- Конкретная обратная связь через continue_current_agent предпочтительнее перезапуска.
- Строки, начинающиеся с "[sdlc:prompt", — служебные маркеры. Не обращай на них внимания.

## Инструкции политики
{supervisor.instructions}

## Правила политики (Markdown-часть SDLC.md)
{policy.body}
```

Полный front matter в system prompt не включается: структура этапов даётся в каждом цикле, а целиком Policy доступна через `read_policy`.

<a id="supervisor-evaluation-prompt"></a>

### 7.5. Evaluation prompt

```text
[sdlc:prompt id={promptId} kind=evaluate cycle={cycle}]

# Цикл {cycle} · задача {key}: {title}
expectedStateVersion: {version}
Сейчас: {локальное время со смещением UTC, день недели}
Политика: {hash} {"(изменилась с прошлого цикла — полный текст ниже)" | "(без изменений)"}

# Текущий этап: {stage.title} ({stageId})
Вход в этап: {stageEnteredAt}; циклов на этапе: {stageCycles}; перезапусков подряд: {consecutiveRestarts}/{max}
{если есть recheck} Перепроверки: использовано {stageRechecks.count} из {maxCount}, всего ждали {waitedMinutes} мин; допустимая задержка {minMinutes}..{maxMinutes} мин
{иначе} Перепроверки на этом этапе недоступны
{stage.instructions}

# Допустимые переходы
1. → {toId} «{to.title}»{terminal ? " [терминальный]" : ""}
   условие: {when}
   guards: доказательства {обязательны|необязательны}, ответ пользователя {обязателен|необязателен}
…

# Причина цикла: {trigger description}
{для agent_settled}
Агент {agentId} (попытка {NNN}, run {runId}) завершил работу: {settleReason}.
## Отчёт агента (заявление, не доказательство)
{report rendered as Markdown | "Структурированного отчёта нет. Последний текст ассистента: …"}

{для recheck_settled}
Агент {agentId} выполнил перепроверку после ожидания {waitedMinutes} мин (перепроверка №{number}). Ожидается: {waitingFor}
## Отчёт агента (заявление, не доказательство)
{report}

{для human_responded}
Пользователь ответил на вопрос {requestId}: «{question}»
Ответ: {answer}  (ссылка human:{eventId})

{для recovered}
Процесс CLI остановился посреди хода агента. Незавершённый вызов инструмента: {toolName} {argsPreview}.
Внешние побочные эффекты могли произойти, а могли и нет. Прежде чем решать, проверь фактическое состояние.

# Последние события
{последние 10 событий, по одному на строку}

{если Policy изменилась: "# Полный текст политики (SDLC.md)\n{raw}"}

Проверь факты и заверши цикл ровно одним вызовом управляющего инструмента.
```

<a id="redaction"></a>

## 8. Redaction

`redact(value)` применяется к: payload событий, `argsPreview` в UI и логах, ленте `read_agent_transcript`, `read_state`.

1. Ключи объектов, совпадающие с `/(token|secret|password|passwd|api[_-]?key|authorization|cookie|private[_-]?key)/i` → значение `"[REDACTED]"`.
2. Строки проходят regex-набор известных форматов: `sk-…`, `ghp_…`/`github_pat_…`, `glpat-…`, `xox[abpr]-…`, `AKIA…`, JWT (`eyJ…\.eyJ…\.…`), PEM-блоки `-----BEGIN … PRIVATE KEY-----`, `Bearer <token>`, URL с `user:pass@`.
3. Длина строк в событиях ограничена 16 KB (обрезка с пометкой).

Переменные окружения CLI не читает и в `.sdlc` не пишет (раздел 24 исходной спецификации).
