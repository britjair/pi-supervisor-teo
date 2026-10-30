// Каталог строк интерфейса (ru), 05-cli-ui.md §1. Тексты из Policy выводятся как есть.
// Модуль без зависимостей от I/O: только функции «данные → строка».

import type { TaskEvent } from "../domain/events.js";
import type { NextAction } from "../domain/next-action.js";
import type { PolicyErrorCode, PolicyIssue, PolicyIssueParam } from "../domain/policy.js";
import { RECOVER_HINT_CODES, type AgentInputKind, type SupervisorTriggerKind, type TaskStatus } from "../domain/task-state.js";
import type { LockHolder } from "../errors/errors.js";
import type { PolicyDiffEntry } from "../policy/policy-diff.js";
import type { TaskKeyProblem } from "../state/task-key.js";
import { plural, shortHash } from "../util/strings.js";
import { formatAgo, formatDuration, formatWhen } from "../util/time.js";

type Params = Record<string, PolicyIssueParam>;

const q = (v: PolicyIssueParam | undefined): string => `«${Array.isArray(v) ? v.join(", ") : String(v)}»`;
const list = (v: PolicyIssueParam | undefined): string =>
  Array.isArray(v) && v.length > 0 ? v.join(", ") : "—";
const suggestion = (p: Params): string => (typeof p["suggestion"] === "string" ? ` Возможно, имелось в виду ${q(p["suggestion"])}.` : "");

const TYPE_NAMES: Record<string, string> = {
  string: "строка",
  number: "число",
  int: "целое число",
  integer: "целое число",
  boolean: "true или false",
  object: "mapping (ключ: значение)",
  record: "mapping (ключ: значение)",
  array: "список",
  null: "пустое значение",
};
const typeName = (t: PolicyIssueParam | undefined) => TYPE_NAMES[String(t)] ?? String(t);

/** Частые ошибки пакета yaml; остальные выводятся его текстом. */
const YAML_ERRORS: Record<string, string> = {
  BAD_INDENT: "неверный отступ: ключи одного mapping должны начинаться с одной колонки",
  TAB_AS_INDENT: "для отступов нельзя использовать табуляцию",
  MISSING_CHAR: "не хватает закрывающего символа (кавычки или скобки)",
  MULTILINE_IMPLICIT_KEY: "ключ не может занимать несколько строк",
  BLOCK_AS_IMPLICIT_KEY: "блочное значение нельзя использовать как ключ",
  UNEXPECTED_TOKEN: "неожиданный символ",
  BAD_SCALAR_START: "значение не может начинаться с этого символа; заключите его в кавычки",
  BAD_ALIAS: "ссылка * указывает на несуществующий якорь &",
  ALIAS_PROPS: "у ссылки * не может быть якоря или тега",
  TAG_RESOLVE_FAILED: "неизвестный тег",
};

const kindName = (k: PolicyIssueParam | undefined) => (k === "agent" ? "агента" : "этапа");

export const plurals = {
  problems: (n: number) => `${n} ${plural(n, "проблема", "проблемы", "проблем")}`,
  warnings: (n: number) => `${n} ${plural(n, "предупреждение", "предупреждения", "предупреждений")}`,
  errors: (n: number) => `${n} ${plural(n, "ошибка", "ошибки", "ошибок")}`,
  stages: (n: number) => `${n} ${plural(n, "этап", "этапа", "этапов")}`,
  agents: (n: number) => `${n} ${plural(n, "агент", "агента", "агентов")}`,
  lines: (n: number) => `${n} ${plural(n, "строка", "строки", "строк")}`,
};

/** Текст одной проблемы Policy по её коду. */
export function policyIssueText(issue: Pick<PolicyIssue, "code" | "params">): string {
  const p = issue.params;
  switch (issue.code) {
    // Файл
    case "ENOENT":
    case "ENOTDIR":
      return "Файл не найден.";
    case "EACCES":
    case "EPERM":
      return `Нет прав на чтение (${issue.code}).`;
    case "IS_DIRECTORY":
      return "По этому пути находится каталог, а не файл.";
    case "NOT_REGULAR_FILE":
      return "По этому пути находится не обычный файл.";
    case "INVALID_UTF8":
      return "Файл не в кодировке UTF-8: найдена недопустимая последовательность байтов.";
    case "NO_OPENING":
      return "Файл должен начинаться строкой «---»: с неё открывается YAML front matter.";
    case "NO_CLOSING":
      return "Front matter не закрыт: после YAML нужна строка «---» (или «...»).";

    // YAML
    case "DUPLICATE_KEY":
      return `Ключ ${q(p["key"])} повторяется. Ключи mapping, в том числе id этапов и агентов, должны быть уникальны.`;
    case "YAML_SYNTAX":
      return `Синтаксическая ошибка YAML: ${YAML_ERRORS[String(p["yamlCode"])] ?? String(p["detail"])} (${String(p["yamlCode"])})`;
    case "ROOT_NOT_MAPPING":
      return "Front matter должен быть mapping вида «ключ: значение».";
    case "SCHEMA_MISSING":
      return `Нет поля schema. Укажите: schema: ${list(p["supported"])}`;
    case "SCHEMA_UNSUPPORTED":
      return `Версия схемы ${q(p["value"])} не поддерживается. Поддерживается: ${list(p["supported"])}.`;

    // Схема
    case "UNKNOWN_KEY": {
      if (p["key"] === "verification") {
        return "Ключ «verification» не поддерживается: supervisor ничего не запускает сам. Проверки с запуском поручаются агенту этапа (01-policy.md §2.6).";
      }
      const known = Array.isArray(p["known"]) ? p["known"] : [];
      const hint = known.length > 0 ? ` Допустимые ключи: ${known.join(", ")}.` : "";
      return `Неизвестный ключ ${q(p["key"])}.${suggestion(p)}${hint} Свои метаданные пишите в ключи с префиксом x-.`;
    }
    case "REQUIRED":
      return "Обязательное поле отсутствует.";
    case "INVALID_TYPE":
      return `Ожидается ${typeName(p["expected"])}, а указано ${typeName(p["received"])}.`;
    case "NOT_INTEGER":
      return `Ожидается целое число, а указано ${String(p["value"])}.`;
    case "OUT_OF_RANGE":
      return p["min"] !== undefined
        ? `Значение ${String(p["value"])} меньше допустимого минимума ${String(p["min"])}.`
        : `Значение ${String(p["value"])} больше допустимого максимума ${String(p["max"])}.`;
    case "INVALID_ENUM":
      return `Недопустимое значение ${q(p["value"])}. Допустимые: ${list(p["allowed"])}.`;
    case "EMPTY_STRING":
      return "Строка не может быть пустой.";
    case "TITLE_MULTILINE":
      return "Название должно быть одной строкой.";
    case "TITLE_TOO_LONG":
      return `Название длиннее ${String(p["max"])} символов.`;
    case "INVALID_MODEL_REF":
      return "Некорректная ссылка на модель. Допустимо: default, <provider>/<modelId> или <provider>/<modelId>:<thinking>.";
    case "MODEL_THINKING_CONFLICT":
      return `Уровень thinking задан дважды: суффиксом в model (${q(p["model"])}) и полем thinking. Оставьте что-то одно.`;
    case "RECHECK_RANGE":
      return `minMinutes (${String(p["minMinutes"])}) больше maxMinutes (${String(p["maxMinutes"])}).`;
    case "EMPTY_MAP":
      return p["kind"] === "agent" ? "Нужен хотя бы один агент." : "Нужен хотя бы один этап.";
    case "INVALID_ID":
      return `Идентификатор ${kindName(p["kind"])} ${q(p["id"])} недопустим: он должен начинаться с латинской буквы и содержать только латинские буквы, цифры, «_» и «-», не длиннее 64 символов.`;
    case "RESERVED_AGENT_ID":
      return `Идентификатор агента ${q(p["id"])} зарезервирован: так называется сессия supervisor.`;
    case "INVALID_VALUE":
      return `Недопустимое значение: ${String(p["detail"])}`;

    // Граф, 01-policy.md §3.1
    case "INITIAL_STAGE_MISSING":
      return `Начальный этап ${q(p["value"])} не объявлен в workflow.stages.${suggestion(p)} Известные этапы: ${list(p["known"])}.`;
    case "INITIAL_STAGE_TERMINAL":
      return `Начальный этап ${q(p["stage"])} терминальный: workflow не может начаться.`;
    case "TRANSITION_TARGET_MISSING":
      return `Этап ${q(p["value"])} не существует.${suggestion(p)} Известные этапы: ${list(p["known"])}.`;
    case "TRANSITION_DUPLICATE_TARGET":
      return `Второй переход в этап ${q(p["target"])} (первый — transitions[${String(p["firstIndex"])}]). Переходы различаются по to, и у этапа может быть только один переход в каждый этап.`;
    case "STAGE_AGENT_MISSING":
      return `Агент ${q(p["value"])} не объявлен в agents.${suggestion(p)} Известные агенты: ${list(p["known"])}.`;
    case "TERMINAL_HAS_TRANSITIONS":
      return `Терминальный этап ${q(p["stage"])} не может иметь переходов.`;
    case "TERMINAL_HAS_AGENT":
      return `У терминального этапа ${q(p["stage"])} не может быть полей ${list(p["fields"])}: на нём работа заканчивается.`;
    case "NONTERMINAL_NO_AGENT":
      return `У нетерминального этапа ${q(p["stage"])} нет agent. Укажите агента или сделайте этап терминальным (terminal: true).`;
    case "NONTERMINAL_NO_TRANSITIONS":
      return `У нетерминального этапа ${q(p["stage"])} нет переходов. Добавьте transitions или сделайте этап терминальным (terminal: true).`;
    case "NO_REACHABLE_TERMINAL":
      return `Из начального этапа ${q(p["initialStage"])} не достижим ни один терминальный этап.`;
    case "TERMINAL_FALSE":
      return "Поле terminal допускает только значение true. Для нетерминального этапа уберите его.";

    // Предупреждения, 01-policy.md §3.2
    case "STAGE_UNREACHABLE":
      return `Этап ${q(p["stage"])} не достижим из начального этапа ${q(p["initialStage"])}.`;
    case "STAGE_DEAD_END":
      return `Из этапа ${q(p["stage"])} не достижим ни один терминальный этап: задача может зациклиться без выхода.`;
    case "AGENT_UNUSED":
      return `Агент ${q(p["agent"])} не используется ни одним этапом.`;
    case "BODY_EMPTY":
      return "Markdown-часть после front matter пустая: supervisor получит только структуру этапов.";

    default:
      return issue.code;
  }
}

/** Заголовок ошибки Policy по коду шага preflight. */
export function policyErrorHeadline(code: PolicyErrorCode, problems: number): string {
  switch (code) {
    case "POLICY_NO_PROCESSES":
      return "В каталоге процессов нет ни одного процесса (файла <процесс>.md).";
    case "POLICY_NOT_FOUND":
      return "Обязательный файл не найден.";
    case "POLICY_NOT_FILE":
      return "Путь существует, но это не обычный файл.";
    case "POLICY_UNREADABLE":
      return "Файл не удаётся прочитать.";
    case "POLICY_EMPTY":
      return "Файл пуст.";
    case "POLICY_ENCODING":
      return "Файл не в кодировке UTF-8.";
    case "POLICY_NO_FRONT_MATTER":
      return "В файле нет YAML front matter.";
    case "POLICY_YAML":
      return `Front matter не разбирается как YAML (${plurals.problems(problems)}):`;
    case "POLICY_UNSUPPORTED_SCHEMA":
      return "Версия схемы Policy не поддерживается.";
    case "POLICY_SCHEMA":
    case "POLICY_GRAPH":
      return `Policy невалидна (${plurals.problems(problems)}):`;
  }
}

export const msg = {
  extension: {
    description: "Pi Supervisor TEO: задачи по процессам ~/.pi/teo с проверкой supervisor-а",
    help: [
      "Pi Supervisor TEO",
      "  /teo start [KEY]     новая задача в этой сессии: процесс, описание, роль первого этапа",
      "  /teo goal <цель>     задача-цель без процесса (ключ GOAL-N)",
      "  /teo resume KEY      продолжить задачу или снять паузу",
      "  /teo next            перейти в новую Pi-сессию, когда этого требует этап",
      "  /teo pause           временно отключить роль и проверки, сохранив привязку",
      "  /teo recover KEY     восстановить оборванный ход",
      "  /teo stop            отвязать задачу от сессии; продолжить: /teo resume KEY или teo resume KEY",
      "  /teo status [KEY]    состояние задач проекта или одной задачи",
      "  /teo history [KEY]   задачи проекта или журнал задачи",
      "Supervisor проверяет результат в конце каждого хода.",
    ].join("\n"),
    planned: (sub: string) => `/teo ${sub} появится на следующих этапах. Сейчас задачу ведёт команда teo в терминале.`,
    unknown: (sub: string) => `Неизвестная подкоманда /teo ${sub}. Справка: /teo help`,
    askKey: "Ключ задачи",
    goalUsage: "Укажите цель: /teo goal <текст цели>",
    resumeUsage: "Укажите задачу: /teo resume KEY",
    recoverUsage: "Укажите задачу: /teo recover KEY",
    busy: (key: string) => `Сессия уже ведёт задачу ${key}. Сначала /teo stop.`,
    alreadyBound: (key: string) => `Сессия уже ведёт задачу ${key}.`,
    alreadyPaused: (key: string) => `Проверки задачи ${key} уже на паузе.`,
    paused: (key: string) => `teo: задача ${key} на паузе; обычная сессия Pi доступна без роли и report-инструментов. Продолжить: /teo resume ${key}.`,
    resumed: (key: string) => `teo: проверки задачи ${key} продолжены.`,
    notBound: "Сессия не ведёт задачу teo.",
    finished: (key: string) => `Задача ${key} завершена: вести нечего.`,
    halted: (key: string, reason: string) => `Задача ${key} остановлена (${reason}). Разберите её в терминале: teo resume ${key} или teo recover ${key}.`,
    bound: (key: string, stage: string, agent: string) => `teo: задача ${key} ведётся в этой сессии. Этап «${stage}», роль «${agent}».`,
    autoResumed: (key: string, stage: string) => `teo: сессия снова ведёт задачу ${key}, этап «${stage}».`,
    autoResumeFailed: (key: string, reason: string) => `teo: не удалось продолжить задачу ${key}: ${reason}`,
    stopped: (key: string) => `teo: задача ${key} отвязана от сессии. Продолжить: /teo resume ${key}.`,
    lockLost: (key: string) => `teo: lock проекта перехвачен другим процессом, задача ${key} больше не ведётся в этой сессии.`,
    modelMissing: (model: string, agent: string) => `teo: модель ${model} роли «${agent}» не найдена в Pi — остаётся текущая модель.`,
    modelUnavailable: (model: string, agent: string) => `teo: модель ${model} роли «${agent}» недоступна без авторизации — остаётся текущая модель.`,
    status: (key: string, stage: string, agent: string, cycle: number) => `teo: ${key} · ${stage} · ${agent} · цикл ${cycle}`,
    statusPaused: (key: string) => `teo: ${key} · пауза`,
    statusNext: (key: string, stage: string) => `teo: ${key} · ${stage} · нужна новая сессия`,
    supervisorChecking: (key: string, cycle: number) => `teo: ${key} · supervisor проверяет · цикл ${cycle}`,
    waitingHuman: (key: string) => `teo: ${key} · ожидается ответ пользователя`,
    waitingUntil: (key: string, dueAt: string) => `teo: ${key} · ожидание до ${dueAt}`,
    questionDeferred: "Вопрос supervisor-а остался открытым. Продолжение будет доступно через /teo resume после восстановления диалога.",
    continueAgent: (message: string) => `[teo] Supervisor проверил ход и вернул этап на доработку.\n\n${message}`,
    restartAgent: (reason: string, message: string) => `[teo] Supervisor начал этап заново.\nПричина: ${reason}\n\n${message}`,
    transition: (key: string, stage: string, agent: string, reason: string, handoff: string | null, role: string) =>
      `[teo] ${key}: предыдущая роль завершена. Переход к этапу «${stage}».\nПричина: ${reason}\n` +
      `Новая роль — «${agent}». Передача: ${handoff?.trim() || "нет"}.\n\n${role}`,
    recheckScheduled: (waitingFor: string, dueAt: string) => `[teo] Supervisor запланировал перепроверку до ${dueAt}: ${waitingFor}`,
    recheckDue: (waitingFor: string, message: string) => `[teo] Срок ожидания закончился. Перепроверьте: ${waitingFor}\n\n${message}`,
    nextRequired: (stage: string) => `Этап «${stage}» должен начаться в новой Pi-сессии. Нажмите Enter с командой /teo next.`,
    nextNotRequired: (key: string) => `Задаче ${key} сейчас не нужна новая Pi-сессия.`,
    nextCancelled: "Создание новой Pi-сессии отменено; команда /teo next осталась доступна.",
    terminal: (key: string, stage: string) => `[teo] Задача ${key} завершена на этапе «${stage}».`,
    cancelled: (key: string, reason: string) => `[teo] Задача ${key} отменена. ${reason}`,
    blocked: (key: string, reason: string) => `[teo] Задача ${key} заблокирована. ${reason}`,
  },

  policyErrorTitle: "Ошибка конфигурации процесса",
  file: (p: string) => `Файл: ${p}`,
  processesDir: (p: string) => `Каталог процессов: ${p}`,
  line: (n: number) => `строка ${n}`,
  nothingStarted: "Ничего не запущено, .teo не изменён.",
  createPolicy: (p: string) => `Создайте ${p} и повторите команду. Автоматически он не создаётся.`,
  createProcess: (dir: string) =>
    `Добавьте процесс в ${dir} и повторите команду, например: cp examples/processes/dev.md ${dir}/dev.md\nИли поставьте задачу целью без процесса: teo new KEY --goal "…"`,
  fixPolicy: (p: string) => `Исправьте ${p} и повторите команду. Проверка: teo doctor`,
  warningsTitle: (n: number) => `Предупреждения (${n}):`,

  unexpectedError: (m: string) => `Непредвиденная ошибка: ${m}`,
  verboseHint: "Подробности: повторите команду с флагом --verbose.",
  debugLogHint: (file: string) => `Подробности: ${file} (или повторите команду с флагом --verbose).`,

  cli: {
    description: "Supervisor процессов для Pi: ведёт задачи по процессам из ~/.pi/teo/<процесс>.md",
    version: "показать версию",
    help: "показать справку",
    helpCommand: "показать справку по команде",
    noColor: "без цвета",
    plain: "линейный вывод даже в терминале",
    verbose: "debug-лог в stderr",
    json: "вывод в JSON",
    cmdNew: "создать задачу и запустить workflow",
    cmdResume: "продолжить задачу с сохранённой фазы",
    cmdStatus: "состояние задачи или сводка по всем задачам",
    cmdHistory: "задачи проекта или журнал событий задачи",
    cmdCancel: "отменить задачу",
    cmdRecover: "ручное восстановление задачи",
    cmdDoctor: "диагностика окружения, Policy и хранилища",
    argKey: "ключ задачи",
    optTitle: "название задачи",
    optDescriptionFile: "файл с описанием задачи",
    optDescription: "описание задачи; «-» — прочитать из stdin",
    optNow: "перепроверить сразу, не дожидаясь срока",
    optNoWait: "не ждать срока перепроверки (exit 6)",
    optAll: "включая завершённые задачи",
    optLimit: "сколько событий показать",
    optReason: "причина отмены",
    optSetStage: "перевести задачу на этап",
    optProcess: "процесс задачи: имя файла ~/.pi/teo/<процесс>.md",
    optGoal: "режим цели: задача без процесса, текст цели — её описание",
    optAcceptPolicy: "принять изменённую Policy",
    optFix: "предложить исправления по одному",
    helpTitles: {
      "Usage:": "Использование:",
      "Options:": "Параметры:",
      "Commands:": "Команды:",
      "Arguments:": "Аргументы:",
      "Global Options:": "Общие параметры:",
    } as Record<string, string>,
    errors: {
      unknownCommand: (name: string, hint: string | null) =>
        `Неизвестная команда «${name}».` + (hint ? ` Возможно, имелась в виду «${hint}».` : ""),
      unknownOption: (name: string, hint: string | null) =>
        `Неизвестный параметр «${name}».` + (hint ? ` Возможно, имелся в виду «${hint}».` : ""),
      missingArgument: (name: string) => `Не указан обязательный аргумент «${name}».`,
      optionMissingArgument: (name: string) => `Параметру «${name}» нужно значение.`,
      excessArguments: "Лишние аргументы.",
      invalidArgument: (m: string) => `Недопустимое значение: ${m}`,
      seeHelp: "Справка: teo --help",
    },
  },

  input: {
    choicePrompt: (n: number) => `Выбор [1-${n}]: `,
    badChoice: (n: number) => `Введите номер от 1 до ${n}.`,
    yesNo: (def: boolean) => (def ? "[Д/н]" : "[д/Н]"),
    badYesNo: "Ответьте «д» или «н».",
    multilineHint: "(пустая строка или Ctrl+D — завершить ввод)",
    interrupted: "Остановлено пользователем.",
    closed: "Ввод закрыт.",
  },

  menu: {
    title: "Pi Supervisor TEO",
    project: (root: string) => `Проект: ${root}`,
    processes: (items: string[]) => `Процессы: ${items.join(", ")}`,
    processOk: (name: string, stages: number) => `${name} (${plurals.stages(stages)})`,
    processBuiltin: (name: string) => `${name} (встроенный: teo new --goal)`,
    processBroken: (name: string) => `${name} (⚠ ошибка Policy)`,
    processProblem: (name: string, problem: "missing" | "invalid") =>
      `⚠ процесс «${name}» ${problem === "missing" ? "не найден" : "с ошибками"}`,
    question: "Что вы хотите сделать?",
    create: "Создать новую задачу",
    finished: (n: number) => `Показать завершённые задачи (${n})`,
    finishedTitle: "Завершённые задачи",
    exit: "Выход",
    back: "Назад",
    corrupted: (key: string) => `⚠ ${key} повреждена`,
    corruptedHint: (key: string) => `Задача ${key} повреждена и не открывается. Подробности: teo doctor`,
    stageMissing: (stage: string) => `⚠ этап «${stage}» отсутствует в Policy`,
    taskActions: {
      resume: "Продолжить",
      status: "Показать статус",
      history: "Показать историю",
      cancel: "Отменить задачу",
    },
    nonInteractiveHint: [
      "Команды:",
      "  teo new KEY --title T --description-file F   создать задачу",
      "  teo new KEY --goal \"цель\"                    задача-цель без процесса",
      "  teo status [KEY]                             состояние",
      "  teo history [KEY]                            задачи и журнал событий",
      "  teo cancel KEY --reason R                    отменить задачу",
    ].join("\n"),
    noTasks: "В проекте нет задач.",
    pressEnter: "Enter — продолжить",
  },

  resume: {
    title: (key: string, title: string) => `Продолжаем ${key} · ${title}`,
    stage: (t: string) => `Текущий этап:        ${t}`,
    lastEvent: (t: string) => `Последнее событие:   ${t}`,
    next: (t: string) => `Следующее действие:  ${t}`,
  },

  recover: {
    title: (key: string, title: string) => `Восстановление ${key} · ${title}`,
    question: "Что сделать?",
    finished: (key: string) => `Задача ${key} завершена: восстанавливать нечего.`,
    nothing: (key: string) => `Задача ${key} не требует ручного восстановления. Продолжить: teo resume ${key}`,
    setStage: "Перевести задачу на этап…",
    chooseStage: "На какой этап перевести задачу? Агент этапа начнёт его заново.",
    currentStage: "(текущий)",
    acceptPolicy: (from: string, to: string) => `Принять текущую Policy (${from} → ${to})`,
    acceptTampered: "Принять изменённый state.json как есть",
    restoreBeforeTamper: "Восстановить state, записанный teo до подмены",
    unblock: "Разблокировать с комментарием (supervisor продолжит)",
    unblockNote: "Что изменилось?",
    unblockNoteEmpty: "Нужен комментарий.",
    exit: "Выйти без изменений",
    tamperedTitle: (file: string) => `Изменения в ${file} относительно последнего state, записанного teo:`,
    tamperedNoDiff: "  отличий в полях задачи нет",
    tamperedMore: (n: number) => `  … ещё ${n}`,
    tamperedInvalid: (file: string, reason: string) => `Копию ${file} принять нельзя: ${reason}`,
    tamperedNoBefore: "Состояния до подмены не сохранилось (задача заблокирована старой версией teo).",
    tamperedNoCopies: "Копии изменённого state.json не найдены.",
    sessionCorrupted: (file: string, reason: string) => `Файл сессии ${file} повреждён: ${reason}`,
    policyStageMissing: (stage: string) => `Этапа «${stage}» нет в текущей Policy: выберите этап.`,
    confirmTampered: "Заменить state задачи изменённой копией?",
    done: {
      setStage: (key: string, stage: string) => `✓ Задача ${key} переведена на этап «${stage}».`,
      acceptPolicy: (key: string) => `✓ Задача ${key} идёт по текущей Policy.`,
      acceptTampered: (key: string) => `✓ Изменённый state задачи ${key} принят.`,
      restoreBeforeTamper: (key: string) => `✓ State задачи ${key} восстановлен.`,
      session: (key: string, label: string) => `✓ ${key}: ${label}.`,
      unblock: (key: string) => `✓ Задача ${key} разблокирована.`,
    },
    next: (key: string) => `Следующий шаг: teo resume ${key}`,
    nonInteractive: (key: string, hints: string[]) =>
      [`Задаче ${key} нужно ручное восстановление, а терминала нет. Варианты:`, ...hints.map((h) => `  ${h}`)].join("\n"),
    hintSetStage: (key: string) => `teo recover ${key} --set-stage <этап>`,
    hintAcceptPolicy: (key: string) => `teo recover ${key} --accept-policy`,
    hintTerminal: (key: string) => `teo recover ${key} в терминале — подмена state и повреждённая сессия разбираются только интерактивно`,
  },

  newTask: {
    title: "Новая задача",
    process: "Процесс",
    chooseProcess: "По какому процессу вести задачу?",
    processChoice: (name: string, initial: string, stages: number) => `${name} — начальный этап «${initial}», ${plurals.stages(stages)}`,
    goal: "Цель",
    goalEmpty: "Цель не может быть пустой.",
    goalMode: "Режим цели: задача без процесса, supervisor проверит достижение цели.",
    goalChoice: "Цель — без процесса: сформулируйте цель, supervisor проверит её достижение",
    goalConflict: "--goal задаёт и процесс, и описание: не указывайте вместе с ним --process, --description или --description-file.",
    processRequired: (names: string[]) =>
      `Процессов несколько, без терминала укажите --process: ${names.join(", ")}.\nПример: teo new PAY-142 --process ${names[0] ?? "dev"} --title "…" --description-file task.txt`,
    projectRoot: (root: string, git: string | null) => `Проект: ${root}${git ? `   (${git})` : ""}`,
    gitSummary: (branch: string, clean: boolean) => `git: ${branch}, ${clean ? "чисто" : "есть незакоммиченные изменения"}`,
    key: "Ключ задачи",
    taskTitle: "Название",
    description: "Описание",
    initialStage: (title: string, agent: string) => `Начальный этап: ${title} (agent: ${agent})`,
    create: "Создать",
    edit: "Изменить",
    cancel: "Отмена",
    summary: (key: string, title: string) => `${key} · ${title}`,
    created: (key: string, stage: string, agent: string) => `✓ Задача ${key} создана · этап «${stage}» · agent ${agent}`,
    notStarted: (key: string) =>
      `Запуск агентов ещё не реализован (этап M3): задача ждёт запуска агента. Состояние: teo status ${key}`,
    keyProblem: (p: TaskKeyProblem | "duplicate", key: string, existing?: string) => {
      switch (p) {
        case "empty":
          return "Ключ не может быть пустым.";
        case "format":
          return "Ключ: латинские буквы, цифры, «.», «_» и «-», начинается с буквы или цифры, не длиннее 100 символов.";
        case "dots":
          return "Ключ не может быть «.» или «..».";
        case "trailing_dot":
          return "Ключ не может заканчиваться точкой.";
        case "reserved":
          return `«${key}» — зарезервированное имя в Windows.`;
        case "duplicate":
          return existing && existing !== key
            ? `Задача «${existing}» уже есть в проекте (ключи сравниваются без учёта регистра).`
            : `Задача «${key}» уже есть в проекте.`;
      }
    },
    titleEmpty: "Название не может быть пустым.",
    titleMultiline: "Название должно быть одной строкой.",
    titleTooLong: (max: number) => `Название длиннее ${max} символов.`,
    descriptionEmpty: "Описание не может быть пустым.",
    missingFields: (fields: string[]) =>
      `Без терминала все поля обязательны. Не указано: ${fields.join(", ")}.\nПример: teo new PAY-142 --title "Оплата через СБП" --description-file task.txt`,
    descriptionConflict: "Укажите описание одним способом: --description или --description-file.",
    descriptionFileUnreadable: (file: string, code: string) => `Не удалось прочитать файл описания ${file} (${code}).`,
  },

  cancel: {
    confirm: (key: string, title: string) => `Отменить задачу ${key} · ${title}? Отмену нельзя откатить.`,
    reason: "Причина отмены",
    reasonEmpty: "Причина не может быть пустой.",
    reasonRequired: "Без терминала нужно указать причину: teo cancel KEY --reason \"…\"",
    done: (key: string) => `✓ Задача ${key} отменена.`,
    declined: "Задача не отменена.",
    alreadyFinished: (key: string, status: TaskStatus) =>
      `Задача ${key} уже ${status === "cancelled" ? "отменена" : "завершена"}: отменять нечего.`,
    journalNote: "Причина сохраняется в журнал задачи дословно.",
  },

  lock: {
    conflictTitle: "Проект занят другим процессом teo",
    holder: (h: NonNullable<LockHolder>, now: Date) =>
      `  PID ${h.pid} на ${h.hostname}${h.taskKey ? `, задача ${h.taskKey}` : ""}, команда ${h.command}, heartbeat ${formatAgo(h.heartbeatAt, now)}`,
    holderUnknown: "  Lock-файл только что создан или повреждён: teo doctor покажет подробности.",
    viewStatus: (key: string | null) => `Посмотреть состояние: teo status${key ? ` ${key}` : ""}`,
    statusLine: (h: NonNullable<LockHolder>, now: Date, alive: boolean | null) =>
      `PID ${h.pid} на ${h.hostname}${h.taskKey ? ` · задача ${h.taskKey}` : ""} · heartbeat ${formatAgo(h.heartbeatAt, now)}` +
      (alive === false ? " · процесс не найден (lock протух)" : alive === null ? " · другой хост" : ""),
    free: "свободен",
    unreadable: "файл есть, но не разбирается",
  },

  status: {
    header: (key: string, title: string) => `${key} · ${title}`,
    labels: {
      project: "Проект",
      process: "Процесс",
      stage: "Этап",
      status: "Статус",
      agent: "Агент",
      lastEvent: "Последнее событие",
      lastDecision: "Последнее решение",
      next: "Следующее действие",
      policy: "Policy",
      lock: "Lock",
      usage: "Расход",
      reason: "Причина",
    },
    stage: (title: string | null, id: string, enteredAt: string, cycles: number, now: Date) =>
      `${title ?? `⚠ отсутствует в Policy`} (${id}) · вход ${formatWhen(enteredAt, now)}, ${cycles} ${plural(cycles, "цикл", "цикла", "циклов")}`,
    status: (status: TaskStatus, phase: string) => `${statusName(status)} (${status}) · фаза ${phase}`,
    agent: (agentId: string, attempt: number, runId: string, run: string) =>
      `${agentId} · попытка ${attempt} · run ${runId.slice(0, 10)}… · ${run}`,
    noAgent: "ещё не запускался",
    event: (e: TaskEvent, now: Date, undelivered: boolean) =>
      `${formatWhen(e.timestamp, now, true)} ${e.type}${undelivered ? " (ещё не в журнале)" : ""}`,
    decision: (at: string, action: string, summary: string, now: Date) =>
      `${formatWhen(at, now)} ${action}${summary ? ` — ${summary}` : ""}`,
    none: "—",
    policyCurrent: (hash: string) => `${shortHash(hash)} (текущая)`,
    policyUnavailable: (hash: string) => `${shortHash(hash)} (текущая Policy процесса недоступна)`,
    processProblem: (name: string, problem: "missing" | "invalid") =>
      `${name} · ⚠ ${problem === "missing" ? "файл процесса не найден" : "Policy процесса с ошибками"} (teo doctor)`,
    policyDiffers: (hash: string, current: string) => `${shortHash(hash)} (текущая Policy другая: ${shortHash(current)})`,
    usage: (inp: number, out: number, cost: number | null) =>
      `in ${compact(inp)} · out ${compact(out)}${cost !== null ? ` · $${cost.toFixed(2)}` : ""}`,
    summaryTitle: (n: number) => `Задачи в работе: ${n}`,
    finishedCount: (n: number) => `Завершённых и отменённых: ${n} (teo history)`,
  },

  history: {
    tasksTitle: (n: number) => `Задачи проекта: ${n}`,
    eventsTitle: (key: string, shown: number, total: number) =>
      shown === total ? `Журнал ${key}: ${total} ${plural(total, "событие", "события", "событий")}` : `Журнал ${key}: последние ${shown} из ${total}`,
    undelivered: "(ещё не в журнале)",
    badLimit: (v: string) => `--limit должен быть положительным целым числом, указано «${v}».`,
  },

  storage: {
    gitignoreOk: ".teo/.gitignore на месте",
    gitignoreMissing: ".teo/.gitignore отсутствует: git status агентов покажет .teo (--fix: создать)",
    lockFree: "Lock проекта свободен",
    lockLive: (line: string) => `Проект занят: ${line}`,
    lockStaleHeartbeat: (line: string) =>
      `Lock с живым PID, но heartbeat давно не обновлялся: ${line}. PID мог быть переиспользован — снимите lock вручную, если teo не запущен`,
    lockDead: (line: string) => `Протухший lock: ${line} (--fix: снять)`,
    lockForeign: (line: string) => `Lock другого хоста: ${line} (--fix: только с явным подтверждением)`,
    lockUnreadable: "Lock-файл не разбирается (--fix: снять, если он старше 30 с)",
    tasksOk: (n: number) => `Задачи: ${n}, state.json и инварианты в порядке`,
    tasksNone: "Задач в проекте нет",
    taskCorrupted: (n: number) => `Повреждённых задач: ${n}`,
    journalOk: "Журналы событий целы, outbox доставлен",
    journalProblems: (n: number) => `Проблемы журналов событий: ${n}`,
    journalBrokenTail: (key: string, bytes: number) => `${key}: оборванная последняя запись (${bytes} байт) (--fix: обрезать хвост)`,
    journalCorrupted: (key: string, line: number | null) => `${key}: невалидная запись в середине журнала${line ? `, строка ${line}` : ""}`,
    journalUndelivered: (key: string, n: number) =>
      `${key}: ${n} ${plural(n, "событие", "события", "событий")} outbox не доставлено в журнал (--fix: дописать)`,
    refsOk: "Ссылки state на файлы сессий и runs в порядке",
    refsMissing: (n: number) => `Ссылок state на отсутствующие файлы: ${n}`,
    refMissing: (key: string, file: string) => `${key}: нет файла ${file}`,
    indexOk: ".teo/index.json согласован с задачами",
    indexStale: ".teo/index.json расходится с задачами (--fix: перестроить; перестраивается и сам при следующей mutating-команде)",
    orphansNone: "Осиротевших временных файлов нет",
    orphans: (n: number) => `Осиротевших временных файлов: ${n} (--fix: удалить; удаляются и сами при следующей mutating-команде)`,
  },

  doctor: {
    title: "teo doctor",
    node: (v: string, min: string) => `Node.js ${v} (нужно ≥ ${min})`,
    processOk: (name: string, p: string, hash: string, stages: number, agents: number) =>
      `Процесс ${name} · ${p} · ${shortHash(hash)} · ${plurals.stages(stages)}, ${plurals.agents(agents)}`,
    processWarnings: (name: string, n: number) => `Процесс ${name}: ${plurals.warnings(n)}`,
    processFailed: (name: string, p: string) => `Процесс ${name} · ${p}`,
    processesNone: (dir: string) => `Своих процессов нет: в ${dir} нет ни одного файла <процесс>.md. Доступен режим цели (teo new --goal)`,
    processBuiltin: (name: string, p: string) => `Процесс ${name} (встроенный, режим цели) · ${p}`,
    processBadNames: (n: number) => `Файлы с недопустимым именем процесса пропущены (${n}): нужны строчные латинские буквы, цифры, «-» и «_»`,
    models: (refs: string) => `Модели в Policy: ${refs}`,
    modelsUsage: (ref: string, users: string[]) => `${ref} (${users.join(", ")})`,
    piSdk: (v: string) => `Pi SDK ${v} загружается`,
    piSdkError: "Не удалось загрузить Pi SDK или создать пробную сессию",
    piCliMissing: "Команда pi --version недоступна: сравнение версий SDK и CLI пропущено",
    piVersionMismatch: (sdk: string, cli: string) => `Версия Pi CLI (${cli}) отличается от SDK (${sdk})`,
    piModelOk: (ref: string, model: string) => `Модель ${ref} → ${model}, авторизация доступна`,
    piModelError: (ref: string) => `Модель ${ref} недоступна или не авторизована`,
    projectRoot: (root: string, source: "git" | "cwd") =>
      `Проект ${root} (${source === "git" ? "корень git-репозитория" : "текущий каталог, git-репозиторий не найден"})`,
    projectAccess: "Права на чтение и запись каталога проекта",
    projectAccessFailed: (code: string) => `Нет прав на чтение и запись каталога проекта (${code})`,
    teoAbsent: "Каталога .teo нет: задач в проекте ещё нет",
    fix: {
      title: "Исправления:",
      nothing: "Исправлять нечего.",
      ask: (title: string, explicit: boolean) => `${title}?${explicit ? " Это нельзя проверить автоматически." : ""}`,
      declined: "пропущено",
      needsLock: "lock проекта не снят",
      busy: (line: string) => `Проект занят живым процессом (${line}): исправления хранилища невозможны.`,
      lockChanged: "lock изменился после проверки: его уже забрал другой процесс",
      lockDead: (line: string) => `Снять протухший lock: ${line}`,
      lockForeign: (line: string) => `Снять lock другого хоста (${line}), если там teo точно не запущен`,
      lockUnreadable: "Удалить нечитаемый lock-файл",
      gitignore: "Создать .teo/.gitignore",
      orphans: (n: number) => `Удалить осиротевшие временные файлы (${n})`,
      journal: (key: string, broken: boolean, undelivered: number) =>
        `Починить журнал ${key}: ${[broken ? "обрезать оборванную запись" : null, undelivered > 0 ? `дописать outbox (${undelivered})` : null].filter(Boolean).join(", ")}`,
      index: "Перестроить .teo/index.json",
      policyFirst: "Сначала исправьте Policy: исправления хранилища выполняются только с валидной Policy.",
      after: (summary: string) => `После исправлений: ${summary.replace(/^Итог: /, "")}`,
    },
    summary: (errors: number, warnings: number) =>
      errors === 0 && warnings === 0
        ? "Итог: проблем не найдено."
        : `Итог: ${plurals.errors(errors)}, ${plurals.warnings(warnings)}.`,
  },
};

/** Строка структурного diff Policy, 01-policy.md §4.4. */
export function policyDiffLine(e: PolicyDiffEntry): { mark: "+" | "-" | "~"; text: string } {
  const change = (from?: unknown, to?: unknown) => (from === undefined && to === undefined ? "изменено" : `${fmt(from)} → ${fmt(to)}`);
  switch (e.kind) {
    case "initial_stage_changed":
      return { mark: "~", text: `начальный этап: ${e.from} → ${e.to}` };
    case "stage_added":
      return { mark: "+", text: `этап ${e.stageId} «${e.title}»` };
    case "stage_removed":
      return { mark: "-", text: `этап ${e.stageId} «${e.title}»` };
    case "stage_changed":
      return { mark: "~", text: `этап ${e.stageId}: ${e.field} ${change(e.from, e.to)}` };
    case "transition_added":
      return { mark: "~", text: `этап ${e.stageId}: добавлен переход → ${e.target}` };
    case "transition_removed":
      return { mark: "~", text: `этап ${e.stageId}: удалён переход → ${e.target}` };
    case "transition_changed":
      return { mark: "~", text: `этап ${e.stageId}: переход → ${e.target}: ${e.field} ${change(e.from, e.to)}` };
    case "agent_added":
      return { mark: "+", text: `агент ${e.agentId}` };
    case "agent_removed":
      return { mark: "-", text: `агент ${e.agentId}` };
    case "agent_changed":
      return { mark: "~", text: `агент ${e.agentId}: ${e.field} ${change(e.from, e.to)}` };
    case "supervisor_changed":
      return { mark: "~", text: `supervisor: ${e.field} ${change(e.from, e.to)}` };
    case "runtime_changed":
      return { mark: "~", text: `runtime.${e.field}: ${fmt(e.from)} → ${fmt(e.to)}` };
    case "body_changed":
      return { mark: "~", text: `Markdown-часть изменена (+${e.added} / −${e.removed} ${plural(e.removed, "строка", "строки", "строк")})` };
  }
}

function fmt(v: unknown): string {
  return v === null || v === undefined ? "—" : String(v);
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

const STATUS_NAMES: Record<TaskStatus, string> = {
  active: "в работе",
  waiting_human: "ждёт ответа",
  interrupted: "прервана",
  blocked: "заблокирована",
  terminal: "завершена",
  cancelled: "отменена",
};

export function statusName(status: TaskStatus): string {
  return STATUS_NAMES[status];
}

const TRIGGERS: Record<SupervisorTriggerKind, (agent: string) => string> = {
  agent_settled: (a) => `supervisor проверит результат ${a}`,
  recheck_settled: (a) => `supervisor проверит результат перепроверки ${a}`,
  human_responded: () => "supervisor обработает ответ пользователя",
  policy_changed: () => "supervisor учтёт изменённую Policy",
  unblocked: () => "supervisor учтёт комментарий при разблокировке",
  recovered: () => "supervisor разберёт прерванный ход агента",
  reevaluate: () => "supervisor повторит прерванный цикл оценки",
};

const AGENT_INPUT: Record<AgentInputKind, (agent: string) => string> = {
  initial: (a) => `запустить agent ${a}`,
  continue: (a) => `продолжить agent ${a} по замечанию supervisor`,
  restart: (a) => `перезапустить agent ${a}`,
  recovery: (a) => `продолжить agent ${a} после сбоя`,
  recheck: (a) => `agent ${a} выполнит перепроверку`,
};

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Текст «Следующее действие» (05-cli-ui.md §6). */
export function nextActionText(a: NextAction, ctx: { key: string; now: Date }): string {
  switch (a.kind) {
    case "start_agent":
      return AGENT_INPUT[a.inputKind](a.agentId ?? "этапа");
    case "agent_running":
      return a.live
        ? `agent ${a.agentId ?? "этапа"} работает`
        : `agent ${a.agentId ?? "этапа"} прерван — будет восстановлен при teo resume ${ctx.key}`;
    case "supervisor_evaluate":
      return a.trigger ? TRIGGERS[a.trigger](a.agentId ?? "агента") : "supervisor оценит состояние задачи";
    case "supervisor_running":
      return a.live ? "supervisor принимает решение" : `supervisor прерван — цикл повторится при teo resume ${ctx.key}`;
    case "apply_decision":
      return `применить решение ${a.action ?? ""}`.trim();
    case "waiting_human":
      return `ждёт ответа пользователя${a.fromAgent ? " (вопрос агента)" : ""}: ${clip(a.question)}`;
    case "waiting_recheck": {
      if (a.overdue) return `перепроверка просрочена — начнётся при teo resume ${ctx.key}`;
      const left = formatDuration(new Date(a.dueAt).getTime() - ctx.now.getTime());
      const base = `перепроверка в ${formatWhen(a.dueAt, ctx.now)} (через ${left}): ${clip(a.waitingFor)}`;
      return a.live ? base : `${base}; teo resume ${ctx.key} (--now — сразу)`;
    }
    case "terminal":
      return "завершена";
    case "cancelled":
      return "отменена";
    case "blocked":
      return `заблокирована${a.reason ? `: ${clip(a.reason)}` : a.code ? `: ${a.code}` : ""} — teo ${a.code && RECOVER_HINT_CODES.includes(a.code) ? "recover" : "resume"} ${ctx.key}`;
  }
}

/** Короткий статус задачи для строки меню. */
export function statusBadge(a: NextAction, ctx: { now: Date; livePid: number | null; interrupted: boolean }): string {
  switch (a.kind) {
    case "agent_running":
      return a.live ? `● агент работает${ctx.livePid ? ` (PID ${ctx.livePid})` : ""}` : "◌ прервана — будет восстановлена";
    case "supervisor_running":
      return a.live ? "● supervisor проверяет" : "◌ прервана — будет восстановлена";
    case "waiting_human":
      return "? ждёт ответа";
    case "waiting_recheck":
      return a.overdue ? "⏳ перепроверка просрочена" : `⏳ перепроверка в ${formatWhen(a.dueAt, ctx.now)}`;
    case "blocked":
      return "⛔ заблокирована";
    case "terminal":
      return "✓ завершена";
    case "cancelled":
      return "✗ отменена";
    case "start_agent":
      return ctx.interrupted ? "◌ прервана" : "○ ждёт запуска агента";
    case "supervisor_evaluate":
      return ctx.interrupted ? "◌ прервана" : "○ ждёт проверки supervisor";
    case "apply_decision":
      return ctx.interrupted ? "◌ прервана" : "○ решение не применено";
  }
}

/** Однострочное описание события для истории. */
export function eventSummary(e: TaskEvent): string {
  switch (e.type) {
    case "task.created":
      return `создана: «${e.payload.title}», этап ${e.payload.stage}`;
    case "task.cancelled":
      return `отменена (${e.payload.by}): ${clip(e.payload.reason)}`;
    case "task.blocked":
      return `заблокирована ${e.payload.code}: ${clip(e.payload.message)}`;
    case "task.unblocked":
      return `разблокирована: ${clip(e.payload.note)}`;
    case "task.terminal":
      return `достигнут терминальный этап ${e.payload.stage}`;
    case "task.resumed":
      return `продолжена (PID ${e.payload.pid}, фаза ${e.payload.phase})`;
    case "policy.changed":
      return `Policy ${shortHash(e.payload.fromHash)} → ${shortHash(e.payload.toHash)} (${e.payload.mode})`;
    case "stage.transitioned":
      return `${e.payload.from} → ${e.payload.to}: ${clip(e.payload.reason)}`;
    case "agent.started":
      return `${e.payload.agentId}#${e.payload.attempt} запущен на этапе ${e.payload.stage}`;
    case "agent.settled":
      return `run ${e.payload.runId.slice(0, 10)}…: ${e.payload.reason}`;
    case "agent.reported":
      return `отчёт ${e.payload.kind}: ${clip(e.payload.summary)}`;
    case "agent.failed":
      return `ошибка: ${clip(e.payload.error)}`;
    case "supervisor.started":
      return `цикл ${e.payload.cycle}${e.payload.trigger ? ` (${e.payload.trigger.kind})` : ""}`;
    case "supervisor.decision":
      return `решение ${e.payload.action}`;
    case "supervisor.note":
      return clip(e.payload.text);
    case "decision.applied":
      return `применено ${e.payload.action}`;
    case "human.requested":
      return `вопрос: ${clip(e.payload.question)}`;
    case "human.responded":
      return `${e.payload.channel === "chat" ? "сообщение" : "ответ"}: ${clip(e.payload.answer)}`;
    case "session.bound":
      return `ведётся в сессии Pi ${e.payload.sessionId.slice(0, 8)}`;
    case "session.unbound":
      return `отвязана от сессии Pi (${e.payload.reason === "stop" ? "/teo stop" : e.payload.reason === "finished" ? "задача завершена" : e.payload.reason === "lock_lost" ? "lock потерян" : "другая сессия"})`;
    case "session.next_requested":
      return `этап ${e.payload.stage} требует новую Pi-сессию`;
    case "supervision.paused":
      return "проверки поставлены на паузу";
    case "supervision.resumed":
      return "проверки продолжены";
    case "wait.scheduled":
      return `ожидание ${e.payload.number}/${e.payload.maxCount} до ${e.payload.dueAt}: ${clip(e.payload.waitingFor)}`;
    case "wait.finished":
      return `ожидание завершено (${e.payload.reason}), ${e.payload.waitedMinutes} мин`;
    case "runtime.interrupted":
      return `остановлено${e.payload.signal ? ` сигналом ${e.payload.signal}` : ""} в фазе ${e.payload.phase}`;
    case "runtime.recovered":
      return `восстановление: ${e.payload.action}`;
    default:
      return "";
  }
}

/** Сообщение о занятом проекте (02-storage.md §10.4). */
export function lockConflictText(holder: LockHolder, now: Date): string {
  return [
    msg.lock.conflictTitle,
    holder ? msg.lock.holder(holder, now) : msg.lock.holderUnknown,
    "",
    msg.lock.viewStatus(holder?.taskKey ?? null),
  ].join("\n");
}
