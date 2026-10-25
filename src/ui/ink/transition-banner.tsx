// Баннер перехода между этапами (05-cli-ui.md §4.2).
import React from "react";
import { Box, Text } from "ink";

export interface TransitionBannerProps {
  taskKey?: string;
  fromTitle?: string;
  toTitle: string;
  reason?: string;
  terminal?: boolean;
  nextAgent?: string | null;
  attempt?: number | null;
  stagesCompleted?: number;
  durationText?: string;
  costText?: string;
  width?: number;
}

export function TransitionBanner({
  taskKey,
  fromTitle,
  toTitle,
  reason,
  terminal = false,
  nextAgent,
  attempt,
  stagesCompleted,
  durationText,
  costText,
  width = 60,
}: TransitionBannerProps): React.ReactElement {
  const bar = "═".repeat(width);

  if (terminal) {
    const stats = [
      stagesCompleted !== undefined ? `Этапов пройдено: ${stagesCompleted}` : null,
      durationText ? `время: ${durationText}` : null,
      costText ? `стоимость: ${costText}` : null,
    ].filter(Boolean).join(" · ");

    return (
      <Box flexDirection="column" marginY={1}>
        <Text color="green">{bar}</Text>
        <Text bold color="green">
          {`✓ Задача ${taskKey ?? ""} достигла этапа «${toTitle}»`}
        </Text>
        {stats ? <Text color="gray">{`  ${stats}`}</Text> : null}
        <Text color="green">{bar}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color="green">{bar}</Text>
      <Text bold color="green">
        {`✓ ${fromTitle ?? ""} → ${toTitle}`}
      </Text>
      {reason ? <Text color="gray">{`  Причина: ${reason}`}</Text> : null}
      {nextAgent ? (
        <Text color="cyan">
          {`→ Запускаю agent: ${nextAgent}${attempt ? ` (attempt ${attempt})` : ""}`}
        </Text>
      ) : null}
      <Text color="green">{bar}</Text>
    </Box>
  );
}
