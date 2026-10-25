# sdlc-cli

CLI `sdlc` ведёт задачу через SDLC-процесс, описанный в `~/.pi/SDLC.md`. Агенты и supervisor работают через Pi SDK 1.4.0. Спецификация — [docs/](docs/README.md), исходные цели — [SDLC_CLI_SPEC.md](SDLC_CLI_SPEC.md).

## Статус

Реализован этап M1 ([docs/06-implementation.md §3](docs/06-implementation.md#3-этапы-реализации)):

- загрузчик и валидатор Policy (`src/policy/`): preflight, front matter, схема, граф, hash, структурный diff, снимки;
- определение project root;
- `sdlc doctor` — окружение, Policy, project root. Проверки Pi появятся в M4, хранилища — в M2;
- остальные команды выполняют preflight Policy и сообщают, что ещё не реализованы.

## Разработка

На хост ничего не ставится: Node, зависимости, сборка и тесты живут в контейнере (Docker / OrbStack / Colima). Образ — `docker/dev.Dockerfile` (Node 26.12.1 — та же версия, что у Node из Homebrew, на котором работает `pi`, плюс git). `node_modules` и кэш npm лежат в именованных volume `sdlc-cli-node-modules` и `sdlc-cli-npm-cache`, поэтому каталог `node_modules/` на хосте пустой.

```bash
scripts/dev.sh npm ci            # зависимости по lockfile
scripts/dev.sh npm run check     # typecheck + lint + build + тесты
scripts/dev.sh npm test          # только тесты (dist/ собирается перед ними)
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
- `test/integration/cli-preflight.test.ts` запускает собранный `dist/cli.js` с подменённым `HOME`.

## Запуск на хосте (открытый вопрос Q4)

`sdlc` должен работать на хосте, потому что ему нужны проект, `~/.pi` и те же Docker и git, что у агентов. Предложение (решим до этапа выпуска M6):

1. Новый Node ставить не нужно: Node 26.12.1 из Homebrew на хосте уже есть, это зависимость `pi`.
2. Сборка в контейнере выдаёт готовый к запуску каталог: `dist/cli.js` с вшитыми чистыми JS-зависимостями (commander, yaml, zod, ink, react) и рядом `dist/node_modules` только для Pi SDK (`npm ci --omit=dev` в контейнере). В M4 нужно проверить, что в дереве Pi 1.4.0 нет нативных `.node`-аддонов: wasm и JS одинаково работают на Linux и macOS. Альтернатива — брать SDK из установленного Homebrew-пакета `pi`. Тогда версия SDK совпадает с CLI автоматически (D14), но sdlc завязывается на раскладку Homebrew.
3. Без `npm link` и глобальной установки: запуск `node ~/code/sdlc-cli/dist/cli.js`, команду `sdlc` даёт alias, который вы добавите в свой `~/.zshrc`.
