// Экран ожидания отложенной перепроверки (05-cli-ui.md §4.5).
// Enter — проверить сейчас · m — написать supervisor · q — выйти · Ctrl+C — остановить
import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { WaitAction } from "../../workflow/wait-step.js";
import { formatElapsed } from "./status-header.js";

export interface WaitScreenProps {
  dueAt: string;
  number: number;
  maxCount: number;
  waitingFor: string;
  nextStepText?: string;
  onAction: (action: WaitAction) => void;
  onWriteMessage: () => void;
  onInterrupt: () => void;
  nowMs: () => number;
  width?: number;
}

export function WaitScreen({
  dueAt,
  number,
  maxCount,
  waitingFor,
  nextStepText,
  onAction,
  onWriteMessage,
  onInterrupt,
  nowMs,
  width = 60,
}: WaitScreenProps): React.ReactElement {
  const [secondsLeft, setSecondsLeft] = useState(() => {
    const target = new Date(dueAt).getTime();
    return Math.max(0, Math.round((target - nowMs()) / 1000));
  });

  useEffect(() => {
    const timer = setInterval(() => {
      const target = new Date(dueAt).getTime();
      const left = Math.max(0, Math.round((target - nowMs()) / 1000));
      setSecondsLeft(left);
      if (left <= 0) {
        clearInterval(timer);
        onAction({ kind: "tick" });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [dueAt, nowMs, onAction]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onInterrupt();
      return;
    }
    if (key.return) {
      onAction({ kind: "check_now" });
      return;
    }
    if (input === "m" || input === "ь") {
      onWriteMessage();
      return;
    }
    if (input === "q" || input === "й") {
      onAction({ kind: "quit" });
      return;
    }
  });

  const dueTime = dueAt ? new Date(dueAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const remaining = formatElapsed(secondsLeft);
  const bar = "═".repeat(width);

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color="yellow">{bar}</Text>
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="yellow">
          {`⏳ Ожидание: ${waitingFor}`}
        </Text>
        <Text color="cyan">
          {`   Перепроверка в ${dueTime} (через ${remaining}) · перепроверка ${number} из ${maxCount}`}
        </Text>
        {nextStepText ? <Text color="gray">{`   Затем: ${nextStepText}`}</Text> : null}
      </Box>
      <Text color="yellow">{bar}</Text>
      <Box paddingX={1} marginTop={1}>
        <Text color="gray">
          {"Enter — проверить сейчас · m — написать supervisor · q — выйти · Ctrl+C — остановить"}
        </Text>
      </Box>
    </Box>
  );
}
