// 모듈 연결(app.ts createHandler): 채팅 ↔ 작동 중 ↔ 지난 세션. 단위 테스트는 각자 가짜를 넣었으므로 여기서 진짜끼리 붙여 본다.
// - 채팅 init → 작동 중 칸에 그 프로젝트의 채팅 세션
// - Plenum 채팅 세션의 훅은 무시(중복 방지)
// - 훅으로 터미널에서 열린 세션은 채팅 이어하기 409, 지난 세션 목록 running 'terminal'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { createHandler, listen } from '../server/app.ts';
import { defaultConfig, saveConfig } from '../server/config.ts';
import { makeFakeStreamClaude } from './fakeclaudeStream.ts';
import { APP } from './helpers.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), '홍길동 연결-'));
const projDir = path.join(root, '내 프로젝트');
fs.mkdirSync(projDir);
const cfgDir = path.join(root, '설정');
saveConfig({ ...defaultConfig(), projects: [{ id: 'p1', name: '내 프로젝트', path: projDir, source: 'local' }] }, cfgDir);
const claudeHome = path.join(root, 'claude-home');
const TERM_SID = '11111111-2222-4333-8444-555555555555';
// 터미널에서 시작한 지난 세션 기록 하나 (cwd 가 프로젝트)
fs.mkdirSync(path.join(claudeHome, 'projects', 'x'), { recursive: true });
fs.writeFileSync(path.join(claudeHome, 'projects', 'x', `${TERM_SID}.jsonl`), JSON.stringify({ type: 'user', cwd: projDir, timestamp: '2026-11-13T01:00:00.000Z', message: { role: 'user', content: '터미널 질문' } }) + '\n');

const fake = makeFakeStreamClaude(path.join(root, '가짜'));
const env = fake.env({ script: path.join(APP, 'test', 'fixtures', 'stream', '04-agents.jsonl') });
const handler = createHandler({ cfgDir, env, claudeHome });
const { server, port } = await listen(handler, 0);
const base = `http://127.0.0.1:${port}`;
afterAll(async () => { await handler.chats.shutdownAll(); await new Promise<void>((r) => server.close(() => r())); });

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Plenum': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}
async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (ok(v)) return v; if (Date.now() > end) throw new Error(`시간 안에 조건이 안 맞음: ${JSON.stringify(v)}`); await new Promise((r) => setTimeout(r, 100)); }
}

let chatSid = '';
it('채팅을 시작하면 작동 중 칸에 그 프로젝트의 채팅 세션이 생긴다', async () => {
  const r = await call('POST', '/api/projects/p1/chats', { text: '시작' });
  expect(r.status).toBe(201);
  const act = await until(() => call('GET', '/api/projects/p1/activity'), (v) => v.body.sessions?.some((s: any) => s.source === 'chat'));
  const s = act.body.sessions.find((x: any) => x.source === 'chat');
  expect(s.chatId).toBe(r.body.chat.chatId);
  chatSid = s.sessionId;
  expect(chatSid).toMatch(/^[0-9a-f-]{36}$/);
});

it('Plenum 채팅 세션의 훅은 무시한다(작동 중에 터미널 세션으로 안 생김)', async () => {
  const h = await call('POST', '/api/hook', { event: 'SessionStart', session_id: chatSid, cwd: projDir, source: 'startup' });
  expect(h.status).toBe(200);
  const act = await call('GET', '/api/projects/p1/activity');
  expect(act.body.sessions.filter((s: any) => s.sessionId === chatSid).map((s: any) => s.source)).toEqual(['chat']);
});

it('훅으로 터미널에서 열린 세션: 지난 세션 목록 running terminal, 채팅 이어하기 409', async () => {
  expect((await call('POST', '/api/hook', { event: 'SessionStart', session_id: TERM_SID, cwd: projDir, source: 'startup' })).status).toBe(200);
  const list = await call('GET', '/api/projects/p1/sessions');
  expect(list.body.find((x: any) => x.id === TERM_SID)?.running).toBe('terminal');
  const r = await call('POST', '/api/projects/p1/chats', { text: '이어서', resume: TERM_SID });
  expect(r.status).toBe(409);
  // 터미널을 닫으면(SessionEnd) 다시 열 수 있다 — 여기선 막힘이 풀리는 것만 본다
  await call('POST', '/api/hook', { event: 'SessionEnd', session_id: TERM_SID, cwd: projDir, reason: 'other' });
  expect((await call('GET', '/api/projects/p1/sessions')).body.find((x: any) => x.id === TERM_SID)?.running).toBe(null);
});
