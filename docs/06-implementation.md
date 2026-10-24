# 06. План реализации

Детализирует разделы 21, 22, 26, 27, 28 [SDLC_CLI_SPEC.md](../SDLC_CLI_SPEC.md).

## 1. Проект

### 1.1. `package.json` (существенное)

```json
{
  "name": "sdlc-cli",
  "type": "module",
  "bin": { "sdlc": "dist/cli.js" },
  "engines": { "node": ">=22.19.0" },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run",
    "test:e2e": "SDLC_E2E=1 vitest run test/e2e"
  }
}
```

### 1.2. Зависимости

Актуальные версии на 2026-10-24. Пакеты фиксируются lockfile, Pi — точной версией.

| Назначение | Пакет | Версия | Примечание |
|---|---|---|---|
| Pi SDK | `@earendil-works/pi-coding-agent` | `1.4.0` (точно, = версия `pi` из Homebrew) | Только в `src/agents/pi/` |
| Схемы tools для Pi | `typebox` | как у Pi | Pi описывает параметры tools через typebox |
| CLI | `commander` | `^15` | |
| TUI | `ink`, `react` | `^8`, `^19` | |
| Компоненты ввода | `@inkjs/ui` | `^2` | Select, TextInput; многострочный ввод — свой компонент |
| YAML | `yaml` | `^2.9` | Номера строк, `uniqueKeys` |
| Валидация | `zod` | `^4` | |
| ID | `ulid` | `^3` | `monotonicFactory` |
| Тесты | `vitest`, `ink-testing-library` | `^5`, `^4` | |
| Сборка | `tsup` | `^9` | ESM, target node22, banner `#!/usr/bin/env node` |
| Типы | `typescript` | `^7` | |

`gray-matter` из исходного списка не используется ([01-policy.md §1.3](01-policy.md#13-выделение-front-matter)). `execa` не нужен: хватает `child_process.execFile`.

### 1.3. `tsconfig.json`

`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `module: "NodeNext"`, `jsx: "react-jsx"`. Доступ к `policy.workflow.stages[id]` всегда возвращает `Stage | undefined`, и это защищает от целого класса ошибок с отсутствующими этапами.

### 1.4. Правила линтера

- `no-restricted-imports`: `@earendil-works/*` разрешён только в `src/agents/pi/**`.
- `no-restricted-imports`: `ink`, `react` разрешены только в `src/ui/**`.
- `no-restricted-syntax`: запрет `process.exit` вне `src/cli.ts`.
- `no-restricted-properties`: запрет `Date.now` и `new Date()` вне `src/util/clock.ts` (время инжектируется, тесты детерминированы).

## 2. Структура исходников

Уточнение раздела 21 исходной спецификации.

```text
src/
├── cli.ts                      # commander, маппинг ошибок → exit codes, сигналы
├── app.ts                      # composition root: собирает сервисы, ничего не решает
├── commands/
│   ├── interactive.ts  new.ts  resume.ts  status.ts  history.ts
│   ├── cancel.ts  recover.ts  doctor.ts
├── domain/                     # только типы и чистые функции, без I/O
│   ├── policy.ts               # PolicySpec, Stage, Transition, AgentDef
│   ├── task-state.ts           # TaskState, Phase, AgentRunRef, инварианты
│   ├── events.ts               # TaskEvent, EventType, payload-типы
│   ├── decisions.ts            # Decision, входы control tools
│   └── next-action.ts          # phase+trigger → описание следующего действия
├── policy/
│   ├── front-matter.ts         # сплиттер с номерами строк
│   ├── policy-schema.ts        # zod
│   ├── graph-validator.ts      # ошибки и предупреждения §3
│   ├── policy-loader.ts        # preflight целиком → LoadedPolicy | PolicyError
│   ├── policy-hash.ts
│   ├── policy-diff.ts          # структурный diff для confirm
│   └── snapshot-store.ts       # .sdlc/policies/<hash>.md
├── state/
│   ├── layout.ts               # все пути .sdlc в одном месте; resolveInside()
│   ├── task-key.ts
│   ├── atomic-file.ts          # writeFileAtomic, appendLine, fsyncDir
│   ├── state-store.ts          # load (инварианты, outbox flush, hash-контроль), commit(mutator)
│   ├── event-store.ts          # чтение с хвоста, ремонт хвоста
│   ├── index-store.ts
│   ├── run-store.ts            # runs/<runId>.json
│   ├── runtime-info.ts         # runtime.json с троттлингом
│   └── lock-manager.ts
├── workflow/
│   ├── engine.ts               # runTask: цикл по фазам
│   ├── agent-step.ts
│   ├── supervisor-step.ts
│   ├── human-step.ts
│   ├── wait-step.ts            # фаза waiting: срок, «проверить сейчас», сообщение, --no-wait
│   ├── decision-validator.ts   # чистая функция: (decision, state, policy, resolvers) → errors
│   ├── decision-executor.ts    # чистая функция эффектов + commit
│   ├── policy-gate.ts
│   └── recovery.ts
├── agents/
│   ├── runtime.ts              # AgentRuntime, AgentSessionHandle, RunOutcome, SessionFileInfo
│   ├── session-pool.ts
│   ├── session-spec.ts         # Policy + state → SessionSpec (tools, model, resources)
│   ├── guard.ts                # GuardConfig + логика решений (без Pi-типов)
│   ├── evidence-refs.ts        # парсинг и разрешение ссылок
│   ├── prompts/
│   │   ├── agent-prompts.ts
│   │   └── supervisor-prompts.ts
│   ├── tools/
│   │   ├── child-tools.ts      # report_result, report_blocker, ask_user
│   │   ├── supervisor-read-tools.ts
│   │   ├── supervisor-control-tools.ts
│   │   └── git-inspect.ts
│   └── pi/                     # единственное место с импортом Pi SDK
│       ├── pi-agent-runtime.ts
│       ├── pi-tool-adapter.ts
│       ├── pi-guard-extension.ts
│       ├── pi-event-mapper.ts
│       └── session-inspector.ts
├── project/
│   └── project-root.ts
├── ui/
│   ├── human-io.ts             # интерфейс HumanIO: ask, confirm, select, input
│   ├── messages.ts             # каталог строк (ru)
│   ├── event-adapter.ts        # RuntimeEvent + state → UiEvent
│   ├── plain/                  # линейный рендер и HumanIO для non-TTY
│   └── ink/
│       ├── app.tsx  task-selector.tsx  new-task-form.tsx
│       ├── run-screen.tsx  status-header.tsx  status-bar.tsx
│       ├── transition-banner.tsx  human-prompt.tsx  multiline-input.tsx  wait-screen.tsx
├── util/
│   ├── clock.ts  ids.ts  redact.ts  exec.ts  truncate.ts
└── errors/
    └── errors.ts
test/
├── fixtures/policies/          # valid/*.md, invalid/*.md
├── helpers/                    # tmp project, FakeAgentRuntime, ScriptedHumanIO, FakeClock, FaultInjector
├── unit/
├── integration/
└── e2e/
```

### 2.1. Ключевые абстракции для тестируемости

| Абстракция | Прод | Тесты |
|---|---|---|
| `AgentRuntime` | `PiAgentRuntime` | `FakeAgentRuntime` ([04-agents.md §2.4](04-agents.md#24-fakeagentruntime)) |
| `HumanIO` | Ink / plain | `ScriptedHumanIO` — очередь ответов, падает на неожиданном вопросе |
| `Clock` | системные часы | `FakeClock` |
| `FaultInjector` | no-op | бросает или убивает процесс в именованной точке (`after-state-commit`, `before-event-append`, `in-control-tool`, …) |
| `GitInspector` | `execFile("git")` | настоящий git во временном репозитории |

`FaultInjector.check(point)` вызывается в нескольких местах `state-store`, `decision-executor` и tools. В проде это пустая функция.

## 3. Этапы реализации

Порядок изменён относительно раздела 27 исходной спецификации: движок с `FakeAgentRuntime` строится и покрывается тестами **до** интеграции с Pi. Так ядро проверяется детерминированно и без денег на модели.

### M1. Каркас и Policy

- Проект, сборка, линтер, vitest, `cli.ts` с командами-заглушками.
- `project-root.ts`.
- `policy/*` полностью, включая diff и снимки.
- `sdlc doctor` в части Policy и окружения (без Pi).

**Готово, когда:** `sdlc doctor` валидирует любую Policy и печатает все ошибки с номерами строк; каждая ошибка из [01-policy.md §3.1](01-policy.md#31-ошибки) покрыта фикстурой `test/fixtures/policies/invalid/<code>.md`; любая команда с невалидной Policy завершается с кодом `2` и не создаёт `.sdlc`.

### M2. Хранилище и задачи

- `state/*`: атомарная запись, outbox, инварианты, ремонт журнала, index, lock с takeover и heartbeat.
- `sdlc new` (без запуска workflow), `status`, `history`, `cancel`; меню на plain-рендере.

**Готово, когда:** две задачи создаются и видны в меню; второй процесс получает exit `3` на mutating-команду и успешно выполняет `status`; unit-тесты §4.1 по хранилищу зелёные; тест с убийством процесса между записью state и append события доказывает доставку outbox.

### M3. Движок на FakeAgentRuntime

- `agents/runtime.ts`, `session-pool.ts`, `prompts/*`, все tools, `evidence-refs.ts`, `guard.ts`.
- `workflow/*` полностью: фазы, валидация и применение решений, human step, отложенная перепроверка, лимиты, recovery, policy gate.
- `FakeAgentRuntime`, `ScriptedHumanIO`, `FaultInjector`.

**Готово, когда:** все integration-сценарии §4.2 проходят на Fake; workflow `discover → execute → done` проходит до терминального этапа; fault-injection в каждой именованной точке с последующим recovery не приводит ни к двойному переходу, ни к повторному вопросу, ни к потере решения.

### M4. Pi

- `agents/pi/*`: runtime, адаптер tools, guard-расширение, маппинг событий, инспектор файлов сессий.
- Git-инструменты supervisor-а на реальном git.
- `doctor`: проверки моделей, авторизации и пробной сессии.

**Готово, когда:** e2e smoke §4.3 проходит на реальной модели; `inspectSessionFile` верно определяет доставку prompt и висящие tool calls на реальных файлах Pi (фикстуры записываются из настоящих сессий); guard блокирует `write` в `.sdlc/tasks/<KEY>/state.json` в реальной сессии.

### M5. TUI

- Ink: меню, форма задачи, экран выполнения, баннеры, human prompt, многострочный ввод, экран ожидания.
- Plain-рендер доведён до формата [05-cli-ui.md §5](05-cli-ui.md#5-неинтерактивный-режим).
- Обработка `Ctrl+C` с подтверждением.

**Готово, когда:** тесты `ink-testing-library` для меню, формы, human prompt, экрана выполнения и экрана ожидания; ручная проверка на реальной Policy: шапка и подвал не пропадают при длинном стриме, ширина 80 колонок не ломает раскладку.

### M6. Hardening и выпуск

- Redaction и его тесты на наборах реальных форматов токенов.
- `doctor --fix`.
- `recover` для всех ситуаций [05-cli-ui.md §2.1](05-cli-ui.md#21-sdlc-recover).
- README установки (`npm ci && npm run build && npm link`), пример `SDLC.md`.
- Прогон чек-листа приёмки §5.

## 4. Тесты

### 4.1. Unit

| Модуль | Что проверяем |
|---|---|
| `front-matter` | BOM, CRLF, `...` как закрывающий разделитель, отсутствие front matter, смещение номеров строк |
| `policy-schema` | defaults; `x-*` игнорируются; неизвестный ключ → ошибка; конфликт `model:…:high` + `thinking` |
| `graph-validator` | каждая ошибка и предупреждение §3; самопереход допустим; цикл без выхода → `STAGE_DEAD_END` |
| `policy-hash` | hash от байтов; изменение только Markdown-части меняет hash |
| `policy-diff` | добавление/удаление этапа, изменение перехода, инструкций, runtime |
| `task-key` | граничные случаи regex, `..`, case-insensitive дубликат, зарезервированные имена |
| `atomic-file` | при ошибке до `rename` целевой файл не меняется; tmp удаляется |
| `state-store` | версия +1; `expectedVersion` конфликт; инварианты; outbox доставляется ровно один раз; hash-контроль подмены |
| `event-store` | обрезанный хвост ремонтируется; битая строка в середине → `TaskCorruptedError`; чтение с хвоста |
| `index-store` | восстановление из state-файлов; повреждённая задача в списке |
| `lock-manager` | `wx`-захват; живой PID не снимается; мёртвый — снимается; чужой hostname не снимается; гонка двух takeover (только один выигрывает); потеря lock обнаруживается heartbeat-ом |
| `decision-validator` | все коды §5.4 [03-engine.md](03-engine.md#control-actions); guards; `cancel_task` без свежего ответа; `schedule_recheck`: этап без `recheck`, задержка вне диапазона, исчерпан `maxCount` |
| `wait-step` | на `FakeClock`: срок не наступил → ждёт; скачок часов вперёд (сон ноутбука) → перепроверка на ближайшем тике; `--no-wait` → outcome `waiting_recheck`; `check_now` и сообщение человека → нужные фазы и события |
| `decision-executor` | эффекты каждого действия; повторный `apply` того же `decisionId` — no-op |
| `evidence-refs` | каждая схема ссылок; неизвестная схема |
| `guard` | нормализация путей, symlink наружу, запись в `artifacts/` разрешена, в state — нет; блокировка после отчёта |
| `redact` | каждый формат секрета; ключи объектов; ответы человека не редактируются |
| `prompts` | snapshot-тесты шаблонов на двух разных Policy; в шаблонах нет литералов этапов |
| `next-action` | текст для каждой фазы и триггера |

### 4.2. Integration (FakeAgentRuntime, временный git-репозиторий)

Сценарии исходной спецификации (26.2) плюс недостающие:

1. Создание задачи → initial stage → агент запущен с initial prompt.
2. Переход между двумя произвольными этапами; агент нового этапа стартует автоматически; `handoff` попал в его prompt.
3. Переход в терминальный этап → exit outcome `0`, `task.terminal`.
4. Агент закончил без отчёта → `unstructured_settle` → supervisor получил хвост текста.
5. Supervisor продолжил агента → та же сессия, новый `promptId`.
6. Supervisor перезапустил агента → новая сессия `-002`, `consecutiveRestarts = 1`; после `maxConsecutiveRestarts` restart отклоняется.
7. Supervisor спросил человека → `human_pending` → ответ → supervisor получил trigger `human_responded`.
8. `ask_user` агента → ответ вернулся в tool; события `human.requested/responded` с `origin = agent`.
9. Supervisor дважды завершился без решения → `blocked`, `SUPERVISOR_NO_DECISION`.
10. Невалидный переход (не объявлен) → tool error → supervisor исправился в том же цикле.
11. Guard `humanResponse: required` без ссылки → отклонено; со ссылкой → принято.
12. Fault: падение после записи решения, до применения → recovery применяет решение один раз.
13. Fault: падение после `commit` перехода, до append события → событие восстановлено из outbox.
14. Fault: падение до доставки prompt агенту → prompt отправлен повторно, без дубликата run.
15. Fault: падение во время tool call агента → supervisor получил trigger `recovered` с описанием висящего вызова; агент автоматически **не** продолжен.
16. Fault: падение во время `ask_user` → вопрос задан повторно, агент продолжен с ответом.
17. Изменение Policy между запусками: `confirm` (да/нет), `latest`, `pinned`; удаление текущего этапа → `blocked` → `recover --set-stage`.
18. Две задачи в одном проекте развиваются независимо.
19. Второй процесс не может изменять проект (exit `3`), `status` работает.
20. `maxCyclesPerStage` срабатывает и блокирует задачу.
21. Non-TTY: `ask_human` → exit `5`; повторный `resume` в TTY показывает тот же вопрос без нового `human.requested`.
22. Подмена `state.json` агентом через `bash` → `blocked`, `STATE_TAMPERED`.
23. `Ctrl+C` во время работы агента → `interrupted`, exit `130`; следующий `resume` восстанавливается по §8.
24. `schedule_recheck` → `waiting` → `FakeClock` доходит до `dueAt` → агенту в ту же сессию ушёл prompt `kind = recheck` → supervisor получил trigger `recheck_settled`; `stageCycles` не вырос, `stageRechecks.count = 1`.
25. Цепочка перепроверок до `maxCount` → следующий `schedule_recheck` отклонён `RECHECK_LIMIT_REACHED` → supervisor выбрал `ask_human`; после `transition_stage` счётчик обнулён.
26. Выход во время ожидания (`q`, exit `6`) → `resume` до срока продолжает отсчёт с прежним `dueAt`; `resume` после срока сразу перепроверяет; `resume --now` перепроверяет без ожидания; `resume --no-wait` до срока → exit `6` без изменения state.
27. Сообщение человека во время ожидания → `human.responded { requestId: null }`, `wait.finished { human_message }`, supervisor получил trigger `human_responded`.
28. Fault: падение процесса в фазе `waiting` → recovery ничего не меняет, срок сохранён.

### 4.3. E2E smoke с Pi

Включается переменной `SDLC_E2E=1`; в обычном `npm test` пропускается.

Окружение:

```text
HOME=<tmp>/home                       # → <tmp>/home/.pi/SDLC.md = test/fixtures/policies/valid/discover-execute-done.md
PI_CODING_AGENT_DIR=<реальный ~/.pi/agent>   # авторизация и модели пользователя
cwd=<tmp>/project                     # git init, один файл
```

Policy `discover → execute → done` с инструкциями «создай файл `NOTES.md` с одной строкой и закоммить», supervisor проверяет коммит через `inspect_git_commit`. Тест запускает `node dist/cli.js new T-1 --title t --description - --plain` и проверяет:

- exit `0`;
- `state.stage = done`, `status = terminal`;
- в журнале есть `stage.transitioned` дважды и ни одного `supervisor.protocol_error`;
- файлы сессий лежат в `.sdlc/tasks/T-1/sessions/`.

Модель для e2e задаётся в фикстуре как `default` — используется модель по умолчанию из настроек Pi.

### 4.4. Тест «в коде нет процесса» (критерий 2)

`test/unit/no-process-literals.test.ts`:

1. Собрать идентификаторы и `title` этапов и агентов из всех `test/fixtures/policies/valid/*.md`, включая фикстуру, повторяющую пример из раздела 8.1 исходной спецификации.
2. Пройти по `src/**/*.{ts,tsx}` через TypeScript compiler API и собрать все строковые и шаблонные литералы.
3. Упасть, если какой-то литерал равен идентификатору этапа или агента либо содержит `title` этапа.

## 5. Чек-лист приёмки

| # | Критерий (раздел 28) | Проверка |
|---|---|---|
| 1 | Нет/нечитаем/пуст/невалиден `SDLC.md` → exit 2 до меню | unit `policy-loader` + integration для каждой команды |
| 2 | Нет названий этапов и графа в исходниках | §4.4 |
| 3 | Изменение этапов не требует пересборки | e2e на двух разных Policy с одним `dist/` |
| 4 | Меню: создание и список незавершённых | ink-тест меню, integration 18 |
| 5 | Продолжение с сохранённого состояния и сессий | integration 5, 23 |
| 6 | Минимум две независимые незавершённые задачи | integration 18 |
| 7 | Второй процесс не меняет состояние | integration 19, unit `lock-manager` |
| 8 | Агент не меняет stage | набор tools агента (unit), guard (unit), integration 22 |
| 9 | После агента всегда supervisor | integration 4, 15; unit фаз |
| 10 | Supervisor читает актуальный `SDLC.md`, видит только объявленные переходы | snapshot evaluation prompt; integration 10, 17 |
| 11 | Проверить, продолжить, перезапустить, спросить, заблокировать, перейти | integration 2, 5, 6, 7, 9 |
| 12 | Заявление без результата не даёт перехода | guards (integration 11); `evidence: required` с неразрешимой ссылкой отклоняется |
| 13 | После transition агент нового этапа стартует сам | integration 2 |
| 14 | Цикл до terminal / block / cancel / остановки | integration 3, 9, 20, 23; ожидание внешних событий без участия человека — 24–28 |
| 15 | На экране task, stage title, agent, активность | ink-тест `run-screen` |
| 16 | Восстановление без потери stage и истории | integration 12–16 |
| 17 | `discover → execute → done` без изменения кода | e2e §4.3 |

Критерий 12 исходной спецификации в общем виде проверить нельзя: «фактический результат» оценивает модель. Механическая гарантия — guards и разрешимость evidence refs, остальное — качество инструкций supervisor-а в Policy.
