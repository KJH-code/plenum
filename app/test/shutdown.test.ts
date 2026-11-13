// 서버가 꺼질 때 채팅 claude 를 고아로 남기지 않는다: shutdownAll(트리째), 다음 시작 때 cleanupOrphans.
// 가짜 claude HANG 모드는 stdin 이 닫혀도 안 끝나고 손자 프로세스 하나를 띄운다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createChatManager } from '../server/chat.ts';
import { commandFor, resolveCommand } from '../server/open.ts';
import { addPid, cleanupOrphans, isAlive, readPids } from '../server/proc.ts';
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
  for (const p of pids) expect(isAlive(p)).toBe(true);

  const t0 = Date.now();
  await m.shutdownAll();
  expect(Date.now() - t0).toBeLessThan(10000);
  expect(m.get(a)!.state).toBe('ended');
  expect(m.get(b)!.state).toBe('ended');
  for (const p of pids) expect(await gone(p), `pid ${p}`).toBe(true);
  expect(readPids(cfgDir)).toEqual([]);
});

it('cleanupOrphans: PID 파일의 claude 는 트리째 정리, 이름에 claude 없는 pid 는 안 건드림', async () => {
  const dir = root();
  const cfgDir = path.join(dir, '설정');
  const fake = makeFakeStreamClaude(path.join(dir, '가짜'));
  const env = fake.env({ hang: true });
  // 매니저 없이 띄운 가짜 claude (지난 서버가 남긴 고아 흉내). 매니저처럼 POSIX 는 새 프로세스 그룹
  const resolved = resolveCommand('claude', env)!;
  expect(resolved).toBeTruthy();
  const c = commandFor(resolved, ['-p'], process.platform);
  const orphan = spawn(c.cmd, c.args, { env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, windowsVerbatimArguments: !!c.verbatim, detached: process.platform !== 'win32' });
  expect(await until(() => fake.hangPids().length === 1)).toBe(true);
  const [, grand] = fake.hangPids()[0];
  // 이름에 claude 가 없는 프로세스
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: process.platform !== 'win32' });
  try {
    addPid(cfgDir, orphan.pid!);
    addPid(cfgDir, other.pid!);
    addPid(cfgDir, 999999); // 없는 pid
    expect(await cleanupOrphans(cfgDir)).toBe(1);
    expect(await gone(orphan.pid!)).toBe(true);
    expect(await gone(grand)).toBe(true);
    expect(isAlive(other.pid!)).toBe(true);
    expect(readPids(cfgDir)).toEqual([]);
    // 빈 파일·없는 파일이면 0
    expect(await cleanupOrphans(cfgDir)).toBe(0);
    expect(await cleanupOrphans(path.join(dir, '없는 폴더'))).toBe(0);
  } finally {
    try { other.kill('SIGKILL'); } catch { /* 무시 */ }
    try { orphan.kill('SIGKILL'); } catch { /* 무시 */ }
  }
});
