// Перед тестами собирается dist/: integration-тесты запускают настоящий node dist/cli.js.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  execFileSync(process.execPath, ["node_modules/tsup/dist/cli-default.js", "--silent"], { cwd: root, stdio: "inherit" });
}
