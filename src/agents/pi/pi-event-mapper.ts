// Поток событий Pi 1.4.0 → независимый от SDK RuntimeEvent.
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RuntimeEvent } from "../runtime.js";
import { argsPreview } from "../../util/redact.js";

export function mapPiEvent(e: AgentSessionEvent): RuntimeEvent | null {
  switch (e.type) {
    case "message_update":
      if (e.assistantMessageEvent.type === "text_delta") return { type: "text", delta: e.assistantMessageEvent.delta };
      if (e.assistantMessageEvent.type === "thinking_delta") return { type: "thinking", delta: e.assistantMessageEvent.delta };
      return null;
    case "tool_execution_start":
      return { type: "tool.started", toolCallId: e.toolCallId, toolName: e.toolName, argsPreview: argsPreview(e.args) };
    case "tool_execution_end":
      return { type: "tool.finished", toolCallId: e.toolCallId, toolName: e.toolName, ok: !e.isError };
    case "auto_retry_start":
      return { type: "retry", attempt: e.attempt, reason: e.errorMessage };
    case "compaction_start":
      return { type: "compaction", phase: "start" };
    case "compaction_end":
      return { type: "compaction", phase: "end" };
    case "turn_end":
      return e.message.role === "assistant" ? {
        type: "usage", usage: {
          inputTokens: e.message.usage.input,
          outputTokens: e.message.usage.output,
          costUsd: e.message.usage.cost.total,
        },
      } : null;
    case "agent_settled":
      return { type: "settled" };
    default:
      return null;
  }
}
