// Шапка экрана выполнения (05-cli-ui.md §4.1).
// ┌ KEY · Stage · agent: id · attempt N ────────────────────────── 00:03:42 ┐
import React from "react";
import { Box, Text } from "ink";

export interface StatusHeaderProps {
  taskKey: string;
  stageTitle: string;
  agentId?: string | null | undefined;
  attempt?: number | null | undefined;
  elapsedSeconds?: number | undefined;
  width?: number | undefined;
}

export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function StatusHeader({
  taskKey,
  stageTitle,
  agentId,
  attempt,
  elapsedSeconds = 0,
  width = 80,
}: StatusHeaderProps): React.ReactElement {
  const leftParts = [
    taskKey,
    stageTitle,
    agentId ? `agent: ${agentId}` : null,
    attempt ? `attempt ${attempt}` : null,
  ].filter(Boolean);

  const rightText = ` ${formatElapsed(elapsedSeconds)} ┐`;
  const maxLabel = Math.max(1, width - rightText.length - 4);
  const rawLabel = leftParts.join(" · ");
  const label = rawLabel.length > maxLabel ? `${rawLabel.slice(0, Math.max(0, maxLabel - 1))}…` : rawLabel;
  const leftText = `┌ ${label} `;
  const fillLen = Math.max(1, width - leftText.length - rightText.length);
  const filler = "─".repeat(fillLen);

  return (
    <Box width={width} flexDirection="row">
      <Text bold color="cyan">{leftText}</Text>
      <Text color="gray">{filler}</Text>
      <Text color="cyan">{rightText}</Text>
    </Box>
  );
}
