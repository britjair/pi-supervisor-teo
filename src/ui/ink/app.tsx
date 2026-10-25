// Главный компонент TUI приложения Ink (05-cli-ui.md §3–4).
import React, { useEffect, useState } from "react";
import { Box, Static, Text, useInput } from "ink";
import type { InkHumanIO, Screen, UiState } from "./ink-human-io.js";
import { RunScreen } from "./run-screen.js";
import { TaskSelector } from "./task-selector.js";
import { MultilineInput } from "./multiline-input.js";
import { HumanPrompt } from "./human-prompt.js";
import { WaitScreen } from "./wait-screen.js";
import { StatusHeader } from "./status-header.js";

export interface InkAppProps {
  controller: InkHumanIO;
}

export function InkApp({ controller }: InkAppProps): React.ReactElement {
  const [state, setState] = useState<UiState>(controller.getSnapshot());

  useEffect(() => {
    return controller.subscribe(() => {
      setState(controller.getSnapshot());
    });
  }, [controller]);

  const screen: Screen = state.screen;

  if (screen.kind === "select") {
    return (
      <PromptLayout log={state.log}>
        <TaskSelector
          header={state.log.length > 0 ? "" : state.title}
          title={screen.title}
          choices={screen.choices}
          onSelect={(_val) => {
            const idx = screen.choices.findIndex((c) => c.value === _val);
            screen.resolve(idx >= 0 ? idx : 0);
          }}
          onCancel={screen.cancel}
          onInterrupt={() => controller.requestInterrupt(true)}
        />
      </PromptLayout>
    );
  }

  if (screen.kind === "input" || screen.kind === "multiline") {
    return (
      <PromptLayout log={state.log}>
        <MultilineInput
          title={screen.title}
          {...(screen.initial !== undefined ? { initial: screen.initial } : {})}
          multiline={screen.kind === "multiline"}
          {...(screen.validate !== undefined ? { validate: screen.validate } : {})}
          onSubmit={screen.resolve}
          onCancel={screen.cancel}
          onInterrupt={() => controller.requestInterrupt(true)}
        />
      </PromptLayout>
    );
  }

  if (screen.kind === "confirm") {
    return (
      <PromptLayout log={state.log}>
        <ConfirmDialog
          title={screen.title}
          defaultValue={screen.defaultValue}
          onConfirm={screen.resolve}
          onCancel={screen.cancel}
          onInterrupt={() => controller.requestInterrupt(true)}
        />
      </PromptLayout>
    );
  }

  if (screen.kind === "question") {
    return (
      <HumanPrompt
        question={screen.question}
        onSubmit={screen.resolve}
        onCancel={screen.cancel}
        onInterrupt={() => controller.requestInterrupt(true)}
      />
    );
  }

  if (screen.kind === "wait") {
    return (
      <Box flexDirection="column" width={80}>
        <StatusHeader
          taskKey={state.key}
          stageTitle={state.stage}
          agentId={state.agent}
          attempt={state.attempt}
          width={80}
        />
        <Static items={state.log.map((line, index) => ({ id: index, line }))}>
          {(item) => <Text key={item.id}>{item.line}</Text>}
        </Static>
        <WaitScreen
          dueAt={screen.dueAt}
          number={screen.number}
          maxCount={screen.maxCount}
          waitingFor={screen.waitingFor}
          onAction={screen.resolve}
          onWriteMessage={() => void controller.waitMessage()}
          onInterrupt={() => controller.requestInterrupt(true)}
          nowMs={controller.nowMs}
          width={80}
        />
      </Box>
    );
  }

  return (
    <RunScreen
      taskKey={state.key}
      stageTitle={state.stage}
      agentId={state.agent}
      attempt={state.attempt}
      activity={state.activity}
      runStartedAtMs={state.runStartedAtMs}
      activityStartedAtMs={state.activityStartedAtMs}
      nowMs={controller.nowMs}
      cycle={state.cycle}
      log={state.log}
      partial={state.partial}
      partialActor={state.partialActor}
      thinking={state.thinking}
      thinkingText={state.thinkingText}
      tokensIn={state.usage.inputTokens}
      tokensOut={state.usage.outputTokens}
      costUsd={state.usage.costUsd}
      stopConfirm={state.stopConfirm}
      statusOverlay={state.statusOverlay}
      onRequestStop={() => controller.requestInterrupt(false)}
      onConfirmStop={(yes) => controller.confirmStop(yes)}
      onToggleThinking={() => controller.toggleThinking()}
      onToggleStatus={() => controller.toggleStatus()}
    />
  );
}

function PromptLayout({ log, children }: { log: string[]; children: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="column" width={80}>
      {log.slice(-20).map((line, index) => <Text key={`${index}:${line}`}>{line}</Text>)}
      {children}
    </Box>
  );
}

function ConfirmDialog({
  title,
  defaultValue,
  onConfirm,
  onCancel,
  onInterrupt,
}: {
  title: string;
  defaultValue: boolean;
  onConfirm: (val: boolean) => void;
  onCancel: () => void;
  onInterrupt: () => void;
}): React.ReactElement {
  const [selected, setSelected] = useState(defaultValue);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onInterrupt();
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (input === "y" || input === "д") {
      onConfirm(true);
      return;
    }
    if (input === "n" || input === "н") {
      onConfirm(false);
      return;
    }
    if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      setSelected((prev) => !prev);
      return;
    }
    if (key.return) {
      onConfirm(selected);
    }
  });

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold color="cyan">{title}</Text>
      <Box marginTop={1}>
        <Box marginRight={2}>
          {selected ? (
            <Text color="green" bold>❯ Да</Text>
          ) : (
            <Text>  Да</Text>
          )}
        </Box>
        <Box>
          {!selected ? (
            <Text color="red" bold>❯ Нет</Text>
          ) : (
            <Text>  Нет</Text>
          )}
        </Box>
      </Box>
      <Text color="gray">(стрелки — переключение, Enter — подтвердить, Esc — отмена)</Text>
    </Box>
  );
}
