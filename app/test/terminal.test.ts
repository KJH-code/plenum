// 터미널로 열기: 명령 모양(셸 없이 배열, cmd verbatim 한 줄)과 라우트 순서(채팅을 닫은 뒤 실행).
// 이 컨테이너는 Linux — Windows 분기는 platform 인자로만 확인한다(실제 wt·cmd 실행은 노트북에서).
import { describe, expect, test } from 'vitest';
import { createActivity } from '../server/activity.ts';
import { handleActivity } from '../server/activityRoutes.ts';
import type { RouteCtx } from '../server/app.ts';
import type { ChatInfo, ChatRegistry } from '../server/chatTypes.ts';
import { defaultConfig } from '../server/config.ts';
import type { Command } from '../server/open.ts';
import { terminalCommand } from '../server/terminal.ts';
import { tmpDir } from './helpers.ts';

const SID = '76d66e6d-7e81-487d-a7c2-fa2fbb3bb61c';
const WIN_CWD = 'C:\\Users\\홍길동\\Documents\\GitHub\\내 프로젝트 (2)';
const WT = 'C:\\Users\\홍길동\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe';
const winEnv = { PATH: 'C:\\Windows\\system32;C:\\Users\\홍길동\\AppData\\Local\\Microsoft\\WindowsApps', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
const hasWt = (f: string) => f.toLowerCase() === WT.toLowerCase();
const noWt = () => false;

describe('terminalCommand', () => {
  test('win32 + wt 있음: wt 절대 경로, 한글·공백 cwd 가 args 한 칸에 그대로', () => {
    const t = terminalCommand({ cwd: WIN_CWD, sessionId: SID, platform: 'win32', env: winEnv, isFile: hasWt });
    expect(t.via).toBe('wt');
    expect(t.command).toEqual({ cmd: WT, args: ['-d', WIN_CWD, 'powershell', '-NoExit', '-Command', `claude --resume ${SID}`] });
    expect(t.command!.verbatim).toBeUndefined();
    expect(t.display).toEqual([`cd -LiteralPath '${WIN_CWD}'`, `claude --resume ${SID}`]);
  });

  test('win32 + wt 없음: cmd.exe verbatim 한 줄', () => {
    const t = terminalCommand({ cwd: WIN_CWD, sessionId: SID, platform: 'win32', env: winEnv, isFile: noWt });
    expect(t.via).toBe('cmd');
    expect(t.command).toEqual({
      cmd: 'cmd.exe',
      args: ['/d', '/s', '/c', `"start "" /D "${WIN_CWD}" powershell -NoExit -Command "claude --resume ${SID}""`],
      verbatim: true,
    });
  });

  test('wt 없을 때 cmd 가 해석하는 문자(" % 줄바꿈)가 든 cwd 는 거부', () => {
    for (const bad of ['C:\\a"b', 'C:\\100%', 'C:\\a\nb']) {
      expect(() => terminalCommand({ cwd: bad, sessionId: SID, platform: 'win32', env: winEnv, isFile: noWt })).toThrow(/cmd가 해석하는 문자/);
    }
  });

  test('wt 가 ; 를 명령 구분자로 읽으므로 ; 가 든 cwd 는 cmd 로', () => {
    const t = terminalCommand({ cwd: 'C:\\a;b', sessionId: SID, platform: 'win32', env: winEnv, isFile: hasWt });
    expect(t.via).toBe('cmd');
  });

  test('linux·darwin: 실행 명령 없음, 두 줄만(작은따옴표 이스케이프)', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const t = terminalCommand({ cwd: "/home/hong/홍길동's 프로젝트", sessionId: SID, platform, env: {} });
      expect(t).toEqual({ via: 'manual', command: null, display: [`cd '/home/hong/홍길동'\\''s 프로젝트'`, `claude --resume ${SID}`] });
    }
  });

  test('세션 ID 가 UUID 가 아니거나 cwd 가 상대 경로면 거부', () => {
    expect(() => terminalCommand({ cwd: '/tmp', sessionId: `${SID}; rm -rf ~`, platform: 'linux' })).toThrow(/세션 ID/);
    expect(() => terminalCommand({ cwd: '/tmp', sessionId: '', platform: 'linux' })).toThrow(/세션 ID/);
    expect(() => terminalCommand({ cwd: 'rel/dir', sessionId: SID, platform: 'linux' })).toThrow(/절대 경로/);
    expect(() => terminalCommand({ cwd: '/tmp', sessionId: SID, platform: 'win32', env: winEnv, isFile: hasWt })).toThrow(/절대 경로/);
  });
});

// 라우트를 직접 부른다(platform·isFile 주입)
function fakeCtx(method: string, parts: string[], projectPath: string) {
  const sent: { status: number; body: any }[] = [];
  const ctx = {
    method, parts, req: null as any, res: null as any, env: winEnv, cfgDir: '',
    cfg: { ...defaultConfig(), projects: [{ id: 'p1', name: 'p', path: projectPath, source: 'local' as const }] },
    body: async () => ({}),
    send: (status: number, body: unknown) => { sent.push({ status, body }); },
  } satisfies RouteCtx;
  return { ctx, sent };
}
function fakeChats(calls: string[], running: boolean): ChatRegistry {
  const info: ChatInfo = { chatId: 'c1', projectId: 'p1', sessionId: SID, state: 'running', mode: null, model: null, effort: null, version: null, lastSeq: 3 };
  return {
    findBySession: (s) => (running && s === SID ? info : null),
    isPlenumChat: () => running,
    close: async (id) => { calls.push(`close:${id}:start`); await new Promise((r) => setTimeout(r, 20)); calls.push(`close:${id}:end`); },
    onEvent: () => () => {},
  };
}

describe('POST /api/projects/:id/sessions/:sid/terminal', () => {
  test('채팅이 돌고 있으면 close 가 끝까지 끝난 뒤 launcher', async () => {
    const calls: string[] = [];
    const chats = fakeChats(calls, true);
    const launched: Command[] = [];
    const launcher = async (c: Command, kind: string) => { calls.push(`launch:${kind}`); launched.push(c); return { ok: true as const }; };
    const { ctx, sent } = fakeCtx('POST', ['projects', 'p1', 'sessions', SID, 'terminal'], WIN_CWD);
    const activity = createActivity({ cfgDir: tmpDir(), chats });
    expect(await handleActivity(ctx, { activity, chats, launcher, platform: 'win32', isFile: hasWt })).toBe(true);
    expect(calls).toEqual(['close:c1:start', 'close:c1:end', 'launch:terminal']);
    expect(launched[0].cmd).toBe(WT);
    expect(sent).toHaveLength(1);
    expect(sent[0].status).toBe(200);
    expect(sent[0].body).toMatchObject({ closedChat: true, launched: true, via: 'wt', display: [`cd -LiteralPath '${WIN_CWD}'`, `claude --resume ${SID}`] });
    expect(sent[0].body.message).toMatch(/trust/);
  });

  test('채팅이 없으면 close 없이 바로 실행', async () => {
    const calls: string[] = [];
    const chats = fakeChats(calls, false);
    const launcher = async () => { calls.push('launch'); return { ok: true as const }; };
    const { ctx, sent } = fakeCtx('POST', ['projects', 'p1', 'sessions', SID, 'terminal'], WIN_CWD);
    await handleActivity(ctx, { activity: createActivity({ cfgDir: tmpDir() }), chats, launcher, platform: 'win32', isFile: noWt });
    expect(calls).toEqual(['launch']);
    expect(sent[0].body).toMatchObject({ closedChat: false, launched: true, via: 'cmd' });
  });

  test('실행 실패면 500 + 이유, display 는 그대로', async () => {
    const launcher = async () => ({ ok: false as const, message: 'wt.exe 실행 실패: ENOENT' });
    const { ctx, sent } = fakeCtx('POST', ['projects', 'p1', 'sessions', SID, 'terminal'], WIN_CWD);
    await handleActivity(ctx, { activity: createActivity({ cfgDir: tmpDir() }), launcher, platform: 'win32', isFile: hasWt });
    expect(sent[0].status).toBe(500);
    expect(sent[0].body.error).toContain('ENOENT');
    expect(sent[0].body).toMatchObject({ launched: false, display: [`cd -LiteralPath '${WIN_CWD}'`, `claude --resume ${SID}`] });
  });

  test('linux: launcher 를 부르지 않고 manual + 두 줄', async () => {
    let called = false;
    const launcher = async () => { called = true; return { ok: true as const }; };
    const { ctx, sent } = fakeCtx('POST', ['projects', 'p1', 'sessions', SID, 'terminal'], '/tmp/홍길동 프로젝트');
    await handleActivity(ctx, { activity: createActivity({ cfgDir: tmpDir() }), launcher, platform: 'linux' });
    expect(called).toBe(false);
    expect(sent[0]).toMatchObject({ status: 200, body: { launched: false, via: 'manual', display: [`cd '/tmp/홍길동 프로젝트'`, `claude --resume ${SID}`] } });
  });

  test('세션 ID 가 이상하면 400, 실행 안 함', async () => {
    let called = false;
    const launcher = async () => { called = true; return { ok: true as const }; };
    const { ctx } = fakeCtx('POST', ['projects', 'p1', 'sessions', 'abc', 'terminal'], WIN_CWD);
    await expect(handleActivity(ctx, { activity: createActivity({ cfgDir: tmpDir() }), launcher, platform: 'win32', isFile: hasWt })).rejects.toMatchObject({ status: 400 });
    expect(called).toBe(false);
  });
});

test('PowerShell 표시 줄: $ 와 작은따옴표가 든 경로', () => {
  const t = terminalCommand({ cwd: "C:\\Users\\홍길동\\a$b 'c'", sessionId: SID, platform: 'win32', env: {}, isFile: () => false });
  expect(t.display[0]).toBe("cd -LiteralPath 'C:\\Users\\홍길동\\a$b ''c'''");
});
