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
        - when: Понятно, но по-другому.
          to: execute   # expect: TRANSITION_DUPLICATE_TARGET
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
