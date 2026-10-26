// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const piImports = {
  group: ["@earendil-works/*"],
  message: "Pi SDK импортируется только в src/agents/pi/ (04-agents.md §2).",
};
const uiImports = {
  group: ["ink", "ink/*", "react", "react/*", "@inkjs/*"],
  message: "Ink и React импортируются только в src/ui/ (06-implementation.md §1.4).",
};
const inkModules = {
  group: ["**/ui/ink/*", "**/ui/interactive-human-io.js"],
  message: "Ink-интерфейс подключается только в cli.ts: общий код нужен и расширению Pi (docs/07-extension-mode.md §4.3).",
};
const noProcessExit = {
  selector: "MemberExpression[object.name='process'][property.name='exit']",
  message: "process.exit разрешён только в src/cli.ts.",
};
const noNewDate = {
  selector: "NewExpression[callee.name='Date'][arguments.length=0]",
  message: "Текущее время берётся из Clock (src/util/clock.ts).",
};
const noDateNow = {
  object: "Date",
  property: "now",
  message: "Текущее время берётся из Clock (src/util/clock.ts).",
};

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [piImports, uiImports] }],
      "no-restricted-syntax": ["error", noProcessExit, noNewDate],
      "no-restricted-properties": ["error", noDateNow],
    },
  },
  {
    files: ["src/agents/pi/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [uiImports] }] },
  },
  {
    // Расширение Pi: SDK можно, Ink-интерфейс CLI нельзя — у расширения интерфейс Pi
    files: ["src/extension/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [uiImports, inkModules] }] },
  },
  {
    // Общий контекст команд нужен и расширению: Ink в него не тянется
    files: ["src/app.ts", "src/commands/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [piImports, uiImports, inkModules] }] },
  },
  {
    files: ["src/ui/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [piImports] }] },
  },
  {
    files: ["src/cli.ts"],
    rules: { "no-restricted-syntax": ["error", noNewDate] },
  },
  {
    files: ["src/util/clock.ts"],
    rules: {
      "no-restricted-syntax": ["error", noProcessExit],
      "no-restricted-properties": "off",
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
