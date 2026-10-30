---
# Все поля схемы, x-* метаданные, самопереход, recheck: {}, якоря YAML.
schema: teo/v1
x-owner: команда платформы

workflow:
  x-comment: метаданные разрешены на любом уровне
  initialStage: triage
  stages:
    x-draft-stage:
      title: игнорируется целиком
    triage:
      title: Разбор
      description: &triage-desc Первичный разбор обращения
      agent: triager
      instructions: Разбери обращение.
      session: fresh
      userSession: same
      transitions:
        - to: triage
          when: Нужен новый вход в этап с чистой сессией.
        - to: awaiting_reply
          when: Нужен ответ внешней системы.
          guards:
            evidence: optional
            humanResponse: optional
    awaiting_reply:
      title: Ожидание внешней системы
      agent: triager
      session: reuse
      userSession: new
      recheck: {}
      transitions:
        - to: closed
          when: Внешняя система ответила.
          guards:
            evidence: required
            humanResponse: required
          x-note: guards проверяет CLI
    closed:
      title: Закрыто
      description: *triage-desc
      terminal: true

agents:
  triager:
    title: Разборщик
    model: anthropic/claude-opus-5-5:high
    instructions: Разбирай обращения.
    tools: [read, bash, grep]
    excludeTools: [bash]
    askUser: false
    piResources:
      contextFiles: none
      extensions: inherit
      skills: none
    timeoutMinutes: 45.5
    x-cost-center: 42

supervisor:
  model: claude-code/claude-opus-5-5
  thinking: xhigh
  instructions: Проверяй.
  piResources:
    contextFiles: inherit

runtime:
  policyChangeMode: pinned
  maxConsecutiveRestarts: 0
  supervisorProtocolRetries: 10
  maxInvalidDecisionsPerCycle: 20
  maxCyclesPerStage: null
  supervisorTimeoutMinutes: 1440
  technicalRetries: 0
  technicalRetryDelaySeconds: 600
---
Правила.
