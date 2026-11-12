import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHandler, listen } from '../server/app.ts';

export const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function tmpDir(prefix = 'plenum-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

// 같은 프로세스 안 서버 (빠른 테스트용). launcher를 갈아 끼우면 실제로 프로그램을 띄우지 않는다
export async function inProcess(opts: Parameters<typeof createHandler>[0] = {}) {
  const { server, port } = await listen(createHandler(opts), 0);
  const base = `http://127.0.0.1:${port}`;
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Plenum': '1' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  };
  return { base, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// 실제 서버 프로세스 (tsx server/main.ts). 표준출력의 "Plenum: http://127.0.0.1:<port>" 줄에서 포트를 읽는다
export async function spawnServer(env: Record<string, string>): Promise<{ base: string; child: ChildProcess; stop: () => Promise<void> }> {
  // tsx.cmd 를 셸로 부르지 않고 node 로 tsx cli 를 직접 부른다 (Windows 한글·공백 경로에서도 인자 그대로)
  const tsxCli = path.join(APP, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsxCli, 'server/main.ts'], { cwd: APP, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = await new Promise<string>((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error(`서버가 30초 안에 뜨지 않았다: ${out}`)), 30000);
    child.stdout!.on('data', (d) => {
      out += d;
      const m = /Plenum: (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    child.stderr!.on('data', (d) => { out += d; });
    child.once('exit', (c) => { clearTimeout(t); reject(new Error(`서버가 종료됨(${c}): ${out}`)); });
  });
  const stop = () => new Promise<void>((r) => { child.once('exit', () => r()); child.kill(); });
  return { base, child, stop };
}
