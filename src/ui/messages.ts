// Каталог строк интерфейса (ru), 05-cli-ui.md §1. Тексты из Policy выводятся как есть.
// Модуль без зависимостей от I/O: только функции «данные → строка».

import type { PolicyErrorCode, PolicyIssue, PolicyIssueParam } from "../domain/policy.js";
import type { PolicyDiffEntry } from "../policy/policy-diff.js";
import { plural, shortHash } from "../util/strings.js";

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
  policyErrorTitle: "Ошибка конфигурации SDLC",
  file: (p: string) => `Файл: ${p}`,
  line: (n: number) => `строка ${n}`,
  nothingStarted: "Ничего не запущено, .sdlc не изменён.",
  createPolicy: (p: string) => `Создайте ${p} и повторите команду. Автоматически он не создаётся.`,
  fixPolicy: (p: string) => `Исправьте ${p} и повторите команду. Проверка: sdlc doctor`,
  warningsTitle: (n: number) => `Предупреждения (${n}):`,

  notImplemented: (command: string) => `Команда «${command}» ещё не реализована.`,
  unexpectedError: (m: string) => `Непредвиденная ошибка: ${m}`,
  verboseHint: "Подробности: повторите команду с флагом --verbose.",

  cli: {
    description: "Локальный контроллер SDLC-процесса из ~/.pi/SDLC.md",
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
      seeHelp: "Справка: sdlc --help",
    },
  },

  doctor: {
    title: "SDLC doctor",
    node: (v: string, min: string) => `Node.js ${v} (нужно ≥ ${min})`,
    policyOk: (p: string, hash: string, stages: number, agents: number) =>
      `Policy ${p} · ${shortHash(hash)} · ${plurals.stages(stages)}, ${plurals.agents(agents)}`,
    policyWarnings: (n: number) => `${plurals.warnings(n)}`,
    policyFailed: (p: string) => `Policy ${p}`,
    models: (refs: string) => `Модели в Policy: ${refs}`,
    modelsUsage: (ref: string, users: string[]) => `${ref} (${users.join(", ")})`,
    piSkipped: "Pi SDK, модели, авторизация и пробная сессия — проверки появятся вместе с интеграцией Pi (M4)",
    projectRoot: (root: string, source: "git" | "cwd") =>
      `Project root ${root} (${source === "git" ? "корень git-репозитория" : "текущий каталог, git-репозиторий не найден"})`,
    projectAccess: "Права на чтение и запись project root",
    projectAccessFailed: (code: string) => `Нет прав на чтение и запись project root (${code})`,
    sdlcAbsent: "Каталога .sdlc нет: задач в проекте ещё нет",
    sdlcSkipped: "Каталог .sdlc есть — проверки хранилища, задач и lock появятся вместе с хранилищем (M2)",
    fixNotImplemented: "doctor --fix ещё не реализован (M6). Без --fix doctor ничего не меняет.",
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
