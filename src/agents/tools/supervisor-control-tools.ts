// Управляющие инструменты supervisor-а, 04-agents.md §5.3, 03-engine.md §5.3.
// Решение записывается в state внутри tool call, до ответа модели: падение процесса его не теряет.

import path from "node:path";
import { CONTROL_ACTIONS, type ControlAction, type Decision } from "../../domain/decisions.js";
import { resolveWithin } from "../../util/paths.js";
import { redact } from "../../util/redact.js";
import type { EngineCore } from "../../workflow/context.js";
import { controlSchemas, validateDecision, type ValidatorResolvers } from "../../workflow/decision-validator.js";
import { sha256File, type EvidenceContext } from "../evidence-refs.js";
import type { SdlcToolDefinition, ToolResult } from "../runtime.js";
import { GitInspector } from "./git-inspect.js";

const DESCRIPTIONS: Record<ControlAction, string> = {
  transition_stage:
    "Перевести задачу на следующий этап. Только переход из списка допустимых, когда его условие выполнено и проверено. Завершает цикл",
  continue_current_agent: "Продолжить агента текущего этапа в той же сессии с конкретным замечанием. Завершает цикл",
  restart_current_agent: "Перезапустить агента текущего этапа в новой сессии. Завершает цикл",
  ask_human: "Задать вопрос пользователю. Ответ придёт в следующем цикле как human.responded. Завершает цикл",
  schedule_recheck:
    "Отложить проверку: через delayMinutes CLI сам продолжит агента этапа с поручением message. Модели в ожидании не вызываются. Завершает цикл",
  block_task: "Заблокировать задачу, если продолжение невозможно без внешних изменений. Завершает цикл",
  cancel_task: "Отменить задачу. Только по явному свежему решению пользователя (humanResponseRef). Завершает цикл",
};

export function evidenceContext(core: EngineCore): EvidenceContext {
  const git = new GitInspector(core.exec, core.store.layout.projectRoot);
  return {
    projectRoot: core.store.layout.projectRoot,
    artifactsDir: core.task().artifactsDir,
    git: (args) => git.run(args),
    findEvent: async (id) => (await core.events()).find((e) => e.id === id) ?? null,
    runExists: async (runId) => (await core.runs().read(runId).catch(() => null)) !== null,
  };
}

export function validatorResolvers(core: EngineCore): ValidatorResolvers {
  const t = core.task();
  return {
    evidence: evidenceContext(core),
    sessionExists: async (file) => {
      const info = await core.runtime.inspectSessionFile(path.join(t.dir, file));
      return info.exists;
    },
    attachment: async (p) => {
      const target = await resolveWithin([core.store.layout.projectRoot, t.dir], core.store.layout.projectRoot, p);
      if (!target) return null;
      try {
        return { path: path.relative(core.store.layout.projectRoot, target), sha256: await sha256File(target) };
      } catch {
        return null;
      }
    },
    events: () => core.events(),
  };
}

export function supervisorControlTools(core: EngineCore): SdlcToolDefinition[] {
  return CONTROL_ACTIONS.map(
    (action): SdlcToolDefinition => ({
      name: action,
      description: DESCRIPTIONS[action],
      parameters: controlSchemas[action],
      async execute(input): Promise<ToolResult> {
        const mem = core.cycle;
        if (!mem) return { content: "NO_CYCLE: цикл оценки не идёт", isError: true, terminate: true };
        if (mem.decisionRecorded) {
          return { content: "DECISION_ALREADY_RECORDED: решение этого цикла уже записано. Заверши ход.", isError: true, terminate: true };
        }
        const state = await core.store.tasks.load(core.key);
        const runtime = core.policy.spec.runtime;
        const result = await validateDecision(action, input, state, core.policy.spec, runtime, validatorResolvers(core));
        if (!result.ok) {
          mem.invalidCount++;
          const first = result.errors[0];
          await core.store.tasks.appendDirect(core.key, "supervisor.decision_rejected", "cli", {
            cycle: mem.cycle,
            action,
            code: first?.code ?? "INVALID",
            message: result.errors.map((e) => `${e.code}: ${e.message}`).join("; "),
          });
          for (const e of result.errors) core.reporter.emit({ type: "decision.rejected", action, code: e.code, message: e.message });
          const text = result.errors.map((e) => `${e.code}: ${e.message}`).join("\n");
          if (mem.invalidCount > runtime.maxInvalidDecisionsPerCycle) {
            return { content: `${text}\nИсчерпан лимит невалидных решений цикла. Цикл завершён.`, isError: true, terminate: true };
          }
          return { content: `${text}\nИсправь решение и вызови инструмент снова.`, isError: true };
        }
        const decision = {
          decisionId: core.ids.next(),
          cycle: mem.cycle,
          action,
          input: result.input,
          decidedAt: core.clock.now().toISOString(),
        } as Decision;
        await core.store.tasks.commit(
          core.key,
          (s, c) => {
            c.emit("supervisor.decision", "supervisor", { decisionId: decision.decisionId, cycle: mem.cycle, action, input: redact(result.input) });
            return { ...s, phase: "decision_pending", pendingDecision: decision };
          },
          { expectedVersion: state.version },
        );
        mem.decisionRecorded = true;
        core.faults.check("in-control-tool");
        return { content: `Решение ${decision.decisionId} записано: ${action}. Заверши ход.`, terminate: true };
      },
    }),
  );
}
