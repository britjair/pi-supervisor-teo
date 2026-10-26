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
    execute:   # expect: NONTERMINAL_NO_AGENT
      title: Выполнение
      transitions:
        - to: done
          when: Сделано.
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
