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
      agent: executr   # expect: STAGE_AGENT_MISSING
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
