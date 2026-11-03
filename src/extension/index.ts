// Точка входа расширения Pi: команда /teo (docs/07-extension-mode.md §4.5).
// Pi SDK здесь — только типы; рантайм SDK подставляет сам Pi (peerDependencies, §4.6).

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runHistory } from "../commands/history.js";
import { runStatus } from "../commands/status.js";
import { msg } from "../ui/messages.js";
import { ExtensionHost } from "./host.js";
import { errorText, extensionAppContext, runCaptured } from "./run-command.js";

const READY = ["start", "goal", "resume", "continue", "sessions", "list", "next", "pause", "recover", "stop", "status", "history", "help"] as const;

export function parseArgs(args: string): { sub: string; rest: string[]; tail: string } {
  const trimmed = args.trim();
  const [sub = "help", ...rest] = trimmed.split(/\s+/).filter(Boolean);
  return { sub: sub.toLowerCase(), rest, tail: trimmed.slice(sub.length).trim() };
}

function show(ctx: ExtensionCommandContext, text: string, type: "info" | "warning" | "error" = "info"): void {
  // `pi -p "/teo status"`: интерфейса нет, notify ничего не покажет. stdout в print-режиме Pi
  // оставляет под итоговый ответ модели (output-guard), поэтому сообщение расширения — в stderr
  if (!ctx.hasUI && ctx.mode === "print") {
    process.stderr.write(text + "\n");
    return;
  }
  ctx.ui.notify(text, type);
}

async function handle(host: ExtensionHost, args: string, ctx: ExtensionCommandContext): Promise<void> {
  const { sub, rest, tail } = parseArgs(args);
  switch (sub) {
    case "help":
      return show(ctx, msg.extension.help);
    case "status": {
      const r = await runCaptured(ctx.cwd, (app) => runStatus(app, rest[0], {}));
      return show(ctx, r.text, r.ok ? "info" : "error");
    }
    case "history": {
      const r = await runCaptured(ctx.cwd, (app) => runHistory(app, rest[0], { all: false, json: false, limit: "20" }));
      return show(ctx, r.text, r.ok ? "info" : "error");
    }
    case "start":
      return host.start(ctx, rest[0]);
    case "goal":
      return host.goal(ctx, tail);
    case "resume":
      return host.resume(ctx, rest[0]);
    case "sessions":
    case "list":
      return host.sessions(ctx);
    case "next":
      return host.next(ctx);
    case "continue":
      return host.continueNow(ctx);
    case "pause":
      return host.pause(ctx);
    case "recover":
      return host.recover(ctx, rest[0]);
    case "stop":
      return host.stop(ctx);
    default:
      return show(ctx, msg.extension.unknown(sub), "warning");
  }
}

export default function teoExtension(pi: ExtensionAPI): void {
  const host = new ExtensionHost(pi);
  host.register();
  pi.registerCommand("teo", {
    description: msg.extension.description,
    getArgumentCompletions: (prefix) => {
      const items = [...READY].filter((s) => s.startsWith(prefix.trim().toLowerCase()));
      return items.length > 0 ? items.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      try {
        await handle(host, args, ctx);
      } catch (err) {
        show(ctx, errorText(extensionAppContext(ctx.cwd).ctx, err), "error");
      }
    },
  });
}
