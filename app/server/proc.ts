// 채팅이 띄운 claude 프로세스 관리: 트리째 종료, PID 파일, 지난 실행이 남긴 고아 정리.
// PID 파일(<cfgDir>/chat-pids.json, [{pid, startedAt, ownerPid, procStart}])은 띄울 때 추가하고 끝나면 지운다.
// ownerPid = 띄운 서버 pid, procStart = 그 claude 프로세스의 OS 시작 시각(ms, 못 읽으면 null).
// 서버가 강제로 꺼져서 지우지 못한 pid 는 다음 시작 때 cleanupOrphans 가 본다:
// 소유 서버가 살아 있으면(같은 설정 폴더로 띄운 두 번째 서버) 건드리지 않고, pid 재사용이면(시작 시각이 다름) 안 죽인다.
// 외부 명령은 셸 없이 execFile·spawn 에 배열로 넘긴다.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface PidEntry { pid: number; startedAt: number; ownerPid: number | null; procStart: number | null }

const PID_FILE = 'chat-pids.json';
const START_SLACK_MS = 2000; // 기록한 시작 시각과 지금 시작 시각이 이만큼 안이면 같은 프로세스

const posInt = (v: unknown): number | null => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function readPids(cfgDir: string): PidEntry[] {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(cfgDir, PID_FILE), 'utf8'));
    return Array.isArray(v)
      ? v.filter((e) => e && posInt(e.pid)).map((e) => ({ pid: e.pid, startedAt: Number(e.startedAt) || 0, ownerPid: posInt(e.ownerPid), procStart: finite(e.procStart) }))
      : [];
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
// 항목을 바로 쓰고(procStart null), 시작 시각을 읽으면 채운다. 그사이 지워졌으면(이미 끝남) 다시 넣지 않는다.
// ownerPid 는 테스트가 다른 서버 흉내로 바꾼다
export async function addPid(cfgDir: string, pid: number, opts: { ownerPid?: number; platform?: NodeJS.Platform } = {}): Promise<void> {
  const ownerPid = opts.ownerPid ?? process.pid;
  writePids(cfgDir, [...readPids(cfgDir).filter((e) => e.pid !== pid), { pid, startedAt: Date.now(), ownerPid, procStart: null }]);
  const t = await procStartTime(pid, opts.platform);
  if (t === null) return;
  const list = readPids(cfgDir);
  const e = list.find((x) => x.pid === pid && x.ownerPid === ownerPid);
  if (!e) return;
  e.procStart = t;
  writePids(cfgDir, list);
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

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, encoding: 'utf8', timeout: 15000, ...(env ? { env } : {}) }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

// Linux 클록 틱(/proc/N/stat 의 시작 시각 단위). getconf 를 한 번만 부른다(없으면 100)
let clkTck: Promise<number> | null = null;
function linuxClkTck(): Promise<number> {
  clkTck ??= run('getconf', ['CLK_TCK']).then((o) => { const n = parseInt(o.trim(), 10); return n > 0 ? n : 100; });
  return clkTck;
}

// 그 pid 의 OS 시작 시각(유닉스 ms). 못 읽으면 null(없는 pid 포함).
// Linux: /proc/stat btime + /proc/N/stat 22번째 칸(부팅 뒤 클록 틱). mac: ps -o lstart=.
// Windows: PowerShell (Get-Process).StartTime.ToFileTimeUtc() (1601년부터 100ns).
export async function procStartTime(pid: number, platform = process.platform): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'win32') {
    const out = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`])).trim();
    if (!/^\d+$/.test(out)) return null;
    return Number(BigInt(out) / 10000n - 11644473600000n);
  }
  if (platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // 3번째 칸(state)부터
      const ticks = Number(rest[22 - 3]);
      const btime = /^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'));
      if (!Number.isFinite(ticks) || !btime) return null;
      return Number(btime[1]) * 1000 + Math.round((ticks * 1000) / (await linuxClkTck()));
    } catch { return null; }
  }
  const out = (await run('ps', ['-p', String(pid), '-o', 'lstart='], { ...process.env, LC_ALL: 'C', LANG: 'C' })).trim();
  const t = out ? Date.parse(out) : NaN;
  return Number.isFinite(t) ? t : null;
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

// PID 파일의 고아를 정리한다. 정리한 수를 돌려준다.
// - 소유 서버가 살아 있으면 건너뛰고 항목도 남긴다(그 서버의 채팅)
// - 소유 서버가 없으면: 지금 시작 시각이 기록과 같고(±2초) claude 일 때만 트리째 종료. 시작 시각을 못 읽거나
//   기록이 없으면 죽이지 않는다(pid 재사용으로 남의 프로세스를 죽이지 않게). 이 항목들은 파일에서 지운다
export async function cleanupOrphans(cfgDir: string, platform = process.platform): Promise<number> {
  const list = readPids(cfgDir);
  const keep: PidEntry[] = [];
  let n = 0;
  for (const e of list) {
    if (e.ownerPid !== null && e.ownerPid !== process.pid && isAlive(e.ownerPid)) { keep.push(e); continue; }
    if (e.pid === process.pid || !isAlive(e.pid) || e.procStart === null) continue;
    const now = await procStartTime(e.pid, platform);
    if (now === null || Math.abs(now - e.procStart) > START_SLACK_MS) continue;
    if (!(await looksLikeClaude(e.pid, platform))) continue;
    await killTree(e.pid, platform);
    n++;
  }
  // 정리하는 동안 다른 서버가 더한 항목은 남긴다
  if (list.length) {
    const seen = new Set(list.map((e) => `${e.pid}:${e.ownerPid}`));
    writePids(cfgDir, [...keep, ...readPids(cfgDir).filter((e) => !seen.has(`${e.pid}:${e.ownerPid}`))]);
  }
  return n;
}
