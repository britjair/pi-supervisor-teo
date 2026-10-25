---
schema: sdlc/v1

workflow:
  initialStage: discover
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
    discover:   # expect: DUPLICATE_KEY
      title: Ещё одно изучение
      terminal: true

agents:
  explorer:
    instructions: Изучи.

supervisor:
  instructions: Проверяй.
---
Правила.
