import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { TaskSelector } from "../../src/ui/ink/task-selector.js";
import { NewTaskForm } from "../../src/ui/ink/new-task-form.js";
import { HumanPrompt } from "../../src/ui/ink/human-prompt.js";
import { RunScreen } from "../../src/ui/ink/run-screen.js";
import { WaitScreen } from "../../src/ui/ink/wait-screen.js";

const DOWN = "\u001B[B";
const CTRL_D = "\u0004";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => cleanup());

describe("Ink UI", () => {
  it("перемещается по меню стрелками и выбирает пункт", async () => {
    const onSelect = vi.fn();
    const view = render(
      <TaskSelector
        title="Что вы хотите сделать?"
        choices={[
          { label: "Создать новую задачу", value: "new" },
          { label: "PAY-142 Ревью", value: "PAY-142" },
        ]}
        onSelect={onSelect}
      />,
    );

    expect(view.lastFrame()).toContain("❯ Создать новую задачу");
    view.stdin.write(DOWN);
    await settle();
    expect(view.lastFrame()).toContain("❯ PAY-142 Ревью");
    view.stdin.write("\r");
    await settle();
    expect(onSelect).toHaveBeenCalledWith("PAY-142");
  });

  it("показывает предпросмотр описания и отправляет форму новой задачи", async () => {
    const onSubmit = vi.fn();
    const view = render(
      <NewTaskForm
        projectRoot="/work/project"
        initialStageLine="Начальный этап: Сбор требований (agent: requirements)"
        initialKey="PAY-142"
        initialTitle="Добавить СБП"
        initialDescription="Подключить новый способ оплаты"
        onSubmit={onSubmit}
        onCancel={() => undefined}
      />,
    );

    view.stdin.write(CTRL_D);
    await settle();
    expect(view.lastFrame()).toContain("Отправить ответ?");
    view.stdin.write("\r");
    await settle();
    expect(view.lastFrame()).toContain("❯ Создать и запустить");
    view.stdin.write("\r");
    await settle();
    expect(onSubmit).toHaveBeenCalledWith({
      key: "PAY-142",
      title: "Добавить СБП",
      description: "Подключить новый способ оплаты",
    });
  });

  it("отправляет выбранный вариант human prompt", async () => {
    const onSubmit = vi.fn();
    const view = render(
      <HumanPrompt
        question={{
          header: "Вопрос от supervisor · PAY-142 · Ревью",
          question: "Какой вариант выбрать?",
          context: "Нужно решение владельца продукта.",
          options: ["Вариант A", "Вариант B"],
          allowFreeText: true,
          attachments: [],
        }}
        onSubmit={onSubmit}
        onCancel={() => undefined}
      />,
    );

    expect(view.lastFrame()).toContain("Вопрос от supervisor");
    view.stdin.write(DOWN);
    await settle();
    view.stdin.write("\r");
    await settle();
    expect(onSubmit).toHaveBeenCalledWith({ answer: "Вариант B", selectedOption: "Вариант B" });
  });

  it("сохраняет шапку и подвал на экране выполнения и обрабатывает клавиши", async () => {
    const onRequestStop = vi.fn();
    const onToggleThinking = vi.fn();
    const onToggleStatus = vi.fn();
    const view = render(
      <RunScreen
        taskKey="PAY-142"
        stageTitle="Ревью"
        agentId="reviewer"
        attempt={2}
        log={Array.from({ length: 40 }, (_, i) => `строка ${i + 1}`)}
        partial="проверяю изменения"
        activity="reviewer выполняет тесты"
        cycle={7}
        nowMs={() => 10_000}
        runStartedAtMs={1_000}
        activityStartedAtMs={5_000}
        onRequestStop={onRequestStop}
        onConfirmStop={() => undefined}
        onToggleThinking={onToggleThinking}
        onToggleStatus={onToggleStatus}
      />,
    );

    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("PAY-142 · Ревью · agent: reviewer · attempt 2");
    expect(frame).toContain("SDLC: Ревью");
    expect(frame).toContain("проверяю изменения");
    expect(frame.split("\n").every((line) => [...line].length <= 80)).toBe(true);

    view.stdin.write("t");
    view.stdin.write("s");
    view.stdin.write("\u0003");
    await settle();
    expect(onToggleThinking).toHaveBeenCalledOnce();
    expect(onToggleStatus).toHaveBeenCalledOnce();
    expect(onRequestStop).toHaveBeenCalledOnce();
  });

  it("подтверждает остановку активного хода", async () => {
    const onConfirmStop = vi.fn();
    const view = render(
      <RunScreen
        taskKey="PAY-142"
        stageTitle="Ревью"
        log={[]}
        stopConfirm={true}
        onRequestStop={() => undefined}
        onConfirmStop={onConfirmStop}
      />,
    );

    expect(view.lastFrame()).toContain("Остановить? (y/Esc)");
    view.stdin.write("y");
    await settle();
    expect(onConfirmStop).toHaveBeenCalledWith(true);
  });

  it("управляет ожиданием клавишами Enter, m и q", async () => {
    const onAction = vi.fn();
    const onWriteMessage = vi.fn();
    const dueAt = new Date(120_000).toISOString();
    const view = render(
      <WaitScreen
        dueAt={dueAt}
        number={4}
        maxCount={12}
        waitingFor="ответ ревьюера"
        onAction={onAction}
        onWriteMessage={onWriteMessage}
        onInterrupt={() => undefined}
        nowMs={() => 0}
      />,
    );

    expect(view.lastFrame()).toContain("Ожидание: ответ ревьюера");
    view.stdin.write("m");
    view.stdin.write("q");
    view.stdin.write("\r");
    await settle();
    expect(onWriteMessage).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith({ kind: "quit" });
    expect(onAction).toHaveBeenCalledWith({ kind: "check_now" });
  });
});
