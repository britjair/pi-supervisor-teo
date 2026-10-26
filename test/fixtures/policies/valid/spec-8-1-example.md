---
# Пример минимальной политики из раздела 8.1 SDLC_CLI_SPEC.md без изменений.
schema: teo/v1

workflow:
  initialStage: requirements
  stages:
    requirements:
      title: Сбор и уточнение требований
      agent: requirements
      transitions:
        - to: waiting_plan_approval
          when: >
            Требования собраны, противоречия устранены,
            план сохранён и представлен пользователю.

    waiting_plan_approval:
      title: Ожидание подтверждения плана
      agent: requirements
      transitions:
        - to: implementation
          when: Пользователь явно одобрил актуальную версию плана.
        - to: requirements
          when: Пользователь запросил изменение требований или плана.

    implementation:
      title: Реализация
      agent: implementer
      transitions:
        - to: review
          when: Реализация завершена и представлены достаточные доказательства.

    review:
      title: Ревью
      agent: reviewer
      transitions:
        - to: fixing
          when: Найдены замечания, требующие изменения реализации.
        - to: qa_ready
          when: Все условия готовности к feature testing выполнены.

    fixing:
      title: Исправление замечаний
      agent: fixer
      transitions:
        - to: review
          when: Замечания исправлены и результат повторно проверен.

    qa_ready:
      title: Готово к feature testing
      terminal: true

agents:
  requirements:
    model: default
    instructions: |
      Собери требования, устрани существенные неопределённости
      и подготовь проверяемый план реализации.

  implementer:
    model: default
    instructions: |
      Реализуй актуальный одобренный план.

  reviewer:
    model: default
    instructions: |
      Проверь реализацию, тесты и соответствие плану.

  fixer:
    model: default
    instructions: |
      Исправь подтверждённые замечания reviewer.

supervisor:
  model: default
  instructions: |
    Независимо проверяй заявления дочерних агентов.
    Не считай текстовый отчёт доказательством фактического выполнения.

runtime:
  maxConsecutiveRestarts: 3
  policyChangeMode: confirm
---

# Общие правила

Supervisor должен сравнивать фактический результат с условиями текущего
перехода. При неполном, противоречивом или непонятном результате он должен
продолжить текущего агента, перезапустить его либо запросить решение человека.
