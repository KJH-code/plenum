// 셸 없이 프로그램을 부른다. 인자는 배열 그대로 넘어가서 한글·공백 경로도 안전하다.
import { execFile } from 'node:child_process';

export interface RunResult { code: number; stdout: string; stderr: string }

export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30000, env: opts.env ?? process.env, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : '')) });
      });
  });
}
