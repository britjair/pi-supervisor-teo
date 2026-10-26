---
schema: teo/v1

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
      agent: executor   # expect: TERMINAL_HAS_AGENT
      session: reuse

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
