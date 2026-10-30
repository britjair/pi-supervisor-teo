# pi-supervisor-teo

CLI и расширение Pi `teo` ведут задачи по процессам из `~/.pi/teo/<процесс>.md`: разработка, подбор автомобиля, любой другой процесс с этапами, ролями и проверяемыми переходами. Агенты и supervisor работают через Pi SDK 1.4.0. План режима расширения — [docs/07-extension-mode.md](docs/07-extension-mode.md). Спецификация — [docs/](docs/README.md), исходные цели — [SDLC_CLI_SPEC.md](SDLC_CLI_SPEC.md).

## Статус

Готовы этапы M1–M6 ([docs/06-implementation.md §3](docs/06-implementation.md#3-этапы-реализации)), R1 (переименование), R2 (несколько процессов), G1 (режим цели), X1–X4 из [docs/07-extension-mode.md §6](docs/07-extension-mode.md#6-этапы-реализации):

- расширение Pi (X1–X4): тот же пакет содержит `dist/extension.js`; работают `/teo start`, `/teo goal`, `/teo resume`, `/teo next`, `/teo pause`, `/teo recover`, `/teo stop`, `/teo status`, `/teo history` и `/teo help`. Задача привязывается к сессии Pi, процесс держит project lock, роль/инструменты/модель берутся из текущего этапа Policy, сообщения пользователя пишутся в журнал. В конце каждого хода отдельная supervisor-сессия проверяет evidence и применяет решение. `userSession: new` переносит этап в дочернюю Pi-сессию, ожидания продолжаются таймером, пауза возвращает обычное окружение Pi, а оборванный ход восстанавливается при `session_start`;

- режим цели (G1): `teo new KEY --goal "…"` или пункт «Цель» в форме — задача без своего процесса по встроенному шаблону `processes/goal.md`; работает и без единого файла в `~/.pi/teo/`;

- несколько процессов (R2): каталог `~/.pi/teo/`, задача запоминает процесс (`state.process`), `teo new --process`, выбор процесса в форме, колонка процесса в меню и сводках; невалидный или удалённый процесс помечается ⚠ и не мешает задачам других процессов;

- загрузчик и валидатор Policy (`src/policy/`): preflight, front matter, схема, граф, hash, структурный diff, снимки;
- хранилище `.teo/` (`src/state/`): атомарная запись, `state.json` с инвариантами и outbox, журнал событий с ремонтом хвоста, обнаружение подмены state, `index.json`, project lock с takeover и heartbeat, `debug.log` (последний процесс, ротация в `.1`, ≤ 5 MB);
- команды `teo` (Ink-меню в TTY, линейный режим для pipe/`--plain`), `new` (создаёт и запускает задачу; `--no-run` создаёт без запуска), `resume`, `status`, `history`, `cancel`, `recover`, `doctor [--fix]`;
- движок M3: фазы, решения supervisor-а, вопросы человеку, ожидание и перепроверка, изменение Policy, recovery и fault-injection;
- интеграция Pi SDK 1.4.0 (M4): модель, сессии и их инспекция, TypeBox-адаптер инструментов, inline guard;
- TUI M5: один Ink root для меню, форм, потока событий, human prompt и ожидания; `Ctrl+C` с подтверждением во время хода, `t` для thinking, `s` для статуса, `Enter`/`m`/`q` в ожидании; plain-репортёр в формате `docs/05-cli-ui.md §5`;
- hardening M6:
  - redaction каждого payload события перед записью (ответ в нативном диалоге — дословно; обычное сообщение чата расширения проходит redaction) и расширенный набор форматов: OpenAI/Anthropic, Stripe, GitHub, GitLab, Slack, AWS, Google, Atlassian, npm, PyPI, Docker Hub, Hugging Face, SendGrid, Telegram, JWT, PEM/OpenSSH/PGP, заголовки `Authorization`, пароли в URL, присваивания `*_TOKEN=…`/`"password": …`; счётчики `inputTokens` и т. п. не скрываются;
  - `teo recover` для всех ситуаций `docs/05-cli-ui.md §2.1`: выбор этапа, принятие новой Policy, подмена state (показ diff, «восстановить state до подмены» или «принять как есть»), повреждённая сессия агента (restart / supervisor / блокировка), разблокировка с комментарием; флаги `--set-stage` и `--accept-policy` — без меню;
  - `teo doctor --fix`: по одному исправлению с подтверждением — протухший lock, lock другого хоста (только явным «да»), `.gitignore`, осиротевшие `*.tmp`, хвост журнала и outbox, `index.json`. Без терминала выполняются только безопасные исправления.

### Чек-лист приёмки ([docs/06-implementation.md §5](docs/06-implementation.md#5-чек-лист-приёмки))

| # | Чем проверяется |
|---|---|
| 1 | `test/unit/policy-loader.test.ts`, `test/integration/cli-preflight.test.ts` (каждая команда × каждая ошибка Policy) |
| 2 | `test/unit/no-process-literals.test.ts` |
| 3 | `test/e2e/pi-smoke.test.ts`: две Policy с разными этапами и агентами на одном `dist/` |
| 4, 6, 15 | `test/unit/ink-ui.test.tsx`, `test/unit/ink-human-io.test.tsx`, `test/integration/storage-cli.test.ts`, сценарий 18 |
| 5, 16 | сценарии 5, 12–16, 23 (`test/integration/engine-*.test.ts`) |
| 7 | сценарий 19, `test/unit/lock-manager.test.ts` |
| 8 | guard и набор tools агента, сценарий 22 |
| 9, 11, 13, 14 | `engine-basic`, сценарии 4–7, 9, 15, 20, 23–28 |
| 10 | `test/unit/prompts.test.ts`: snapshot-ы промптов на двух Policy, сценарии 10, 17 |
| 12 | guards: сценарий 11, `test/unit/agent-guard-evidence.test.ts` |
| 17 | e2e `discover → execute → done` |

## Разработка

На хост ничего не ставится: Node, зависимости, сборка и тесты живут в контейнере (Docker / OrbStack / Colima). Pi SDK зафиксирован на 1.4.0; его транзитивный `undici` переопределён на исправленную версию 8.12.3 (`npm audit`: 0 проблем). Образ — `docker/dev.Dockerfile` (Node 26.12.1 — та же версия, что у Node из Homebrew, на котором работает `pi`, плюс git). `node_modules` и кэш npm лежат в именованных volume `pi-supervisor-teo-node-modules` и `pi-supervisor-teo-npm-cache`, поэтому каталог `node_modules/` на хосте пустой.

```bash
scripts/dev.sh npm ci            # зависимости по lockfile
# Контекст docker закреплён в scripts/dev.sh: orbstack (переопределяется TEO_DEV_DOCKER_CONTEXT)
scripts/dev.sh npm run check     # typecheck + lint + build + тесты
scripts/dev.sh npm test          # обычные тесты, e2e пропущен
scripts/e2e.sh                   # платный e2e через реальную модель Pi; временная копия auth/config
TEO_DEV_REBUILD=1 scripts/dev.sh true   # пересобрать образ
```

Проверить свой процесс, не трогая `~/.pi`, можно на копии:

```bash
scripts/dev.sh sh -c 'mkdir -p /tmp/h/.pi/teo && cp examples/processes/*.md /tmp/h/.pi/teo/ && HOME=/tmp/h node dist/cli.js doctor'
```

### Тесты

- `test/fixtures/policies/invalid/<CODE>.md` — по фикстуре на каждую ошибку. Маркер `# expect: CODE` стоит на строке, где должна сообщаться ошибка: тест сверяет коды и номера строк со всеми маркерами. `# expect-unlocated: CODE` — ошибка без номера строки.
- `test/fixtures/policies/valid/` и `examples/processes/` должны загружаться. Предупреждения отмечаются маркером `# warn: CODE`.
- `test/unit/no-process-literals.test.ts` (критерий приёмки 2): ни один строковый литерал в `src/` не совпадает с id этапа или агента из фикстур и не содержит название этапа.
- Тесты хранилища `test/integration/storage-cli.test.ts` запускают собранный `dist/cli.js` с подменённым `HOME` и `TZ=UTC`. Сбой в именованной точке включается переменной `TEO_FAULT=after-state-commit:kill` (D27): так тест убивает процесс между записью state и журналом.
- `test/integration/engine-*.test.ts` прогоняют движок на `FakeAgentRuntime` с временным проектом и инъекцией сбоя в каждой именованной точке каждого её прохождения; отдельные unit-тесты проверяют guard, evidence и остановку активной сессии.
- Меню и формы тестируются in-process через `ScriptedHumanIO` (`test/helpers/`); Ink-компоненты меню, формы, human prompt, выполнения и ожидания — через `ink-testing-library` в `test/unit/ink-ui.test.tsx`.
- `test/integration/recover.test.ts` — каждая ситуация `teo recover` и флаги через CLI; `test/integration/doctor-fix.test.ts` — исправления `doctor --fix`, отказ, lock другого хоста, живой владелец.
- `test/unit/redact.test.ts` — реальные форматы токенов (собираются из частей, чтобы сканеры секретов не реагировали на фикстуры) и отсутствие ложных срабатываний на хешах, ULID и счётчиках токенов.
- `test/unit/prompts.test.ts` — snapshot-ы промптов в `test/unit/__snapshots__/prompts/` на двух Policy; после осознанного изменения шаблона обновляются через `scripts/dev.sh npx vitest run -u test/unit/prompts.test.ts`.
- `test/integration/processes.test.ts` — несколько процессов: выбор, `--process`, невалидный и удалённый процесс, `doctor` по процессам.
- `test/integration/goal-mode.test.ts` — режим цели: встроенный шаблон, `--goal`, форма, движок на шаблоне цели.
- `test/integration/extension-load.test.ts` — пакет как расширение: настоящий загрузчик Pi, манифест без предупреждений, `/teo` через сессию SDK и через `pi -e <пакет> -p`.
- `test/integration/extension-host.test.ts` — X2 на фейковом `ExtensionAPI`: привязка и восстановление, lock, роль, tools/model, guard, журнал чата, stop.
- `test/integration/extension-supervisor.test.ts` — X3: report tools, settle, отдельный supervisor, continue/restart/transition/ask_human и полный процесс подбора автомобиля в одной сессии; `test/e2e/extension-host.test.ts` — настоящие host-модель и supervisor доводят задачу до terminal.
- `test/integration/extension-lifecycle.test.ts` — X4: `userSession: new`, `/teo next`, таймер recheck, `/teo pause`/resume и recovery после закрытия Pi.
- Полный обычный прогон X4: 50 файлов, 502 теста; реальный Pi e2e: 6 тестов. Отдельно: `scripts/e2e.sh test/e2e/extension-host.test.ts`.
- `scripts/e2e.sh` монтирует только нужные файлы из `~/.pi/agent` **read-only**, копирует их во временный контейнер и удаляет список установленных пакетов/расширений из копии настроек. Исходный `~/.pi` не изменяется. Для другого источника: `TEO_E2E_AGENT_DIR=<каталог> scripts/e2e.sh`. E2E делает реальные вызовы модели и может стоить денег.

## Установка на хост

`teo` работает на хосте: ему нужны проект, `~/.pi` и те же Docker и git, что у агентов. Новый Node не нужен — подходит Node 26.12.1 из Homebrew, на котором уже работает `pi` (нужен ≥ 22.19).

Зависимости ставятся **на той же платформе, где запускается CLI**: в `@earendil-works/pi-tui` есть платформенные `.node`-файлы, поэтому Linux-дерево `node_modules` из контейнера на macOS переносить нельзя. Volume контейнера не пересекается с каталогом `node_modules/` хоста.

Выбран стандартный путь ([docs/06-implementation.md §3, M6](docs/06-implementation.md#m6-hardening-и-выпуск)):

```bash
cd ~/code/pi-supervisor-teo
npm ci && npm run build && npm link   # команда teo появляется в /opt/homebrew/bin
```

`npm link` ссылается на рабочую копию: после `git pull` достаточно `npm ci && npm run build`. Удалить: `npm unlink -g pi-supervisor-teo`. Pi SDK — dev-зависимость пакета (для расширения Pi подставляет свой), поэтому `npm ci` — без `--omit=dev`.

Расширение Pi из того же каталога (после `npm run build`):

```bash
pi -e ~/code/pi-supervisor-teo        # попробовать в одной сессии, без установки
pi install ~/code/pi-supervisor-teo   # подключить насовсем (пишет в ~/.pi/agent/settings.json)
```

В сессии: `/teo start [KEY]`, `/teo goal <цель>`, `/teo resume KEY`, `/teo next`, `/teo pause`, `/teo recover KEY`, `/teo stop`, `/teo status`, `/teo history KEY`, `/teo help`.

Затем:

```bash
mkdir -p ~/.pi/teo
cp examples/processes/dev.md ~/.pi/teo/dev.md                       # процесс разработки
cp examples/processes/car-selection.md ~/.pi/teo/car-selection.md   # тестовый процесс подбора автомобиля
cd <проект> && teo doctor            # процессы, Pi SDK, модели, авторизация, хранилище
teo                                  # меню: создать или продолжить задачу
```

Эти команды выполняет пользователь: при разработке на хост ничего не ставилось, установка на macOS не запускалась.
