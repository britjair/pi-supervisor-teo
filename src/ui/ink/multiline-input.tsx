// Многострочный редактор ввода (05-cli-ui.md §4.3).
// Enter — перевод строки, Ctrl+D — предпросмотр/отправка, Esc — отмена.
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Validate } from "../human-io.js";

export interface MultilineInputProps {
  title: string;
  initial?: string;
  multiline?: boolean;
  validate?: Validate;
  confirmBeforeSubmit?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  onInterrupt?: (() => void) | undefined;
}

export function MultilineInput({
  title,
  initial = "",
  multiline = true,
  validate,
  confirmBeforeSubmit = true,
  onSubmit,
  onCancel,
  onInterrupt,
}: MultilineInputProps): React.ReactElement {
  const [text, setText] = useState(initial);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onInterrupt?.();
      return;
    }

    if (preview) {
      if (key.return) {
        const err = validate?.(text) ?? null;
        if (err) {
          setError(err);
          setPreview(false);
          return;
        }
        onSubmit(text);
        return;
      }
      if (key.escape) {
        setPreview(false);
        return;
      }
      return;
    }

    if (key.escape) {
      onCancel();
      return;
    }

    if (key.ctrl && input === "d") {
      const err = validate?.(text) ?? null;
      if (err) {
        setError(err);
        return;
      }
      if (confirmBeforeSubmit) {
        setPreview(true);
      } else {
        onSubmit(text);
      }
      return;
    }

    if (key.return) {
      if (!multiline) {
        const err = validate?.(text) ?? null;
        if (err) {
          setError(err);
          return;
        }
        onSubmit(text);
        return;
      }
      setText((prev) => prev + "\n");
      setError(null);
      return;
    }

    if (key.backspace || key.delete) {
      setText((prev) => prev.slice(0, -1));
      setError(null);
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      setText((prev) => prev + input);
      setError(null);
    }
  });

  if (preview) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text bold color="cyan">{title}</Text>
        <Box borderStyle="round" borderColor="gray" paddingX={1} marginY={1}>
          <Text>{text || "(пусто)"}</Text>
        </Box>
        <Text color="yellow">Отправить ответ? (Enter — отправить / Esc — редактировать)</Text>
      </Box>
    );
  }

  const hint = multiline
    ? "(Enter — новая строка, Ctrl+D — завершить, Esc — отмена)"
    : "(Enter — отправить, Esc — отмена)";

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text bold color="cyan">{title} </Text>
        <Text color="gray">{hint}</Text>
      </Box>
      <Box borderStyle="round" borderColor={error ? "red" : "blue"} paddingX={1} marginY={1}>
        <Text>{text}</Text>
        <Text color="gray">█</Text>
      </Box>
      {error ? <Text color="red">! {error}</Text> : null}
    </Box>
  );
}
