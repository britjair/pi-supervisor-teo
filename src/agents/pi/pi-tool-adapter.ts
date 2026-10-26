// Zod-контракт движка → TypeBox-контракт Pi. Проверка Zod выполняется повторно
// после TypeBox: defaults, refinements и сообщения ошибок принадлежат teo.

import { z } from "zod";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TeoToolDefinition } from "../runtime.js";

export function toPiTool(tool: TeoToolDefinition): ToolDefinition {
  const schema = Type.Unsafe(z.toJSONSchema(tool.parameters, { target: "draft-7" }));
  return defineTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: schema,
    // Tools, пишущие state/run, сериализуются: Pi по умолчанию исполняет пачку параллельно.
    executionMode: "sequential",
    async execute(toolCallId, input, signal) {
      const parsed = tool.parameters.safeParse(input);
      if (!parsed.success) return {
        content: [{ type: "text", text: `INVALID_INPUT: ${z.prettifyError(parsed.error)}` }],
        details: undefined,
        isError: true,
      };
      const result = await tool.execute(parsed.data, { toolCallId, signal: signal ?? new AbortController().signal });
      return {
        content: [{ type: "text", text: result.content }],
        details: undefined,
        ...(result.isError ? { isError: true } : {}),
        ...(result.terminate ? { terminate: true } : {}),
      };
    },
  });
}
