// 채팅이 띄운 claude 프로세스 관리: 트리째 종료, PID 파일, 지난 실행이 남긴 고아 정리.
// PID 파일(<cfgDir>/chat-pids.json, [{pid, startedAt}])은 띄울 때 추가하고 끝나면 지운다.
// 서버가 강제로 꺼져서 지우지 못한 pid 는 다음 시작 때 cleanupOrphans 가 본다.
// 외부 명령은 셸 없이 execFile·spawn 에 배열로 넘긴다.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface PidEntry { pid: number; startedAt: number }

const PID_FILE = 'chat-pids.json';

export function readPids(cfgDir: string): PidEntry[] {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(cfgDir, PID_FILE), 'utf8'));
    return Array.isArray(v) ? v.filter((e) => e && Number.isInteger(e.pid) && e.pid > 0).map((e) => ({ pid: e.pid, startedAt: Number(e.startedAt) || 0 })) : [];
  } catch { return []; }
}
function writePids(cfgDir: string, list: PidEntry[]) {
  fs.mkdirSync(cfgDir, { recursive: true });
  const file = path.join(cfgDir, PID_FILE);
  const tmp = path.join(cfgDir, `${PID_FILE}.${process.pid}.tmp`);
  const sorted = [...list].sort((a, b) => a.pid - b.pid);
  fs.writeFileSync(tmp, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
export function addPid(cfgDir: string, pid: number) {
  writePids(cfgDir, [...readPids(cfgDir).filter((e) => e.pid !== pid), { pid, startedAt: Date.now() }]);
}
export function removePid(cfgDir: string, pid: number) {
  const list = readPids(cfgDir);
  if (list.some((e) => e.pid === pid)) writePids(cfgDir, list.filter((e) => e.pid !== pid));
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e && e.code === 'EPERM'; }
}

// 트리째 종료. Windows: taskkill /T /F (.cmd 는 cmd.exe 가 감싸서 그 아래 node 까지 죽여야 한다).
// POSIX: 띄울 때 detached 로 새 프로세스 그룹을 만들었으므로 그룹째(-pid). 그룹이 아니면 그 pid 만.
export function killTree(pid: number, platform = process.platform): Promise<void> {
  if (platform === 'win32') {
    return new Promise((resolve) => {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 없음 */ } }
  return Promise.resolve();
}

// 두 번째 신호 등 기다릴 수 없을 때. Windows 는 taskkill 을 띄우기만 한다
export function killTreeNow(pid: number, platform = process.platform) {
  if (platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {}); } catch { /* 무시 */ }
    return;
  }
  void killTree(pid, platform);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, encoding: 'utf8', timeout: 15000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

// 그 pid 가 claude 인가 (pid 재사용으로 남의 프로세스를 죽이지 않게).
// Linux: /proc/N/cmdline 전체(npm 설치는 node …/claude-code/cli.js). mac: ps comm.
// Windows: tasklist 이미지 이름. npm 설치 claude.cmd 는 우리가 띄운 pid 가 cmd.exe 라 이름에 claude 가 없다 →
// cmd.exe 일 때만 PowerShell 로 명령줄을 읽어 claude 가 들어 있는지 본다.
export async function looksLikeClaude(pid: number, platform = process.platform): Promise<boolean> {
  if (platform === 'win32') {
    const out = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const m = /^"([^"]*)","(\d+)"/m.exec(out);
    if (!m || Number(m[2]) !== pid) return false;
    if (/claude/i.test(m[1])) return true;
    if (!/^cmd\.exe$/i.test(m[1])) return false;
    const cl = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`]);
    return /claude/i.test(cl);
  }
  if (platform === 'linux') {
    try { return /claude/i.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ')); } catch { return false; }
  }
  return /claude/i.test(await run('ps', ['-p', String(pid), '-o', 'comm=']));
}

// PID 파일의 pid 중 살아 있고 claude 인 것만 트리째 종료하고 파일을 비운다. 정리한 수를 돌려준다
export async function cleanupOrphans(cfgDir: string, platform = process.platform): Promise<number> {
  const list = readPids(cfgDir);
  let n = 0;
  for (const e of list) {
    if (e.pid === process.pid || !isAlive(e.pid)) continue;
    if (!(await looksLikeClaude(e.pid, platform))) continue;
    await killTree(e.pid, platform);
    n++;
  }
  if (list.length) writePids(cfgDir, []);
  return n;
}
