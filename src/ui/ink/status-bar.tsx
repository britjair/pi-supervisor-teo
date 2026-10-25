// Подвал экрана выполнения и строка активности со спиннером (05-cli-ui.md §4.1).
// ⠋ supervisor проверяет результат reviewer · 00:00:18
// └ SDLC: Ревью · supervisor · cycle 7 · in 41k out 3k · Ctrl+C — остановить ┘
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { formatElapsed } from "./status-header.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface StatusBarProps {
  stageTitle: string;
  role?: string | undefined;
  cycle?: number | undefined;
  activity?: string | undefined;
  activitySeconds?: number | undefined;
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  costUsd?: number | null | undefined;
  stopConfirm?: boolean | undefined;
  width?: number | undefined;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function StatusBar({
  stageTitle,
  role = "supervisor",
  cycle = 0,
  activity = "",
  activitySeconds = 0,
  tokensIn = 0,
  tokensOut = 0,
  costUsd = null,
  stopConfirm = false,
  width = 80,
}: StatusBarProps): React.ReactElement {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  const spinner = SPINNER_FRAMES[frame] ?? "⠋";
  const activityDuration = formatElapsed(activitySeconds);
  const activityText = activity ? `${spinner} ${activity} · ${activityDuration}` : "";

  const usageParts = [];
  if (tokensIn > 0 || tokensOut > 0) {
    usageParts.push(`in ${formatTokens(tokensIn)} out ${formatTokens(tokensOut)}`);
  }
  if (costUsd !== null && costUsd > 0) {
    usageParts.push(`$${costUsd.toFixed(2)}`);
  }

  const hint = stopConfirm ? "Остановить? (y/Esc)" : "Ctrl+C — остановить";
  const leftParts = [
    `SDLC: ${stageTitle}`,
    role,
    cycle > 0 ? `cycle ${cycle}` : null,
    ...usageParts,
  ].filter(Boolean);

  const rightText = ` ${hint} ┘`;
  const maxLabel = Math.max(1, width - rightText.length - 4);
  const rawLabel = leftParts.join(" · ");
  const label = rawLabel.length > maxLabel ? `${rawLabel.slice(0, Math.max(0, maxLabel - 1))}…` : rawLabel;
  const leftText = `└ ${label} `;
  const fillLen = Math.max(1, width - leftText.length - rightText.length);
  const filler = "─".repeat(fillLen);

  return (
    <Box width={width} flexDirection="column">
      {activityText ? (
        <Box paddingLeft={1} marginBottom={0}>
          <Text color="yellow">{activityText}</Text>
        </Box>
      ) : null}
      <Box flexDirection="row">
        <Text color="cyan">{leftText}</Text>
        <Text color="gray">{filler}</Text>
        <Text color={stopConfirm ? "red" : "gray"}>{rightText}</Text>
      </Box>
    </Box>
  );
}
