---
# Второй workflow с другими этапами и агентами: тот же dist/ без пересборки (критерий приёмки 3).
schema: sdlc/v1

workflow:
  initialStage: sketch
  stages:
    sketch:
      title: Набросок
      agent: drafter
      instructions: |
        Опиши в artifacts/sketch.md, какой файл HELLO.md будет создан и какая строка в нём будет.
      transitions:
        - to: deliver
          when: >
            В artifacts/sketch.md записаны имя файла HELLO.md и его будущая строка.
          guards:
            evidence: required

    deliver:
      title: Доставка
      agent: courier
      instructions: |
        Создай файл HELLO.md со строкой из artifacts/sketch.md и закоммить его.
      transitions:
        - to: shipped
          when: >
            Файл HELLO.md закоммичен в текущую ветку, рабочее дерево чистое.
          guards:
            evidence: required

    shipped:
      title: Отгружено
      terminal: true

agents:
  drafter:
    title: Составитель
    model: default
    askUser: false
    instructions: |
      Ты только планируешь: в репозитории ничего не меняешь, пишешь лишь в artifacts/.

  courier:
    title: Курьер
    model: default
    askUser: false
    instructions: |
      Ты выполняешь план из artifacts/sketch.md.

supervisor:
  model: default
  instructions: |
    Коммит подтверждай через inspect_git_commit, чистоту дерева — через inspect_git_status.

runtime:
  policyChangeMode: latest
  maxCyclesPerStage: 5
---

# Правила

Отчёт агента — заявление. Переход только по проверенным фактам.
