// 서버가 꺼질 때 채팅 claude 를 고아로 남기지 않는다: shutdownAll(트리째), 다음 시작 때 cleanupOrphans.
// 가짜 claude HANG 모드는 stdin 이 닫혀도 안 끝나고 손자 프로세스 하나를 띄운다.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createChatManager } from '../server/chat.ts';
import { commandFor, resolveCommand } from '../server/open.ts';
import { addPid, cleanupOrphans, isAlive, procStartTime, readPids } from '../server/proc.ts';
import { makeFakeStreamClaude } from './fakeclaudeStream.ts';

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), '홍길동 테스트-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 10000) {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) return false; await sleep(50); }
  return true;
}
// process.kill(pid, 0) 이 실패할 때까지 (SIGKILL 전달·회수는 비동기라 조금 기다린다)
const gone = (pid: number) => until(() => !isAlive(pid), 5000);

it('shutdownAll: HANG 가짜 claude 2개와 손자까지 10초 안에 모두 끝낸다', async () => {
  const dir = root();
  const cfgDir = path.join(dir, '설정');
  const proj = path.join(dir, '프로젝트');
  fs.mkdirSync(proj);
  const fake = makeFakeStreamClaude(path.join(dir, '가짜'));
  const m = createChatManager({ cfgDir, env: fake.env({ hang: true }), closeWaitMs: 1000 });
  const a = (await m.start({ id: 'p', path: proj }, { text: '하나' })).chat.chatId;
  const b = (await m.start({ id: 'p', path: proj }, { text: '둘' })).chat.chatId;
  expect(await until(() => fake.hangPids().length === 2)).toBe(true);
  const pids = fake.hangPids().flat();
  expect(pids).toHaveLength(4);
  expect(readPids(cfgDir)).toHaveLength(2);
  // 항목: 소유 서버 = 이 프로세스, OS 시작 시각(비동기로 채움)
  expect(await until(() => readPids(cfgDir).every((e) => e.procStart !== null))).toBe(true);
  for (const e of readPids(cfgDir)) {
    expect(e.ownerPid).toBe(process.pid);
    expect(Math.abs(e.procStart! - Date.now())).toBeLessThan(60000);
  }
  for (const p of pids) expect(isAlive(p)).toBe(true);

  const t0 = Date.now();
  await m.shutdownAll();
  expect(Date.now() - t0).toBeLessThan(10000);
  expect(m.get(a)!.state).toBe('ended');
  expect(m.get(b)!.state).toBe('ended');
  for (const p of pids) expect(await gone(p), `pid ${p}`).toBe(true);
  expect(readPids(cfgDir)).toEqual([]);
});

// 지난 서버가 남긴 고아 흉내: 매니저 없이 띄운 HANG 가짜 claude (매니저처럼 POSIX 는 새 프로세스 그룹)
async function orphanClaude(dir: string) {
  const fake = makeFakeStreamClaude(path.join(dir, '가짜'));
  const env = fake.env({ hang: true });
  const resolved = resolveCommand('claude', env)!;
  expect(resolved).toBeTruthy();
  const c = commandFor(resolved, ['-p'], process.platform);
  const child = spawn(c.cmd, c.args, { env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, windowsVerbatimArguments: !!c.verbatim, detached: process.platform !== 'win32' });
  expect(await until(() => fake.hangPids().length === 1)).toBe(true);
  return { child, grand: fake.hangPids()[0][1] };
}
// 끝난 프로세스의 pid (소유 서버가 없어진 흉내)
async function deadPid(): Promise<number> {
  const p = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => p.once('exit', r));
  return p.pid!;
}
const sleeper = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform !== 'win32' });
const kill = (p: ChildProcess) => { try { p.kill('SIGKILL'); } catch { /* 무시 */ } };
function rewrite(cfgDir: string, f: (e: any) => any) {
  const file = path.join(cfgDir, 'chat-pids.json');
  fs.writeFileSync(file, JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).map(f)));
}

it('procStartTime: 지금 뜬 프로세스는 지금 근처, 없는 pid 는 null', async () => {
  const p = sleeper();
  try {
    const t = await procStartTime(p.pid!);
    expect(t).not.toBeNull();
    expect(Math.abs(t! - Date.now())).toBeLessThan(10000);
    expect(await procStartTime(await deadPid())).toBeNull();
    expect(await procStartTime(0)).toBeNull();
  } finally { kill(p); }
});

it('cleanupOrphans: 소유 서버가 없고 시작 시각이 같으면 claude 를 트리째 정리, 이름에 claude 없는 pid·없는 pid 는 안 건드림', async () => {
  const dir = root();
  const cfgDir = path.join(dir, '설정');
  const { child: orphan, grand } = await orphanClaude(dir);
  const other = sleeper();
  const dead = await deadPid();
  try {
    await addPid(cfgDir, orphan.pid!, { ownerPid: dead });
    await addPid(cfgDir, other.pid!, { ownerPid: dead });
    await addPid(cfgDir, 999999, { ownerPid: dead }); // 없는 pid
    expect(readPids(cfgDir).find((e) => e.pid === orphan.pid)!.procStart).not.toBeNull();
    expect(await cleanupOrphans(cfgDir)).toBe(1);
    expect(await gone(orphan.pid!)).toBe(true);
    expect(await gone(grand)).toBe(true);
    expect(isAlive(other.pid!)).toBe(true);
    expect(readPids(cfgDir)).toEqual([]);
    // 빈 파일·없는 파일이면 0
    expect(await cleanupOrphans(cfgDir)).toBe(0);
    expect(await cleanupOrphans(path.join(dir, '없는 폴더'))).toBe(0);
  } finally { kill(other); kill(orphan); }
});

it('cleanupOrphans: 소유 서버가 살아 있으면(같은 설정 폴더의 두 번째 서버) 안 죽이고 항목도 남긴다', async () => {
  const dir = root();
  const cfgDir = path.join(dir, '설정');
  const { child: orphan, grand } = await orphanClaude(dir);
  const owner = sleeper(); // 첫 서버 흉내
  try {
    await addPid(cfgDir, orphan.pid!, { ownerPid: owner.pid! });
    const before = readPids(cfgDir);
    expect(await cleanupOrphans(cfgDir)).toBe(0);
    await sleep(300);
    expect(isAlive(orphan.pid!)).toBe(true);
    expect(isAlive(grand)).toBe(true);
    expect(readPids(cfgDir)).toEqual(before);
  } finally { kill(owner); kill(orphan); try { process.kill(grand, 'SIGKILL'); } catch { /* 무시 */ } }
});

it('cleanupOrphans: 시작 시각이 기록과 다르면(pid 재사용) 또는 기록이 없으면 안 죽인다', async () => {
  const dir = root();
  const cfgDir = path.join(dir, '설정');
  const { child: orphan, grand } = await orphanClaude(dir);
  const dead = await deadPid();
  try {
    await addPid(cfgDir, orphan.pid!, { ownerPid: dead });
    rewrite(cfgDir, (e) => ({ ...e, procStart: e.procStart - 60000 })); // 다른 프로세스였던 기록
    expect(await cleanupOrphans(cfgDir)).toBe(0);
    await sleep(300);
    expect(isAlive(orphan.pid!)).toBe(true);
    expect(readPids(cfgDir)).toEqual([]); // 소유 서버가 없는 항목은 지운다
    // 옛 모양 항목(ownerPid·procStart 없음): 시작 시각을 대조할 수 없으니 안 죽인다
    fs.writeFileSync(path.join(cfgDir, 'chat-pids.json'), JSON.stringify([{ pid: orphan.pid, startedAt: 1 }]));
    expect(await cleanupOrphans(cfgDir)).toBe(0);
    await sleep(300);
    expect(isAlive(orphan.pid!)).toBe(true);
    expect(readPids(cfgDir)).toEqual([]);
  } finally { kill(orphan); try { process.kill(grand, 'SIGKILL'); } catch { /* 무시 */ } }
});

// Windows 에서 PowerShell 이 시작 시각을 못 읽는 경우(null) 흉내: 읽기 함수만 바꾸고 나머지 조건(소유 서버 없음, claude)은 같다
it('cleanupOrphans: 시작 시각을 못 읽으면(null) 소유 서버가 없고 claude 여도 안 죽이고 항목도 남긴다, 같은 값을 읽으면 죽인다(대조군)', async () => {
  const dir = root();
  const cfgDir = path.join(dir, '설정');
  const { child: orphan, grand } = await orphanClaude(dir);
  const dead = await deadPid();
  try {
    await addPid(cfgDir, orphan.pid!, { ownerPid: dead });
    const recorded = readPids(cfgDir)[0].procStart;
    expect(recorded).not.toBeNull();
    const asked: number[] = [];
    expect(await cleanupOrphans(cfgDir, process.platform, async (pid) => { asked.push(pid); return null; })).toBe(0);
    expect(asked).toEqual([orphan.pid]); // 읽기까지 갔다(앞 조건에서 빠진 게 아님)
    await sleep(300);
    expect(isAlive(orphan.pid!)).toBe(true);
    expect(isAlive(grand)).toBe(true);
    // 항목은 남긴다(다음 정리 때 다시 본다). 프로세스가 없어지면 그때 지운다
    expect(readPids(cfgDir).map((e) => e.pid)).toEqual([orphan.pid]);

    // 대조군: 같은 항목, 읽기 함수만 기록과 같은 값
    await addPid(cfgDir, orphan.pid!, { ownerPid: dead });
    rewrite(cfgDir, (e) => ({ ...e, procStart: recorded }));
    expect(await cleanupOrphans(cfgDir, process.platform, async () => recorded)).toBe(1);
    expect(await gone(orphan.pid!)).toBe(true);
    expect(await gone(grand)).toBe(true);
    expect(readPids(cfgDir)).toEqual([]);
  } finally { kill(orphan); try { process.kill(grand, 'SIGKILL'); } catch { /* 무시 */ } }
});

it('cleanupOrphans: 시작 시각을 못 읽어 남긴 항목도 프로세스가 없으면 지운다', async () => {
  const dir = root();
  const cfgDir = path.join(dir, '설정');
  const dead = await deadPid();
  const gonePid = await deadPid();
  await addPid(cfgDir, gonePid, { ownerPid: dead });
  rewrite(cfgDir, (e) => ({ ...e, procStart: Date.now() }));
  const asked: number[] = [];
  expect(await cleanupOrphans(cfgDir, process.platform, async (pid) => { asked.push(pid); return null; })).toBe(0);
  expect(asked).toEqual([]);
  expect(readPids(cfgDir)).toEqual([]);
});

// 소유 서버 pid 를 관계없는 살아 있는 프로세스가 물려받은 흉내: 소유 pid 는 살아 있고 시작 시각만 다르다
it('cleanupOrphans: 소유 pid 가 살아 있어도 시작 시각이 ownerStart 와 다르면(pid 재사용) 고아로 정리, 같으면 안 건드림', async () => {
  const dir = root();
  const cfgDir = path.join(dir, '설정');
  const { child: orphan, grand } = await orphanClaude(dir);
  const owner = sleeper();
  try {
    const ownerStart = await procStartTime(owner.pid!);
    expect(ownerStart).not.toBeNull();
    // 진짜 소유(같은 시각) → 안 건드리고 항목도 그대로
    await addPid(cfgDir, orphan.pid!, { ownerPid: owner.pid!, ownerStart });
    const before = readPids(cfgDir);
    expect(before[0].ownerStart).toBe(ownerStart);
    expect(await cleanupOrphans(cfgDir)).toBe(0);
    await sleep(300);
    expect(isAlive(orphan.pid!)).toBe(true);
    expect(readPids(cfgDir)).toEqual(before);
    // 소유 서버의 시작 시각을 못 읽으면 살아 있다고 본다
    expect(await cleanupOrphans(cfgDir, process.platform, async (pid) => (pid === owner.pid ? null : procStartTime(pid)))).toBe(0);
    expect(isAlive(orphan.pid!)).toBe(true);
    expect(readPids(cfgDir)).toEqual(before);
    // 같은 pid 지만 다른 프로세스(시작 시각 1분 다름) → 소유 서버 없음 → 고아 정리
    rewrite(cfgDir, (e) => ({ ...e, ownerStart: ownerStart! - 60000 }));
    expect(await cleanupOrphans(cfgDir)).toBe(1);
    expect(await gone(orphan.pid!)).toBe(true);
    expect(await gone(grand)).toBe(true);
    expect(isAlive(owner.pid!)).toBe(true);
    expect(readPids(cfgDir)).toEqual([]);
  } finally { kill(owner); kill(orphan); try { process.kill(grand, 'SIGKILL'); } catch { /* 무시 */ } }
});

it('addPid: 기본 소유자는 이 서버, ownerStart 는 이 서버의 시작 시각', async () => {
  const dir = root();
  const cfgDir = path.join(dir, '설정');
  const p = sleeper();
  try {
    await addPid(cfgDir, p.pid!);
    const [e] = readPids(cfgDir);
    expect(e.ownerPid).toBe(process.pid);
    expect(e.ownerStart).toBe(await procStartTime(process.pid));
  } finally { kill(p); }
});

// 정리하는 동안 다른 서버가 파일을 바꾼 흉내: 시작 시각 읽기 안에서 파일을 고친다
it('cleanupOrphans: 마지막 쓰기는 파일을 다시 읽어 이번에 지운 항목만 뺀다(그사이 다른 서버의 지움·더함·procStart 채움 유지)', async () => {
  const dir = root();
  const cfgDir = path.join(dir, '설정');
  const { child: orphan, grand } = await orphanClaude(dir);
  const owner = sleeper(); // 다른 서버(살아 있음)
  const other1 = sleeper();
  const other2 = sleeper();
  const dead = await deadPid();
  try {
    await addPid(cfgDir, orphan.pid!, { ownerPid: dead });
    await addPid(cfgDir, other1.pid!, { ownerPid: owner.pid! });
    await addPid(cfgDir, other2.pid!, { ownerPid: owner.pid! });
    rewrite(cfgDir, (e) => (e.pid === other2.pid ? { ...e, procStart: null } : e));
    const recorded = readPids(cfgDir).find((e) => e.pid === orphan.pid)!.procStart;
    const file = path.join(cfgDir, 'chat-pids.json');
    const added = { pid: 4242424, startedAt: 1, ownerPid: owner.pid!, ownerStart: null, procStart: 7 };
    let touched = false;
    const startTime = async (pid: number) => {
      if (!touched) {
        touched = true;
        // 다른 서버: other1 이 끝나 지우고, other2 의 procStart 를 채우고, 새 채팅을 더한다
        const cur = JSON.parse(fs.readFileSync(file, 'utf8')).filter((e: any) => e.pid !== other1.pid).map((e: any) => (e.pid === other2.pid ? { ...e, procStart: 123 } : e));
        fs.writeFileSync(file, JSON.stringify([...cur, added]));
      }
      return pid === orphan.pid ? recorded : procStartTime(pid);
    };
    expect(await cleanupOrphans(cfgDir, process.platform, startTime)).toBe(1);
    expect(touched).toBe(true);
    expect(await gone(orphan.pid!)).toBe(true);
    const after = readPids(cfgDir);
    expect(after.map((e) => e.pid)).toEqual([other2.pid!, added.pid].sort((a, b) => a - b));
    expect(after.find((e) => e.pid === other2.pid)!.procStart).toBe(123);
    expect(after.find((e) => e.pid === added.pid)).toEqual(added);
  } finally { for (const p of [owner, other1, other2, orphan]) kill(p); try { process.kill(grand, 'SIGKILL'); } catch { /* 무시 */ } }
});
