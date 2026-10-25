---
schema: sdlc/v1

workflow:
  initialStage: discover
  stages:
    discover:
      title: Изучение
      agent: explorer
      transitions:
        - to: execute
          when: Понятно.
    execute:
      title: Выполнение
      agent: executor
      transitions:
        - to: done
          when: Сделано.
    done:
      title: Готово
      terminal: true
      transitions:   # expect: TERMINAL_HAS_TRANSITIONS
        - to: discover
          when: Начать заново.

agents:
  explorer:
    instructions: Изучи задачу.
  executor:
    instructions: Выполни задачу.

supervisor:
  instructions: Проверяй факты.
---

# Правила

Проверяй факты.
