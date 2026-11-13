// 작동 중 현황: 훅(터미널 세션)과 채팅 이벤트를 id 로 짝 맞추기, 턴 끝 정리, 유령 정리, 경로 대조, 포트 파일.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { createActivity, GHOST_MS } from '../server/activity.ts';
import type { ChatEvent, ChatInfo, ChatRegistry, WorkerRun } from '../server/chatTypes.ts';
import { defaultConfig, saveConfig } from '../server/config.ts';
import { readServerFile, removeServerFile, serverFilePath, writeServerFile } from '../server/serverfile.ts';
import { readSessions } from '../server/store.ts';
import { inProcess } from './helpers.ts';

const SID = '76d66e6d-7e81-487d-a7c2-fa2fbb3bb61c';
const SID2 = '0b8e2a51-3c4d-4e5f-8a9b-1c2d3e4f5a6b';
const PROJ = '/tmp/홍길동 프로젝트';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), '홍길동 테스트-'));

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, add: (ms: number) => { t += ms; } };
}
const hook = (event: string, extra: Record<string, unknown> = {}) => ({ event, session_id: SID, cwd: PROJ, transcript_path: `/home/hong/.claude/projects/x/${SID}.jsonl`, ...extra });

// 가짜 registry: 이벤트를 손으로 흘린다
function fakeRegistry(plenumSessions: string[] = []) {
  const listeners = new Set<(c: ChatInfo, e: ChatEvent) => void>();
  let seq = 0;
  const info = (chatId: string): ChatInfo => ({ chatId, projectId: 'p1', sessionId: SID, state: 'running', mode: null, model: null, effort: null, version: null, lastSeq: seq });
  const reg: ChatRegistry & { emit(chatId: string, ev: any): void } = {
    findBySession: () => null,
    isPlenumChat: (s) => plenumSessions.includes(s),
    close: async () => {},
    onEvent(l) { listeners.add(l); return () => listeners.delete(l); },
    emit(chatId, ev) { seq++; for (const l of listeners) l(info(chatId), { seq, at: 5000 + seq, ...ev }); },
  };
  return reg;
}

describe('터미널 세션 (훅)', () => {
  let cfgDir: string;
  beforeEach(() => { cfgDir = tmp(); });

  test('전경 워커 2개 중 하나만 끝나고 턴이 끝나면 running 워커만 남는다 → 그 워커도 끝나면 0', () => {
    const a = createActivity({ cfgDir, workerModel: (t) => (t === 'jh-kit:w-implement' ? 'sonnet' : null) });
    expect(a.ingestHook(hook('SessionStart', { source: 'startup' }))).toEqual({ ok: true });
    expect(a.forProject(PROJ)[0].state).toBe('running');
    a.ingestHook(hook('SubagentStart', { agent_type: 'jh-kit:w-implement', agent_id: 'a1' }));
    a.ingestHook(hook('SubagentStart', { agent_type: 'Explore', agent_id: 'a2' }));
    a.ingestHook(hook('SubagentStop', { agent_type: 'jh-kit:w-implement', agent_id: 'a1' }));
    a.ingestHook(hook('Stop'));
    let [s] = a.forProject(PROJ);
    expect(s.source).toBe('terminal');
    expect(s.state).toBe('idle');
    expect(s.workers.map((w) => [w.id, w.state, w.worker])).toEqual([['a2', 'running', 'Explore']]);
    a.ingestHook(hook('SubagentStop', { agent_type: 'Explore', agent_id: 'a2' }));
    a.ingestHook(hook('Stop'));
    [s] = a.forProject(PROJ);
    expect(s.workers).toEqual([]);
  });

  test('워커 모델은 workerModel(agent_type)', () => {
    const a = createActivity({ cfgDir, workerModel: (t) => (t === 'jh-kit:w-implement' ? 'sonnet' : null) });
    a.ingestHook(hook('SubagentStart', { agent_type: 'jh-kit:w-implement', agent_id: 'a1' }));
    expect(a.forProject(PROJ)[0].workers[0]).toMatchObject({ id: 'a1', model: 'sonnet', background: false, description: null, state: 'running' });
  });

  test('id 로만 짝: 같은 agent_type 의 다른 id 가 끝나도 내 워커는 running', () => {
    const a = createActivity({ cfgDir });
    a.ingestHook(hook('SubagentStart', { agent_type: 'Explore', agent_id: 'a1' }));
    a.ingestHook(hook('SubagentStop', { agent_type: 'Explore', agent_id: 'zz' }));
    const ws = a.forProject(PROJ)[0].workers;
    expect(ws.find((w) => w.id === 'a1')!.state).toBe('running');
  });

  test('SubagentStop 이 Start 보다 먼저 와도 유령이 남지 않는다', () => {
    const a = createActivity({ cfgDir });
    a.ingestHook(hook('SessionStart'));
    a.ingestHook(hook('SubagentStop', { agent_type: 'Explore', agent_id: 'a1' }));
    a.ingestHook(hook('Stop'));
    a.ingestHook(hook('SubagentStart', { agent_type: 'Explore', agent_id: 'a1' }));
    expect(a.forProject(PROJ)[0].workers).toEqual([]);
    a.ingestHook(hook('Stop'));
    expect(a.forProject(PROJ)[0].workers).toEqual([]);
  });

  test('SessionStart 없이 다른 이벤트가 먼저 와도 세션을 만든다, SessionEnd 면 사라진다', () => {
    const a = createActivity({ cfgDir });
    a.ingestHook(hook('SubagentStart', { agent_type: 'Explore', agent_id: 'a1' }));
    expect(a.terminalAlive(SID)).toBe(true);
    expect(a.forProject(PROJ)).toHaveLength(1);
    a.ingestHook(hook('SessionEnd', { reason: 'prompt_input_exit' }));
    expect(a.terminalAlive(SID)).toBe(false);
    expect(a.forProject(PROJ)).toEqual([]);
  });

  test('마지막 이벤트 뒤 12시간이면 유령 — terminalAlive false, 현황에서 빠진다', () => {
    const c = clock();
    const a = createActivity({ cfgDir, now: c.now });
    a.ingestHook(hook('SessionStart'));
    c.add(GHOST_MS - 1);
    expect(a.terminalAlive(SID)).toBe(true);
    a.ingestHook(hook('Stop')); // 이벤트가 오면 다시 센다
    c.add(GHOST_MS - 1);
    expect(a.terminalAlive(SID)).toBe(true);
    c.add(1);
    expect(a.terminalAlive(SID)).toBe(false);
    expect(a.forProject(PROJ)).toEqual([]);
  });

  test('forgetTerminal 은 바로 뺀다', () => {
    const a = createActivity({ cfgDir });
    a.ingestHook(hook('SessionStart'));
    expect(a.forgetTerminal(SID)).toBe(true);
    expect(a.terminalAlive(SID)).toBe(false);
    expect(a.forgetTerminal(SID)).toBe(false);
  });

  test('Skill 모드 → 세션 mode + sessions.json', () => {
    const a = createActivity({ cfgDir });
    a.ingestHook(hook('PreToolUse', { tool_input: { skill: 'Read' } }));
    expect(a.forProject(PROJ)[0].mode).toBeNull();
    a.ingestHook(hook('PreToolUse', { tool_input: { skill: 'jh-kit:plus' } }));
    expect(a.forProject(PROJ)[0].mode).toBe('강화');
    expect(readSessions(cfgDir)[SID].mode).toBe('강화');
  });

  test('Plenum 채팅 세션의 훅은 무시한다(조건 하나만 다른 두 세션)', () => {
    const a = createActivity({ cfgDir, chats: fakeRegistry([SID]) });
    const r = a.ingestHook(hook('SessionStart'));
    expect(r.ok).toBe(false);
    expect(a.terminalAlive(SID)).toBe(false);
    expect(a.ingestHook({ ...hook('SessionStart'), session_id: SID2 })).toEqual({ ok: true });
    expect(a.terminalAlive(SID2)).toBe(true);
  });

  test('잘못된 본문은 무시: 이상한 event, UUID 아님, 긴 cwd, 문자열 아닌 칸, 빈 본문', () => {
    const a = createActivity({ cfgDir });
    const bad = [
      hook('UserPromptSubmit'),
      hook('__proto__'),
      { ...hook('SessionStart'), session_id: 'not-a-uuid' },
      { ...hook('SessionStart'), session_id: `${SID}x` },
      { ...hook('SessionStart'), cwd: '/' + 'a'.repeat(4096) },
      { ...hook('SessionStart'), cwd: 42 },
      { ...hook('PreToolUse'), tool_input: { skill: ['plus'] } },
      hook('SubagentStart', { agent_type: 'Explore' }), // agent_id 없음
      null, [], 'SessionStart', {},
    ];
    for (const b of bad) {
      const r = a.ingestHook(b);
      expect(r.ok, JSON.stringify(b)?.slice(0, 80)).toBe(false);
      if (!r.ok) expect(typeof r.ignored).toBe('string');
    }
    expect(a.terminalAlive(SID)).toBe(false);
    expect(a.ingestHook({ ...hook('SessionStart'), cwd: '/' + 'a'.repeat(4095) }).ok).toBe(true);
  });

  test('한글·공백 cwd 대조, 다른 폴더는 안 맞음', () => {
    const a = createActivity({ cfgDir });
    a.ingestHook(hook('SessionStart'));
    expect(a.forProject('/tmp/홍길동 프로젝트/')).toHaveLength(1);
    expect(a.forProject('/tmp/홍길동 프로젝트'.normalize('NFD'))).toHaveLength(1);
    expect(a.forProject('/tmp/홍길순 프로젝트')).toEqual([]);
  });

  test('win32 는 대소문자·구분자를 가리지 않는다', () => {
    const a = createActivity({ cfgDir, platform: 'win32' });
    a.ingestHook(hook('SessionStart', { cwd: 'C:\\Users\\홍길동\\Documents\\GitHub\\Plenum' }));
    expect(a.forProject('c:/users/홍길동/documents/github/plenum')).toHaveLength(1);
    const posix = createActivity({ cfgDir, platform: 'linux' });
    posix.ingestHook(hook('SessionStart', { cwd: '/tmp/Plenum' }));
    expect(posix.forProject('/tmp/plenum')).toEqual([]);
  });

  test('since 오름차순', () => {
    const c = clock();
    const a = createActivity({ cfgDir, now: c.now });
    a.ingestHook({ ...hook('SessionStart'), session_id: SID2 });
    c.add(10);
    a.ingestHook(hook('SessionStart'));
    expect(a.forProject(PROJ).map((s) => s.sessionId)).toEqual([SID2, SID]);
  });
});

describe('채팅 세션 (registry 이벤트)', () => {
  // 04-agents 녹화의 두 Agent: 전경(count files) + 백그라운드(say hi)
  const FG = 'toolu_018k3aiCWTvXZA1jg2tTdEde';
  const BG = 'toolu_018TDrrbjFUKLDvbbkGyqZJx';
  const w = (id: string, state: WorkerRun['state'], background: boolean, description: string): WorkerRun =>
    ({ id, worker: 'general-purpose', model: null, description, background, state, startedAt: 1, endedAt: state === 'running' ? null : 2 });

  test('전경 done + 백그라운드 running → result 뒤 백그라운드만 → exit 면 세션 사라짐', () => {
    const reg = fakeRegistry();
    const a = createActivity({ cfgDir: tmp(), chats: reg });
    a.registerChatProject('c1', PROJ);
    reg.emit('c1', { type: 'init', sessionId: SID, version: '2.1.323', model: 'haiku', permissionMode: 'default' });
    reg.emit('c1', { type: 'worker', worker: w(FG, 'running', false, 'count files') });
    reg.emit('c1', { type: 'worker', worker: w(BG, 'running', true, 'say hi') });
    reg.emit('c1', { type: 'state', state: 'waiting' });
    expect(a.forProject(PROJ)[0]).toMatchObject({ source: 'chat', chatId: 'c1', sessionId: SID, state: 'waiting' });
    reg.emit('c1', { type: 'state', state: 'running' });
    reg.emit('c1', { type: 'mode', mode: '기본' });
    reg.emit('c1', { type: 'worker', worker: w(FG, 'done', false, 'count files') });
    let [s] = a.forProject(PROJ);
    expect(s.workers.map((x) => [x.id, x.state])).toEqual([[FG, 'done'], [BG, 'running']]);
    expect(s.mode).toBe('기본');
    reg.emit('c1', { type: 'result', subtype: 'success', isError: false, text: 'ok', denials: 0 });
    [s] = a.forProject(PROJ);
    expect(s.state).toBe('idle');
    expect(s.workers.map((x) => [x.id, x.background, x.state])).toEqual([[BG, true, 'running']]);
    reg.emit('c1', { type: 'exit', code: 0, signal: null });
    expect(a.forProject(PROJ)).toEqual([]);
  });

  test('프로젝트 경로는 registerChatProject 로만(다른 프로젝트·등록 안 된 채팅은 안 보임)', () => {
    const reg = fakeRegistry();
    const a = createActivity({ cfgDir: tmp(), chats: reg });
    a.registerChatProject('c1', '/tmp/다른 프로젝트');
    reg.emit('c1', { type: 'init', sessionId: SID, version: null, model: null, permissionMode: null });
    reg.emit('c2', { type: 'init', sessionId: SID2, version: null, model: null, permissionMode: null });
    expect(a.forProject(PROJ)).toEqual([]);
    expect(a.forProject('/tmp/다른 프로젝트')).toHaveLength(1);
  });

  test('dispose 뒤로는 이벤트를 안 받는다', () => {
    const reg = fakeRegistry();
    const a = createActivity({ cfgDir: tmp(), chats: reg });
    a.registerChatProject('c1', PROJ);
    a.dispose();
    reg.emit('c1', { type: 'init', sessionId: SID, version: null, model: null, permissionMode: null });
    expect(a.forProject(PROJ)).toEqual([]);
  });
});

describe('라우트 /api/hook·activity', () => {
  test('X-Plenum 없는 /api/hook 은 403, 응답에 access-control-* 없음', async () => {
    const srv = await inProcess({ cfgDir: tmp() });
    const r = await fetch(`${srv.base}/api/hook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(hook('SessionStart')) });
    expect(r.status).toBe(403);
    expect([...r.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);
    await srv.close();
  });

  test('훅 → GET activity, 틀린 본문은 200 + ignored, 헤더 대조', async () => {
    const cfgDir = tmp();
    saveConfig({ ...defaultConfig(), projects: [{ id: 'p1', name: '프로젝트', path: PROJ, source: 'local' }] }, cfgDir);
    const srv = await inProcess({ cfgDir, workerModel: () => 'opus' });
    expect((await srv.call('POST', '/api/hook', hook('SessionStart'))).body).toEqual({ ok: true });
    await srv.call('POST', '/api/hook', hook('SubagentStart', { agent_type: 'Explore', agent_id: 'a1' }));
    const bad = await srv.call('POST', '/api/hook', { event: 'Nope', session_id: SID });
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
    expect(typeof bad.body.ignored).toBe('string');
    const res = await fetch(`${srv.base}/api/projects/p1/activity`);
    expect([...res.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);
    const act = await res.json() as any;
    expect(act.projectId).toBe('p1');
    expect(act.sessions).toHaveLength(1);
    expect(act.sessions[0].workers[0]).toMatchObject({ id: 'a1', model: 'opus' });
    expect((await srv.call('POST', `/api/projects/p1/sessions/${SID}/forget-terminal`)).body).toEqual({ ok: true, forgotten: true });
    expect((await srv.call('GET', '/api/projects/p1/activity')).body.sessions).toEqual([]);
    expect((await srv.call('GET', '/api/projects/없음/activity')).status).toBe(404);
    await srv.close();
  });
});

describe('포트 파일', () => {
  test('쓰기 → 읽기 → 내 pid 면 지운다', () => {
    const dir = path.join(tmp(), 'plenum');
    const v = writeServerFile(dir, 4318);
    expect(readServerFile(dir)).toEqual(v);
    expect(v).toMatchObject({ port: 4318, pid: process.pid });
    expect(fs.readdirSync(dir)).toEqual(['server.json']); // 임시 파일이 남지 않음
    expect(removeServerFile(dir)).toBe(true);
    expect(fs.existsSync(serverFilePath(dir))).toBe(false);
    expect(removeServerFile(dir)).toBe(false); // 없어도 던지지 않음
  });

  test('남의 pid 면 안 지운다', () => {
    const dir = tmp();
    fs.writeFileSync(serverFilePath(dir), JSON.stringify({ port: 4317, pid: process.pid + 1, startedAt: 1 }));
    expect(removeServerFile(dir)).toBe(false);
    expect(fs.existsSync(serverFilePath(dir))).toBe(true);
  });

  test('깨진 파일은 없는 것으로', () => {
    const dir = tmp();
    fs.writeFileSync(serverFilePath(dir), '{');
    expect(readServerFile(dir)).toBeNull();
    expect(removeServerFile(dir)).toBe(false);
  });
});
