# 03. Workflow engine: фазы, цикл, решения, recovery

Детализирует разделы 15–19 [SDLC_CLI_SPEC.md](../SDLC_CLI_SPEC.md). Определения типов — в [02-storage.md](02-storage.md#3-statejson).

## 1. Идея

Движок — конечный автомат над полем `state.phase`. Каждый шаг:

1. загружает state (с outbox-flush и проверкой инвариантов);
2. по `phase` выбирает **один** обработчик;
3. обработчик выполняет работу и фиксирует результат одним `commit`.

Между шагами процесс может умереть в любой точке. Следующий запуск продолжит с той фазы, которая записана в state. Поэтому отдельная «таблица восстановления» почти не нужна: recovery — это обработчики фаз `*_running`, выполненные при старте (§8).

SDLC-этапы (`state.stage`) и фазы движка ортогональны. Фазы одинаковы для любого workflow; этапы приходят из Policy.

## 2. Фазы

```text
                ┌──────────────────────────────────────────────────────────┐
                │                                                          │
 task.created   ▼        start/continue          settle / report            │
 ─────────► agent_pending ──────────► agent_running ──────────► supervisor_pending
                ▲                          │                         │
                │                          │ ask_user (sync, внутри   │ cycle start
                │                          │ run, фаза не меняется)   ▼
                │                                             supervisor_running
                │                                                    │ control tool
                │                                                    ▼
                │         continue / restart / transition     decision_pending
                └────────────────────────────────────────────────────┤
                                                                     │ ask_human
                         answer                                      ▼
   supervisor_pending ◄─────────────────────────────────────── human_pending
                                                                     
   transition → terminal stage / block_task / cancel_task ───────► halted

   decision_pending ── schedule_recheck ──► waiting ── срок / «проверить сейчас» ──► agent_pending (kind recheck)
                                               └──── сообщение человека ────────────► supervisor_pending
```

| Phase | Обработчик | Commit по завершении |
|---|---|---|
| `agent_pending` | `AgentStep.start()` | перед prompt: `agent_running` + `agent.started`/`agent.prompted` |
| `agent_running` | `AgentStep.await()` | `supervisor_pending` + `agent.settled` (или `agent.failed`) |
| `supervisor_pending` | `SupervisorStep.start()` | `supervisor_running` + `supervisor.started`, `supervisor.cycle++` |
| `supervisor_running` | `SupervisorStep.await()` | решение → `decision_pending` + `supervisor.decision`; протокольная ошибка → `halted/blocked` |
| `decision_pending` | `DecisionExecutor.apply()` | эффекты решения + `decision.applied` |
| `human_pending` | `HumanStep.ask()` | `supervisor_pending` + `human.responded` |
| `waiting` | `WaitStep.await()` (§12) | срок наступил → `agent_pending { kind: recheck }` + `wait.finished`; сообщение человека → `supervisor_pending` + `human.responded`, `wait.finished` |
| `halted` | — | цикл завершается |

Перед обработчиками `agent_pending` и `supervisor_pending` выполняется проверка Policy (§7). Во время `*_running` Policy не перечитывается.

## 3. Основной цикл

```ts
async function runTask(taskKey: string, ctx: EngineContext): Promise<ExitOutcome> {
  await recovery.onOpen(taskKey, ctx);                 // §8: interrupted → нормальная фаза, task.resumed

  while (true) {
    ctx.signal.throwIfAborted();                       // Ctrl+C / SIGTERM, §9
    const state = await store.load(taskKey);

    switch (state.phase) {
      case "halted":             return outcomeFor(state);   // terminal → 0, blocked/cancelled → см. 05-cli-ui
      case "agent_pending":      await policyGate(state, ctx); await agentStep.start(state, ctx); break;
      case "agent_running":      await agentStep.await(state, ctx); break;
      case "supervisor_pending": await policyGate(state, ctx); await supervisorStep.start(state, ctx); break;
      case "supervisor_running": await supervisorStep.await(state, ctx); break;
      case "decision_pending":   await decisionExecutor.apply(state, ctx); break;
      case "human_pending":      await humanStep.ask(state, ctx); break;   // non-TTY → возврат outcome waiting_human
      case "waiting":            await waitStep.await(state, ctx); break;  // --no-wait до срока → outcome waiting_recheck
    }
  }
}
```

Отличия от псевдокода раздела 16 исходной спецификации:

- ответ человека ведёт к supervisor, а не к агенту: supervisor сам решает, что делать с ответом (обычно `continue_current_agent` с текстом ответа). Это сохраняет правило «каждое продвижение — решение supervisor»;
- агент запускается не каждой итерацией, а только из фазы `agent_pending`, которую выставляет решение supervisor или transition. Нет вопроса «запускать ли этап заново»;
- `start` и `await` разделены. `*_running` в state означает «работа могла начаться», и recovery знает, что проверять.

Внутри одного процесса `start` и `await` выполняются подряд: `start` коммитит `*_running`, отправляет prompt и возвращает управление; следующая итерация попадает в `await` той же живой сессии. Живые Pi-сессии держит `SessionPool` процесса: `await` берёт сессию из пула, а при её отсутствии (после рестарта процесса) переходит в recovery-ветку (§8).

## 4. Agent step

### 4.1. `agent_pending` → `agent_running`

Вход: `state.nextAgentInput`.

| `kind` | Сессия | Run |
|---|---|---|
| `initial` | По `stage.session`: `fresh` → новая `<agentId>-<NNN+1>.jsonl`; `reuse` → последняя сессия этого агента в задаче | новый `runId`, attempt = NNN |
| `continue` | `currentRun.sessionFile` | тот же run (`currentRun.status = running`) |
| `restart` | новая `<agentId>-<NNN+1>.jsonl` | новый run, `consecutiveRestarts++` |
| `recovery` | `currentRun.sessionFile` | тот же run |
| `recheck` | `currentRun.sessionFile` | тот же run (§12) |

Шаги:

1. Разрешить модель агента. Ошибка → `blocked`, `statusReason.code = MODEL_UNAVAILABLE`.
2. Сформировать prompt (шаблоны — в [04-agents.md](04-agents.md#prompts)) и `promptId` (ULID).
3. `commit`: `phase = agent_running`, `currentRun` обновлён, `promptsSent += promptId`, `nextAgentInput = null`; события `agent.started` (новый run) или `agent.continued` / `agent.restarted`, плюс `agent.prompted`. Создаётся или обновляется `runs/<runId>.json`.
4. Открыть сессию в `SessionPool` и отправить prompt (не дожидаясь завершения).

### 4.2. `agent_running` → `supervisor_pending`

1. Дождаться `RunOutcome` от сессии.
2. Определить `SettleReason`:

| Наблюдение | `SettleReason` |
|---|---|
| в run записан `report.kind = result` | `reported_result` |
| в run записан `report.kind = blocker` | `reported_blocker` |
| `outcome = completed` без отчёта | `unstructured_settle` |
| `outcome = aborted` по таймауту агента | `timeout` |
| `outcome = aborted` по сигналу пользователя | не settle: обработка §9 |
| `outcome = error` (после встроенных ретраев Pi) | `runtime_error` |

3. Для `runtime_error`: если использовано меньше `runtime.technicalRetries` попыток в этом run, подождать `technicalRetryDelaySeconds`, записать `agent.failed { retrying: true }` и вернуть фазу `agent_pending` с `kind = recovery` и текстом «предыдущий запрос завершился ошибкой провайдера, продолжи». Иначе — settle с `runtime_error`.
4. `commit`: `currentRun.status = settled` (или `failed`), `phase = supervisor_pending`, `supervisor.trigger = { kind: "agent_settled", ref: runId }`, событие `agent.settled` (или `agent.failed`). Если последний prompt run-а имел `kind = recheck`, trigger — `recheck_settled` (§12.4).

Каждое завершение агента ведёт к supervisor (критерий приёмки 9), включая `timeout` и `runtime_error`.

### 4.3. Отчёты внутри run

- Первый вызов `report_result` / `report_blocker` в run записывается в `runs/<runId>.json` и в state (`commit` с событием `agent.reported`), затем возвращает модели `terminate: true`.
- Повторный вызов в том же prompt-цикле получает ошибку `ALREADY_REPORTED`.
- После отчёта guard-расширение блокирует все прочие tool calls этого run с `terminate: true` (см. [04-agents.md](04-agents.md#guard-extension)). Так закрыт случай, когда модель вызвала `report_result` пачкой вместе с другими tools: Pi завершает ход, только если `terminate` вернули все tools пачки.
- При `continue` и `recheck` отчёт предыдущего prompt-цикла переносится в `runs/<runId>.json.reportsHistory[]`, и агент может отчитаться заново.

### 4.4. `ask_user` внутри run

Дочерний агент может задать вопрос пользователю синхронно (tool `ask_user`, если `agents.<id>.askUser ≠ false`). Фаза остаётся `agent_running`, а записи такие:

1. `commit`: `status = waiting_human`, `pendingHumanRequest = { origin: "agent", runId, … }`, событие `human.requested`.
2. UI задаёт вопрос (§6).
3. `commit`: `status = active`, `pendingHumanRequest = null`, событие `human.responded`.
4. Tool возвращает агенту ответ и `eventId` ответа.

Поэтому `waiting_human` допустим и при `phase = agent_running`, если `pendingHumanRequest.origin = agent` (инварианты — [02-storage.md §3.2](02-storage.md#32-инварианты-проверяются-при-каждой-загрузке)).

Зачем это нужно. Исходная спецификация позволяла общаться с человеком только supervisor-у. Этап сбора требований — это диалог, и прогон каждого уточняющего вопроса через цикл «агент → report_blocker → supervisor → ask_human → supervisor → continue» стоил бы три модельных вызова на вопрос и рвал бы контекст. При этом ответы всё равно попадают в журнал как `human.responded`, и supervisor может опираться на них как на доказательство (guard `humanResponse`).

## 5. Supervisor step

### 5.1. `supervisor_pending` → `supervisor_running`

1. Проверить лимиты:
   - `runtime.maxCyclesPerStage` (если задан): `stageCycles + 1 > limit` → `blocked` с кодом `STAGE_CYCLE_LIMIT`, без запуска модели. Циклы с trigger `recheck_settled` в `stageCycles` не учитываются: их число ограничено `stage.recheck.maxCount` (§12.5).
2. Сформировать evaluation prompt ([04-agents.md](04-agents.md#supervisor-evaluation-prompt)). Полный текст Policy включается, если `supervisor.lastPolicyHashShown ≠ policyHash` или после compaction supervisor-сессии; иначе только hash и пометка «не изменилась, см. read_policy».
3. `commit`: `phase = supervisor_running`, `supervisor.cycle++`, `stageCycles++` (кроме trigger `recheck_settled`), событие `supervisor.started { cycle, trigger }`. Версия после этой записи и есть `expectedStateVersion` для цикла: она печатается в промпте.
4. Отправить prompt в supervisor-сессию.

### 5.2. Маркер промпта

Каждый prompt (и агенту, и supervisor) начинается строкой:

```text
[sdlc:prompt id=01JB2X… kind=evaluate cycle=12]
```

Маркер нужен recovery: по наличию `id` в файле сессии определяется, был ли prompt доставлен (Pi 1.4 пишет user-сообщение на диск сразу). Модели в system prompt сказано игнорировать эту строку.

### 5.3. `supervisor_running` → `decision_pending`

Supervisor работает с инструментами чтения и проверки (без ограничения числа вызовов) и завершает цикл одним управляющим tool.

Обработка управляющего tool call:

```text
onControlTool(name, input):
  if cycleDecisionRecorded: return toolError(DECISION_ALREADY_RECORDED)
  errors = validateDecision(name, input, state, policy)          # §5.4
  if errors:
     invalidCount++ ; event supervisor.decision_rejected
     if invalidCount > runtime.maxInvalidDecisionsPerCycle:
        return toolError(..., terminate: true)                   # цикл завершится протокольной ошибкой
     return toolError(errors)                                    # модель исправляется в том же цикле
  decision = { decisionId: ulid(), cycle, action: name, input, decidedAt }
  commit: phase = decision_pending, pendingDecision = decision, event supervisor.decision
  cycleDecisionRecorded = true
  return { content: "Decision <id> recorded: <action>", terminate: true }
```

Решение фиксируется в state **внутри** tool call, до того как модель получит ответ. Если процесс упадёт после этого, решение не потеряется и не будет принято повторно.

<a id="control-actions"></a>

### 5.4. Валидация решений

Общие проверки для всех управляющих tools:

| Проверка | Код |
|---|---|
| `expectedStateVersion = state.version` | `STALE_STATE_VERSION` |
| в этом цикле решение ещё не записано | `DECISION_ALREADY_RECORDED` |
| `pendingDecision = null` | `DECISION_PENDING` |
| строковые поля не пусты | `INVALID_INPUT` |

Проверки по действиям:

| Действие | Технические проверки |
|---|---|
| `transition_stage { to, reason, evidenceRefs?, handoff? }` | `to` существует в Policy (`UNKNOWN_STAGE`); переход `stage → to` объявлен (`TRANSITION_NOT_DECLARED`); guards перехода выполнены (`GUARD_EVIDENCE_REQUIRED`, `GUARD_HUMAN_RESPONSE_REQUIRED`); все `evidenceRefs` синтаксически корректны и разрешимы (`EVIDENCE_UNRESOLVED`) |
| `continue_current_agent { message }` | `currentRun` есть, создан в текущем входе в этап и его `agentId = stage.agent` (`NO_CONTINUABLE_RUN`); файл сессии существует (`SESSION_MISSING`) |
| `restart_current_agent { reason, message }` | `consecutiveRestarts < runtime.maxConsecutiveRestarts` (`RESTART_LIMIT_REACHED`, в сообщении подсказка: выбери `ask_human` или `block_task`) |
| `ask_human { question, context?, options?, allowFreeText?, attachments? }` | `attachments` — существующие файлы внутри project root или каталога задачи (`ATTACHMENT_INVALID`); `options` от 2 до 10 штук, если заданы |
| `schedule_recheck { delayMinutes, waitingFor, message, evidenceRefs? }` | у этапа есть `recheck` (`RECHECK_NOT_ALLOWED`); `delayMinutes` в `[minMinutes, maxMinutes]` (`RECHECK_DELAY_OUT_OF_RANGE`); `stageRechecks.count < maxCount` (`RECHECK_LIMIT_REACHED`, подсказка: выбери `ask_human` или `block_task`); те же проверки run, что у `continue_current_agent` (`NO_CONTINUABLE_RUN`, `SESSION_MISSING`); `evidenceRefs` разрешимы (`EVIDENCE_UNRESOLVED`) |
| `block_task { reason, resolutionHint }` | — |
| `cancel_task { reason, humanResponseRef }` | `humanResponseRef` = `human:<eventId>`, это самое последнее событие `human.responded` задачи, и оно записано после входа в текущий этап (`CANCEL_NOT_CONFIRMED_BY_HUMAN`) |

`cancel_task` из исходной спецификации («только после явного пользовательского решения») получил механическую проверку: без ссылки на свежий ответ человека отмена невозможна.

Смысл условий `when` CLI не проверяет.

### 5.5. Supervisor завершился без решения

```text
onSupervisorSettled(outcome):
  if decision recorded: return                                   # нормальный путь
  if outcome = error: технический ретрай по runtime.technicalRetries (как у агента), затем protocol_error
  if protocolRetriesUsed < runtime.supervisorProtocolRetries:
     protocolRetriesUsed++
     follow-up в ту же сессию (текст ниже), остаться в supervisor_running
  else:
     commit: status = blocked, phase = halted,
             statusReason = { code: SUPERVISOR_NO_DECISION, … },
             events supervisor.protocol_error, task.blocked
```

Follow-up:

```text
[sdlc:prompt id=… kind=protocol_retry cycle=12]
Ты завершил ход без вызова управляющего инструмента. Цикл должен завершиться ровно одним из:
transition_stage, continue_current_agent, restart_current_agent, ask_human, schedule_recheck,
block_task, cancel_task. Текущий expectedStateVersion: 43.
```

Счётчик `protocolRetriesUsed` хранится в памяти цикла: после рестарта процесса цикл начинается заново (§8), и счётчик сбрасывается. Это допустимо, потому что рестарт процесса — внешнее событие.

`runtime.supervisorTimeoutMinutes`: по истечении сессия прерывается (`abort`), дальше как «без решения».

## 6. Human step

### 6.1. `ask_human` от supervisor

`DecisionExecutor.apply(ask_human)`:

```text
commit: phase = human_pending, status = waiting_human,
        pendingHumanRequest = { requestId: <eventId>, origin: "supervisor", … },
        lastAppliedDecisionId = decisionId, pendingDecision = null,
        events: human.requested, decision.applied
```

`HumanStep.ask()`:

- TTY: показать вопрос (§6.3), дождаться ответа;
- не TTY: вернуть outcome `waiting_human` → exit `5`. Вопрос ждёт следующего интерактивного запуска.

После ответа:

```text
commit: phase = supervisor_pending, status = active, pendingHumanRequest = null,
        supervisor.trigger = { kind: "human_responded", ref: <eventId ответа> },
        event human.responded
```

### 6.2. Идемпотентность вопросов

Вопрос однозначно идентифицируется `requestId`. Повторный запуск в `human_pending` показывает **тот же** вопрос без новой записи `human.requested`. Повторного «задать тот же вопрос» быть не может: событие создаётся только при `apply`, а `apply` идемпотентен (§7.1).

### 6.3. Представление вопроса

```text
╭─ Вопрос от supervisor · PAY-142 · Ожидание подтверждения плана ─────────╮
│ Подтверждаете план реализации (artifacts/plan.md, версия sha256:7c1e…)?  │
│                                                                          │
│ Контекст: план обновлён после ваших правок к разделу «Возвраты».         │
│ Вложения: .sdlc/tasks/PAY-142/artifacts/plan.md                          │
╰──────────────────────────────────────────────────────────────────────────╯
❯ Да, план одобрен
  Нет, нужны правки
  Свой ответ…
```

- `options` отображаются списком; если `allowFreeText` (default `true`), добавляется пункт «Свой ответ…».
- Многострочный ввод: `Enter` — новая строка, `Ctrl+D` или пустая строка после текста — отправить. Точный keybinding — [05-cli-ui.md](05-cli-ui.md#human-prompt).
- В `human.responded` пишется `answer` (итоговый текст) и `selectedOption`.
- `attachments` фиксируются с sha256 на момент вопроса. Supervisor видит, какую версию файла видел человек, и может сравнить её с текущей, прежде чем ссылаться на approval.

<a id="decision-executor"></a>

## 7. Применение решений

### 7.1. Идемпотентность

`DecisionExecutor.apply(state)` выполняет **одну** транзакцию `commit`, которая одновременно:

- вносит эффекты решения;
- выставляет `lastAppliedDecisionId = pendingDecision.decisionId`, `pendingDecision = null`;
- добавляет событие `decision.applied`.

Атомарная запись state гарантирует: решение применено целиком либо не применено. Если процесс упал до записи — при следующем запуске фаза всё ещё `decision_pending`, и `apply` выполняется снова (без побочных эффектов вне state). Если после — фаза уже другая.

Это закрывает все пункты раздела 18.3 исходной спецификации: двойной смены этапа, дубликата run, повторного вопроса и повторной пометки terminal быть не может.

### 7.2. Эффекты решений

| Действие | Изменения state | События |
|---|---|---|
| `transition_stage` → нетерминальный этап | `stage = to`, `stageEnteredAt`, `stageEntryEventId`, `stageCycles = 0`, `stageRechecks = { 0, 0, null }`, `consecutiveRestarts = 0`, `currentRun` остаётся (как «предыдущий»), `phase = agent_pending`, `nextAgentInput = { kind: "initial", message: handoff }` | `stage.transitioned`, `decision.applied` |
| `transition_stage` → терминальный этап | `stage = to`, `status = terminal`, `phase = halted` | `stage.transitioned`, `task.terminal`, `decision.applied` |
| `continue_current_agent` | `phase = agent_pending`, `nextAgentInput = { kind: "continue", message }` | `decision.applied` (`agent.continued` пишется в `agent_pending → agent_running`) |
| `restart_current_agent` | `phase = agent_pending`, `nextAgentInput = { kind: "restart", message }` | `decision.applied` |
| `ask_human` | §6.1 | `human.requested`, `decision.applied` |
| `schedule_recheck` | `phase = waiting`, `wait = { decisionId, number, waitingFor, message, delayMinutes, scheduledAt: now, dueAt: now + delayMinutes }`, `stageRechecks.count++`, `firstScheduledAt` при первом ожидании | `wait.scheduled`, `decision.applied` |
| `block_task` | `status = blocked`, `phase = halted`, `statusReason = { code: "SUPERVISOR_BLOCKED", message: reason }` | `task.blocked`, `decision.applied` |
| `cancel_task` | `status = cancelled`, `phase = halted` | `task.cancelled`, `decision.applied` |

После `transition_stage` агент нового этапа запускается автоматически, без возврата в меню (критерий 13). После settle агента управление всегда переходит к supervisor (раздел 16 исходной спецификации).

<a id="policy-gate"></a>

### 7.3. Policy gate

`policyGate(state)` перед `agent_pending` и `supervisor_pending`:

1. `loadAndValidate()`. Ошибка Policy посреди работы → state не меняется, процесс выходит с exit `2` и сообщением. Задача остаётся в текущей фазе и продолжится после исправления файла.
2. Hash совпадает → дальше.
3. Не совпадает → обработка по [01-policy.md §4](01-policy.md#4-изменение-policy-между-запусками). Если при `agent_pending` применена новая Policy, фаза меняется на `supervisor_pending` с trigger `policy_changed`, кроме случая `nextAgentInput.kind = initial` сразу после transition: там агент нового этапа запускается уже по новой Policy.

<a id="recovery"></a>

## 8. Recovery

### 8.1. Когда

`recovery.onOpen(taskKey)` при каждом открытии задачи, до основного цикла, под project lock.

### 8.2. Определение прерывания

Задача считается прерванной, если `status = interrupted` (штатная остановка по сигналу) **или** `phase ∈ {agent_running, supervisor_running}` при отсутствии живого владельца (lock только что получен этим процессом, значит прежний владелец мёртв).

### 8.3. Таблица действий

| Фаза при открытии | Наблюдение | Действие | Commit |
|---|---|---|---|
| `agent_pending`, `supervisor_pending`, `decision_pending`, `human_pending`, `waiting` | — | Ничего: обработчик фазы идемпотентен. Для `waiting` с прошедшим `dueAt` перепроверка начнётся сразу | `status = active` (или `waiting_human`) + `task.resumed` |
| `agent_running` | В run есть `report` | Агент фактически отчитался. Settle с сохранённым reason | `supervisor_pending` + `agent.settled` + `runtime.recovered` |
| `agent_running` | Последний `promptId` отсутствует в файле сессии (или файла нет) | Prompt не был доставлен, никаких действий агент не совершал. Безопасно отправить заново | `agent_pending` с тем же `nextAgentInput` (восстанавливается из `runs/<runId>.json.input`) + `runtime.recovered` |
| `agent_running` | `pendingHumanRequest.origin = agent` | Агент ждал ответа. Задать вопрос заново и продолжить сессию сообщением «Ваш вопрос был прерван рестартом. Ответ пользователя: …» | `human.responded`, затем `agent_pending { kind: recovery }` |
| `agent_running` | Prompt доставлен, отчёта нет, последняя запись сессии — завершённый ответ ассистента (`stopReason = stop`) | Агент закончил, но процесс упал до settle | `supervisor_pending` + `agent.settled { reason: unstructured_settle }` |
| `agent_running` | Prompt доставлен, ход прерван посередине (висящий tool call, `stopReason ∈ {aborted, error}`, или последний — user/toolResult) | Состояние внешнего мира неизвестно: agent мог быть посреди `git push` или деплоя. **Не продолжать автоматически.** Передать supervisor-у | `supervisor_pending` с trigger `recovered`, `agent.settled { reason: interrupted }`. В промпт supervisor идёт описание незавершённого tool call |
| `supervisor_running` | — | Supervisor только читает и решает; его повтор безопасен. Повторить цикл | `supervisor_pending` с trigger `reevaluate` + `runtime.recovered` |
| любая | `currentRun.sessionFile` указан, но файл повреждён (не парсится Pi) | Неоднозначно | Показать пользователю варианты (§8.4) |

Строка «Агент запущен, сессия допускает продолжение → возобновить сессию» исходной таблицы заменена передачей supervisor-у. CLI не может знать, безопасно ли продолжать прерванный ход, а supervisor может проверить фактическое состояние (git, файлы) и сам вызвать `continue_current_agent` с нужным предупреждением.

### 8.4. Неоднозначные случаи

```text
Задача PAY-142 не может быть восстановлена автоматически.

Причина: файл сессии sessions/implementer-002.jsonl повреждён (line 87: invalid JSON).
Этап: Реализация · агент implementer · attempt 2

❯ Перезапустить агента этапа с новой сессией (restart)
  Передать supervisor для решения
  Заблокировать задачу
  Выйти без изменений
```

Выбор пишется как `human.responded` (origin `cli`) и `runtime.recovered { action }`.

## 9. Сигналы и остановка

| Сигнал | Поведение |
|---|---|
| `SIGINT` (Ctrl+C) первый раз | В TUI — подтверждение «Остановить? Агент будет прерван» (`y` / `Esc`). Без TTY — сразу остановка |
| Подтверждённая остановка | 1) `abort()` у активной Pi-сессии (ждать до 5 с); 2) `commit`: `status = interrupted`, фаза не меняется, событие `runtime.interrupted { signal, phase, runId }`; 3) освободить lock; 4) exit `130` |
| `SIGINT` повторно во время остановки | Немедленный `process.exit(130)`. Состояние останется корректным: следующий запуск пройдёт recovery §8 |
| `SIGTERM` | Как подтверждённая остановка, exit `143` |
| `SIGHUP` | Как `SIGTERM` |

Остановка во время `human_pending` не меняет state, кроме `task.resumed`/`runtime.interrupted`-пары: вопрос просто ждёт.

Во время `waiting` активной Pi-сессии нет, поэтому `Ctrl+C` останавливает без подтверждения: `status = interrupted`, фаза `waiting` и `dueAt` сохраняются. Выход клавишей `q` с экрана ожидания state не меняет и завершает процесс с exit `6` (§12.3).

## 10. Лимиты и предохранители

Все лимиты задаются Policy (`runtime.*`); в коде только default-значения. Ни один лимит не выражает конкретный процесс: это защита от зацикливания модели.

| Параметр | Где срабатывает | Результат |
|---|---|---|
| `maxConsecutiveRestarts` | валидация `restart_current_agent` | tool error, supervisor выбирает другое действие |
| `supervisorProtocolRetries` | supervisor закончил без решения | follow-up, затем `blocked` |
| `maxInvalidDecisionsPerCycle` | невалидные управляющие вызовы | `blocked` с `SUPERVISOR_INVALID_DECISIONS` |
| `maxCyclesPerStage` | старт цикла supervisor | `blocked` с `STAGE_CYCLE_LIMIT` |
| `agents.<id>.timeoutMinutes` | agent run | `abort` → settle `timeout` → supervisor |
| `supervisorTimeoutMinutes` | цикл supervisor | `abort` → как «без решения» |
| `technicalRetries`, `technicalRetryDelaySeconds` | ошибки провайдера после ретраев Pi | повтор, затем settle `runtime_error` (агент) или `blocked` (supervisor) |
| `stage.recheck.minMinutes`, `maxMinutes` | валидация `schedule_recheck` | tool error `RECHECK_DELAY_OUT_OF_RANGE` |
| `stage.recheck.maxCount` | валидация `schedule_recheck` | tool error `RECHECK_LIMIT_REACHED`, supervisor выбирает `ask_human` или `block_task` |

## 11. Разблокировка

`sdlc resume <KEY>` для задачи со `status = blocked`:

1. Показать причину (`statusReason`).
2. Для `POLICY_STAGE_MISSING`, `STATE_TAMPERED` — отказать и направить в `sdlc recover <KEY>`.
3. Иначе спросить комментарий человека («Что изменилось?»).
4. `commit`: `status = active`, `phase = supervisor_pending`, `trigger = { kind: "unblocked", ref: <eventId> }`, события `human.responded`, `task.unblocked`.

Supervisor получает комментарий и решает, что делать дальше.

<a id="recheck"></a>

## 12. Отложенная перепроверка

### 12.1. Зачем

Этапы ревью и feature testing ждут внешних событий: ответа ревьюера, завершения CI-pipeline, сборки. Это может занять от минут до суток. Отвергнутые варианты:

- агент ждёт в цикле (`sleep` в `bash`): держит модельную сессию, упирается в `timeoutMinutes`, ожидание теряется при рестарте;
- ожидание через человека (`ask_human` «напишите, когда ревьюер ответит»): человек работает будильником;
- фоновый polling-воркер: вне MVP (раздел 4.2 исходной спецификации, фоновой daemon).

Выбрано: supervisor решает «проверить снова через N минут» (`schedule_recheck`), CLI хранит срок в state и сам будит агента этапа. Само ожидание моделей не вызывает.

### 12.2. Поток

```text
агент:      report_result { summary: "ревьюер пока не ответил",
                            externalWait: { waitingFor: "ответ в треде ревью", checkAgainInMinutes: 30 } }
supervisor: проверяет по транскрипту, что запрос ревью действительно отправлен
            → schedule_recheck { delayMinutes: 30, waitingFor, message: "проверь тред и MR" }
CLI:        phase = waiting, dueAt = now + 30 мин            ← модели не вызываются
            … срок …
CLI:        wait.finished { reason: due } → agent_pending { kind: recheck }
агент:      та же сессия, prompt kind=recheck → проверяет Slack и MR → report_result
supervisor: trigger recheck_settled → transition_stage / снова schedule_recheck / ask_human / block_task
```

### 12.3. `WaitStep.await()`

```text
await(state):
  loop:
    if clock.now() ≥ wait.dueAt: finish("due"); return
    if options.noWait: return outcome waiting_recheck                 # exit 6
    action = await race(tick(15 s), humanAction, signal)
    tick        → обновить runtime.json (обратный отсчёт), continue
    check_now   → finish("skipped_by_human"); return
    message     → onHumanMessage(text); return
    quit        → return outcome waiting_recheck                      # exit 6, state не меняется

finish(reason):
  commit: phase = agent_pending,
          nextAgentInput = { kind: "recheck", message: wait.message, decisionId: wait.decisionId },
          stageRechecks.waitedMinutes += minutes(now − wait.scheduledAt), wait = null,
          event wait.finished { reason, waitedMinutes }

onHumanMessage(text):
  commit: phase = supervisor_pending, wait = null,
          supervisor.trigger = { kind: "human_responded", ref: <eventId human.responded> },
          stageRechecks.waitedMinutes += …,
          events human.responded { requestId: null, answer: text },
                 wait.finished { reason: "human_message", responseRef }
```

- Срок сравнивается с настенными часами на каждом тике, а не через один `setTimeout(delay)`. Если ноутбук спал, проверка начнётся на первом тике после пробуждения.
- Срок хранится в state (`wait.dueAt`), а не в памяти процесса. Остановка и `sdlc resume` отсчёт не сбрасывают. Если срок прошёл, пока `sdlc` не работал, перепроверка начинается сразу после открытия задачи.
- Перед `agent_pending` после пробуждения, как обычно, срабатывает policy gate (§7.3).
- Без TTY процесс ждёт сам и печатает строку в начале ожидания и раз в 10 минут. С флагом `--no-wait` он сразу выходит с exit `6`, если срок не наступил. Так задачу можно будить из cron или скрипта, при этом сам CLI фоновой работы не ведёт.
- `sdlc resume <KEY> --now` вызывает `finish("skipped_by_human")` без ожидания.
- Сообщение человека во время ожидания («ревьюер в отпуске до понедельника», «approve дали устно») уходит supervisor-у, а не агенту, как и любой ответ человека (§3).

### 12.4. Перепроверка

Prompt `kind = recheck` (шаблон в [04-agents.md §7.3](04-agents.md#73-continue-и-restart)) отправляется в текущую сессию агента этапа (`currentRun.sessionFile`), как при `continue`. Агент помнит, что уже сделал: какой тред открыт, какой pipeline запущен. Run остаётся тем же, предыдущий отчёт переносится в `reportsHistory`.

После settle trigger supervisor-а — `recheck_settled`. В evaluation prompt supervisor видит номер перепроверки, суммарное время ожидания и `waitingFor`.

Длинная цепочка перепроверок растит сессию агента, её сжимает auto-compaction Pi. Если нужен свежий контекст, supervisor вызывает `restart_current_agent` вместо очередного ожидания.

### 12.5. Лимиты и стоимость

- Пока задача в `waiting`, модели не вызываются.
- Каждая перепроверка стоит одного agent prompt и одного supervisor-цикла. Их число ограничено `stage.recheck.maxCount`, поэтому циклы с trigger `recheck_settled` не учитываются в `maxCyclesPerStage`: долгое ревью не упирается в общий лимит циклов.
- Выбор задержки (нарастающие интервалы, нерабочее время, когда напомнить ревьюеру, когда звать человека) задаёт Policy. Для этого в evaluation prompt есть текущее локальное время и статистика ожиданий этапа ([04-agents.md §7.5](04-agents.md#supervisor-evaluation-prompt)).
- Ожидающий процесс держит project lock: другие задачи этого проекта в это время не запускаются. Выход клавишей `q` освобождает проект, а `sdlc resume` продолжит отсчёт. Ожидание нескольких задач в одном процессе — post-MVP.

### 12.6. Статус, отмена, recovery

- Ожидание не меняет `status`: задача `active`, срок виден в меню и в `sdlc status`.
- `sdlc cancel` и `sdlc recover` работают как обычно. Из другого процесса — только после выхода ожидающего: lock общий.
- Recovery в фазе `waiting` ничего не делает (§8.3): обработчик идемпотентен, всё нужное есть в `wait`.
