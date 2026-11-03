# План: реальное переключение моделей supervisor-а и корректный cooldown лимитов

## 1. Диагностика (подтверждена данными APD-1264)

### Что говорит журнал задачи
Из `events.jsonl` задачи `APD-1264` (циклы 16–19) видно идеально ровный цикл:

```
model.exhausted openai-codex/gpt-5.6-sol          reason: "Codex error: The usage limit has been reached"
model.fallback  -> claude-bridge/claude-opus-5-5
model.exhausted claude-bridge/claude-opus-5-5     reason: "Codex error: The usage limit has been reached"
model.fallback  -> antigravity/gemini-3.8-flash-medium
model.exhausted antigravity/gemini-3.8-flash-medium reason: "Codex error: The usage limit has been reached"
model.fallback  -> openai-codex/gpt-5.6-luna
model.exhausted openai-codex/gpt-5.6-luna         reason: "Codex error: The usage limit has been reached"
wait.scheduled  delayMinutes: 30
```

Два признака подделки:
1. Все четыре модели падают с **одним и тем же** текстом `Codex error: ...`, хотя `claude-bridge` и
   `antigravity` — вообще другие провайдеры и не могут вернуть ошибку Codex.
2. Вся «цепочка fallback» прогорает за **1–4 секунды**: реальных сетевых вызовов не было.

### Что говорит файл сессии supervisor-а
В `.teo/tasks/APD-1264/sessions/supervisor.jsonl` **все 74 assistant-сообщения** записаны с
`provider: openai-codex, model: gpt-5.6-sol`. Ни одного запроса к `claude-bridge` или
`antigravity` не было никогда — несмотря на записи `model.fallback` в журнале.

### Причина №2 (переключения моделей не происходит) — `SessionPool.open`
`src/agents/session-pool.ts`:

```typescript
async open(spec: SessionSpec): Promise<AgentSessionHandle> {
  const existing = this.sessions.get(spec.file);
  if (existing) return existing;      // <-- модель из spec игнорируется
  const handle = await this.runtime.openSession(spec);
  ...
}
```

Сессии кешируются **только по пути файла**, а `spec.model` при попадании в кеш отбрасывается.
Для supervisor-а путь всегда один и тот же — `sessions/supervisor.jsonl`
(`supervisorSessionSpec`, `src/agents/session-spec.ts:62`). Поэтому в ветке fallback
(`src/workflow/supervisor-step.ts:317`):

```typescript
const spec = supervisorSessionSpec(core, nextModel);
const handle = await core.pool.open(spec);   // вернулся СТАРЫЙ handle с исчерпанной моделью
core.pool.start(key, handle, prompt, ...);
```

возвращается прежний handle, созданный с уже исчерпанной `gpt-5.6-sol`. Запрос уходит в ту же
мёртвую сессию, мгновенно получает ту же ошибку Codex, и следующая модель цепочки помечается
исчерпанной, хотя её никто не спрашивал. То же самое касается и обычного старта цикла
(`supervisor-step.ts:254`): выбранная `selectSupervisorModel` модель не применяется, пока жив
процесс Pi.

Итог: цепочка моделей в `models.md` в режиме расширения **не работала ни разу**; работала только
подмена модели для роли пользовательской сессии (там используется `pi.setModel`, и это корректно).

### Причина №1 (таймер 30 минут вместо реального срока)
`parseResetCooldownMs` (`src/util/model-exhaustion.ts`) умеет разбирать только
`retry-after: N`, `in XmYs`, `in Xs`. Сообщение Codex о лимите —
`"Codex error: The usage limit has been reached"` — **не содержит времени сброса вообще**.
Парсер возвращает `null`, и берётся `DEFAULT_COOLDOWN_MS = 30 минут`.

Дальше получается вечный цикл: ждём 30 минут → `wait.finished (due)` → supervisor стартует →
мгновенно прогорает вся цепочка → снова 30 минут. В журнале это видно для циклов 17, 18, 19.

### Можно ли отличить недельный лимит от 5-часового? Сейчас — нет
Проверено:
- Teo получает от Pi только строку `RunOutcome.error.message`; окна и времени сброса в ней нет.
- Pi умеет вычислить срок, но теряет его: в `pi-ai/dist/api/openai-codex-responses.js:1256`
  строится `friendlyMessage = "...Try again in ~N min."` из `err.resets_at`, но следующая строка —
  `message = err.message || friendlyMessage || message`, и при наличии `err.message` тайминг
  выбрасывается. Дефект в pi-ai, не в Teo.
- Заголовки `retry-after` / `x-codex-*`, различающие primary (5 ч) и secondary (неделя), pi-ai
  читает только для внутренних ретраев и наружу не отдаёт.
- Эндпоинт `https://chatgpt.com/backend-api/codex/usage` (его использует расширение
  `pi-chatgpt-usage-status`; отдаёт `primary_window` = 5 ч и `secondary_window` = неделя с
  `reset_at`) сейчас отвечает **403 + HTML Cloudflare**. Проверено через Node `fetch` и Python,
  с разными UA/заголовками; токен валиден, соседний `/codex/responses` отвечает 405 — заблокирован
  именно этот путь.
- Локальных снапшотов лимитов в `~/.codex` (`state_5.sqlite`, `logs_2.sqlite`) нет.

Вывод: название окна определить нельзя, но оно и не нужно — нужен момент, когда можно снова
работать. Его находим пробой (§2.4), а не угадыванием.

---

## 2. Согласованные изменения

### 2.1. Пул сессий учитывает модель (`src/agents/session-pool.ts`)
- Хранить рядом с handle id модели и уровень thinking, с которыми сессия открыта.
- В `open(spec)` сравнивать `spec.model.id`/`thinking` с моделью кешированной сессии. При
  несовпадении — `dispose()` старого handle и открытие новой сессии **на том же файле**
  (транскрипт на диске сохраняется, история не теряется — так же, как при перезапуске процесса).
- Добавить явный `reopen(spec)` и использовать его в ветке fallback supervisor-а.
- Одно изменение закрывает оба места (`supervisor-step.ts:254` и `:317`) и снимает тот же
  латентный дефект на стороне агента (`agent-step.ts:255`).

### 2.2. Не помечать исчерпанной модель, которую не вызывали (`src/workflow/supervisor-step.ts`)
- Записывать `model.exhausted` только для модели, реально вернувшей ошибку: сверять модель
  последнего ответа сессии с `mem.modelUsed`. Если переключение не применилось — не помечать.
- В `model.fallback` добавить признак «модель применена», чтобы расхождение было видно в журнале.

### 2.3. Cooldown на весь провайдер (решение пользователя)
- `ModelCooldownTracker` получает уровень `provider`: ошибка `usage limit` от провайдера кладёт на
  cooldown **все** его модели (`openai-codex/*` целиком). Недельный лимит Codex — на аккаунт,
  поэтому пробовать `gpt-5.6-luna` после `gpt-5.6-sol` бессмысленно.
- `isExhausted(provider, modelId)` проверяет сначала запись провайдера, затем запись модели.
- Запись уровня модели остаётся для случаев, когда лимит действительно на модель
  (`model_not_found`-подобные квоты, отдельные per-model rate limits).

### 2.4. Срок ожидания: проба вместо угадывания
- Если провайдер прислал срок — использовать его. Расширить `parseResetCooldownMs`:
  часы и сутки (`in 5 hours`, `in 2 days`, `через 2 дня`), `Try again in ~N min`,
  абсолютное время (`resets at <ISO>`, `will reset at ...`, HTTP-date в `Retry-After`).
  Отрицательные и абсурдные значения отбрасывать.
- Если срока нет — **канареечная проба** провайдера по нарастающему графику:
  15 мин → 30 мин → 1 ч → 2 ч → 4 ч → 8 ч → 24 ч (крышка). Проба — один короткий запрос, а не
  полный цикл supervisor-а: 5-часовое окно отпустит на первом-втором шаге, недельное обойдётся
  дешёво вместо прогорания всей цепочки каждые 30 минут.
- График сбрасывается после успешного вызова провайдера.
- Опортунистически пробовать `chatgpt.com/backend-api/codex/usage`: при 200 брать точный
  `reset_at` (`secondary_window` — неделя, `primary_window` — 5 ч) и показывать настоящий отсчёт;
  при 403/ошибке молча уходить на график проб. Токен читать из `~/.pi/agent/auth.json`,
  в логи и сообщения не выводить.

### 2.5. Хранение cooldown на диске и ручной сброс (решение пользователя)
- Файл **глобальный**: `~/.pi/teo/model-cooldowns.json`. Лимиты принадлежат аккаунту, а не
  репозиторию, и несколько проектов должны видеть один и тот же cooldown.
- Формат: записи `{ provider, modelId | null, exhaustedUntil, attempt, reason, recordedAt }`.
  Причину редактировать через `redact`, токенов не хранить.
- Запись атомарная (tmp + rename), устойчивая к повреждению файла: битый файл — не ошибка,
  трактуется как пустой cooldown.
- Команды CLI:
  - `teo models cooldown` — показать активные cooldown-ы, срок и номер попытки;
  - `teo models reset [<provider>[/<model>]]` / `--all` — снять cooldown вручную.

### 2.6. Прозрачность в UI (`src/extension/host.ts`, `src/ui/messages.ts`)
- В статус-баре и в сообщении об ожидании указывать, **что именно** исчерпано (провайдер или
  модель) и до какого времени, вместо общего «сброс лимита модели supervisor-а».
- При реальном переключении на резервную модель писать в ленту чата, на какую модель перешли.
- Если срок неизвестен, писать честно: «срок сброса провайдером не сообщён, следующая проверка
  через …», а не показывать выдуманный обратный отсчёт.

---

## 3. План тестирования

1. **Unit (`test/unit/model-exhaustion.test.ts`)**: разбор `in 2 days`, `in 5 hours`,
   `Try again in ~N min`, `will reset at <ISO>`, HTTP-date; нарастающий график проб и его сброс
   после успеха; cooldown уровня провайдера перекрывает все его модели.
2. **Unit (новый тест пула)**: `open(spec)` с другой моделью на том же файле возвращает новый
   handle, старый получает `dispose()`, путь файла сессии не меняется.
3. **Unit (хранилище cooldown)**: round-trip записи/чтения, атомарность, битый файл = пустой,
   ручной сброс по провайдеру и по модели.
4. **Интеграционный (`test/integration/model-profiles.test.ts`)**: цепочка supervisor-а, где
   первая модель отдаёт `usage limit`, — проверить, что второй запрос ушёл **во вторую модель**
   (а не в ту же сессию) и что `wait` не планируется, пока в цепочке есть живые провайдеры.
5. **Интеграционный (CLI)**: `teo models cooldown` и `teo models reset`.
6. **Проверка на стенде**: после `/reload` убедиться по `sessions/supervisor.jsonl`, что в
   транскрипте появились сообщения с `provider`, отличным от `openai-codex`.

---

## 4. Второй раунд: ошибка провайдера не должна блокировать задачу

После первого раунда fallback впервые заработал по-настоящему — и сразу вскрылась проблема,
которую прежний баг маскировал: до второй модели цепочки запрос раньше не доходил.

### 4.1. Что случилось (APD-1264, цикл 27)
```
model.exhausted  openai-codex/gpt-5.6-sol  scope=provider known=False attempt=1
model.fallback   gpt-5.6-sol -> claude-bridge/claude-opus-5  applied=True
supervisor.protocol_error
task.blocked     SUPERVISOR_NO_DECISION: prompt-capture: no capture for this 10173-char system prompt
```
`applied: true` — переключение состоялось. Но claude-bridge вернул `prompt-capture: no capture`.

### 4.2. Почему claude-bridge не может обслужить supervisor
`pi-claude-bridge` — не API-провайдер, а мост к Claude Code. Он проецирует в SDK системный промпт,
записанный его хуком `before_agent_start`. Хранилище капч process-global
(`globalThis[SHARED_CAPTURES_KEY]`), но наполняют его только сессии, где расширение загружено.
Сессия supervisor-а создаётся через SDK и всегда с `noExtensions: true`
(`pi-agent-runtime.openSession:170`, жёстко для роли supervisor) — капчи для её промпта
(10 173 симв.) не существует. Две известные капчи (18 129 симв.) — из пользовательской
TUI-сессии, расходятся на 208-м символе.

Для ролей этапов тот же провайдер работает штатно: они идут в пользовательской сессии Pi.
`pi-antigravity` самодостаточен (берёт промпт из контекста запроса) и supervisor обслуживает.

### 4.3. Дефект в движке
Fallback по цепочке срабатывал только внутри `isModelExhaustedError`. Ошибка не про лимит →
technical retries → `SUPERVISOR_NO_DECISION`, хотя в цепочке оставалась живая antigravity.

### 4.4. Сделано
- `switchToNextModel` вынесена из ветки лимита: общий путь для двух причин
  (`cause: "exhausted" | "provider_error"`).
- Устойчивая ошибка провайдера (после `technicalRetries`) → событие `model.unusable`,
  модель выводится из цепочки до перезапуска процесса, цикл продолжается на следующей.
  Cooldown при этом не ставится: это не лимит аккаунта.
- `SUPERVISOR_NO_DECISION` возникает только когда живых моделей в цепочке не осталось.
- `src/agents/pi/provider-traits.ts`: `PROVIDERS_NEEDING_SESSION_EXTENSION = ["claude-bridge"]`.
  `selectSupervisorModel` пропускает такие провайдеры без холостой попытки.
- `teo doctor` предупреждает, если провайдер-мост стоит в цепочке роли `supervisor`,
  с объяснением причины и подсказкой. Для ролей этапов предупреждения нет.
- `~/.pi/teo/models.md`: claude-bridge убран из роли supervisor (бэкап рядом).

### 4.5. Проверено
Новые тесты падают на прежнем поведении ровно с тем же `SUPERVISOR_NO_DECISION`
и текстом `prompt-capture`, что увидел пользователь, и проходят на новом.
