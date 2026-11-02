# План решения: исправление зависания/пропадания ввода пользователя в фазе waiting (APD-1264)

## 1. Диагностика проблемы

В задаче `APD-1264` на этапе «Сбор и уточнение требований» (роль «Аналитик») произошло следующее:
1. Аналитик завершил ход без вызова `report_result` (`unstructured_settle`), задав вопросы пользователю в чат.
2. Teo запустил supervisor для оценки хода.
3. Все модели supervisor-а (`openai-codex/gpt-5.6-sol`, `claude-bridge/claude-opus-5-5`, `default`) вернули 429 / usage limit. Модель `antigravity/gemini-3.8-flash` из `models.md` не была выбрана, так как в каталоге Pi зарегистрирована модель `antigravity/gemini-3.8-flash-high`.
4. Supervisor перевёл задачу в `phase: "waiting"` с `waitingFor: "сброс лимита модели supervisor-а"` и таймером сброса.
5. Пользователь ввёл текст ответа в терминале. Обработчик `onInput` в `ExtensionHost`:
   - Сохранил сообщение как событие `human.responded` через `waitingHumanMessage(text)`.
   - Очистил таймер ожидания (`clearWaitTimer`).
   - Попытался возобновить супервизор (`resumeBoundWorkflow`).
   - Поскольку лимиты моделей ещё не сбросились, supervisor снова перешёл в `phase: "waiting"`, вернув `decision: null`.
6. **Критический дефект в `applyOutsideBoundary`:**
   При отсутствии решения (`!decision`) функция проверяла только `isHalted(result.state)`, а ветка `result.state.phase === "waiting"` отсутствовала. Из-за этого:
   - Вызывался `refreshStatus`, сбрасывавший статус ожидания в Pi TUI на обычный рабочий («Аналитик · цикл 2»).
   - Таймер ожидания `scheduleWaitTimer` не запускался заново.
   - В UI не выводилось ни уведомления, ни сообщения в ленту чата.
   - `onInput` возвращал `{ action: "handled" }`, из-за чего Pi очищал строку ввода пользователя и не выводил ничего в чат.
7. В итоге для пользователя ввод выглядел как бесследное пропадание текста и зависание интерфейса.

---

## 2. Согласованные изменения

### 2.1. Восстановление таймера и обратного отсчёта в `applyOutsideBoundary` (`src/extension/host.ts`)
- Добавить обработку `result.state.phase === "waiting"` в `applyOutsideBoundary`:
  ```typescript
  if (!decision) {
    if (isHalted(result.state)) {
      await this.finishResult(b, ctx, result.state);
    } else if (result.state.phase === "waiting") {
      await this.scheduleWaitTimer(b, ctx);
    } else {
      await this.refreshStatus(b, ctx);
    }
    return;
  }
  ```

### 2.2. Обратная связь пользователю при вводе в `onInput` (`src/extension/host.ts`)
- Если во время фазы `waiting` пользователь отправляет ввод, и задача после попытки запуска supervisor-а остаётся в фазе `waiting`:
  - Выводить информационное уведомление `ctx.ui.notify(...)` с сообщением о сохранении ответа и оставшемся времени ожидания.
  - Дублировать подтверждение в ленту чата через `this.pi.sendMessage(...)` с текстом сообщения и системным пояснением о статусе ожидания, чтобы пользователь явно видел свой ввод в истории диалога.
  - Гарантировать перезапуск `scheduleWaitTimer(b, ctx)`.

### 2.3. Улучшение сопоставления моделей в `matchPiModel` (`src/policy/models-config.ts`)
- Добавить сопоставление с нормализацией суффиксов уровней thinking (`-high`, `-medium`, `-low`, `-extra-low`, `-tiered`).
- Если в `models.md` указано `antigravity/gemini-3.8-flash`, а в Pi зарегистрирована `antigravity/gemini-3.8-flash-high`, модель сопоставляется корректно.

---

## 3. План тестирования и сборки

1. **Unit-тесты:**
   - Тесты сопоставления моделей `matchPiModel` в `test/unit/models-config.test.ts` (с суффиксами `-high`, `-low` и т.д.).
2. **Интеграционные тесты `ExtensionHost`:**
   - Тест сценария: пользователь вводит сообщение во время ожидания лимита supervisor-а:
     - ввод перехватывается, сохраняется в события;
     - пользователю выводится уведомление и сообщение в ленту чата;
     - таймер ожидания перевзводится и статус-бар показывает обратный отсчёт;
     - по истечении таймера `fireWaitTimer` возобновляет выполнение.
3. **Сборка проекта (`npm run build`).**
