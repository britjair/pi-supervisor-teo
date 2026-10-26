// Компонент меню выбора задачи (05-cli-ui.md §3).
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Choice } from "../human-io.js";

export interface TaskSelectorProps<T> {
  header?: string;
  projectRoot?: string;
  policyInfo?: string;
  title: string;
  choices: ReadonlyArray<Choice<T>>;
  onSelect: (value: T) => void;
  onCancel?: () => void;
  onInterrupt?: (() => void) | undefined;
  width?: number;
}

export function TaskSelector<T>({
  header = "Pi Supervisor TEO",
  projectRoot,
  policyInfo,
  title,
  choices,
  onSelect,
  onCancel,
  onInterrupt,
  width = 80,
}: TaskSelectorProps<T>): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onInterrupt?.();
      return;
    }
    if (key.escape) {
      onCancel?.();
      return;
    }

    if (input === "q" || input === "й") {
      const exitChoice = choices.find((c) => c.key === "q");
      if (exitChoice) {
        onSelect(exitChoice.value);
        return;
      }
      onCancel?.();
      return;
    }

    if (key.upArrow || input === "k") {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : choices.length - 1));
      return;
    }

    if (key.downArrow || input === "j") {
      setSelectedIndex((prev) => (prev < choices.length - 1 ? prev + 1 : 0));
      return;
    }

    if (key.return) {
      const chosen = choices[selectedIndex];
      if (chosen) onSelect(chosen.value);
    }
  });

  return (
    <Box flexDirection="column" width={width} marginY={1}>
      {header ? <Text bold color="cyan">{header}</Text> : null}
      {projectRoot ? <Text color="gray">Project: {projectRoot}</Text> : null}
      {policyInfo ? <Text color="gray">Policy:  {policyInfo}</Text> : null}
      <Box marginY={1}>
        <Text bold>{title}</Text>
      </Box>
      <Box flexDirection="column">
        {choices.map((choice, i) => {
          const isSelected = i === selectedIndex;
          return (
            <Box key={i}>
              {isSelected ? (
                <Text color="cyan" bold>{`❯ ${choice.label}`}</Text>
              ) : (
                <Text>{`  ${choice.label}`}</Text>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
