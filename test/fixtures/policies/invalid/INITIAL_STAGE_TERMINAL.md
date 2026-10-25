---
schema: sdlc/v1

workflow:
  initialStage: done   # expect: INITIAL_STAGE_TERMINAL
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

supervisor:
  instructions: Проверяй факты.
---
Правила.
