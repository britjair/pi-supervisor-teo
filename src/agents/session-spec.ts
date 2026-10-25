// Policy + state → SessionSpec: tools, модель, ресурсы Pi, guard (04-agents.md §2, §4.1, §5.1).

import path from "node:path";
import type { AgentDef } from "../domain/policy.js";
import type { EngineCore } from "../workflow/context.js";
import { agentSystemPrompt } from "./prompts/agent-prompts.js";
import { supervisorSystemPrompt } from "./prompts/supervisor-prompts.js";
import type { ModelRef, ResolvedModel, SessionSpec } from "./runtime.js";
import { childTools } from "./tools/child-tools.js";
import { supervisorControlTools } from "./tools/supervisor-control-tools.js";
import { supervisorReadTools } from "./tools/supervisor-read-tools.js";

/** Встроенные tools Pi по умолчанию для агента: default Pi плюс поиск. */
export const DEFAULT_AGENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
/** Supervisor только читает. Инструменты расширений ему не выдаются (точный allowlist). */
export const SUPERVISOR_BUILTIN_TOOLS = ["read", "grep", "find", "ls"];

export function agentModelRef(agent: AgentDef): ModelRef {
  return { ref: agent.model, thinking: agent.thinking, extensions: agent.piResources.extensions === "inherit" };
}

export function agentBuiltinTools(agent: AgentDef): string[] {
  return (agent.tools ?? DEFAULT_AGENT_TOOLS).filter((t) => !agent.excludeTools.includes(t));
}

export function taskDirDisplay(core: EngineCore): string {
  return path.relative(core.store.layout.projectRoot, core.task().dir);
}

export function agentSessionSpec(core: EngineCore, agent: AgentDef, file: string, model: ResolvedModel): SessionSpec {
  const t = core.task();
  const root = core.store.layout.projectRoot;
  return {
    file,
    cwd: root,
    role: "agent",
    model,
    systemPromptAppend: agentSystemPrompt(taskDirDisplay(core)),
    builtinTools: agentBuiltinTools(agent),
    customTools: childTools(core, agent, file),
    piResources: {
      contextFiles: agent.piResources.contextFiles === "inherit",
      extensions: agent.piResources.extensions === "inherit",
      skills: agent.piResources.skills === "inherit",
    },
    guard: {
      role: "agent",
      projectRoot: root,
      taskDir: t.dir,
      writableInsideSdlc: [t.artifactsDir],
      readableRoots: [root],
      isReported: () => core.reported.has(file),
    },
  };
}

export function supervisorSessionSpec(core: EngineCore, model: ResolvedModel): SessionSpec {
  const t = core.task();
  const root = core.store.layout.projectRoot;
  const sv = core.policy.spec.supervisor;
  return {
    file: path.join(t.dir, "sessions", "supervisor.jsonl"),
    cwd: root,
    role: "supervisor",
    model,
    systemPromptAppend: supervisorSystemPrompt({ instructions: sv.instructions, body: core.policy.body }),
    builtinTools: SUPERVISOR_BUILTIN_TOOLS,
    customTools: [...supervisorReadTools(core), ...supervisorControlTools(core)],
    piResources: {
      contextFiles: sv.piResources.contextFiles === "inherit",
      extensions: sv.piResources.extensions === "inherit",
      skills: sv.piResources.skills === "inherit",
    },
    guard: {
      role: "supervisor",
      projectRoot: root,
      taskDir: t.dir,
      writableInsideSdlc: [],
      readableRoots: [root],
      isReported: () => false,
    },
  };
}
