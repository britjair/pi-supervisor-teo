# sdlc-cli

CLI `sdlc` ведёт задачу через SDLC-процесс, описанный в `~/.pi/SDLC.md`. Агенты и supervisor работают через Pi SDK 1.4.0. Спецификация — [docs/](docs/README.md), исходные цели — [SDLC_CLI_SPEC.md](SDLC_CLI_SPEC.md).

## Статус

Готовы этапы M1–M4 ([docs/06-implementation.md §3](docs/06-implementation.md#3-этапы-реализации)):

- загрузчик и валидатор Policy (`src/policy/`): preflight, front matter, схема, граф, hash, структурный diff, снимки;
- хранилище `.sdlc/` (`src/state/`): атомарная запись, `state.json` с инвариантами и outbox, журнал событий с ремонтом хвоста, обнаружение подмены state, `index.json`, project lock с takeover и heartbeat;
- команды `sdlc` (меню, пока линейное), `new` (создаёт и запускает задачу; `--no-run` создаёт без запуска), `resume`, `status`, `history`, `cancel`, `doctor` (включая SDK/модели/авторизацию; без `--fix`);
- движок M3: фазы, решения supervisor-а, вопросы человеку, ожидание и перепроверка, изменение Policy, recovery и fault-injection;
- интеграция Pi SDK 1.4.0 (M4): модель, сессии и их инспекция, TypeBox-адаптер инструментов, inline guard, plain-вывод хода CLI. `recover` в CLI пока заглушка; Ink — M5, полный `recover` — M6.

## Разработка

На хост ничего не ставится: Node, зависимости, сборка и тесты живут в контейнере (Docker / OrbStack / Colima). Pi SDK зафиксирован на 1.4.0; его транзитивный `undici` переопределён на исправленную версию 8.12.3 (`npm audit`: 0 проблем). Образ — `docker/dev.Dockerfile` (Node 26.12.1 — та же версия, что у Node из Homebrew, на котором работает `pi`, плюс git). `node_modules` и кэш npm лежат в именованных volume `sdlc-cli-node-modules` и `sdlc-cli-npm-cache`, поэтому каталог `node_modules/` на хосте пустой.

```bash
scripts/dev.sh npm ci            # зависимости по lockfile
# Контекст docker закреплён в scripts/dev.sh: orbstack (переопределяется SDLC_DEV_DOCKER_CONTEXT)
scripts/dev.sh npm run check     # typecheck + lint + build + тесты
scripts/dev.sh npm test          # обычные тесты, e2e пропущен
scripts/e2e.sh                   # платный e2e через реальную модель Pi; временная копия auth/config
SDLC_DEV_REBUILD=1 scripts/dev.sh true   # пересобрать образ
```

Проверить свою Policy, не трогая `~/.pi`, можно на копии:

```bash
scripts/dev.sh sh -c 'mkdir -p /tmp/h/.pi && cp examples/SDLC.md /tmp/h/.pi/SDLC.md && HOME=/tmp/h node dist/cli.js doctor'
```

### Тесты

- `test/fixtures/policies/invalid/<CODE>.md` — по фикстуре на каждую ошибку. Маркер `# expect: CODE` стоит на строке, где должна сообщаться ошибка: тест сверяет коды и номера строк со всеми маркерами. `# expect-unlocated: CODE` — ошибка без номера строки.
- `test/fixtures/policies/valid/` и `examples/SDLC.md` должны загружаться. Предупреждения отмечаются маркером `# warn: CODE`.
- `test/unit/no-process-literals.test.ts` (критерий приёмки 2): ни один строковый литерал в `src/` не совпадает с id этапа или агента из фикстур и не содержит название этапа.
- Тесты хранилища `test/integration/storage-cli.test.ts` запускают собранный `dist/cli.js` с подменённым `HOME` и `TZ=UTC`. Сбой в именованной точке включается переменной `SDLC_FAULT=after-state-commit:kill` (D27): так тест убивает процесс между записью state и журналом.
- `test/integration/engine-*.test.ts` прогоняют движок на `FakeAgentRuntime` с временным проектом и инъекцией сбоя в каждой именованной точке каждого её прохождения; отдельные unit-тесты проверяют guard, evidence и остановку активной сессии.
- Меню и формы тестируются in-process через `ScriptedHumanIO` (`test/helpers/`).
- `scripts/e2e.sh` монтирует только нужные файлы из `~/.pi/agent` **read-only**, копирует их во временный контейнер и удаляет список установленных пакетов/расширений из копии настроек. Исходный `~/.pi` не изменяется. Для другого источника: `SDLC_E2E_AGENT_DIR=<каталог> scripts/e2e.sh`. E2E делает реальные вызовы модели и может стоить денег.

## Запуск на хосте (открытый вопрос Q4)

`sdlc` должен работать на хосте, потому что ему нужны проект, `~/.pi` и те же Docker и git, что у агентов. Предложение (решим до этапа выпуска M6):

1. Новый Node ставить не нужно: Node 26.12.1 из Homebrew на хосте уже есть, это зависимость `pi`.
2. Путь распространения ещё не выбран. Проверка в M4 нашла в зависимости Pi (`@earendil-works/pi-tui`) платформенные `.node`-файлы, включая готовые сборки для macOS; просто переносить Linux-установку `node_modules` на macOS **нельзя**. Возможные варианты M6: собирать macOS-дерево зависимостей в контейнере с проверкой платформенных пакетов или использовать SDK из установленного Homebrew-пакета `pi`. Последний вариант связывает sdlc с раскладкой Homebrew.
3. Без `npm link` и глобальной установки: запуск `node ~/code/sdlc-cli/dist/cli.js`, команду `sdlc` даёт alias, который вы добавите в свой `~/.zshrc`.
