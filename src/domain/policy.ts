// Модель Policy — файла процесса ~/.pi/teo/<процесс>.md, 01-policy.md §2. Только типы и чистые функции.
// Код не знает ни одного конкретного этапа или агента: всё приходит из файла.

export const POLICY_SCHEMA_ID = "teo/v1";
export type PolicySchemaId = typeof POLICY_SCHEMA_ID;

export type PolicyHash = `sha256:${string}`;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type ResourceMode = "inherit" | "none";
export type PiResources = {
  contextFiles: ResourceMode;
  extensions: ResourceMode;
  skills: ResourceMode;
};

export type GuardLevel = "required" | "optional";
export type TransitionGuards = { evidence: GuardLevel; humanResponse: GuardLevel };

export type Transition = {
  to: string;
  when: string;
  guards: TransitionGuards;
};

export type RecheckSpec = {
  minMinutes: number;
  maxMinutes: number;
  maxCount: number;
};

export type SessionMode = "fresh" | "reuse";
/** Пользовательская Pi-сессия при входе в этап расширения; CLI это поле игнорирует. */
export type UserSessionMode = "same" | "new";

export type WorkStage = {
  kind: "work";
  id: string;
  title: string;
  description: string | null;
  agent: string;
  instructions: string | null;
  session: SessionMode;
  userSession: UserSessionMode;
  transitions: Transition[];
  recheck: RecheckSpec | null;
};

export type TerminalStage = {
  kind: "terminal";
  id: string;
  title: string;
  description: string | null;
};

export type Stage = WorkStage | TerminalStage;

export type AgentDef = {
  id: string;
  title: string;
  /** modelRef как в файле: "default", "provider/id" или "provider/id:thinking" (§2.3). */
  model: string;
  thinking: ThinkingLevel | null;
  instructions: string;
  /** Allowlist встроенных tools Pi; null — набор по умолчанию (04-agents.md §4.1). */
  tools: string[] | null;
  excludeTools: string[];
  askUser: boolean;
  piResources: PiResources;
  timeoutMinutes: number | null;
};

export type SupervisorDef = {
  model: string;
  thinking: ThinkingLevel | null;
  instructions: string;
  piResources: PiResources;
};

export type PolicyChangeMode = "confirm" | "latest" | "pinned";

export type RuntimeSettings = {
  policyChangeMode: PolicyChangeMode;
  maxConsecutiveRestarts: number;
  supervisorProtocolRetries: number;
  maxInvalidDecisionsPerCycle: number;
  maxCyclesPerStage: number | null;
  supervisorTimeoutMinutes: number;
  technicalRetries: number;
  technicalRetryDelaySeconds: number;
};

/**
 * Нормализованный front matter с применёнными default.
 * Словари созданы без прототипа: `stages["constructor"]` — это `undefined`, а не функция.
 */
export type PolicySpec = {
  schema: PolicySchemaId;
  workflow: {
    initialStage: string;
    stages: Record<string, Stage>;
  };
  agents: Record<string, AgentDef>;
  supervisor: SupervisorDef;
  runtime: RuntimeSettings;
};

/** Одна проблема Policy. Текст для человека строится по `code` и `params` в ui/messages.ts. */
export type PolicyIssue = {
  code: string;
  /** Путь в front matter: workflow.stages.review.transitions[1].to */
  path: string | null;
  /** Номер строки в файле процесса (с 1) */
  line: number | null;
  params: Record<string, PolicyIssueParam>;
};
export type PolicyIssueParam = string | number | boolean | null | readonly string[];

export type PolicyWarning = PolicyIssue;

/** Имя процесса — имя файла ~/.pi/teo/<имя>.md: как ключ задачи, но в нижнем регистре (D32). */
export const PROCESS_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type PolicyErrorCode =
  | "POLICY_NO_PROCESSES"
  | "POLICY_NOT_FOUND"
  | "POLICY_NOT_FILE"
  | "POLICY_UNREADABLE"
  | "POLICY_EMPTY"
  | "POLICY_ENCODING"
  | "POLICY_NO_FRONT_MATTER"
  | "POLICY_YAML"
  | "POLICY_UNSUPPORTED_SCHEMA"
  | "POLICY_SCHEMA"
  | "POLICY_GRAPH";

/** Коды ошибок графовой валидации, 01-policy.md §3.1. */
export const GRAPH_ERROR_CODES = [
  "INITIAL_STAGE_MISSING",
  "INITIAL_STAGE_TERMINAL",
  "TRANSITION_TARGET_MISSING",
  "TRANSITION_DUPLICATE_TARGET",
  "STAGE_AGENT_MISSING",
  "TERMINAL_HAS_TRANSITIONS",
  "TERMINAL_HAS_AGENT",
  "NONTERMINAL_NO_AGENT",
  "NONTERMINAL_NO_TRANSITIONS",
  "NO_REACHABLE_TERMINAL",
  "TERMINAL_FALSE",
] as const;
export type GraphErrorCode = (typeof GRAPH_ERROR_CODES)[number];

/** Коды предупреждений, 01-policy.md §3.2. */
export const GRAPH_WARNING_CODES = ["STAGE_UNREACHABLE", "STAGE_DEAD_END", "AGENT_UNUSED", "BODY_EMPTY"] as const;
export type GraphWarningCode = (typeof GRAPH_WARNING_CODES)[number];

export type LoadedPolicy = {
  path: string;
  /** Исходный текст целиком (BOM сохранён: текст кодируется обратно в те же байты). */
  raw: string;
  /** sha256 от байтов файла, 01-policy.md §1.4 */
  hash: PolicyHash;
  schema: PolicySchemaId;
  spec: PolicySpec;
  /** Markdown после front matter */
  body: string;
  warnings: PolicyWarning[];
};

export const STAGE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const AGENT_ID_RE = STAGE_ID_RE;
/** Зарезервировано под имя сессии supervisor.jsonl (01-policy.md §2.2). */
export const RESERVED_AGENT_IDS: readonly string[] = ["supervisor"];

export const TITLE_MAX_LENGTH = 120;

export type ParsedModelRef =
  | { kind: "default"; thinking: null }
  | { kind: "explicit"; provider: string; modelId: string; thinking: ThinkingLevel | null };

const THINKING_SUFFIX_RE = new RegExp(`:(${THINKING_LEVELS.join("|")})$`);
const MODEL_REF_RE = /^[^\s/:]+\/\S+$/;

/**
 * Синтаксический разбор modelRef (01-policy.md §2.3). Существование модели здесь не проверяется:
 * это делает Pi SDK при старте workflow и `teo doctor`.
 * Суффикс `:<thinking>` распознаётся только с известным уровнем: id моделей тоже бывают с двоеточием.
 */
export function parseModelRef(ref: string): ParsedModelRef | null {
  if (ref === "default") return { kind: "default", thinking: null };
  if (!MODEL_REF_RE.test(ref)) return null;
  const suffix = THINKING_SUFFIX_RE.exec(ref);
  const base = suffix ? ref.slice(0, suffix.index) : ref;
  const slash = base.indexOf("/");
  const provider = base.slice(0, slash);
  const modelId = base.slice(slash + 1);
  if (!provider || !modelId) return null;
  return { kind: "explicit", provider, modelId, thinking: (suffix?.[1] as ThinkingLevel | undefined) ?? null };
}

export function isTerminalStage(stage: Stage): stage is TerminalStage {
  return stage.kind === "terminal";
}

export function stageList(spec: PolicySpec): Stage[] {
  return Object.values(spec.workflow.stages);
}

export function agentList(spec: PolicySpec): AgentDef[] {
  return Object.values(spec.agents);
}

export function getStage(spec: PolicySpec, id: string): Stage | undefined {
  return Object.hasOwn(spec.workflow.stages, id) ? spec.workflow.stages[id] : undefined;
}

export function getAgent(spec: PolicySpec, id: string): AgentDef | undefined {
  return Object.hasOwn(spec.agents, id) ? spec.agents[id] : undefined;
}
