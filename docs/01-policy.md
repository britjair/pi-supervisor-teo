# 01. Policy: формат и валидация процессов `~/.pi/teo/<процесс>.md`

Детализирует разделы 7–8 [SDLC_CLI_SPEC.md](../SDLC_CLI_SPEC.md).

## 1. Загрузка

### 1.1. Каталог процессов

```ts
const processesDir = path.join(os.homedir(), ".pi", "teo");   // ~/.pi/teo/<процесс>.md
```

Каждый файл `<процесс>.md` — отдельная Policy (D32). Имя процесса — имя файла без `.md`: строчные латинские буквы, цифры, `-` и `_`, до 64 символов (`car-selection`, `dev`). Файлы с другим именем пропускаются, `teo doctor` показывает их предупреждением.

- Задача при создании выбирает процесс (`teo new --process <имя>`, меню в терминале; единственный валидный процесс выбирается сам) и запоминает его в `state.process`. Дальше она всегда идёт по файлу своего процесса.
- Preflight выполняется для каждого процесса отдельно. Нет ни одного процесса — `POLICY_NO_PROCESSES`; нет ни одного валидного — ошибка первого процесса. В обоих случаях exit `2` до любых действий.
- Невалидный или удалённый процесс при наличии валидных не мешает другим задачам (D41). Сводные команды помечают задачи такого процесса ⚠. Команды над такой задачей (`resume`, `status KEY`, `history KEY`, `cancel`, `recover`) и `new --process <он>` завершаются с exit `2`.

Переопределений через флаги нет. Тесты подменяют `HOME` (см. [06-implementation.md](06-implementation.md#43-e2e-smoke-с-pi)).

### 1.2. Последовательность preflight

Каждый шаг при ошибке возвращает `PolicyError` с кодом; дальше не выполняется ничего.

| # | Проверка | Код ошибки |
|---|---|---|
| 0 | В каталоге процессов есть хотя бы один `<процесс>.md` (только для preflight всех процессов) | `POLICY_NO_PROCESSES` |
| 1 | `fs.stat(path)` успешен | `POLICY_NOT_FOUND` |
| 2 | `stat.isFile()` (симлинк на файл допустим, `stat`, не `lstat`) | `POLICY_NOT_FILE` |
| 3 | `fs.readFile` успешен | `POLICY_UNREADABLE` |
| 4 | Содержимое после `trim()` не пустое | `POLICY_EMPTY` |
| 5 | Файл валиден как UTF-8 (`new TextDecoder("utf-8", { fatal: true })`) | `POLICY_ENCODING` |
| 6 | Есть front matter (см. 1.3) | `POLICY_NO_FRONT_MATTER` |
| 7 | YAML парсится, корень — mapping | `POLICY_YAML` |
| 8 | `schema` присутствует и поддерживается | `POLICY_UNSUPPORTED_SCHEMA` |
| 9 | Zod-схема (раздел 2) | `POLICY_SCHEMA` |
| 10 | Ссылочная и графовая валидация (раздел 3) | `POLICY_GRAPH` |

Шаги 9–10 собирают **все** ошибки, а не первую, чтобы автор политики исправил файл за один проход.

Результат успешной загрузки:

```ts
type LoadedPolicy = {
  path: string;
  raw: string;              // исходный текст целиком
  hash: `sha256:${string}`; // от байтов файла, см. 1.4
  schema: "teo/v1";
  spec: PolicySpec;         // нормализованный front matter с применёнными default
  body: string;             // Markdown после front matter
  warnings: PolicyWarning[];
};
```

### 1.3. Выделение front matter

`gray-matter` не используем: он кэширует результат по содержимому и скрывает номера строк. Собственный сплиттер:

1. Убрать UTF-8 BOM, если есть.
2. Первая строка должна быть ровно `---` (допускаются хвостовые пробелы и `\r`).
3. Закрывающий разделитель — первая следующая строка, равная `---` или `...`.
4. Всё между ними — YAML; всё после — `body`.
5. Номер первой строки YAML запоминается, чтобы смещать номера строк в ошибках.

YAML разбирается пакетом `yaml` (`parseDocument`, `uniqueKeys: true`, `prettyErrors: true`). Дубликат ключа — ошибка `POLICY_YAML` с номером строки. Так выполняется требование «идентификаторы уникальны» для этапов и агентов: это ключи mapping.

### 1.4. Hash

```ts
hash = "sha256:" + createHash("sha256").update(rawBytes).digest("hex");
```

Считается от исходных байтов файла без нормализации переводов строк и пробелов. Любое изменение, включая Markdown-часть, считается изменением политики.

## 2. Схема `teo/v1`

### 2.1. Полная структура

```yaml
schema: teo/v1                     # обязательно, ровно эта строка

workflow:
  initialStage: <stageId>           # обязательно
  stages:                           # обязательно, непустой mapping
    <stageId>:
      title: <string>               # обязательно для любого этапа
      description: <string>         # опционально, для UI и supervisor

      # только для нетерминального этапа:
      agent: <agentId>              # обязательно
      instructions: <string>        # опционально, цель этапа для агента и supervisor
      session: fresh | reuse        # опционально, default fresh (см. 2.4)
      transitions:                  # обязательно, непустой список
        - to: <stageId>
          when: <string>            # обязательно, оценивает supervisor
          guards:                   # опционально, структурные требования (см. 2.5)
            evidence: required | optional
            humanResponse: required | optional
      recheck:                      # опционально; без него schedule_recheck на этапе запрещён (см. 2.8)
        minMinutes: <number>        # default 1, 1..1440
        maxMinutes: <number>        # default 120, 1..1440, не меньше minMinutes
        maxCount: <int>             # default 20, 1..1000: ожиданий за один вход в этап

      # только для терминального этапа:
      terminal: true

agents:                             # обязательно, непустой mapping
  <agentId>:
    title: <string>                 # опционально, для UI; default = agentId
    model: <modelRef>               # опционально, default "default" (см. 2.3)
    thinking: off|minimal|low|medium|high|xhigh|max   # опционально
    instructions: <string>          # обязательно
    tools: [<string>, ...]          # опционально, allowlist инструментов Pi (см. 04-agents)
    excludeTools: [<string>, ...]   # опционально
    askUser: true | false           # опционально, default true: доступен ли tool ask_user
    piResources:                    # опционально, что подгружать из окружения Pi
      contextFiles: inherit | none  # AGENTS.md; default inherit
      extensions: inherit | none    # default inherit
      skills: inherit | none        # default inherit
    timeoutMinutes: <number>        # опционально, жёсткий лимит одного прогона

supervisor:                         # обязательно
  model: <modelRef>                 # опционально, default "default"
  thinking: <level>                 # опционально
  instructions: <string>            # обязательно
  piResources:                      # опционально
    contextFiles: inherit | none    # default none
    extensions: inherit | none      # default inherit (см. 2.7)
    skills: inherit | none          # default none

runtime:                            # опционально целиком
  policyChangeMode: confirm | latest | pinned       # default confirm
  maxConsecutiveRestarts: <int>                     # default 3, 0..100
  supervisorProtocolRetries: <int>                  # default 1, 0..10
  maxInvalidDecisionsPerCycle: <int>                # default 3, 1..20
  maxCyclesPerStage: <int> | null                   # default null (без лимита), 1..1000
  supervisorTimeoutMinutes: <number>                # default 30, 1..1440
  technicalRetries: <int>                           # default 2, 0..10
  technicalRetryDelaySeconds: <int>                 # default 15, 1..600
```

Ключи, начинающиеся с `x-`, разрешены на любом уровне и игнорируются: это место для пользовательских метаданных. Любой другой неизвестный ключ — ошибка `POLICY_SCHEMA` (Zod `.strict()`), чтобы опечатки вроде `transition:` не проходили молча.

### 2.2. Идентификаторы и строки

| Что | Правило |
|---|---|
| `stageId`, `agentId` | `^[A-Za-z][A-Za-z0-9_-]{0,63}$` |
| `agentId` не может быть `supervisor` | зарезервировано под имя сессии `supervisor.jsonl` |
| Обязательные строки (`title`, `when`, `instructions`) | после `trim()` длина ≥ 1 |
| `title` | ≤ 120 символов, без переводов строк |

Ограничение на `agentId` нужно, потому что он входит в имя файла сессии `<agentId>-<NNN>.jsonl`.

### 2.3. `modelRef`

| Значение | Смысл |
|---|---|
| `default` | Модель по умолчанию из настроек Pi (`~/.pi/agent/settings.json`) |
| `<provider>/<modelId>` | Конкретная модель, например `anthropic/claude-opus-5-5` |
| `<provider>/<modelId>:<thinking>` | То же с уровнем thinking (синтаксис Pi CLI) |

Разрешение выполняет `resolveCliModel` из Pi SDK. Если указаны и суффикс `:<thinking>`, и поле `thinking`, это ошибка `POLICY_SCHEMA`.

Существование модели и наличие авторизации проверяются не при валидации Policy, а при старте workflow и в `teo doctor`: валидация Policy не должна зависеть от сети и `auth.json`. Неизвестная модель при старте даёт ошибку конфигурации с exit code `2`.

### 2.4. `session: fresh | reuse`

Определяет, какая Pi-сессия используется при **входе** в этап:

- `fresh` — новый agent run с новой сессией `<agentId>-<NNN+1>.jsonl`;
- `reuse` — если у этого `agentId` в задаче уже есть сессия, CLI продолжает самую позднюю (новый run, тот же `sessionFile`). Если сессии нет, ведёт себя как `fresh`.

Пример: этапы «сбор требований» и «ожидание подтверждения плана» обслуживает один агент; `reuse` на втором этапе сохраняет весь контекст диалога. Код при этом ничего не знает о смысле этапов.

`restart_current_agent` всегда создаёт новую сессию независимо от `session`.

### 2.5. Guards переходов

Guards — структурные требования к вызову `transition_stage`. CLI проверяет их механически; смысл `when` по-прежнему оценивает supervisor.

| Guard | Проверка CLI при `transition_stage` |
|---|---|
| `evidence: required` | `evidenceRefs` непуст, и каждая ссылка разрешима (см. [04-agents.md](04-agents.md#evidence-refs)) |
| `humanResponse: required` | Среди `evidenceRefs` есть `human:<eventId>`, это событие `human.responded` текущей задачи, и оно записано **после** входа в текущий этап |

`humanResponse: required` даёт политике способ сказать «переход только после явного ответа человека», не зашивая approval в код. Это закрывает слабое место исходной спецификации: условие «пользователь явно одобрил план» больше не держится только на честности модели.

Default обоих guards — `optional`.

### 2.6. Supervisor не запускает команды

Секции `supervisor.verification` из исходной спецификации нет: supervisor ничего не исполняет сам. Он только читает (git, файлы проекта, артефакты, журнал, транскрипты агентов) и управляет дочерними агентами через управляющие tools. Если для проверки нужно что-то запустить (тесты, сборку, запрос к GitLab), supervisor поручает это агенту этапа через `continue_current_agent` и проверяет результат по транскрипту его сессии.

Ключ `verification` в Policy — ошибка `POLICY_SCHEMA`, как любой неизвестный ключ.

### 2.7. `piResources.extensions` и провайдеры моделей

Провайдеры моделей в Pi часто подключаются как расширения: например, `claude-code` и `antigravity` регистрируются через `pi.registerProvider()` из пакетов в `settings.json`. Значение `extensions: none` выключает и их, и модели таких провайдеров перестают разрешаться.

Поэтому:

- по умолчанию `extensions: inherit` и у агентов, и у supervisor;
- модель разрешается **после** загрузки расширений сессии. Если при `extensions: none` модель не находится, ошибка `MODEL_UNAVAILABLE` прямо подсказывает: «модель может предоставляться расширением; уберите `extensions: none`»;
- `teo doctor` для каждого `modelRef` показывает, кто его предоставляет: встроенный провайдер или расширение (пакет).

Инструменты, которые расширения регистрируют для supervisor-а, отсекаются allowlist-ом инструментов (см. [04-agents.md §5.1](04-agents.md#51-набор)). Поэтому `inherit` не расширяет полномочия supervisor-а.

### 2.8. `recheck`: отложенная перепроверка

Некоторые этапы ждут внешнего события: ответа ревьюера, завершения CI-pipeline, сборки. Агент не должен ждать его в цикле внутри run, а человек не должен вручную будить задачу. Блок `recheck` разрешает supervisor-у на этом этапе вызвать `schedule_recheck`. Через заданное время CLI сам продолжит агента этапа с поручением проверить ещё раз ([03-engine.md §12](03-engine.md#12-отложенная-перепроверка)).

```yaml
code_review:
  agent: review_coordinator
  recheck:
    minMinutes: 3
    maxMinutes: 15
    maxCount: 12
```

| Поле | Смысл |
|---|---|
| `minMinutes`, `maxMinutes` | Допустимый диапазон `delayMinutes` в одном `schedule_recheck`. Конкретную задержку выбирает supervisor по правилам Markdown-части Policy |
| `maxCount` | Сколько ожиданий допускается за один вход в этап. Счётчик сбрасывается при `transition_stage`. При исчерпании `schedule_recheck` отклоняется, и supervisor должен выбрать `ask_human` или `block_task` |

`recheck: {}` включает перепроверку со значениями по умолчанию. Если блока нет, `schedule_recheck` на этапе отклоняется с `RECHECK_NOT_ALLOWED`: ожидание включается явно и только там, где оно имеет смысл.

`minMinutes > maxMinutes` — ошибка `POLICY_SCHEMA`.

Ожидание идёт, только пока запущен `teo`: фонового процесса нет (раздел 4.2 исходной спецификации). Если процесс остановлен, проверка произойдёт при следующем `teo resume`, сразу, если срок уже прошёл.

## 3. Ссылочная и графовая валидация

Выполняется после успешного Zod-разбора. Ошибки (`POLICY_GRAPH`) блокируют запуск, предупреждения выводятся и не блокируют.

### 3.1. Ошибки

| Код | Условие |
|---|---|
| `INITIAL_STAGE_MISSING` | `initialStage` отсутствует в `stages` |
| `INITIAL_STAGE_TERMINAL` | `initialStage` терминальный: workflow не может начаться |
| `TRANSITION_TARGET_MISSING` | `transitions[i].to` указывает на несуществующий этап |
| `TRANSITION_DUPLICATE_TARGET` | у одного этапа два перехода с одинаковым `to` |
| `STAGE_AGENT_MISSING` | `stage.agent` отсутствует в `agents` |
| `TERMINAL_HAS_TRANSITIONS` | `terminal: true` и непустой `transitions` |
| `TERMINAL_HAS_AGENT` | `terminal: true` и задан `agent`, `instructions`, `session` или `recheck` |
| `NONTERMINAL_NO_AGENT` | нетерминальный этап без `agent` |
| `NONTERMINAL_NO_TRANSITIONS` | нетерминальный этап без `transitions` или с пустым списком |
| `NO_REACHABLE_TERMINAL` | из `initialStage` (BFS по `transitions`) не достижим ни один терминальный этап |
| `TERMINAL_FALSE` | `terminal: false` указан явно (поле допускает только `true`, чтобы не было двух способов выразить одно) |

`TRANSITION_DUPLICATE_TARGET` добавлен сверх исходной спецификации: переходы идентифицируются по `to`, и два перехода с одной целью сделали бы ссылку `transition_stage(to)` неоднозначной.

Переход этапа в самого себя разрешён. Он означает «новый вход в этап»: новый agent run по правилу `session`, новый `stageEntryEventId`.

### 3.2. Предупреждения

| Код | Условие |
|---|---|
| `STAGE_UNREACHABLE` | этап не достижим из `initialStage` |
| `STAGE_DEAD_END` | из достижимого нетерминального этапа не достижим ни один терминальный (бесконечный цикл без выхода) |
| `AGENT_UNUSED` | агент не используется ни одним этапом |
| `BODY_EMPTY` | Markdown-часть пустая: supervisor получит только front matter |

### 3.3. Формат вывода ошибок

```text
Process configuration error

File: /Users/user/.pi/teo/dev.md
Policy is invalid (3 problems):

  ✗ workflow.stages.review.transitions[1].to (line 48)
    Stage "qa_redy" does not exist. Known stages: requirements, implementation, review, fixing, qa_ready

  ✗ workflow.stages.fixing.agent (line 55)
    Agent "fixr" is not defined in agents.

  ✗ workflow
    No terminal stage is reachable from initialStage "requirements".

Nothing was started and .teo was not modified.
Fix ~/.pi/teo/dev.md and restart the command. Check it with: teo doctor
```

Exit code — `2`. Номера строк берутся из YAML-узлов (`yaml` хранит `range`), для графовых ошибок — из узла этапа.

## 4. Изменение Policy между запусками

### 4.1. Когда проверяется

1. При открытии задачи (создание, продолжение, `resume`).
2. В начале каждой итерации workflow loop: Policy перечитывается и валидируется заново (раздел 16 исходной спецификации).

Сравнивается `loaded.hash` с `state.policyHash`.

### 4.2. Снимки политики

При первом использовании нового hash CLI сохраняет копию текста:

```text
.teo/policies/<sha256-hex>.md
```

Снимки нужны, чтобы:

- в режиме `confirm` показать структурный diff между старой и новой версией;
- после рестарта восстановить, по какой политике задача шла (`read_policy` с параметром `hash`);
- разбирать инциденты.

### 4.3. Поведение по режимам

`policyChangeMode` берётся из **новой** версии Policy: пользователь только что сам её отредактировал, и его текущее намерение важнее старого.

| Режим | Интерактивный запуск | Неинтерактивный запуск |
|---|---|---|
| `confirm` | Показать diff и спросить «Продолжить по новой политике?» Да → применить. Нет → выйти без изменений (exit 0) | Не применять, остановиться с exit code `5` и подсказкой |
| `latest` | Применить автоматически | Применить автоматически |
| `pinned` | Отказать, предложить `teo recover <KEY> --accept-policy` | То же, exit code `5` |

Применение — одна атомарная запись state: `policyHash`, `policySchema`, событие `policy.changed { fromHash, toHash, mode, diff }`, а также `phase = supervisor_pending` с `trigger = policy_changed`, если в момент изменения не идёт agent run. Так supervisor увидит новую политику до следующего управляющего решения.

Если изменение обнаружено между итерациями, пока жив дочерний агент (`phase = agent_running`), агент не прерывается: проверка выполняется после его settle, до запуска supervisor.

### 4.4. Структурный diff

Показывается пользователю и кладётся в `policy.changed.payload.diff`:

```text
Policy changed: sha256:3f1a…c2 → sha256:9b7e…41

  + stage  security_review "Security review"
  ~ stage  review: transition added → security_review
  ~ agent  reviewer: instructions changed
  ~ runtime.maxConsecutiveRestarts: 3 → 5
  ~ markdown body changed (+12 / −3 lines)

Current stage "review" exists in the new policy.
```

### 4.5. Текущий этап исчез

Если `state.stage` отсутствует в новой Policy, или этап стал терминальным при активном run:

- автоматическое продолжение запрещено во всех режимах;
- state: `status = blocked`, `statusReason.code = POLICY_STAGE_MISSING`;
- событие `task.blocked`;
- выход с подсказкой `teo recover <KEY>`, где пользователь выбирает существующий этап (см. [05-cli-ui.md](05-cli-ui.md#teo-recover)).

### 4.6. Изменился агент текущего этапа

- Активная сессия не пересоздаётся: новые `instructions` агента действуют со следующего run.
- Если у текущего этапа поменялся `agent`, это фиксируется в `policy.changed`. Supervisor на ближайшем цикле видит, что `currentRun.agentId` отличается от `stage.agent`, и `continue_current_agent` для него недоступен (см. [03-engine.md](03-engine.md#control-actions)).
