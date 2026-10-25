// Preflight Policy целиком, 01-policy.md §1.2: файл → front matter → YAML → схема → граф.
// Каждый шаг при ошибке бросает PolicyError, дальше ничего не выполняется.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { LineCounter, isMap, parseDocument } from "yaml";
import { POLICY_SCHEMA_ID, type LoadedPolicy, type PolicyErrorCode, type PolicyIssue } from "../domain/policy.js";
import { PolicyError } from "../errors/errors.js";
import { isFrontMatterFailure, splitFrontMatter } from "./front-matter.js";
import { validateGraph } from "./graph-validator.js";
import { normalizePolicy } from "./normalize.js";
import { hashPolicyBytes } from "./policy-hash.js";
import { rawPolicySchema, stripExtensionKeys, structuralChecks, toSchemaProblems } from "./policy-schema.js";
import { createLocator, formatPath } from "./yaml-locate.js";

export function defaultPolicyPath(homeDir: string): string {
  return path.join(homeDir, ".pi", "SDLC.md");
}

export class PolicyLoader {
  constructor(readonly path: string) {}

  /** Полный preflight. Policy перечитывается при каждом вызове: кэша нет. */
  loadAndValidate(): Promise<LoadedPolicy> {
    return loadPolicyFile(this.path);
  }
}

const fail = (code: PolicyErrorCode, file: string, issues: PolicyIssue[] = [], cause?: unknown): never => {
  throw new PolicyError(code, file, issues, cause === undefined ? undefined : { cause });
};

const fileIssue = (code: string, params: PolicyIssue["params"] = {}, line: number | null = null): PolicyIssue => ({
  code,
  path: null,
  line,
  params,
});

function errnoOf(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err ? String(err.code) : "UNKNOWN";
}

export async function loadPolicyFile(file: string): Promise<LoadedPolicy> {
  let info;
  try {
    info = await stat(file); // stat, а не lstat: симлинк на файл допустим
  } catch (err) {
    const errno = errnoOf(err);
    if (errno === "EACCES" || errno === "EPERM") fail("POLICY_UNREADABLE", file, [fileIssue(errno)], err);
    fail("POLICY_NOT_FOUND", file, [fileIssue(errno)], err);
  }
  if (!info?.isFile()) {
    fail("POLICY_NOT_FILE", file, [fileIssue(info?.isDirectory() ? "IS_DIRECTORY" : "NOT_REGULAR_FILE")]);
  }

  let bytes: Uint8Array;
  try {
    bytes = await readFile(file);
  } catch (err) {
    return fail("POLICY_UNREADABLE", file, [fileIssue(errnoOf(err))], err);
  }
  return parsePolicyBytes(bytes, file);
}

/** Номер первой строки с невалидной UTF-8 последовательностью. */
function firstInvalidUtf8Line(bytes: Uint8Array): number | null {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let line = 1;
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i === bytes.length || bytes[i] === 0x0a) {
      try {
        decoder.decode(bytes.subarray(start, i));
      } catch {
        return line;
      }
      line++;
      start = i + 1;
    }
  }
  return null;
}

/** Шаги 4–10 preflight над уже прочитанными байтами. */
export function parsePolicyBytes(bytes: Uint8Array, file: string): LoadedPolicy {
  // 4. Пустой файл
  if (new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "").trim() === "") fail("POLICY_EMPTY", file);

  // 5. UTF-8. BOM сохраняется в raw, чтобы текст кодировался обратно в те же байты (снимки, hash).
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (err) {
    return fail("POLICY_ENCODING", file, [fileIssue("INVALID_UTF8", {}, firstInvalidUtf8Line(bytes))], err);
  }

  // 6. Front matter
  const split = splitFrontMatter(raw);
  if (isFrontMatterFailure(split)) {
    return fail("POLICY_NO_FRONT_MATTER", file, [fileIssue(split.reason.toUpperCase(), {}, split.line)]);
  }

  // 7. YAML
  const lineCounter = new LineCounter();
  const doc = parseDocument(split.yaml, { lineCounter, uniqueKeys: true, prettyErrors: false, strict: true });
  const yamlLine = (offset: number | undefined) =>
    offset === undefined ? null : lineCounter.linePos(offset).line + split.yamlStartLine - 1;

  if (doc.errors.length > 0) {
    const yamlLines = split.yaml.split("\n");
    fail(
      "POLICY_YAML",
      file,
      doc.errors.map((e) => {
        const lineText = yamlLines[lineCounter.linePos(e.pos[0]).line - 1] ?? "";
        const key = /^\s*(?:-\s+)?(.+?)\s*:(?:\s|$)/.exec(lineText)?.[1] ?? split.yaml.slice(e.pos[0], e.pos[1]);
        return {
          code: e.code === "DUPLICATE_KEY" ? "DUPLICATE_KEY" : "YAML_SYNTAX",
          path: null,
          line: yamlLine(e.pos[0]),
          params: { yamlCode: e.code, detail: e.message.split("\n")[0] ?? "", key },
        };
      }),
    );
  }
  if (!isMap(doc.contents)) {
    fail("POLICY_YAML", file, [fileIssue("ROOT_NOT_MAPPING", {}, split.yamlStartLine)]);
  }

  const locate = createLocator(doc, lineCounter, split.yamlStartLine);

  // 8. Версия схемы
  const schemaValue: unknown = doc.get("schema");
  if (schemaValue !== POLICY_SCHEMA_ID) {
    fail("POLICY_UNSUPPORTED_SCHEMA", file, [
      {
        code: schemaValue === undefined ? "SCHEMA_MISSING" : "SCHEMA_UNSUPPORTED",
        path: "schema",
        line: schemaValue === undefined ? null : locate(["schema"]),
        params: { value: schemaValue === undefined ? null : String(schemaValue), supported: [POLICY_SCHEMA_ID] },
      },
    ]);
  }

  // 9. Схема
  const data = stripExtensionKeys(doc.toJS({ maxAliasCount: 100 }));
  const parsed = rawPolicySchema.safeParse(data);
  const problems = [...(parsed.success ? [] : toSchemaProblems(parsed.error.issues, data)), ...structuralChecks(data)];
  if (problems.length > 0) {
    const issues = problems.map((p) => ({ code: p.code, path: formatPath(p.path), line: locate(p.path), params: p.params }));
    fail("POLICY_SCHEMA", file, issues.sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity)));
  }
  const rawPolicy = parsed.data!;

  // 10. Ссылки и граф
  const graph = validateGraph(rawPolicy, split.body, locate);
  if (graph.errors.length > 0) {
    throw new PolicyError("POLICY_GRAPH", file, graph.errors, { warnings: graph.warnings });
  }

  return {
    path: file,
    raw,
    hash: hashPolicyBytes(bytes),
    schema: POLICY_SCHEMA_ID,
    spec: normalizePolicy(rawPolicy),
    body: split.body,
    warnings: graph.warnings,
  };
}
