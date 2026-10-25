---
schema: sdlc/v1

workflow:
  initialStage: discover   # expect: NO_REACHABLE_TERMINAL
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
        - to: discover
          when: Нужно изучить ещё раз.
    done:
      title: Готово
      terminal: true

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
