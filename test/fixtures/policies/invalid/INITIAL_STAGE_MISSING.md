---
schema: teo/v1

workflow:
  initialStage: discovr   # expect: INITIAL_STAGE_MISSING
  stages:
    discover:
      title: Изучение
      agent: explorer
      transitions:
        - to: done
          when: Готово.
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
