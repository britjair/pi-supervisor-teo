import { fileURLToPath } from "node:url";
import path from "node:path";

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
export const fixturesDir = path.join(repoRoot, "test", "fixtures", "policies");
export const validDir = path.join(fixturesDir, "valid");
export const invalidDir = path.join(fixturesDir, "invalid");
export const examplesDir = path.join(repoRoot, "examples", "processes");
export const examplePolicy = path.join(examplesDir, "dev.md");
export const cliPath = path.join(repoRoot, "dist", "cli.js");
