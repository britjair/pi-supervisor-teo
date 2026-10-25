// Inline guard Pi: отделяет ограничения модели от workflow и не пишет файлов расширения.
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { guardToolCall } from "../guard.js";
import type { GuardConfig } from "../runtime.js";

export function createGuardExtension(config: GuardConfig, cwd: string): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const verdict = await guardToolCall(config, event.toolName, event.input, cwd);
      return verdict.allow ? undefined : { block: true, reason: verdict.reason, terminate: verdict.terminate };
    });
  };
}
