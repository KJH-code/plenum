// 채팅 매니저·라우트: 진짜 claude 녹화(fixtures/stream)를 가짜 claude 로 재생한다.
// 가짜 claude 는 PATH 이름으로 찾는다(fakeclaudeStream.ts). 임시 폴더는 한글·공백 이름.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chatArgs, chatEnv, createChatManager, LIMIT_UNKNOWN_RESET, type ChatManager } from '../server/chat.ts';
import type { Card, ChatEvent } from '../server/chatTypes.ts';
import { readLimits, readSessions, saveLimits } from '../server/store.ts';
import { makeFakeStreamClaude, writeScript, type FakeStreamClaude } from './fakeclaudeStream.ts';
import { workerModel } from '../server/app.ts';
import { defaultConfig, saveConfig } from '../server/config.ts';
import { readKit } from '../server/kit.ts';
import { APP, copyDir, inProcess } from './helpers.ts';
import { FIXTURE_KIT } from './kitrepo.ts';

const REC = path.join(APP, 'test', 'fixtures', 'stream');
const rec = (name: string) => path.join(REC, name);

interface Setup { root: string; cfgDir: string; project: { id: string; path: string }; fake: FakeStreamClaude }
function setup(): Setup {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '홍길동 테스트-'));
  const projDir = path.join(root, '내 프로젝트');
  fs.mkdirSync(projDir);
  return { root, cfgDir: path.join(root, '설정'), project: { id: 'p1', path: projDir }, fake: makeFakeStreamClaude(path.join(root, '가짜')) };
}

const managers: ChatManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((m) => m.shutdownAll())); });

function manager(s: Setup, env: NodeJS.ProcessEnv, deps: Parameters<typeof createChatManager>[0]['deps'] = {}) {
  const m = createChatManager({ cfgDir: s.cfgDir, env, deps, closeWaitMs: 3000 });
  managers.push(m);
  return m;
}

// 조건에 맞는 이벤트를 기다린다 (after 보다 뒤 seq)
function waitEvent<T extends ChatEvent['type']>(m: ChatManager, chatId: string, type: T, pred: (e: Extract<ChatEvent, { type: T }>) => boolean = () => true, after = 0, ms = 15000): Promise<Extract<ChatEvent, { type: T }>> {
  return new Promise((resolve, reject) => {
    let off = () => {};
    const t = setTimeout(() => { off(); reject(new Error(`${type} 이벤트가 ${ms}ms 안에 안 왔다`)); }, ms);
    let done = false;
    off = m.subscribe(chatId, after, (e) => {
      if (done || e.type !== type || !pred(e as any)) return;
      done = true;
      clearTimeout(t);
      queueMicrotask(() => off());
      resolve(e as any);
    });
  });
}
function events(m: ChatManager, chatId: string): ChatEvent[] {
  const out: ChatEvent[] = [];
  m.subscribe(chatId, 0, (e) => out.push(e))();
  return out;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) return false; await sleep(20); }
  return true;
}
const nextCard = async (m: ChatManager, chatId: string, after: number) => (await waitEvent(m, chatId, 'card', () => true, after));

describe('녹화 재생', () => {
  it('01 카드: 질문 답·허용·이 세션 동안 허용(addRules 만)·거부 이유, 한도', async () => {
    const s = setup();
    const m = manager(s, s.fake.env({ script: rec('01-cards.jsonl'), extra: { CLAUDE_CODE_SESSION_ID: 'outer', CLAUDE_CODE_REMOTE_SESSION_ID: 'outer2' } }));
    const { chat, warnings } = await m.start(s.project, { text: '시작', model: 'haiku', effort: 'low' });
    expect(warnings).toEqual([]);
    const id = chat.chatId;

    const q = await nextCard(m, id, 0);
    const qc = q.card as Extract<Card, { kind: 'question' }>;
    expect(qc.kind).toBe('question');
    expect(qc.isModeQuestion).toBe(false);
    expect(qc.questions[0].options.map((o) => [o.label, o.recommended])).toEqual([['a.txt (Recommended)', true], ['b.txt', false]]);
    expect(m.get(id)!.state).toBe('waiting');
    m.respond(id, { requestId: qc.requestId, action: 'answer', answers: { 'Which file name?': 'a.txt (Recommended)' } });
    await expect(Promise.resolve().then(() => m.respond(id, { requestId: qc.requestId, action: 'allow' }))).rejects.toMatchObject({ status: 409 });

    const p1 = await nextCard(m, id, q.seq);
    const pc1 = p1.card as Extract<Card, { kind: 'permission' }>;
    expect(pc1.kind).toBe('permission');
    expect(pc1.toolName).toBe('Bash');
    expect(pc1.sessionRules).toEqual([{ toolName: 'Bash', ruleContent: 'touch a.txt' }]);
    m.respond(id, { requestId: pc1.requestId, action: 'allow' });

    const p2 = await nextCard(m, id, p1.seq);
    const pc2 = p2.card as Extract<Card, { kind: 'permission' }>;
    expect(pc2.sessionRules).toEqual([{ toolName: 'Bash', ruleContent: 'touch c.txt' }]);
    m.respond(id, { requestId: pc2.requestId, action: 'allow-session' });

    const p3 = await nextCard(m, id, p2.seq);
    const pc3 = p3.card as Extract<Card, { kind: 'permission' }>;
    expect((pc3.input as any).command).toBe('rm a.txt');
    m.respond(id, { requestId: pc3.requestId, action: 'deny', reason: '  삭제는 내가 직접 할게 ' });

    const r = await waitEvent(m, id, 'result');
    expect(r.subtype).toBe('success');
    await waitEvent(m, id, 'state', (e) => e.state === 'idle', r.seq);

    // stdin 으로 간 것
    const sent = s.fake.stdin();
    expect(sent[0]).toEqual({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } });
    expect(sent[1]).toEqual({ type: 'user', message: { role: 'user', content: '시작' } });
    const resp = (rid: string) => sent.find((x) => x.type === 'control_response' && x.response.request_id === rid).response;
    expect(resp(qc.requestId).subtype).toBe('success');
    expect(resp(qc.requestId).response.updatedInput.answers).toEqual({ 'Which file name?': 'a.txt (Recommended)' });
    expect(resp(qc.requestId).response.updatedInput.questions[0].question).toBe('Which file name?');
    expect(resp(pc1.requestId).response).toEqual({ behavior: 'allow', updatedInput: { command: 'touch a.txt', description: 'Create a.txt' } });
    const ss = resp(pc2.requestId).response;
    expect(ss.updatedPermissions).toEqual([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch c.txt' }], behavior: 'allow', destination: 'session' }]);
    expect(JSON.stringify(ss)).not.toMatch(/setMode|addDirectories/);
    // "사용자가" 를 밝힌다(그냥 이유만 주면 Claude 가 훅이 막은 것으로 이해했다)
    expect(resp(pc3.requestId).response).toEqual({ behavior: 'deny', message: '사용자가 거부함. 이유: 삭제는 내가 직접 할게' });

    // 한도: pct 4·28, limits.json
    const lim = events(m, id).filter((e) => e.type === 'limits');
    expect(lim.length).toBeGreaterThan(0);
    const l0 = (lim[0] as any).limits;
    expect([l0.fiveHour.pct, l0.sevenDay.pct]).toEqual([4, 28]);
    expect(l0.rejected).toBeNull();
    expect(readLimits(s.cfgDir)!.sevenDay!.pct).toBe(28);
    expect(m.getLimits()!.fiveHour!.pct).toBe(4);

    // init → sessions.json
    const init = events(m, id).find((e) => e.type === 'init') as any;
    expect(init.sessionId).toBe('b5b49096-5604-499f-a80b-49f35d8d09bb');
    expect(init.version).toBe('2.1.323');
    expect(readSessions(s.cfgDir)[init.sessionId]).toMatchObject({ version: '2.1.323', plenum: true, projectId: 'p1' });
    expect(m.findBySession(init.sessionId)!.chatId).toBe(id);
    expect(m.isPlenumChat(init.sessionId)).toBe(true);
    expect(events(m, id).some((e) => e.type === 'notice' && e.code === 'version-old')).toBe(false);

    // 인자·cwd·env
    const call = s.fake.argsCalls()[0];
    expect(call.args).toEqual(chatArgs({ model: 'haiku', effort: 'low' }));
    expect(call.args).not.toContain('--bare');
    expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(s.project.path));
    expect(call.sessionEnv).toEqual([null, null]);
    // 채팅 claude 에만 PLENUM_NOTIFY=0 (훅이 Plenum 에 안 알리게), 사용자 defaultMode 가 새지 않게 --permission-mode default
    expect(call.notify).toBe('0');
    expect(call.args.join(' ')).toContain('--permission-mode default');

    // "이 세션 동안 허용" 은 세션에만: 보낸 updatedPermissions 의 destination 이 전부 session, localSettings 없음.
    // 가짜는 파일을 안 쓰므로 destination 단언이 핵심이고 .claude 폴더 단언은 보조(진짜 claude 실측은 노트북 확인 항목)
    const ups = sent.filter((x) => x.type === 'control_response').flatMap((x) => x.response.response?.updatedPermissions ?? []);
    expect(ups.length).toBeGreaterThan(0);
    expect(ups.map((u: any) => u.destination)).toEqual(ups.map(() => 'session'));
    expect(JSON.stringify(sent)).not.toContain('localSettings');
    expect(fs.existsSync(path.join(s.project.path, '.claude'))).toBe(false);

    await m.close(id);
    expect(m.get(id)!.state).toBe('ended');
    expect(events(m, id).some((e) => e.type === 'exit')).toBe(true);
    expect(m.isPlenumChat(init.sessionId)).toBe(false);
    expect(fs.readFileSync(path.join(s.cfgDir, 'chat-pids.json'), 'utf8').trim()).toBe('[]');
  });

  it('03 모드: 모드 질문 → "모드 없음" 답 → mode 이벤트 + sessions.json, Edit diff', async () => {
    const s = setup();
    const m = manager(s, s.fake.env({ script: rec('03-mode.jsonl') }));
    const id = (await m.start(s.project, { text: 'README 첫 줄' })).chat.chatId;
    const q = await nextCard(m, id, 0);
    const qc = q.card as Extract<Card, { kind: 'question' }>;
    expect(qc.isModeQuestion).toBe(true);
    expect(qc.questions[0].header).toBe('모드');
    expect(qc.questions[0].options[0].recommended).toBe(true);
    m.respond(id, { requestId: qc.requestId, action: 'answer', answers: { [qc.questions[0].question]: '모드 없음 (추천)' } });
    const mode = await waitEvent(m, id, 'mode');
    expect(mode.mode).toBe('모드 없음');
    const sid = m.get(id)!.sessionId!;
    expect(readSessions(s.cfgDir)[sid].mode).toBe('모드 없음');
    expect(m.get(id)!.mode).toBe('모드 없음');

    const e = await nextCard(m, id, q.seq);
    const ec = e.card as Extract<Card, { kind: 'permission' }>;
    expect(ec.toolName).toBe('Edit');
    expect(ec.sessionRules).toEqual([]); // setMode 만 제안됨 → 버림
    expect(ec.diff).toEqual({ path: '/tmp/plenum-rec-홍길동-AbCdEf/README.md', old: '# fake\n', new: '# fake project\n' });
    await expect(Promise.resolve().then(() => m.respond(id, { requestId: ec.requestId, action: 'allow-session' }))).rejects.toMatchObject({ status: 400 });
    m.respond(id, { requestId: ec.requestId, action: 'allow' });
    await waitEvent(m, id, 'result');
  });

  it('04 워커: 전경·백그라운드 2개, id = tool_use_id, 둘 다 done', async () => {
    const s = setup();
    const m = manager(s, s.fake.env({ script: rec('04-agents.jsonl') }), { workerModel: (t) => (t === 'general-purpose' ? 'haiku' : null) });
    const id = (await m.start(s.project, { text: '워커' })).chat.chatId;
    await waitEvent(m, id, 'result');
    const ws = events(m, id).filter((e) => e.type === 'worker').map((e: any) => e.worker);
    const ids = [...new Set(ws.map((w) => w.id))].sort();
    expect(ids).toEqual(['toolu_018TDrrbjFUKLDvbbkGyqZJx', 'toolu_018k3aiCWTvXZA1jg2tTdEde']);
    const last = (wid: string) => ws.filter((w) => w.id === wid).at(-1);
    expect(last('toolu_018k3aiCWTvXZA1jg2tTdEde')).toMatchObject({ worker: 'general-purpose', model: 'haiku', description: 'count files', background: false, state: 'done' });
    expect(last('toolu_018TDrrbjFUKLDvbbkGyqZJx')).toMatchObject({ description: 'say hi', background: true, state: 'done' });
    expect(last('toolu_018TDrrbjFUKLDvbbkGyqZJx').endedAt).toBeTypeOf('number');
    // 끝 이벤트는 워커마다 한 번
    expect(ws.filter((w) => w.state === 'done')).toHaveLength(2);
    // 하위 에이전트 도구는 parentToolUseId 가 붙는다
    const tools = events(m, id).filter((e) => e.type === 'tool') as any[];
    expect(tools.some((t) => t.parentToolUseId === 'toolu_018k3aiCWTvXZA1jg2tTdEde')).toBe(true);
    expect(tools.filter((t) => t.name === 'Agent').every((t) => t.parentToolUseId === null)).toBe(true);
  });

  it('05 interrupt: control_request interrupt → result error_during_execution → idle, 닫으면 ended', async () => {
    const s = setup();
    const m = manager(s, s.fake.env({ script: rec('05-interrupt.jsonl') }));
    const id = (await m.start(s.project, { text: '길게' })).chat.chatId;
    await waitEvent(m, id, 'init');
    m.interrupt(id);
    const r = await waitEvent(m, id, 'result');
    expect(r).toMatchObject({ subtype: 'error_during_execution', isError: true });
    await waitEvent(m, id, 'state', (e) => e.state === 'idle');
    expect(s.fake.stdin().find((x) => x.type === 'control_request' && x.request.subtype === 'interrupt')).toEqual({ type: 'control_request', request_id: 'int-1', request: { subtype: 'interrupt' } });
    await m.close(id);
    expect(m.get(id)!.state).toBe('ended');
    expect(events(m, id).find((e) => e.type === 'exit')).toMatchObject({ code: 1 });
  });

  it('응답 중에 닫으면 interrupt 먼저 보내고 끝난다', async () => {
    const s = setup();
    const m = manager(s, s.fake.env({ script: rec('05-interrupt.jsonl') }));
    const id = (await m.start(s.project, { text: '길게' })).chat.chatId;
    await waitEvent(m, id, 'init');
    expect(m.get(id)!.state).toBe('running');
    const t0 = Date.now();
    await m.close(id);
    expect(Date.now() - t0).toBeLessThan(2500); // closeWaitMs(3000)까지 안 기다림
    expect(m.get(id)!.state).toBe('ended');
    expect(s.fake.stdin().some((x) => x.type === 'control_request' && x.request.subtype === 'interrupt')).toBe(true);
    await expect(Promise.resolve().then(() => m.send(id, '또'))).rejects.toMatchObject({ status: 409 });
  });
});

const INIT = (version: string, sid = '11111111-2222-3333-4444-555555555555') => ({ type: 'system', subtype: 'init', session_id: sid, claude_code_version: version, model: 'claude-haiku-5-5', permissionMode: 'default' });
const RESULT = { type: 'result', subtype: 'success', is_error: false, result: '끝', permission_denials: [] };
const HELLO = [{ dir: 'in', msg: { type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } } }, { dir: 'in', msg: { type: 'user' } }] as const;

describe('합성 대본', () => {
  it('모르는 control_request → stdin 에 error 응답 + unknown 카드 + notice', async () => {
    const s = setup();
    const file = path.join(s.root, 'unknown.jsonl');
    writeScript(file, [...HELLO, { dir: 'out', msg: INIT('2.1.323') },
      { dir: 'out', msg: { type: 'control_request', request_id: 'el-1', request: { subtype: 'elicit_something', foo: 1 } } },
      { dir: 'in', msg: { type: 'control_response', response: { request_id: 'el-1' } } },
      { dir: 'out', msg: RESULT }, { dir: 'exit', code: 0 }]);
    const m = manager(s, s.fake.env({ script: file }));
    const id = (await m.start(s.project, { text: '안녕' })).chat.chatId;
    const c = await waitEvent(m, id, 'card');
    expect(c.card).toEqual({ kind: 'unknown', requestId: 'el-1', subtype: 'elicit_something', version: '2.1.323' });
    await waitEvent(m, id, 'result');
    expect(events(m, id).some((e) => e.type === 'notice' && e.code === 'unknown-request')).toBe(true);
    expect(s.fake.stdin().find((x) => x.type === 'control_response')).toEqual({ type: 'control_response', response: { subtype: 'error', request_id: 'el-1', error: 'Plenum 채팅이 처리하지 못하는 요청' } });
    await expect(Promise.resolve().then(() => m.respond(id, { requestId: 'el-1', action: 'allow' }))).rejects.toMatchObject({ status: 409 });
    await expect(Promise.resolve().then(() => m.respond(id, { requestId: 'nope', action: 'allow' }))).rejects.toMatchObject({ status: 404 });
  });

  // 한도 규칙(limitGate): 대본이 rate_limit_event(rejected, resetsAt) 를 낸 뒤 다음 user 를 기다린다
  async function limitChat(resetsAt: number | null) {
    const s = setup();
    const file = path.join(s.root, 'limit.jsonl');
    const w: any = { utilization: 1, status: 'rejected', ...(resetsAt !== null ? { resetsAt } : {}) };
    writeScript(file, [...HELLO, { dir: 'out', msg: INIT('2.1.323') },
      { dir: 'out', msg: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', ...(resetsAt !== null ? { resetsAt } : {}), rateLimitType: 'five_hour', unifiedWindows: { five_hour: w } } } },
      { dir: 'out', msg: RESULT }, { dir: 'in', msg: { type: 'user' } }, { dir: 'out', msg: RESULT }, { dir: 'exit', code: 0 }]);
    const m = manager(s, s.fake.env({ script: file }));
    const st = await m.start(s.project, { text: '안녕' });
    const id = st.chat.chatId;
    const l = await waitEvent(m, id, 'limits');
    expect(l.limits.rejected).toEqual({ window: 'five_hour', resetsAt });
    await waitEvent(m, id, 'result');
    return { s, m, id, start: st };
  }
  const statusOf = async (f: () => unknown) => { try { await f(); return 0; } catch (e: any) { return e.status; } };

  it('한도: 리셋이 미래 → send·start(새 채팅·이어하기) 429, 새 매니저도 파일 값으로 막는다', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const { s, m, id } = await limitChat(reset);
    let err: any;
    try { m.send(id, '또'); } catch (e) { err = e; }
    expect(err.status).toBe(429);
    expect(err.message).toContain(new Date(reset * 1000).toISOString());
    const calls = s.fake.argsCalls().length;
    expect(await statusOf(() => m.start(s.project, { text: '새로' }))).toBe(429);
    expect(await statusOf(() => m.start(s.project, { text: '이어', resume: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }))).toBe(429);
    expect(s.fake.argsCalls()).toHaveLength(calls); // 띄우지 않음
    const m2 = manager(s, s.fake.env());
    expect(m2.getLimits()!.rejected!.resetsAt).toBe(reset);
    expect(await statusOf(() => m2.start(s.project, { text: '새로' }))).toBe(429);
  });

  it('한도: rejected 인데 리셋 시각을 모름 → 막지 않고 경고(warnings + notice warn), start 도 같다', async () => {
    const { s, m, id } = await limitChat(null);
    const before = m.get(id)!.lastSeq;
    const r = m.send(id, '또');
    expect(r.warnings).toEqual([LIMIT_UNKNOWN_RESET]);
    const n = await waitEvent(m, id, 'notice', (e) => e.message === LIMIT_UNKNOWN_RESET, before);
    expect(n).toMatchObject({ level: 'warn', code: 'limit-rejected' });
    await waitEvent(m, id, 'result', () => true, before);
    expect(s.fake.stdin().filter((x) => x.type === 'user').map((x) => x.message.content)).toEqual(['안녕', '또']);
    // 새 채팅도 띄우고 경고
    const st = await m.start({ id: 'p2', path: s.project.path }, { text: '새로' });
    expect(st.warnings).toEqual([LIMIT_UNKNOWN_RESET]);
    expect(events(m, st.chat.chatId).some((e) => e.type === 'notice' && e.message === LIMIT_UNKNOWN_RESET)).toBe(true);
  });

  it('한도: 리셋 시각이 지났으면 막지도 경고하지도 않는다', async () => {
    const { m, id } = await limitChat(Math.floor(Date.now() / 1000) - 60);
    expect(m.send(id, '또').warnings).toEqual([]);
  });

  it('버전 2.1.200 → version-old notice (경고만)', async () => {
    const s = setup();
    const file = path.join(s.root, 'old.jsonl');
    writeScript(file, [...HELLO, { dir: 'out', msg: INIT('2.1.200') }, { dir: 'out', msg: RESULT }, { dir: 'exit', code: 0 }]);
    const m = manager(s, s.fake.env({ script: file }));
    const id = (await m.start(s.project, { text: '안녕' })).chat.chatId;
    const n = await waitEvent(m, id, 'notice', (e) => e.code === 'version-old');
    expect(n.level).toBe('warn');
    await waitEvent(m, id, 'result');
    // 2.1.248 은 경고 없음
    const file2 = path.join(s.root, 'ok.jsonl');
    writeScript(file2, [...HELLO, { dir: 'out', msg: INIT('2.1.248') }, { dir: 'out', msg: RESULT }, { dir: 'exit', code: 0 }]);
    const m2 = manager(s, s.fake.env({ script: file2 }));
    const id2 = (await m2.start({ id: 'p2', path: s.project.path }, { text: '안녕' })).chat.chatId;
    await waitEvent(m2, id2, 'result');
    expect(events(m2, id2).some((e) => e.type === 'notice' && e.code === 'version-old')).toBe(false);
  });

  it('같은 프로젝트에서 응답 중인 채팅이 있으면 warnings 1개 (막지 않음)', async () => {
    const s = setup();
    const file = path.join(s.root, 'busy.jsonl');
    // init 뒤 다음 user 를 기다리며 running 으로 머문다
    writeScript(file, [...HELLO, { dir: 'out', msg: INIT('2.1.323') }, { dir: 'in', msg: { type: 'user' } }, { dir: 'exit', code: 0 }]);
    const m = manager(s, s.fake.env({ script: file }));
    const a = await m.start(s.project, { text: '하나' });
    expect(a.warnings).toEqual([]);
    await waitEvent(m, a.chat.chatId, 'init');
    expect(m.get(a.chat.chatId)!.state).toBe('running');
    const b = await m.start(s.project, { text: '둘' });
    expect(b.warnings).toHaveLength(1);
    expect(b.warnings[0]).toContain('같은 프로젝트');
    expect(events(m, b.chat.chatId).filter((e) => e.type === 'notice' && e.code === 'concurrent')).toHaveLength(1);
    // 다른 프로젝트는 경고 없음
    expect((await m.start({ id: 'p2', path: s.project.path }, { text: '셋' })).warnings).toEqual([]);
    // send 도 같다 (b 가 running 이 된 뒤)
    await waitEvent(m, b.chat.chatId, 'init');
    expect(m.send(a.chat.chatId, '더').warnings).toHaveLength(1);
    expect(m.list('p1').map((c) => c.chatId).sort()).toEqual([a.chat.chatId, b.chat.chatId].sort());
  });

  it('resume: 인자 검사, 터미널에서 열려 있으면 409, 이미 도는 채팅이면 글을 그 채팅에 보내고 그것을 돌려줌', async () => {
    const s = setup();
    const sid = 'b5b49096-5604-499f-a80b-49f35d8d09bb';
    const file = path.join(s.root, 'resume.jsonl');
    writeScript(file, [...HELLO, { dir: 'out', msg: INIT('2.1.323', sid) }, { dir: 'in', msg: { type: 'user' } }, { dir: 'exit', code: 0 }]);
    const alive = new Set<string>(['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']);
    const m = manager(s, s.fake.env({ script: file }), { terminalAlive: (x) => alive.has(x) });
    const status = async (f: () => Promise<unknown>) => { try { await f(); return 0; } catch (e: any) { return e.status; } };
    expect(await status(() => m.start(s.project, { text: '이어', resume: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }))).toBe(409);
    expect(await status(() => m.start(s.project, { text: '이어', resume: '../x' }))).toBe(400);
    expect(await status(() => m.start(s.project, { text: '이어', model: 'haiku; rm' }))).toBe(400);
    expect(await status(() => m.start(s.project, { text: '이어', model: 'x'.repeat(61) }))).toBe(400);
    expect(await status(() => m.start(s.project, { text: '이어', effort: 'ultra' }))).toBe(400);
    expect(await status(() => m.start(s.project, { text: '   ' }))).toBe(400);
    expect(s.fake.argsCalls()).toHaveLength(0);
    const a = await m.start(s.project, { text: '이어', resume: sid, model: 'claude-opus-5-5[1m]', effort: 'max' });
    expect(a.chat.sessionId).toBe(sid);
    expect(a.forwarded).toBeUndefined();
    await waitEvent(m, a.chat.chatId, 'init');
    const b = await m.start(s.project, { text: '또', resume: sid });
    expect(b.chat.chatId).toBe(a.chat.chatId);
    expect(b.forwarded).toBe(true);
    expect(events(m, a.chat.chatId).filter((e) => e.type === 'user').map((e: any) => e.text)).toEqual(['이어', '또']);
    expect(await until(() => s.fake.stdin().filter((x) => x.type === 'user').length === 2)).toBe(true);
    expect(s.fake.stdin().filter((x) => x.type === 'user').map((x) => x.message.content)).toEqual(['이어', '또']);
    expect(s.fake.argsCalls()).toHaveLength(1);
    expect(s.fake.argsCalls()[0].args.slice(-6)).toEqual(['--model', 'claude-opus-5-5[1m]', '--effort', 'max', '--resume', sid]);
  });

  it('resume: 이어할 채팅이 카드 답을 기다리면 409, 글은 보내지 않음', async () => {
    const s = setup();
    const sid = 'b5b49096-5604-499f-a80b-49f35d8d09bb';
    const file = path.join(s.root, 'waiting.jsonl');
    writeScript(file, [...HELLO, { dir: 'out', msg: INIT('2.1.323', sid) },
      { dir: 'out', msg: { type: 'control_request', request_id: 'r-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, permission_suggestions: [] } } },
      { dir: 'in', msg: { type: 'control_response', response: { request_id: 'r-1' } } }, { dir: 'exit', code: 0 }]);
    const m = manager(s, s.fake.env({ script: file }));
    const a = await m.start(s.project, { text: '처음' });
    await waitEvent(m, a.chat.chatId, 'card');
    expect(m.get(a.chat.chatId)!.state).toBe('waiting');
    let err: any;
    try { await m.start(s.project, { text: '버려지면 안 되는 글', resume: sid }); } catch (e) { err = e; }
    expect(err.status).toBe(409);
    expect(err.message).toContain('답을 기다리는 카드가 있다');
    expect(events(m, a.chat.chatId).filter((e) => e.type === 'user').map((e: any) => e.text)).toEqual(['처음']);
    expect(s.fake.stdin().filter((x) => x.type === 'user')).toHaveLength(1);
    expect(s.fake.argsCalls()).toHaveLength(1);
  });

  it('respond: 카드 대기 중 close 된 채팅에 답하면 409 chat-ended(card-answered 아님)', async () => {
    const s = setup();
    const file = path.join(s.root, 'waiting.jsonl');
    writeScript(file, [...HELLO, { dir: 'out', msg: INIT('2.1.323') },
      { dir: 'out', msg: { type: 'control_request', request_id: 'r-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, permission_suggestions: [] } } },
      { dir: 'in', msg: { type: 'control_response', response: { request_id: 'r-1' } } }, { dir: 'exit', code: 0 }]);
    const m = manager(s, s.fake.env({ script: file }));
    const id = (await m.start(s.project, { text: '처음' })).chat.chatId;
    await waitEvent(m, id, 'card');
    await m.close(id);
    expect(m.get(id)!.state).toBe('ended');
    let err: any;
    try { m.respond(id, { requestId: 'r-1', action: 'allow' }); } catch (e) { err = e; }
    expect(err?.status).toBe(409);
    expect(err.reason).toBe('chat-ended');
    expect(s.fake.stdin().filter((x) => x.type === 'control_response')).toHaveLength(0);
  });

  it('resume: 닫는 중인 채팅의 세션을 이어하면 끝나기를 기다렸다가 --resume 으로 새로 띄운다(201)', async () => {
    const s = setup();
    const sid = 'b5b49096-5604-499f-a80b-49f35d8d09bb';
    const file = path.join(s.root, 'idle.jsonl');
    writeScript(file, [...HELLO, { dir: 'out', msg: INIT('2.1.323', sid) }, { dir: 'out', msg: RESULT }, { dir: 'in', msg: { type: 'user' } }, { dir: 'out', msg: RESULT }, { dir: 'exit', code: 0 }]);
    const env = s.fake.env({ script: file });
    const chats = manager(s, env);
    const srv = await inProcess({ cfgDir: s.cfgDir, env, chats });
    try {
      const pid = (await srv.call('POST', '/api/projects', { kind: 'local', path: s.project.path })).body.id;
      const first = (await srv.call('POST', `/api/projects/${pid}/chats`, { text: '처음' })).body.chat.chatId;
      await waitEvent(chats, first, 'state', (e) => e.state === 'idle');
      const closing = chats.close(first); // 기다리지 않는다
      expect(chats.get(first)!.state).toBe('idle');
      const r = await srv.call('POST', `/api/projects/${pid}/chats`, { text: '이어', resume: sid });
      expect(r.status).toBe(201);
      expect(r.body.forwarded).toBeUndefined();
      expect(r.body.chat.chatId).not.toBe(first);
      expect(chats.get(first)!.state).toBe('ended');
      await closing;
      expect(await until(() => s.fake.argsCalls().length === 2)).toBe(true);
      const calls = s.fake.argsCalls();
      expect(calls[1].args.slice(-2)).toEqual(['--resume', sid]);
      expect(events(chats, r.body.chat.chatId).filter((e) => e.type === 'user').map((e: any) => e.text)).toEqual(['이어']);
    } finally {
      await srv.close();
    }
  });

  // 거부 이유 → stdin 의 deny message (정확 일치)
  it.each([
    { reason: undefined, message: '사용자가 거부함' },
    { reason: '', message: '사용자가 거부함' },
    { reason: '   ', message: '사용자가 거부함' },
    { reason: ' 지우지 마 ', message: '사용자가 거부함. 이유: 지우지 마' },
  ])('거부: 이유 $reason → message "$message"', async ({ reason, message }) => {
    const s = setup();
    const file = path.join(s.root, 'deny.jsonl');
    writeScript(file, [...HELLO, { dir: 'out', msg: INIT('2.1.323') },
      { dir: 'out', msg: { type: 'control_request', request_id: 'd-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm a.txt' }, permission_suggestions: [] } } },
      { dir: 'in', msg: { type: 'control_response', response: { request_id: 'd-1' } } }, { dir: 'out', msg: RESULT }, { dir: 'exit', code: 0 }]);
    const m = manager(s, s.fake.env({ script: file }));
    const id = (await m.start(s.project, { text: '지워' })).chat.chatId;
    await waitEvent(m, id, 'card');
    m.respond(id, { requestId: 'd-1', action: 'deny', ...(reason !== undefined ? { reason } : {}) });
    await waitEvent(m, id, 'result');
    const r = s.fake.stdin().find((x) => x.type === 'control_response');
    expect(r).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'd-1', response: { behavior: 'deny', message } } });
  });

  it('플러그인 캐시 Read 허용 규칙: 띄운 claude 인자에 있고, CLAUDE_CONFIG_DIR 이 있으면 없다', async () => {
    const RULE = 'Read(~/.claude/plugins/cache/**)';
    const pair = (args: string[]) => { const i = args.indexOf('--allowedTools'); return i < 0 ? null : args.slice(i, i + 2); };
    // 함수 모양
    expect(pair(chatArgs({}))).toEqual(['--allowedTools', RULE]);
    expect(pair(chatArgs({ model: 'haiku', resume: '11111111-2222-4333-8444-555555555555' }, { PATH: '/x' }))).toEqual(['--allowedTools', RULE]);
    expect(pair(chatArgs({}, { CLAUDE_CONFIG_DIR: 'C:\\Users\\홍길동\\다른 설정' }))).toBeNull();
    expect(pair(chatArgs({}, { CLAUDE_CONFIG_DIR: '' }))).toEqual(['--allowedTools', RULE]); // 빈 값은 없는 것과 같다
    expect(chatArgs({}).filter((a) => a.startsWith('Read(') || /^(Edit|Write|Bash)\(/.test(a))).toEqual([RULE]); // Read 만
    // 실제로 띄운 인자
    const s = setup();
    const file = path.join(s.root, 'args.jsonl');
    writeScript(file, [...HELLO, { dir: 'out', msg: INIT('2.1.323') }, { dir: 'out', msg: RESULT }, { dir: 'exit', code: 0 }]);
    const m1 = manager(s, s.fake.env({ script: file }));
    await waitEvent(m1, (await m1.start(s.project, { text: '하나' })).chat.chatId, 'result');
    const m2 = manager(s, s.fake.env({ script: file, extra: { CLAUDE_CONFIG_DIR: path.join(s.root, '다른 설정') } }));
    await waitEvent(m2, (await m2.start(s.project, { text: '둘' })).chat.chatId, 'result');
    const calls = s.fake.argsCalls();
    expect(calls).toHaveLength(2);
    expect(pair(calls[0].args)).toEqual(['--allowedTools', RULE]);
    expect(pair(calls[1].args)).toBeNull();
  });

  it('PATH 에 claude 가 없으면 400', async () => {
    const s = setup();
    const m = manager(s, { ...s.fake.env(), PATH: path.join(s.root, '빈 PATH') });
    await expect(m.start(s.project, { text: '안녕' })).rejects.toThrow(/PATH/);
  });

  it('JSON 이 아닌 줄·모르는 type 은 무시한다', async () => {
    const s = setup();
    const file = path.join(s.root, 'junk.jsonl');
    writeScript(file, [...HELLO, { dir: 'out', msg: '이건 JSON 객체가 아님' }, { dir: 'out', msg: { type: 'mystery', x: 1 } }, { dir: 'out', msg: INIT('2.1.323') }, { dir: 'out', msg: RESULT }, { dir: 'exit', code: 0 }]);
    const m = manager(s, s.fake.env({ script: file }));
    const id = (await m.start(s.project, { text: '안녕' })).chat.chatId;
    const r = await waitEvent(m, id, 'result');
    expect(r.text).toBe('끝');
  });
});

// SSE 응답을 count 개 이벤트까지 읽는다
function readSse(base: string, url: string, count: number): Promise<{ headers: http.IncomingHttpHeaders; events: { id: number; data: any }[] }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      let buf = '';
      const evs: { id: number; data: any }[] = [];
      const t = setTimeout(() => { req.destroy(); resolve({ headers: res.headers, events: evs }); }, 3000);
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const id = /^id: (\d+)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          if (id && data) evs.push({ id: Number(id[1]), data: JSON.parse(data[1]) });
        }
        if (evs.length >= count) { clearTimeout(t); req.destroy(); resolve({ headers: res.headers, events: evs }); }
      });
    });
    req.on('error', (e: any) => { if (e.code !== 'ECONNRESET') reject(e); });
  });
}

describe('라우트', () => {
  it('POST·GET chats, SSE 재생(after=N, 끝난 text-delta 없음), 헤더, 403·404', async () => {
    const s = setup();
    const env = s.fake.env({ script: rec('02-resume.jsonl') });
    const chats = createChatManager({ cfgDir: s.cfgDir, env, closeWaitMs: 3000 });
    managers.push(chats);
    const live: ChatEvent[] = [];
    chats.onEvent((_c, e) => live.push(e));
    const srv = await inProcess({ cfgDir: s.cfgDir, env, chats });
    try {
      const add = await srv.call('POST', '/api/projects', { kind: 'local', path: s.project.path });
      expect(add.status).toBe(201);
      const pid = add.body.id;

      // X-Plenum 없는 POST 403
      for (const p of [`/api/projects/${pid}/chats`, '/api/chats/x/send', '/api/chats/x/respond', '/api/chats/x/interrupt', '/api/chats/x/close']) {
        const r = await fetch(srv.base + p, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"text":"안녕"}' });
        expect(r.status, p).toBe(403);
      }
      expect(s.fake.argsCalls()).toHaveLength(0);

      const st = await srv.call('POST', `/api/projects/${pid}/chats`, { text: 'Which file?', model: 'haiku' });
      expect(st.status).toBe(201);
      expect(st.body.warnings).toEqual([]);
      const chatId = st.body.chat.chatId;
      expect((await srv.call('GET', `/api/projects/${pid}/chats`)).body.map((c: any) => c.chatId)).toEqual([chatId]);
      expect((await srv.call('POST', `/api/projects/없음/chats`, { text: 'x' })).status).toBe(404);
      await waitEvent(chats, chatId, 'state', (e) => e.state === 'idle');

      // 실시간으로는 text-delta 가 왔다
      const deltas = live.filter((e) => e.type === 'text-delta');
      expect(deltas.length).toBe(2);
      const lastSeq = chats.get(chatId)!.lastSeq;
      const all = await readSse(srv.base, `/api/chats/${chatId}/events?after=0`, lastSeq - deltas.length);
      expect(all.headers['content-type']).toBe('text/event-stream; charset=utf-8');
      expect(all.headers['cache-control']).toBe('no-store');
      expect(Object.keys(all.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
      expect(all.events.some((e) => e.data.type === 'text-delta')).toBe(false);
      expect(all.events.some((e) => e.data.type === 'assistant-text' && e.data.text === 'a.txt')).toBe(true);
      expect(all.events.map((e) => e.id)).toEqual(all.events.map((e) => e.data.seq));
      expect(all.events.at(-1)!.id).toBe(lastSeq);

      const n = all.events[3].id;
      const tail = await readSse(srv.base, `/api/chats/${chatId}/events?after=${n}`, all.events.length - 4);
      expect(tail.events.map((e) => e.id)).toEqual(all.events.slice(4).map((e) => e.id));
      expect(tail.events[0].id).toBeGreaterThan(n);

      // 그 밖 라우트
      expect((await srv.call('GET', '/api/limits')).body.limits.fiveHour.pct).toBe(4);
      expect((await srv.call('GET', '/api/chats/없음/events')).status).toBe(404);
      expect((await srv.call('POST', '/api/chats/없음/send', { text: 'x' })).status).toBe(404);
      expect((await srv.call('POST', `/api/chats/${chatId}/respond`, { requestId: 'x', action: 'allow' })).status).toBe(404);
      const sent = await srv.call('POST', `/api/chats/${chatId}/send`, { text: '하나 더' });
      expect(sent.status).toBe(200);
      expect(sent.body.ok).toBe(true);
      expect((await srv.call('POST', `/api/chats/${chatId}/interrupt`)).status).toBe(200);
      const closed = await srv.call('POST', `/api/chats/${chatId}/close`);
      expect(closed.status).toBe(200);
      expect(closed.body.state).toBe('ended');
      expect((await srv.call('POST', `/api/chats/${chatId}/send`, { text: 'x' })).status).toBe(409);
      expect((await srv.call('GET', `/api/projects/${pid}/chats`)).body).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it('409 본문 reason: awaiting-card(chatId 포함)·terminal-open·card-answered·chat-ended, 채팅 밖 409 는 reason 없음', async () => {
    const s = setup();
    const sid = 'b5b49096-5604-499f-a80b-49f35d8d09bb';
    const term = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const file = path.join(s.root, 'waiting.jsonl');
    writeScript(file, [...HELLO, { dir: 'out', msg: INIT('2.1.323', sid) },
      { dir: 'out', msg: { type: 'control_request', request_id: 'r-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, permission_suggestions: [] } } },
      { dir: 'in', msg: { type: 'control_response', response: { request_id: 'r-1' } } }, { dir: 'exit', code: 0 }]);
    const env = s.fake.env({ script: file });
    const chats = manager(s, env, { terminalAlive: (x) => x === term });
    const srv = await inProcess({ cfgDir: s.cfgDir, env, chats });
    try {
      const pid = (await srv.call('POST', '/api/projects', { kind: 'local', path: s.project.path })).body.id;
      const dup = await srv.call('POST', '/api/projects', { kind: 'local', path: s.project.path });
      expect(dup.status).toBe(409);
      expect(Object.keys(dup.body)).toEqual(['error']);
      const chatId = (await srv.call('POST', `/api/projects/${pid}/chats`, { text: '처음' })).body.chat.chatId;
      await waitEvent(chats, chatId, 'card');

      const busy = await srv.call('POST', `/api/projects/${pid}/chats`, { text: '버려지면 안 되는 글', resume: sid });
      expect(busy.status).toBe(409);
      expect(busy.body).toEqual({ error: expect.stringContaining('답을 기다리는 카드가 있다'), reason: 'awaiting-card', chatId });

      const t = await srv.call('POST', `/api/projects/${pid}/chats`, { text: '이어', resume: term });
      expect(t.status).toBe(409);
      expect(t.body).toEqual({ error: expect.stringContaining('터미널'), reason: 'terminal-open' });

      expect((await srv.call('POST', `/api/chats/${chatId}/respond`, { requestId: 'r-1', action: 'allow' })).status).toBe(200);
      const again = await srv.call('POST', `/api/chats/${chatId}/respond`, { requestId: 'r-1', action: 'allow' });
      expect(again.status).toBe(409);
      expect(again.body).toEqual({ error: '이미 답한 카드', reason: 'card-answered' });

      expect((await srv.call('POST', `/api/chats/${chatId}/close`)).status).toBe(200);
      const ended = await srv.call('POST', `/api/chats/${chatId}/send`, { text: 'x' });
      expect(ended.status).toBe(409);
      expect(ended.body).toEqual({ error: expect.stringContaining('채팅이 끝났다'), reason: 'chat-ended' });
    } finally {
      await srv.close();
    }
  });
});

describe('끝난 채팅·훅 (지난 세션 running, 작동 중)', () => {
  const S01 = 'b5b49096-5604-499f-a80b-49f35d8d09bb';
  it('채팅 → close 면 running null, 그 뒤 터미널 훅 SessionStart 면 terminal(작동 중에도 잡힘), SessionEnd 면 null. PLENUM_NOTIFY 는 채팅 claude 에만', async () => {
    const s = setup();
    // 진짜 기록(01 세션)을 이 프로젝트 cwd 로 옮긴 세션 파일
    const home = path.join(s.root, '.claude 홈');
    const src = path.join(APP, 'test', 'fixtures', 'history', 'projects', '-tmp-plenum-rec-----AbCdEg', `${S01}.jsonl`);
    const ls = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((l) => (typeof l.cwd === 'string' ? { ...l, cwd: s.project.path } : l));
    fs.mkdirSync(path.join(home, 'projects', 'x'), { recursive: true });
    fs.writeFileSync(path.join(home, 'projects', 'x', `${S01}.jsonl`), ls.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const file = path.join(s.root, 'idle.jsonl');
    writeScript(file, [...HELLO, { dir: 'out', msg: INIT('2.1.323', S01) }, { dir: 'out', msg: RESULT }, { dir: 'in', msg: { type: 'user' } }, { dir: 'exit', code: 0 }]);
    // 테스트를 돌리는 env 에 PLENUM_NOTIFY 가 있어도(예: PLENUM_NOTIFY=0 npx vitest) 서버 env 에는 없게 만든다
    const env = s.fake.env({ script: file });
    delete env.PLENUM_NOTIFY;
    expect(env.PLENUM_NOTIFY).toBeUndefined();
    const chats = createChatManager({ cfgDir: s.cfgDir, env, closeWaitMs: 3000 });
    managers.push(chats);
    const srv = await inProcess({ cfgDir: s.cfgDir, env, chats, claudeHome: home });
    try {
      const pid = (await srv.call('POST', '/api/projects', { kind: 'local', path: s.project.path })).body.id;
      const running = async () => (await srv.call('GET', `/api/projects/${pid}/sessions`)).body.find((x: any) => x.id === S01)?.running;
      const hook = (event: string, extra: Record<string, unknown> = {}) => srv.call('POST', '/api/hook', { event, session_id: S01, cwd: s.project.path, ...extra });
      const terminalWorkers = async () => (await srv.call('GET', `/api/projects/${pid}/activity`)).body.sessions.filter((x: any) => x.source === 'terminal').flatMap((x: any) => x.workers.map((w: any) => w.id));

      const chatId = (await srv.call('POST', `/api/projects/${pid}/chats`, { text: '안녕' })).body.chat.chatId;
      await waitEvent(chats, chatId, 'state', (e) => e.state === 'idle');
      expect(await running()).toBe('chat');
      // 채팅 claude 만 PLENUM_NOTIFY=0 을 받았다. 서버 env 는 그대로(터미널로 열기는 terminal.test 에서 본다)
      expect(s.fake.argsCalls()[0].notify).toBe('0');
      expect(env.PLENUM_NOTIFY).toBeUndefined();
      expect(chatEnv(env).PLENUM_NOTIFY).toBe('0');
      expect(env.PLENUM_NOTIFY).toBeUndefined();

      expect((await srv.call('POST', `/api/chats/${chatId}/close`)).body.state).toBe('ended');
      expect(chats.findBySession(S01)).toBeNull();
      expect(await running()).toBeNull();

      // 같은 세션을 터미널에서 이어 열면 훅이 그대로 온다
      expect((await hook('SessionStart', { source: 'resume' })).body).toEqual({ ok: true });
      expect((await hook('SubagentStart', { agent_type: 'Explore', agent_id: 'a1' })).body).toEqual({ ok: true });
      expect(await running()).toBe('terminal');
      expect(await terminalWorkers()).toEqual(['a1']);
      await hook('SessionEnd', { reason: 'prompt_input_exit' });
      expect(await running()).toBeNull();
      expect(await terminalWorkers()).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it('라우트: 리셋 시각 모르는 한도면 새 채팅 201·send 200 + 경고(막지 않음)', async () => {
    const s = setup();
    const file = path.join(s.root, 'idle.jsonl');
    writeScript(file, [...HELLO, { dir: 'out', msg: INIT('2.1.323') }, { dir: 'out', msg: RESULT }, { dir: 'in', msg: { type: 'user' } }, { dir: 'out', msg: RESULT }, { dir: 'in', msg: { type: 'user' } }, { dir: 'exit', code: 0 }]);
    const env = s.fake.env({ script: file });
    const lim = (resetsAt: number | null) => ({ receivedAt: Date.now(), fiveHour: { pct: 100, resetsAt, status: 'rejected' }, rejected: { window: 'five_hour', resetsAt } });
    saveLimits(s.cfgDir, lim(null) as any);
    const chats = createChatManager({ cfgDir: s.cfgDir, env, closeWaitMs: 3000 });
    managers.push(chats);
    const srv = await inProcess({ cfgDir: s.cfgDir, env, chats });
    try {
      const pid = (await srv.call('POST', '/api/projects', { kind: 'local', path: s.project.path })).body.id;
      const st = await srv.call('POST', `/api/projects/${pid}/chats`, { text: '안녕' });
      expect(st.status).toBe(201);
      expect(st.body.warnings).toEqual([LIMIT_UNKNOWN_RESET]);
      const chatId = st.body.chat.chatId;
      await waitEvent(chats, chatId, 'state', (e) => e.state === 'idle');
      const ok = await srv.call('POST', `/api/chats/${chatId}/send`, { text: '또' });
      expect(ok.status).toBe(200);
      expect(ok.body.warnings).toEqual([LIMIT_UNKNOWN_RESET]);
    } finally {
      await srv.close();
    }
  });
});

describe('워커 모델 (kit 워커 정의)', () => {
  it('subagent_type 의 플러그인 접두어를 떼고 kit 워커 이름으로 찾는다 (jh-kit:w-implement-lite → haiku)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), '홍길동 테스트-'));
    const repo = path.join(root, 'jh kit');
    copyDir(FIXTURE_KIT, path.join(repo, 'kit'));
    const impl = fs.readFileSync(path.join(repo, 'kit', 'workers', 'impl.md'), 'utf8');
    fs.writeFileSync(path.join(repo, 'kit', 'workers', 'w-implement-lite.md'), impl.replace('name: impl', 'name: w-implement-lite').replace('model: sonnet', 'model: haiku'));
    const ky = path.join(repo, 'kit', 'kit.yaml');
    fs.writeFileSync(ky, fs.readFileSync(ky, 'utf8').replace('worker_order: [rev, impl]', '  - tier: Haiku medium\n    label: "Haiku medium"\n    role: "구현"\nworker_order: [rev, impl, w-implement-lite]'));
    const cfgDir = path.join(root, '설정');
    saveConfig({ ...defaultConfig(), kitRepoPath: repo }, cfgDir);
    expect(readKit(repo).ok).toBe(true);
    expect(workerModel(cfgDir, 'jh-kit:w-implement-lite')).toBe('haiku');
    expect(workerModel(cfgDir, 'w-implement-lite')).toBe('haiku');
    expect(workerModel(cfgDir, 'other-plugin:impl')).toBe('sonnet');
    expect(workerModel(cfgDir, 'general-purpose')).toBeNull(); // 녹화 04 의 내장 에이전트
    expect(workerModel(cfgDir, '')).toBeNull();
  });
});

describe('--effort 지원 감지', () => {
  it('도움말에 --effort 가 있으면 effort: true, 같은 경로·버전은 캐시', async () => {
    const s = setup();
    const env = s.fake.env({ version: '2.1.300' });
    const { claudeCaps } = await import('../server/claudecaps.ts');
    expect(await claudeCaps(env)).toEqual({ found: true, version: '2.1.300', effort: true });
    // 캐시: 도움말이 바뀌어도 같은 경로·버전이면 다시 묻지 않는다
    expect(await claudeCaps({ ...env, FAKE_CLAUDE_HELP_EFFORT: '0' })).toEqual({ found: true, version: '2.1.300', effort: true });
    expect(await claudeCaps({ ...env, PATH: path.join(s.root, '빈 PATH') })).toEqual({ found: false, version: null, effort: false });
  });

  it('도움말에 --effort 가 없으면 effort: false, effort 를 넣은 start 는 400 (없으면 시작)', async () => {
    const s = setup();
    const file = path.join(s.root, 'ok.jsonl');
    writeScript(file, [...HELLO, { dir: 'out', msg: INIT('2.1.248') }, { dir: 'out', msg: RESULT }, { dir: 'exit', code: 0 }]);
    const env = s.fake.env({ script: file, version: '2.1.248', helpEffort: false });
    const chats = createChatManager({ cfgDir: s.cfgDir, env, closeWaitMs: 3000 });
    managers.push(chats);
    const srv = await inProcess({ cfgDir: s.cfgDir, env, chats });
    try {
      // claude --version 을 띄우는 GET 이라 X-Plenum 필수
      expect((await srv.call('GET', '/api/claude/capabilities')).status).toBe(403);
      expect((await srv.call('GET', '/api/claude/capabilities', undefined, { 'X-Plenum': '1' })).body).toEqual({ found: true, version: '2.1.248', effort: false });
      const pid = (await srv.call('POST', '/api/projects', { kind: 'local', path: s.project.path })).body.id;
      const bad = await srv.call('POST', `/api/projects/${pid}/chats`, { text: '안녕', effort: 'high' });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toContain('--effort 가 없다');
      expect(s.fake.argsCalls()).toHaveLength(0);
      const ok = await srv.call('POST', `/api/projects/${pid}/chats`, { text: '안녕', model: 'haiku' });
      expect(ok.status).toBe(201);
      await waitEvent(chats, ok.body.chat.chatId, 'result');
      expect(s.fake.argsCalls()[0].args).not.toContain('--effort');
    } finally {
      await srv.close();
    }
  });
});
