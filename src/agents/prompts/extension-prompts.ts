// Промпты режима расширения (docs/07-extension-mode.md §4.3): роль этапа в пользовательской сессии Pi.
// Только подстановки из Policy и state: ни имён этапов, ни ролей, ни правил процесса.

import type { AgentDef, PolicySpec, WorkStage } from "../../domain/policy.js";
import { transitionsBlock } from "./agent-prompts.js";

export type StageSectionData = {
  task: { key: string; title: string; description: string };
  process: string;
  spec: PolicySpec;
  stage: WorkStage;
  agent: AgentDef;
  /** Передача от supervisor при входе в этап */
  handoff: string | null;
  taskDirDisplay: string;
};

/** Секция системного промпта на каждый ход привязанной сессии. */
export function stageSection(d: StageSectionData): string {
  return [
    `Ты работаешь в процессе «${d.process}» под управлением teo. Сейчас идёт задача ${d.task.key}: ${d.task.title}.`,
    `Твоя роль на этом этапе — «${d.agent.title}». Выполняй только текущий этап: менять этап ты не можешь,`,
    "его меняет отдельный supervisor по условиям ниже, когда проверит факты. Пользователь — участник",
    "процесса: отвечай ему в роли, его сообщения записываются в журнал задачи как подтверждения.",
    "",
    "# Задача",
    d.task.description.trim(),
    "",
    `# Текущий этап: ${d.stage.title} (${d.stage.id})`,
    ...[d.stage.description, d.stage.instructions].filter((x): x is string => !!x).map((x) => x.trim()),
    "",
    `# Твоя роль: ${d.agent.title}`,
    d.agent.instructions.trim(),
    "",
    "# Как оценивается этап",
    "Supervisor продвинет задачу, только когда одно из условий выполнено и подтверждено:",
    transitionsBlock(d.spec, d.stage),
    "",
    "# Передача от supervisor",
    d.handoff?.trim() || "Нет.",
    "",
    "# Правила",
    `- Документы задачи лежат в ${d.taskDirDisplay}. Внутри .teo писать можно только в ${d.taskDirDisplay}/artifacts/.`,
    "- Указания и роли прошлых этапов в этой сессии больше не действуют: действует только этот раздел.",
    "- Сообщай только о том, что действительно сделал и проверил.",
  ].join("\n");
}

/** Первое сообщение роли при входе в этап: роль начинает сама, не дожидаясь пользователя (критерий 13). */
export function stageKickoff(d: { stageTitle: string; agentTitle: string }): string {
  return `[teo] Начался этап «${d.stageTitle}». Роль — «${d.agentTitle}». Приступай к работе этапа.`;
}
