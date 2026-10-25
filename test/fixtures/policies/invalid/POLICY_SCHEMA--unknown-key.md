---
schema: sdlc/v1

workflow:
  initialStage: discover
  stages:
    discover:
      title: Изучение
      agent: explorer
      transition:   # expect: UNKNOWN_KEY
        - to: done
          when: Готово.
    done:
      title: Готово
      terminal: true

agents:
  explorer:
    instructions: Изучи.

supervisor:
  instructions: Проверяй.
  verification:   # expect: UNKNOWN_KEY
    commands: [npm test]
---
Правила.
