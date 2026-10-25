import { execFile } from "node:child_process";

export type ExecResult = { code: number; stdout: string; stderr: string };

export type ExecOptions = {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
};

/** Запуск программы без shell. Ненулевой код выхода не считается исключением. */
export type Exec = (file: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;

export const execFileNoThrow: Exec = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 30_000,
        env: { ...process.env, ...options.env },
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          // ENOENT (программы нет), таймаут и подобное — не код выхода.
          reject(error);
          return;
        }
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      },
    );
  });
