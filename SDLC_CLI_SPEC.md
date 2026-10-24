# SDLC CLI — техническая спецификация MVP

Статус: draft для начала реализации  
Версия: 0.1  
Язык реализации: TypeScript  
Целевая среда первой версии: локальный компьютер разработчика, macOS/Linux  
Основной способ интеграции с моделями: Pi SDK

> Детальная спецификация для реализации — в [docs/](docs/README.md). Она уточняет этот документ; все отступления перечислены в журнале решений [docs/README.md](docs/README.md#журнал-решений).

## 1. Назначение

`sdlc` — локальный CLI-контроллер, который ведёт одну задачу через настраиваемый SDLC-процесс: от сбора требований до терминального этапа, определённого пользователем.

CLI должен:

- хранить несколько незавершённых SDLC-задач для одного проекта;
- при запуске предлагать создать новую задачу или продолжить существующую;
- показывать текущую задачу, этап, агента и активность поверх потока вывода модели;
- запускать дочерних агентов через Pi SDK;
- после результата дочернего агента передавать управление верхнеуровневой supervisor-модели;
- позволять supervisor-модели проверять фактическое состояние проекта и доказательства выполнения;
- переводить задачу на следующий этап только по решению supervisor;
- продолжать процесс до терминального этапа или явной блокировки, не завершаясь после каждого агента;
- восстанавливать выполнение после остановки CLI или сбоя процесса.

## 2. Главный архитектурный принцип

В исходном коде `sdlc-cli` не должно быть конкретного SDLC-процесса.

В коде запрещено фиксировать:

- названия этапов;
- начальный или конечный этап;
- порядок переходов;
- условия переходов;
- роли дочерних агентов;
- инструкции агентам;
- правила ревью, исправления, сборки, деплоя и QA;
- необходимость конкретного human approval;
- количество повторных ревью или исправлений.

Все перечисленное определяется файлом:

```text
~/.pi/SDLC.md
```

В TypeScript остаются только универсальные механизмы:

- чтение и валидация политики;
- хранение состояния и журнала событий;
- запуск и возобновление модельных сессий;
- предоставление моделям инструментов;
- интерактивный интерфейс;
- блокировки, атомарная запись и восстановление;
- структурная проверка решений supervisor;
- исполнение решения supervisor.

## 3. Термины

| Термин | Значение |
|---|---|
| Project | Репозиторий или текущая рабочая папка, внутри которой запущен `sdlc` |
| Task | Одна фича, баг или другая единица работы, проходящая SDLC |
| Policy | Полное содержимое `~/.pi/SDLC.md` |
| Stage | Текущий этап workflow, объявленный в Policy |
| Agent definition | Описание роли и инструкций дочерней модели в Policy |
| Agent run | Одна попытка выполнения дочерним агентом текущего этапа |
| Supervisor | Верхнеуровневая модель, оценивающая результат и управляющая workflow |
| Evidence | Проверяемые сведения: commit SHA, состояние Git, результаты тестов, pipeline, URL стенда и другие факты |
| Event | Неизменяемая запись о значимом действии в рамках задачи |
| Transition | Подтверждённая смена одного этапа на другой |

## 4. Границы MVP

### 4.1. Входит в MVP

- локальный запуск командой `sdlc`;
- обязательный глобальный `~/.pi/SDLC.md`;
- YAML front matter для машинно-читаемой части политики;
- Markdown-текст для смысловых правил supervisor;
- несколько сохранённых задач в одном проекте;
- одна одновременно исполняемая задача в одном рабочем дереве;
- отдельная постоянная Pi-сессия supervisor на каждую задачу;
- отдельные Pi-сессии дочерних агентов;
- интерактивное создание и выбор задачи;
- потоковый вывод дочернего агента;
- постоянная строка текущего этапа;
- approval и другие ответы пользователя через CLI;
- переходы, повторный запуск и продолжение агента;
- восстановление после штатного завершения и аварии;
- файловое состояние без отдельной базы данных.

### 4.2. Не входит в MVP

- облачный controller;
- одновременное изменение одного Git working tree несколькими задачами;
- управление несколькими компьютерами;
- Slack, GitLab, Jira или Firebase как встроенные интеграции CLI;
- web-интерфейс;
- удалённая база данных;
- фоновой daemon;
- автоматическое создание `SDLC.md`;
- встроенный конкретный AppDepo workflow.

Интеграции с GitLab, Slack, Firebase и другими системами могут выполняться дочерними агентами через доступные им инструменты. Позже они могут быть выделены в отдельные адаптеры.

## 5. Размещение файлов

### 5.1. Исходный код CLI

CLI разрабатывается как отдельный Git-репозиторий:

```text
~/Projects/sdlc-cli/
├── package.json
├── tsconfig.json
├── src/
├── test/
└── dist/
```

После сборки команда `sdlc` устанавливается в `PATH` через `npm link`. В дальнейшем возможна публикация во внутренний npm registry.

### 5.2. Глобальная политика

```text
~/.pi/SDLC.md
```

Это единственный обязательный глобальный файл первой версии.

### 5.3. Состояние проекта

В корне текущего проекта:

```text
<project-root>/.sdlc/
├── index.json
├── project.lock.json
└── tasks/
    └── <task-key>/
        ├── state.json
        ├── task.md
        ├── plan.md
        ├── events.jsonl
        ├── runtime.json
        ├── evidence/
        └── sessions/
            ├── supervisor.jsonl
            ├── requirements-001.jsonl
            ├── implementer-001.jsonl
            └── reviewer-001.jsonl
```

Имена дочерних сессий приведены только как пример. Фактические идентификаторы агентов определяются Policy.

Каталог `.sdlc/` рекомендуется добавить в `.gitignore` проекта.

## 6. Определение корня проекта

1. Если текущая папка находится внутри Git-репозитория, project root равен результату `git rev-parse --show-toplevel`.
2. Если Git-репозиторий отсутствует, project root равен `process.cwd()`.
3. Все пути внутри `.sdlc` вычисляются относительно найденного project root.
4. CLI обязан показать найденный project root перед созданием новой задачи.

## 7. Проверки при запуске

Проверки выполняются до показа меню и до любой записи в `.sdlc`.

Порядок:

1. Вычислить путь `~/.pi/SDLC.md` через `os.homedir()`.
2. Проверить, что файл существует.
3. Проверить, что это обычный читаемый файл.
4. Проверить, что файл не пустой.
5. Разобрать YAML front matter.
6. Провалидировать структуру Policy.
7. Проверить целостность графа workflow.

При любой ошибке CLI:

- печатает понятное сообщение;
- не создаёт `.sdlc`;
- не запускает модели;
- завершается с кодом `2`.

Пример для отсутствующего файла:

```text
SDLC configuration error

Required file was not found or is not readable:
/Users/user/.pi/SDLC.md

Create ~/.pi/SDLC.md and restart the command.
```

Fallback-policy и автоматическое создание файла запрещены.

## 8. Формат `SDLC.md`

### 8.1. Общий формат

Файл состоит из двух частей:

1. YAML front matter — структура workflow, агенты и runtime-настройки.
2. Markdown — подробные смысловые правила, которые читает supervisor.

Пример минимальной политики:

```md
---
schema: sdlc/v1

workflow:
  initialStage: requirements
  stages:
    requirements:
      title: Сбор и уточнение требований
      agent: requirements
      transitions:
        - to: waiting_plan_approval
          when: >
            Требования собраны, противоречия устранены,
            план сохранён и представлен пользователю.

    waiting_plan_approval:
      title: Ожидание подтверждения плана
      agent: requirements
      transitions:
        - to: implementation
          when: Пользователь явно одобрил актуальную версию плана.
        - to: requirements
          when: Пользователь запросил изменение требований или плана.

    implementation:
      title: Реализация
      agent: implementer
      transitions:
        - to: review
          when: Реализация завершена и представлены достаточные доказательства.

    review:
      title: Ревью
      agent: reviewer
      transitions:
        - to: fixing
          when: Найдены замечания, требующие изменения реализации.
        - to: qa_ready
          when: Все условия готовности к feature testing выполнены.

    fixing:
      title: Исправление замечаний
      agent: fixer
      transitions:
        - to: review
          when: Замечания исправлены и результат повторно проверен.

    qa_ready:
      title: Готово к feature testing
      terminal: true

agents:
  requirements:
    model: default
    instructions: |
      Собери требования, устрани существенные неопределённости
      и подготовь проверяемый план реализации.

  implementer:
    model: default
    instructions: |
      Реализуй актуальный одобренный план.

  reviewer:
    model: default
    instructions: |
      Проверь реализацию, тесты и соответствие плану.

  fixer:
    model: default
    instructions: |
      Исправь подтверждённые замечания reviewer.

supervisor:
  model: default
  instructions: |
    Независимо проверяй заявления дочерних агентов.
    Не считай текстовый отчёт доказательством фактического выполнения.

runtime:
  maxConsecutiveRestarts: 3
  policyChangeMode: confirm
---

# Общие правила

Supervisor должен сравнивать фактический результат с условиями текущего
перехода. При неполном, противоречивом или непонятном результате он должен
продолжить текущего агента, перезапустить его либо запросить решение человека.
```

### 8.2. Обязательные поля

| Поле | Назначение |
|---|---|
| `schema` | Версия схемы политики |
| `workflow.initialStage` | Идентификатор начального этапа |
| `workflow.stages` | Непустая карта этапов |
| `agents` | Карта определений дочерних агентов |
| `supervisor` | Настройки и инструкции supervisor |

Для нетерминального этапа обязательны:

- `title`;
- `agent`;
- непустой `transitions`.

Для терминального этапа обязательно `terminal: true`. Поля `agent` и `transitions` для него не требуются.

### 8.3. Структурная валидация Policy

CLI проверяет только структуру, а не смысл условий:

- `initialStage` существует;
- каждый `transition.to` указывает на существующий этап;
- каждый `stage.agent` существует в `agents`;
- идентификаторы уникальны;
- из начального этапа достижим хотя бы один терминальный этап;
- терминальный этап не содержит исходящих переходов;
- обязательные строки не пусты;
- runtime-параметры имеют допустимые типы и диапазоны.

Текст поля `when` не интерпретируется TypeScript-кодом. Его оценивает supervisor-модель.

### 8.4. Изменение Policy между запусками

При каждом запуске CLI вычисляет SHA-256 полного содержимого `SDLC.md`.

В `state.json` сохраняются:

```json
{
  "policyHash": "sha256:...",
  "policySchema": "sdlc/v1"
}
```

Если политика изменилась для незавершённой задачи:

- режим `confirm`: показать различие hash и спросить, продолжать ли по новой политике;
- режим `latest`: автоматически применить новую политику и записать событие;
- режим `pinned`: отказаться продолжать без явной миграции.

Режим задаётся в самом `SDLC.md`. Для MVP значение по умолчанию — `confirm`.

Если текущий этап отсутствует в новой политике, автоматическое продолжение запрещено. Задача переводится в техническую блокировку до ручного выбора существующего этапа командой восстановления.

## 9. Модель данных

### 9.1. `index.json`

`index.json` используется для быстрого построения меню, но не является источником истины.

```json
{
  "schemaVersion": 1,
  "tasks": [
    {
      "key": "PAY-142",
      "title": "Добавить оплату через СБП",
      "stage": "review",
      "stageTitle": "Ревью",
      "status": "active",
      "updatedAt": "2026-10-24T12:40:00.000Z"
    }
  ]
}
```

При расхождении `index.json` восстанавливается из `tasks/*/state.json`.

### 9.2. `state.json`

Источник истины по текущему состоянию задачи:

```json
{
  "schemaVersion": 1,
  "key": "PAY-142",
  "title": "Добавить оплату через СБП",
  "projectRoot": "/Users/user/Projects/cms",
  "stage": "review",
  "status": "active",
  "version": 17,
  "policyHash": "sha256:...",
  "policySchema": "sdlc/v1",
  "createdAt": "2026-10-24T10:00:00.000Z",
  "updatedAt": "2026-10-24T12:40:00.000Z",
  "currentRun": {
    "runId": "01JAZ...",
    "agentId": "reviewer",
    "attempt": 1,
    "sessionFile": "sessions/reviewer-001.jsonl",
    "status": "settled",
    "startedAt": "2026-10-24T12:33:00.000Z",
    "finishedAt": "2026-10-24T12:39:00.000Z"
  },
  "supervisorSessionFile": "sessions/supervisor.jsonl",
  "pendingHumanRequest": null,
  "lastEventId": "01JB0..."
}
```

`stage` является обычной строкой. В коде не создаётся enum конкретных этапов.

### 9.3. Статус задачи

Технические статусы задачи не являются SDLC-этапами:

| Статус | Значение |
|---|---|
| `active` | Workflow может продолжаться |
| `waiting_human` | Supervisor запросил ответ пользователя |
| `interrupted` | Процесс остановился во время незавершённого действия |
| `blocked` | Автоматическое продолжение невозможно |
| `terminal` | Достигнут этап с `terminal: true` |
| `cancelled` | Пользователь явно отменил задачу |

Эти статусы описывают состояние движка и не заменяют пользовательские этапы из Policy.

### 9.4. `events.jsonl`

Append-only журнал. Одна строка — один JSON-объект:

```json
{
  "id": "01JB0...",
  "timestamp": "2026-10-24T12:40:00.000Z",
  "taskKey": "PAY-142",
  "type": "stage.transitioned",
  "stateVersion": 17,
  "payload": {
    "from": "implementation",
    "to": "review",
    "reason": "Supervisor подтвердил выполнение условий",
    "evidenceRefs": ["git:7baf12c", "command:test-003"]
  }
}
```

Минимальные типы событий:

- `task.created`;
- `task.resumed`;
- `task.cancelled`;
- `policy.changed`;
- `agent.started`;
- `agent.output` — опционально, полный поток можно не дублировать;
- `agent.settled`;
- `agent.failed`;
- `agent.continued`;
- `agent.restarted`;
- `supervisor.started`;
- `supervisor.decision`;
- `human.requested`;
- `human.responded`;
- `stage.transitioned`;
- `task.blocked`;
- `task.terminal`;
- `runtime.interrupted`;
- `runtime.recovered`.

## 10. Работа с несколькими задачами

### 10.1. Главное меню

При обычном запуске:

```text
$ sdlc

SDLC Controller
Project: /Users/user/Projects/cms

Что вы хотите сделать?

❯ Создать новую задачу
  PAY-142  REVIEWING               Добавить оплату через СБП
  AUTH-77  WAITING_PLAN_APPROVAL   Исправить refresh token
  APP-91   BLOCKED                 Нужен выбор Dev-стенда
  Показать завершённые задачи
  Выход
```

Названия этапов в интерфейсе берутся из `workflow.stages[*].title`, а не из кода.

Незавершённые задачи сортируются по `updatedAt` по убыванию. Терминальные и отменённые задачи скрыты в отдельном списке.

Если незавершённых задач нет, CLI сразу предлагает создать новую.

### 10.2. Создание задачи

CLI запрашивает:

- ключ задачи;
- краткое название;
- первоначальное описание;
- подтверждение найденного project root.

Ключ должен быть уникален в пределах проекта и соответствовать безопасному формату имени каталога: `[A-Za-z0-9][A-Za-z0-9._-]{0,99}`.

После создания:

- этап устанавливается равным `workflow.initialStage`;
- создаётся supervisor-сессия;
- создаётся первая дочерняя сессия агента начального этапа;
- записывается `task.created`;
- запускается основной workflow loop.

### 10.3. Продолжение задачи

При выборе задачи CLI показывает:

```text
Продолжаем PAY-142

Текущий этап: Ревью
Последнее событие: implementer завершил работу
Следующее действие: supervisor проверит результат
```

Затем CLI определяет следующее действие из сохранённого runtime-состояния, а не запускает этап заново безусловно.

### 10.4. Команды без интерактивного меню

Для автоматизации допускаются:

```bash
sdlc new PAY-142
sdlc resume PAY-142
sdlc status PAY-142
sdlc history
sdlc doctor
```

Основным пользовательским интерфейсом остаётся команда `sdlc` без аргументов.

## 11. Блокировки и параллельность

В MVP разрешено хранить много задач, но исполнять только одну задачу на один project root одновременно.

Файл блокировки:

```text
.sdlc/project.lock.json
```

```json
{
  "pid": 18432,
  "hostname": "macbook",
  "taskKey": "PAY-142",
  "startedAt": "2026-10-24T12:30:00.000Z",
  "heartbeatAt": "2026-10-24T12:42:13.000Z"
}
```

Требования:

- блокировка создаётся атомарно;
- heartbeat обновляется во время работы;
- второй процесс может показать status, но не менять задачу;
- протухшая блокировка снимается только после проверки, что локальный PID отсутствует;
- штатное завершение освобождает блокировку;
- `SIGINT` и `SIGTERM` обрабатываются с записью состояния.

Параллельная работа нескольких задач появится после добавления отдельных Git worktree. Формат состояния должен заранее содержать необязательное поле `workspacePath`, чтобы миграция не потребовала смены модели данных.

## 12. Pi-сессии

### 12.1. Supervisor

Для каждой задачи создаётся одна долговечная supervisor-сессия:

```text
.sdlc/tasks/<task-key>/sessions/supervisor.jsonl
```

Она сохраняет историю решений и контекст конкретной задачи.

Перед каждым решением supervisor получает актуальные:

- полное содержимое `SDLC.md`;
- hash политики;
- текущий stage и его допустимые переходы;
- `state.json`;
- релевантные последние события;
- результат текущего дочернего агента;
- ответы пользователя;
- доступные инструменты проверки и управления.

### 12.2. Дочерние агенты

Каждый agent run получает отдельную сессию:

```text
sessions/<agent-id>-<attempt>.jsonl
```

Примеры:

```text
sessions/implementer-001.jsonl
sessions/reviewer-001.jsonl
sessions/fixer-001.jsonl
sessions/reviewer-002.jsonl
```

Операция `continue_current_agent` продолжает существующую сессию. Операция `restart_current_agent` создаёт новую сессию и увеличивает attempt.

### 12.3. Адаптер Pi

Прямое использование Pi SDK из бизнес-логики запрещено. Нужен интерфейс:

```ts
interface AgentRuntime {
  createSession(options: CreateSessionOptions): Promise<SessionRef>;
  openSession(sessionFile: string): Promise<AgentSession>;
  prompt(session: AgentSession, prompt: string): Promise<void>;
  followUp(session: AgentSession, prompt: string): Promise<void>;
  waitForIdle(session: AgentSession): Promise<void>;
  abort(session: AgentSession): Promise<void>;
  subscribe(session: AgentSession, listener: AgentEventListener): Unsubscribe;
}
```

Первая реализация — `PiAgentRuntime`. Это изолирует CLI от изменений API и позволяет писать тесты с `FakeAgentRuntime`.

## 13. Контракты дочернего агента

Дочерний агент не имеет права изменять `state.json` или переводить этап.

Он завершает работу одним из структурированных инструментов:

### `report_result`

```ts
type ReportResultInput = {
  summary: string;
  evidence?: Array<{
    kind: string;
    value: string;
    description?: string;
  }>;
  artifacts?: Array<{
    kind: string;
    pathOrUrl: string;
    description?: string;
  }>;
  notes?: string[];
};
```

### `report_blocker`

```ts
type ReportBlockerInput = {
  summary: string;
  details: string;
  requiresHuman: boolean;
  suggestedQuestion?: string;
};
```

Вызов `report_result` не означает успешного перехода. Это только заявление дочернего агента, которое проверяет supervisor.

Если сессия завершилась без одного из этих инструментов, supervisor получает факт `unstructured_settle` и выбирает дальнейшее действие.

## 14. Инструменты supervisor

Supervisor получает универсальные инструменты двух групп.

### 14.1. Инструменты чтения и проверки

- `read_policy`;
- `read_state`;
- `read_task_description`;
- `read_plan`;
- `read_agent_result`;
- `read_recent_events`;
- `inspect_git_status`;
- `inspect_git_commit`;
- `inspect_file`;
- `list_files`;
- `read_evidence`;
- `run_verification_command` — если разрешено Policy и runtime-конфигурацией.

Набор инструментов может расширяться без изменения workflow schema.

### 14.2. Управляющие инструменты

- `transition_stage`;
- `continue_current_agent`;
- `restart_current_agent`;
- `ask_human`;
- `block_task`;
- `cancel_task` — только после явного пользовательского решения;
- `record_note`.

Supervisor обязан завершать каждый цикл ровно одним управляющим действием.

### 14.3. Контракт `transition_stage`

```ts
type TransitionStageInput = {
  expectedStateVersion: number;
  to: string;
  reason: string;
  evidenceRefs?: string[];
};
```

CLI проверяет только технические инварианты:

- `expectedStateVersion` равен текущей версии;
- `to` существует в Policy;
- переход `currentStage -> to` объявлен в Policy;
- нет другого незавершённого управляющего действия;
- запись состояния возможна атомарно.

CLI не оценивает смысл поля `when`. Эту оценку выполняет supervisor по Policy и фактическим доказательствам.

## 15. Решения supervisor

Supervisor должен уметь обработать как штатный, так и нестандартный результат.

| Ситуация | Возможное действие supervisor |
|---|---|
| Все условия следующего этапа доказаны | `transition_stage` |
| Агент не закончил работу | `continue_current_agent` |
| Сессия ушла в неверном направлении | `restart_current_agent` |
| Нужен выбор или разрешение человека | `ask_human` |
| Результат агента противоречит Git/файлам/тестам | продолжить или перезапустить агента с конкретным замечанием |
| Инструмент был вызван, но результата фактически нет | продолжить агента либо запросить повторное выполнение |
| Безопасное автоматическое продолжение невозможно | `block_task` |

Пример проверки:

1. Implementer сообщает commit `abc123` и успешные тесты.
2. Supervisor вызывает `inspect_git_commit("abc123")` и `inspect_git_status()`.
3. Фактически HEAD равен `def456`, дерево грязное, commit отсутствует.
4. Supervisor не вызывает переход.
5. Supervisor вызывает `continue_current_agent` с описанием расхождения.

## 16. Основной workflow loop

Псевдокод:

```ts
while (true) {
  const policy = await policyLoader.loadAndValidate();
  const state = await stateStore.load(taskKey);
  const stage = policy.workflow.stages[state.stage];

  if (stage.terminal === true) {
    await taskService.markTerminal(state);
    return;
  }

  if (state.pendingHumanRequest) {
    const answer = await ui.askHuman(state.pendingHumanRequest);
    await eventStore.appendHumanResponse(answer);
    await stateStore.clearHumanRequest();
  }

  const runtimeState = await recoveryService.determineNextAction(state);

  if (runtimeState.requiresAgentRun) {
    await agentRunner.runOrResume(stage.agent, state, policy);
  }

  const decision = await supervisorRunner.evaluate(state, policy);
  await decisionExecutor.execute(decision, state, policy);
}
```

Цикл заканчивается только когда:

- достигнут этап с `terminal: true`;
- пользователь отменил задачу;
- supervisor вызвал `block_task`;
- произошла невосстановимая техническая ошибка;
- пользователь явно остановил процесс сигналом или командой.

После обычного `agent_settled` CLI не должен возвращаться в главное меню до решения supervisor.

## 17. Защита от молчаливой остановки моделей

### 17.1. Дочерний агент завершился без результата

CLI:

1. записывает `agent.settled` с причиной `unstructured_settle`;
2. запускает supervisor;
3. supervisor решает: продолжить, перезапустить, спросить человека или заблокировать.

### 17.2. Supervisor завершился без управляющего действия

CLI один раз отправляет follow-up в ту же supervisor-сессию:

```text
Вы завершили ответ без управляющего tool call. Выберите ровно одно действие:
transition_stage, continue_current_agent, restart_current_agent, ask_human
или block_task.
```

Если supervisor повторно не выбрал действие:

- записать ошибку протокола;
- перевести технический статус задачи в `blocked`;
- показать пользователю причину и команду возобновления.

Количество таких повторов должно задаваться параметром в `SDLC.md`, а не константой workflow.

## 18. Состояние и атомарность

### 18.1. Версионирование

Каждое изменение `state.json` увеличивает `version` на 1.

Управляющие операции используют optimistic concurrency через `expectedStateVersion`.

### 18.2. Атомарная запись

Изменение состояния:

1. записать новый JSON во временный файл в том же каталоге;
2. вызвать `fsync` для файла;
3. переименовать временный файл поверх `state.json`;
4. по возможности вызвать `fsync` каталога;
5. обновить `index.json` тем же безопасным способом;
6. дописать событие в `events.jsonl`.

При несовпадении index и state источником истины остаётся `state.json` плюс журнал событий.

### 18.3. Идемпотентность управляющих действий

Каждое решение supervisor получает `decisionId`. Исполнитель хранит последний применённый `decisionId`.

Повторное получение того же решения после сбоя не должно:

- второй раз менять этап;
- создавать дубликат agent run;
- повторно задавать пользователю один вопрос;
- повторно помечать задачу терминальной.

Внешние действия дочерних агентов в MVP не гарантируют полной идемпотентности, но supervisor должен проверять фактический результат перед повтором.

## 19. Восстановление после сбоя

При открытии задачи со статусом `interrupted` CLI анализирует последнее событие и runtime-состояние.

| Последнее состояние | Действие |
|---|---|
| Агент запущен, Pi-сессия доступна и idle | Передать результат supervisor |
| Агент запущен, сессия допускает продолжение | Возобновить сессию |
| Supervisor принял решение, но оно не применено | Идемпотентно применить решение |
| Transition записан в state, но отсутствует в events | Восстановить событие |
| Состояние неоднозначно | Показать варианты восстановления пользователю |

CLI не должен автоматически повторять потенциально необратимое внешнее действие, если невозможно проверить, было ли оно выполнено.

## 20. Терминальный интерфейс

Для TUI рекомендуется Ink.

### 20.1. Основной экран

```text
┌ PAY-142 · Ревью · agent: reviewer · attempt 1 ──────── 00:03:42 ┐

Проверяю изменения в payment_service.go...
Запускаю тесты...
✓ unit tests: 147 passed
✗ отсутствует обработка timeout

└ SDLC: Ревью · supervisor ожидает результат reviewer ───────────┘
```

Верхняя и нижняя строки строятся по фактическому `state.json` и runtime-событиям, а не по свободному тексту модели.

### 20.2. Переход этапа

После атомарно сохранённого transition:

```text
════════════════════════════════════════════════════
✓ Реализация завершена
→ Новый этап: Ревью
→ Запускаю agent: reviewer
════════════════════════════════════════════════════
```

### 20.3. Строка состояния

Минимальные поля:

- task key;
- человекочитаемый title этапа;
- agent id;
- attempt;
- текущая активность;
- elapsed time.

### 20.4. Поток событий Pi

События адаптируются в UI-события:

```ts
type UiEvent =
  | { type: "agent.text"; text: string }
  | { type: "agent.tool.started"; toolName: string }
  | { type: "agent.tool.finished"; toolName: string; ok: boolean }
  | { type: "agent.settled" }
  | { type: "stage.changed"; from: string; to: string }
  | { type: "activity.changed"; text: string };
```

### 20.5. Неинтерактивный терминал

Если stdout не является TTY, CLI отключает динамическую перерисовку и печатает линейный лог:

```text
[PAY-142][review][reviewer] Запускаю тесты
[PAY-142][review][reviewer] Тесты завершены
[PAY-142][supervisor] Проверяю результат
[PAY-142] transition review -> fixing
```

## 21. Предлагаемая структура исходного кода

```text
src/
├── cli.ts
├── app.ts
├── commands/
│   ├── interactive.ts
│   ├── new.ts
│   ├── resume.ts
│   ├── status.ts
│   ├── history.ts
│   └── doctor.ts
├── policy/
│   ├── policy-loader.ts
│   ├── policy-schema.ts
│   ├── policy-validator.ts
│   └── policy-hash.ts
├── workflow/
│   ├── controller.ts
│   ├── decision-executor.ts
│   ├── recovery-service.ts
│   └── transition-validator.ts
├── agents/
│   ├── agent-runtime.ts
│   ├── pi-agent-runtime.ts
│   ├── child-agent-runner.ts
│   ├── supervisor-runner.ts
│   └── tool-registry.ts
├── state/
│   ├── state-store.ts
│   ├── event-store.ts
│   ├── index-store.ts
│   ├── lock-manager.ts
│   └── atomic-file.ts
├── project/
│   └── project-root.ts
├── ui/
│   ├── app.tsx
│   ├── task-selector.tsx
│   ├── status-header.tsx
│   ├── status-bar.tsx
│   ├── transition-banner.tsx
│   └── human-prompt.tsx
├── domain/
│   ├── policy.ts
│   ├── task-state.ts
│   ├── events.ts
│   └── decisions.ts
└── errors/
    └── errors.ts
```

## 22. Зависимости

Предварительный набор:

| Назначение | Вариант |
|---|---|
| CLI arguments | `commander` |
| TUI | `ink`, `react` |
| Интерактивный выбор | компоненты Ink или собственные компоненты |
| YAML front matter | `gray-matter` + YAML parser |
| Runtime validation | `zod` |
| Идентификаторы | `ulid` |
| Pi integration | Pi SDK через `PiAgentRuntime` |
| Тесты | `vitest` |
| Сборка | `tsc` или `tsup` |

Конкретные библиотеки могут быть заменены без изменения архитектурных контрактов.

## 23. Ошибки и exit codes

| Код | Значение |
|---:|---|
| `0` | Штатное завершение команды или достижение terminal stage |
| `1` | Непредвиденная runtime-ошибка |
| `2` | Ошибка конфигурации `SDLC.md` |
| `3` | Конфликт блокировки |
| `4` | Задача не найдена или повреждена |
| `130` | Остановка пользователем через `Ctrl+C` |

Сообщения должны содержать:

- что произошло;
- какой файл, этап или task затронут;
- можно ли безопасно продолжить;
- конкретную следующую команду, если она существует.

## 24. Безопасность и границы полномочий

- CLI не читает секреты для журналирования и не записывает environment в `.sdlc`.
- Полные аргументы потенциально секретных tool calls не должны попадать в `events.jsonl` без редактирования.
- Дочерний агент не получает инструмент изменения SDLC state.
- Supervisor не изменяет файлы state напрямую — только через управляющие tools.
- Любой путь, полученный от модели, нормализуется и проверяется перед файловой операцией.
- `task-key` не может содержать `/`, `..` или управляющие символы.
- Команды проверки запускаются только в project root или явно назначенном workspacePath.
- Необратимые действия должны оставаться предметом правил Policy и human approval, а не скрытой логики CLI.

## 25. Наблюдаемость

Команда:

```bash
sdlc status PAY-142
```

показывает:

- текущий stage и title;
- технический status;
- текущего или последнего агента;
- attempt;
- время последнего события;
- последнюю supervisor decision;
- ожидаемое следующее действие;
- policy hash;
- наличие активной блокировки.

Команда:

```bash
sdlc doctor
```

проверяет:

- наличие и валидность `~/.pi/SDLC.md`;
- доступность Pi runtime;
- возможность создать временную session;
- права чтения/записи project root;
- целостность `.sdlc/index.json`;
- наличие протухших lock-файлов;
- ссылки state на существующие session files.

`doctor` не запускает workflow и не исправляет данные без подтверждения.

## 26. Тестовая стратегия

### 26.1. Unit tests

- парсинг корректного `SDLC.md`;
- ошибки отсутствующего, пустого и невалидного файла;
- проверка ссылок stages, agents и transitions;
- вычисление policy hash;
- transition validation;
- optimistic state version;
- атомарная запись;
- task-key validation;
- восстановление index;
- lock acquisition и stale lock detection;
- идемпотентное применение `decisionId`.

### 26.2. Integration tests с FakeAgentRuntime

- создание задачи и запуск initial stage;
- успешный переход между двумя произвольными этапами;
- переход в terminal stage;
- child agent завершился без structured result;
- supervisor продолжил агента;
- supervisor перезапустил агента;
- supervisor запросил человека;
- supervisor дважды завершился без control tool;
- восстановление после сбоя между decision и transition;
- изменение Policy между запусками;
- несколько задач в одном project root;
- запрет второго mutating-процесса.

### 26.3. End-to-end smoke test с Pi

Минимальная тестовая Policy содержит три произвольных этапа:

```text
discover -> execute -> done
```

Тест подтверждает, что CLI не зависит от конкретных имён этапов и может полностью пройти workflow до `terminal: true`.

## 27. Этапы реализации

### Этап 1. Каркас и Policy

- создать TypeScript-проект;
- добавить CLI entrypoint;
- реализовать preflight `~/.pi/SDLC.md`;
- реализовать parser, Zod schema и graph validation;
- реализовать project root detection;
- добавить `sdlc doctor`.

Результат: CLI валидирует произвольную Policy и завершается до любых действий при ошибке.

### Этап 2. Файловое состояние и несколько задач

- реализовать `.sdlc` layout;
- state/index/event stores;
- атомарную запись;
- lock manager;
- создание, список, выбор и продолжение задач;
- команды `new`, `status`, `history`.

Результат: можно создать несколько задач и безопасно возобновлять выбранную.

### Этап 3. AgentRuntime и дочерние агенты

- определить `AgentRuntime`;
- реализовать `FakeAgentRuntime`;
- реализовать `PiAgentRuntime`;
- добавить persistent sessions;
- добавить `report_result` и `report_blocker`;
- связать поток событий с линейным UI.

Результат: агент произвольного stage запускается согласно Policy и возвращает структурированный результат.

### Этап 4. Supervisor loop

- создать постоянную supervisor-сессию;
- реализовать verification и control tools;
- реализовать decision executor;
- добавить continue/restart/ask/block/transition;
- добавить защиту от settle без control tool;
- довести цикл до terminal stage.

Результат: CLI автономно проходит workflow между пользовательскими точками принятия решений.

### Этап 5. TUI

- добавить Ink;
- task selector;
- streaming output;
- status header/footer;
- transition banners;
- human prompts;
- fallback для non-TTY.

Результат: пользователь постоянно видит текущую задачу, этап, агента и активность.

### Этап 6. Recovery и hardening

- восстановление после сигналов и аварий;
- идемпотентные decisions;
- policy migration handling;
- redaction логов;
- интеграционные и end-to-end тесты;
- документация установки через `npm link`.

## 28. Критерии приёмки MVP

MVP считается готовым, если выполняются все условия:

1. При отсутствии, нечитаемости, пустоте или невалидности `~/.pi/SDLC.md` команда завершается до показа меню с exit code `2`.
2. В исходниках отсутствуют конкретные названия пользовательских SDLC-этапов и конкретный граф workflow.
3. Изменение этапов и переходов в корректном `SDLC.md` не требует пересборки CLI.
4. `sdlc` показывает создание новой задачи и список незавершённых задач текущего проекта.
5. Выбранная задача продолжается с сохранённого состояния и с сохранёнными Pi-сессиями.
6. В одном проекте можно хранить минимум две независимые незавершённые задачи.
7. Второй процесс не может одновременно изменять состояние проекта.
8. Дочерний агент не может напрямую изменить stage.
9. После завершения дочернего агента всегда запускается supervisor.
10. Supervisor читает актуальный `SDLC.md` и получает только объявленные для текущего stage переходы.
11. Supervisor может проверить результат, продолжить или перезапустить агента, спросить человека, заблокировать задачу либо выполнить допустимый transition.
12. Заявление агента без фактического результата не приводит к автоматическому переходу.
13. После transition автоматически запускается агент нового stage.
14. Цикл продолжается до `terminal: true`, блокировки, отмены или остановки пользователем.
15. На экране постоянно видны task, stage title, agent и текущая активность.
16. После перезапуска CLI может восстановить задачу без потери подтверждённого stage и истории событий.
17. Тестовый workflow с произвольными именами `discover -> execute -> done` проходит полностью без изменений TypeScript-кода.

## 29. Решения, отложенные после MVP

- отдельный Git worktree на каждую параллельно исполняемую задачу;
- облачный controller и локальные runners;
- несколько runner-компьютеров;
- SQLite вместо JSON/JSONL;
- встроенные Slack/GitLab/Jira/Firebase adapters;
- web dashboard;
- фоновые webhook и polling workers;
- публикация CLI во внутренний registry;
- подпись и версионирование корпоративных Policy;
- разделение одного workflow между несколькими людьми.

## 30. Итоговая модель

```text
~/.pi/SDLC.md
    определяет workflow, агентов, переходы и условия
                     │
                     ▼
sdlc-cli
    выполняет универсальный цикл и хранит состояние
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
  дочерний агент            supervisor
  выполняет этап            проверяет результат
          │                     │
          └──────────┬──────────┘
                     ▼
          управляющее действие
                     │
     transition / continue / restart /
          ask human / block
                     │
                     ▼
         следующий цикл или terminal
```

`SDLC.md` отвечает на вопрос «как должен идти процесс». `sdlc-cli` отвечает только за то, чтобы этот процесс надёжно исполнялся, не терял состояние и не останавливался без явной причины.
