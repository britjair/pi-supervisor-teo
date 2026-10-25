// Экран выполнения задачи (05-cli-ui.md §4.1, §4.4).
import React, { useEffect, useState } from "react";
import { Box, Static, Text, useInput } from "ink";
import { StatusHeader } from "./status-header.js";
import { StatusBar } from "./status-bar.js";

export interface RunScreenProps {
  taskKey: string;
  stageTitle: string;
  agentId?: string | null | undefined;
  attempt?: number | null | undefined;
  log: string[];
  partial?: string | undefined;
  partialActor?: "agent" | "supervisor" | null | undefined;
  thinking?: boolean | undefined;
  thinkingText?: string | undefined;
  activity?: string | undefined;
  runStartedAtMs?: number | undefined;
  activityStartedAtMs?: number | undefined;
  nowMs?: (() => number) | undefined;
  cycle?: number | undefined;
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  costUsd?: number | null | undefined;
  stopConfirm?: boolean | undefined;
  statusOverlay?: boolean | undefined;
  width?: number | undefined;
  onRequestStop: () => void;
  onConfirmStop: (yes: boolean) => void;
  onToggleThinking?: (() => void) | undefined;
  onToggleStatus?: (() => void) | undefined;
}

export function RunScreen({
  taskKey,
  stageTitle,
  agentId,
  attempt,
  log,
  partial = "",
  partialActor = null,
  thinking = false,
  thinkingText = "",
  activity = "",
  runStartedAtMs = 0,
  activityStartedAtMs = 0,
  nowMs = () => 0,
  cycle = 0,
  tokensIn = 0,
  tokensOut = 0,
  costUsd = null,
  stopConfirm = false,
  statusOverlay = false,
  width = 80,
  onRequestStop,
  onConfirmStop,
  onToggleThinking,
  onToggleStatus,
}: RunScreenProps): React.ReactElement {
  const [now, setNow] = useState(() => nowMs());

  useEffect(() => {
    const timer = setInterval(() => setNow(nowMs()), 1000);
    return () => clearInterval(timer);
  }, [nowMs]);

  const elapsedSeconds = runStartedAtMs > 0 ? (now - runStartedAtMs) / 1000 : 0;
  const activitySeconds = activityStartedAtMs > 0 ? (now - activityStartedAtMs) / 1000 : 0;

  useInput((input, key) => {
    if (stopConfirm) {
      if (key.ctrl && input === "c") {
        onRequestStop();
        return;
      }
      if (input === "y" || input === "д" || key.return) {
        onConfirmStop(true);
        return;
      }
      if (key.escape || input === "n" || input === "н") {
        onConfirmStop(false);
        return;
      }
      return;
    }

    if (key.ctrl && input === "c") {
      onRequestStop();
      return;
    }

    if (input === "t" || input === "е") {
      onToggleThinking?.();
      return;
    }

    if (input === "s" || input === "ы") {
      onToggleStatus?.();
      return;
    }
  });

  return (
    <Box flexDirection="column" width={width}>
      <StatusHeader
        taskKey={taskKey}
        stageTitle={stageTitle}
        agentId={agentId}
        attempt={attempt}
        elapsedSeconds={elapsedSeconds}
        width={width}
      />

      {/* Прокручиваемая лента завершённых строк */}
      <Static items={log.map((line, idx) => ({ id: idx, text: line }))}>
        {(item) => (
          <Box key={item.id} width={width}>
            {item.text.startsWith("supervisor ›") ? (
              <Text color="gray">{item.text}</Text>
            ) : (
              <Text>{item.text}</Text>
            )}
          </Box>
        )}
      </Static>

      {/* Текущая частичная строка стрима */}
      {partial ? (
        <Box width={width} paddingX={1}>
          <Text color="cyan">{partialActor === "supervisor" ? `supervisor › ${partial}` : partial}</Text>
        </Box>
      ) : null}

      {/* Thinking остаётся динамическим: его можно скрыть клавишей t. */}
      {thinking && thinkingText ? (
        <Box width={width} paddingX={1} borderStyle="single" borderColor="gray">
          <Text color="gray">{thinkingText}</Text>
        </Box>
      ) : null}

      {/* Оверлей статуса */}
      {statusOverlay ? (
        <Box
          borderStyle="round"
          borderColor="yellow"
          flexDirection="column"
          paddingX={1}
          marginY={1}
          width={width}
        >
          <Text bold color="yellow">Статус задачи {taskKey}</Text>
          <Text>Этап: {stageTitle}</Text>
          {agentId ? <Text>Агент: {agentId} (попытка {attempt ?? 1})</Text> : null}
          <Text>Цикл supervisor: {cycle}</Text>
          <Text color="gray">Нажмите s, чтобы скрыть оверлей.</Text>
        </Box>
      ) : null}

      <StatusBar
        stageTitle={stageTitle}
        role={agentId ? "agent" : "supervisor"}
        cycle={cycle}
        activity={activity}
        activitySeconds={activitySeconds}
        tokensIn={tokensIn}
        tokensOut={tokensOut}
        costUsd={costUsd}
        stopConfirm={stopConfirm}
        width={width}
      />
    </Box>
  );
}
