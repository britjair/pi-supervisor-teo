---
# Минимальный workflow с произвольными именами (критерий приёмки 17, e2e smoke 06 §4.3).
schema: sdlc/v1

workflow:
  initialStage: discover
  stages:
    discover:
      title: Изучение задачи
      agent: explorer
      instructions: |
        Изучи репозиторий и опиши в artifacts/notes-plan.md, что нужно сделать.
      transitions:
        - to: execute
          when: >
            В artifacts/notes-plan.md описано, какой файл будет создан и что в нём будет.
          guards:
            evidence: required

    execute:
      title: Выполнение
      agent: executor
      instructions: |
        Создай файл NOTES.md с одной строкой и закоммить его.
      transitions:
        - to: done
          when: >
            Файл NOTES.md закоммичен в текущую ветку, рабочее дерево чистое.
          guards:
            evidence: required

    done:
      title: Готово
      terminal: true

agents:
  explorer:
    title: Исследователь
    model: default
    askUser: false
    instructions: |
      Ты изучаешь задачу и ничего не меняешь в репозитории, кроме artifacts/.

  executor:
    title: Исполнитель
    model: default
    askUser: false
    instructions: |
      Ты выполняешь задачу по плану из artifacts/notes-plan.md.

supervisor:
  model: default
  instructions: |
    Проверяй коммит через inspect_git_commit и состояние дерева через inspect_git_status.

runtime:
  policyChangeMode: latest
  maxCyclesPerStage: 5
---

# Правила

Отчёт агента — не доказательство. Коммит подтверждается только инструментами git.
