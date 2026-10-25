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
        - to: done
          when: Делать нечего.
    execute:   # expect: NONTERMINAL_NO_TRANSITIONS
      title: Выполнение
      agent: executor
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
