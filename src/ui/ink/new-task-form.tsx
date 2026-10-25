// Форма создания новой задачи в Ink (05-cli-ui.md §3.2).
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { keyError, titleError } from "../../commands/new.js";
import { MultilineInput } from "./multiline-input.js";

export interface NewTaskFormProps {
  projectRoot: string;
  gitInfo?: string | null;
  initialStageLine?: string;
  existingKeys?: string[];
  initialKey?: string;
  initialTitle?: string;
  initialDescription?: string;
  onSubmit: (task: { key: string; title: string; description: string }) => void;
  onCancel: () => void;
  width?: number;
}

type Step = "key" | "title" | "description" | "confirm";

export function NewTaskForm({
  projectRoot,
  gitInfo,
  initialStageLine,
  existingKeys = [],
  initialKey = "",
  initialTitle = "",
  initialDescription = "",
  onSubmit,
  onCancel,
  width = 80,
}: NewTaskFormProps): React.ReactElement {
  const [step, setStep] = useState<Step>(initialKey ? (initialTitle ? "description" : "title") : "key");
  const [key, setKey] = useState(initialKey);
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [confirmIndex, setConfirmIndex] = useState(0);

  const confirmChoices = ["Создать и запустить", "Изменить", "Отмена"] as const;

  useInput((input, keyPress) => {
    if (step !== "confirm") return;

    if (keyPress.escape || (keyPress.ctrl && input === "c")) {
      onCancel();
      return;
    }

    if (keyPress.upArrow || input === "k") {
      setConfirmIndex((prev) => (prev > 0 ? prev - 1 : confirmChoices.length - 1));
      return;
    }

    if (keyPress.downArrow || input === "j") {
      setConfirmIndex((prev) => (prev < confirmChoices.length - 1 ? prev + 1 : 0));
      return;
    }

    if (keyPress.return) {
      const choice = confirmChoices[confirmIndex];
      if (choice === "Создать и запустить") {
        onSubmit({ key, title, description });
      } else if (choice === "Изменить") {
        setStep("key");
      } else {
        onCancel();
      }
    }
  });

  return (
    <Box flexDirection="column" width={width} marginY={1}>
      <Text bold color="cyan">Новая задача</Text>
      <Text color="gray">
        {`Project root: ${projectRoot}${gitInfo ? `   (${gitInfo})` : ""}`}
      </Text>

      {/* Шаг 1: Ключ */}
      {step === "key" ? (
        <MultilineInput
          title="Ключ задачи"
          initial={key}
          multiline={false}
          confirmBeforeSubmit={false}
          validate={(v) => keyError(v.trim(), existingKeys)}
          onSubmit={(val) => {
            setKey(val.trim());
            setStep("title");
          }}
          onCancel={onCancel}
        />
      ) : (
        <Box marginTop={1}>
          <Text color="cyan">Ключ задачи: </Text>
          <Text>{key || "(не задан)"}</Text>
        </Box>
      )}

      {/* Шаг 2: Название */}
      {step === "title" ? (
        <MultilineInput
          title="Название"
          initial={title}
          multiline={false}
          confirmBeforeSubmit={false}
          validate={(v) => titleError(v)}
          onSubmit={(val) => {
            setTitle(val.trim());
            setStep("description");
          }}
          onCancel={() => setStep("key")}
        />
      ) : step !== "key" ? (
        <Box>
          <Text color="cyan">Название: </Text>
          <Text>{title || "(не задано)"}</Text>
        </Box>
      ) : null}

      {/* Шаг 3: Описание */}
      {step === "description" ? (
        <MultilineInput
          title="Описание"
          initial={description}
          multiline={true}
          confirmBeforeSubmit={true}
          validate={(v) => (v.trim() ? null : "Описание не может быть пустым.")}
          onSubmit={(val) => {
            setDescription(val.trim());
            setStep("confirm");
          }}
          onCancel={() => setStep("title")}
        />
      ) : step === "confirm" ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan">Описание:</Text>
          <Box borderStyle="single" borderColor="gray" paddingX={1}>
            <Text>{description}</Text>
          </Box>
        </Box>
      ) : null}

      {/* Подтверждение */}
      {step === "confirm" ? (
        <Box flexDirection="column" marginTop={1}>
          {initialStageLine ? <Text color="yellow">{initialStageLine}</Text> : null}
          <Box flexDirection="column" marginTop={1}>
            {confirmChoices.map((choice, i) => {
              const isSelected = i === confirmIndex;
              return (
                <Box key={i}>
                  {isSelected ? (
                    <Text color="cyan" bold>{`❯ ${choice}`}</Text>
                  ) : (
                    <Text>{`  ${choice}`}</Text>
                  )}
                </Box>
              );
            })}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}
