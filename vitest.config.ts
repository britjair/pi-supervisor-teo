import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: process.env["SDLC_E2E"] === "1" ? [] : ["test/e2e/**"],
    globalSetup: ["test/helpers/global-setup.ts"],
    testTimeout: 20_000,
  },
});
