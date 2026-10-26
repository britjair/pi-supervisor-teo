import { readFileSync } from "node:fs";
import { defineConfig, type Options } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

const common: Options = {
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  sourcemap: true,
  splitting: false,
  define: { __TEO_VERSION__: JSON.stringify(pkg.version) },
};

export default defineConfig([
  // CLI teo: зависимости из node_modules пакета
  { ...common, entry: { cli: "src/cli.ts" }, clean: true, banner: { js: "#!/usr/bin/env node" } },
  // Расширение Pi: самодостаточный файл. Pi SDK и typebox подставляет сам Pi (docs/packages.md Pi),
  // всё остальное вшивается: локальный пакет Pi не устанавливает его зависимости.
  {
    ...common,
    entry: { extension: "src/extension/index.ts" },
    clean: false,
    external: [/^@earendil-works\//, "typebox"],
    noExternal: [/^(?!@earendil-works\/|typebox$)/],
    // Бандл ESM: зависимостям на CommonJS нужен require
    banner: { js: 'import { createRequire as __teoCreateRequire } from "node:module"; const require = __teoCreateRequire(import.meta.url);' },
  },
]);
