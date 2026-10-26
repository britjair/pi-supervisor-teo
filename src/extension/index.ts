// Точка входа расширения Pi: команда /teo (docs/07-extension-mode.md §4.5, этап X1).
// Pi SDK здесь — только типы; рантайм SDK подставляет сам Pi (peerDependencies, §4.6).

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runHistory } from "../commands/history.js";
import { runStatus } from "../commands/status.js";
import { msg } from "../ui/messages.js";
import { runCaptured } from "./run-command.js";

/** Подкоманды /teo. Пока работают только чтение и справка; остальные — этапы X2–X4. */
const READY = ["status", "history", "help"] as const;
const PLANNED = ["start", "resume", "goal", "next", "pause", "stop", "recover"] as const;

export function parseArgs(args: string): { sub: string; rest: string[] } {
  const [sub = "help", ...rest] = args.trim().split(/\s+/).filter(Boolean);
  return { sub: sub.toLowerCase(), rest };
}

async function handle(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const { sub, rest } = parseArgs(args);
  const show = (text: string, type: "info" | "warning" | "error" = "info") => {
    // `pi -p "/teo status"`: интерфейса нет, notify ничего не покажет. stdout в print-режиме Pi
    // оставляет под итоговый ответ модели (output-guard), поэтому сообщение расширения — в stderr
    if (!ctx.hasUI && ctx.mode === "print") {
      process.stderr.write(text + "\n");
      return;
    }
    ctx.ui.notify(text, type);
  };
  switch (sub) {
    case "help":
      return show(msg.extension.help);
    case "status": {
      const r = await runCaptured(ctx.cwd, (app) => runStatus(app, rest[0], {}));
      return show(r.text, r.ok ? "info" : "error");
    }
    case "history": {
      const r = await runCaptured(ctx.cwd, (app) => runHistory(app, rest[0], { all: false, json: false, limit: "20" }));
      return show(r.text, r.ok ? "info" : "error");
    }
    default:
      if ((PLANNED as readonly string[]).includes(sub)) return show(msg.extension.planned(sub), "warning");
      return show(msg.extension.unknown(sub), "warning");
  }
}

export default function teoExtension(pi: ExtensionAPI): void {
  pi.registerCommand("teo", {
    description: msg.extension.description,
    getArgumentCompletions: (prefix) => {
      const items = [...READY, ...PLANNED].filter((s) => s.startsWith(prefix.trim().toLowerCase()));
      return items.length > 0 ? items.map((value) => ({ value, label: value })) : null;
    },
    handler: handle,
  });
}
