// Фабрика интерактивного HumanIO. Composition root не зависит напрямую от Ink/React.
import type { Readable, Writable } from "node:stream";
import type { Clock } from "../util/clock.js";
import type { HumanIO } from "./human-io.js";
import { InkHumanIO } from "./ink/ink-human-io.js";
import { PlainHumanIO } from "./plain/plain-human-io.js";
import type { Style } from "./plain/style.js";

export function createInteractiveHumanIO(
  stdin: Readable,
  stdout: Writable,
  stderr: Writable,
  clock: Clock,
  style: Style,
  plain: boolean,
): HumanIO {
  return plain
    ? new PlainHumanIO(stdin, stdout, style, true)
    : new InkHumanIO(stdin, stdout, stderr, clock);
}
