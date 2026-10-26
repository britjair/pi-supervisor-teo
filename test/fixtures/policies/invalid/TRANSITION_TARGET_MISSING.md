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
        - to: don   # expect: TRANSITION_TARGET_MISSING
          when: Сделано.
        - to: done
          when: Сделано иначе.
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
