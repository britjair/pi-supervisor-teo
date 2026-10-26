---
schema: teo/v1

workflow:
  initialStage: discover
  stages:
    discover:
      title: Изучение
      agent: explorer
      terminal: false   # expect: TERMINAL_FALSE
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
