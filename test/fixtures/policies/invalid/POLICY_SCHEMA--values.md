---
schema: teo/v1

workflow:
  initialStage: discover
  stages:
    discover:
      title: |   # expect: TITLE_MULTILINE
        Изучение
        в две строки
      agent: explorer
      session: sometimes   # expect: INVALID_ENUM
      userSession: teleport   # expect: INVALID_ENUM
      recheck:
        minMinutes: 30
        maxMinutes: 10   # expect: RECHECK_RANGE
        maxCount: 0   # expect: OUT_OF_RANGE
      transitions:
        - to: done
          when: '   '   # expect: EMPTY_STRING
          guards:
            evidence: always   # expect: INVALID_ENUM
    done:
      title: Готово
      terminal: true
    2nd-stage:   # expect: INVALID_ID
      title: Плохой id
      terminal: true

agents:
  explorer:
    model: anthropic/claude-opus-5-5:high
    thinking: low   # expect: MODEL_THINKING_CONFLICT
    instructions: Изучи.
    timeoutMinutes: 0   # expect: OUT_OF_RANGE
    askUser: 'yes'   # expect: INVALID_TYPE
  supervisor:   # expect: RESERVED_AGENT_ID
    instructions: Не может так называться.
  modeless:
    model: claude-opus   # expect: INVALID_MODEL_REF
    instructions: Модель без провайдера.

supervisor:   # expect: REQUIRED
  model: default

runtime:
  maxConsecutiveRestarts: 1.5   # expect: NOT_INTEGER
  maxCyclesPerStage: 0   # expect: OUT_OF_RANGE
  policyChangeMode: ask   # expect: INVALID_ENUM
---
Правила.
