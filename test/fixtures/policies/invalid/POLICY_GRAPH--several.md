---
schema: teo/v1

workflow:
  initialStage: requirements   # expect: NO_REACHABLE_TERMINAL
  stages:
    requirements:
      title: Требования
      agent: analyst
      transitions:
        - to: review
          when: Готово.
    review:
      title: Ревью
      agent: reviewer
      transitions:
        - to: fixing
          when: Есть замечания.
        - to: qa_redy   # expect: TRANSITION_TARGET_MISSING
          when: Замечаний нет.
    fixing:
      title: Исправления
      agent: fixr   # expect: STAGE_AGENT_MISSING
      transitions:
        - to: review
          when: Исправлено.
    qa_ready:
      title: Готово к тестированию
      agent: reviewer   # expect: TERMINAL_HAS_AGENT
      terminal: true

agents:
  analyst:
    instructions: Собери требования.
  reviewer:
    instructions: Проверь.

supervisor:
  instructions: Проверяй факты.
---
Правила.
