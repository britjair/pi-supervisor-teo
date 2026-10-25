import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { UserAbortError } from "../../src/errors/errors.js";
import { PlainHumanIO } from "../../src/ui/plain/plain-human-io.js";
import { createStyle } from "../../src/ui/plain/style.js";

function io(input: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = "";
  stdout.on("data", (d: Buffer) => (out += d.toString()));
  stdin.end(input);
  return { human: new PlainHumanIO(stdin, stdout, createStyle(false), false), out: () => out };
}

describe("PlainHumanIO", () => {
  it("select: номер, клавиша, повтор при неверном вводе", async () => {
    const { human, out } = io("9\nабв\n2\nq\n");
    const choices = [
      { label: "Создать", value: "create" },
      { label: "PAY-142", value: "task" },
      { label: "Выход", value: "exit", key: "q" },
    ];
    expect(await human.select("Что вы хотите сделать?", choices)).toBe("task");
    expect(await human.select("Ещё раз", choices)).toBe("exit");
    expect(out()).toContain("  1) Создать\n  2) PAY-142\n  3) Выход [q]");
    expect(out().match(/Введите номер от 1 до 3\./g)).toHaveLength(2);
  });

  it("input: валидация, значение по умолчанию", async () => {
    const { human, out } = io("bad key\nPAY-1\n\n");
    expect(await human.input("Ключ", { validate: (v) => (/\s/.test(v) ? "без пробелов" : null) })).toBe("PAY-1");
    expect(await human.input("Название", { initial: "старое" })).toBe("старое");
    expect(out()).toContain("  без пробелов");
  });

  it("multiline: пустая строка после текста завершает ввод, пустые строки в начале пропускаются", async () => {
    const { human } = io("\nпервая\n  вторая\n\nне попадёт\n");
    expect(await human.multiline("Описание")).toBe("первая\n  вторая");
  });

  it("multiline: конец ввода (Ctrl+D) завершает текст", async () => {
    const { human } = io("строка 1\nстрока 2");
    expect(await human.multiline("Описание")).toBe("строка 1\nстрока 2");
  });

  it("confirm: д/н и значение по умолчанию", async () => {
    const { human } = io("да\nn\n\nможет\nд\n");
    expect(await human.confirm("?", false)).toBe(true);
    expect(await human.confirm("?", true)).toBe(false);
    expect(await human.confirm("?", true)).toBe(true);
    expect(await human.confirm("?", false)).toBe(true);
  });

  it("конец ввода на однострочном вопросе — UserAbortError", async () => {
    const { human } = io("");
    await expect(human.input("Ключ")).rejects.toBeInstanceOf(UserAbortError);
  });
});
