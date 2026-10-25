import { spawn } from "node:child_process";

/** PID только что завершившегося процесса: заведомо мёртвый (сразу после выхода не переиспользуется). */
export function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", () => resolve(child.pid ?? 0));
  });
}
