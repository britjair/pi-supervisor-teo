// Экран вопроса человеку от supervisor или дочернего агента (05-cli-ui.md §4.3).
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { HumanAnswer, QuestionView } from "../human-io.js";
import { MultilineInput } from "./multiline-input.js";

export interface HumanPromptProps {
  question: QuestionView;
  onSubmit: (answer: HumanAnswer) => void;
  onCancel: () => void;
  onInterrupt?: (() => void) | undefined;
  width?: number;
}

const CUSTOM_OPTION = "Свой ответ…";

export function HumanPrompt({
  question,
  onSubmit,
  onCancel,
  onInterrupt,
  width = 80,
}: HumanPromptProps): React.ReactElement {
  const options = question.options ?? [];
  const hasOptions = options.length > 0;
  const allChoices = hasOptions
    ? [...options, ...(question.allowFreeText ? [CUSTOM_OPTION] : [])]
    : [];

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editingCustom, setEditingCustom] = useState(!hasOptions);

  useInput((input, key) => {
    if (editingCustom) return;

    if (key.ctrl && input === "c") {
      onInterrupt?.();
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.upArrow || input === "k") {
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : allChoices.length - 1));
      return;
    }

    if (key.downArrow || input === "j") {
      setSelectedIndex((prev) => (prev < allChoices.length - 1 ? prev + 1 : 0));
      return;
    }

    if (key.return) {
      const chosen = allChoices[selectedIndex];
      if (!chosen || chosen === CUSTOM_OPTION) {
        setEditingCustom(true);
        return;
      }
      onSubmit({ answer: chosen, selectedOption: chosen });
    }
  });

  const headerLine = `╭─ ${question.header} `;
  const fillLen = Math.max(1, width - headerLine.length - 1);
  const topBorder = `${headerLine}${"─".repeat(fillLen)}╮`;
  const bottomBorder = `╰${"─".repeat(width - 1)}╯`;

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Рамка вопроса */}
      <Box flexDirection="column" width={width}>
        <Text color="cyan">{topBorder}</Text>
        <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor="cyan" borderTop={false} borderBottom={false}>
          <Text bold>{question.question}</Text>
          {question.context ? (
            <Box marginTop={1}>
              <Text color="gray">Контекст: {question.context}</Text>
            </Box>
          ) : null}
          {question.attachments.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color="gray">Вложения:</Text>
              {question.attachments.map((a, i) => (
                <Text key={i} color="gray">{`  ${a.path} (sha256:${a.sha256.slice(0, 8)}…)`}</Text>
              ))}
            </Box>
          ) : null}
        </Box>
        <Text color="cyan">{bottomBorder}</Text>
      </Box>

      {/* Варианты ответа или свободный ввод */}
      {editingCustom ? (
        <MultilineInput
          title="Ваш ответ"
          multiline={true}
          confirmBeforeSubmit={true}
          validate={(v) => (v.trim() ? null : "Ответ не может быть пустым.")}
          onSubmit={(text) => onSubmit({ answer: text.trim(), selectedOption: null })}
          onCancel={() => {
            if (hasOptions) setEditingCustom(false);
            else onCancel();
          }}
          onInterrupt={onInterrupt}
        />
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Выберите вариант (стрелки / j, k, Enter — выбрать, Esc — отмена):</Text>
          {allChoices.map((choice, i) => {
            const isSelected = i === selectedIndex;
            return (
              <Box key={i} marginX={1}>
                {isSelected ? (
                  <Text color="cyan" bold>{`❯ ${choice}`}</Text>
                ) : (
                  <Text>{`  ${choice}`}</Text>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
