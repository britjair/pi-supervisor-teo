import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    exclude: process.env["TEO_E2E"] === "1" ? [] : ["test/e2e/**"],
    globalSetup: ["test/helpers/global-setup.ts"],
    testTimeout: 20_000,
  },
});
