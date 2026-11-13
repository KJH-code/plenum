// 지난 세션 목록·기록 (server/history.ts). 진짜 기록 fixture 를 한글·공백 이름 임시 폴더로 복사해서 쓴다.
// fixture: test/fixtures/history/projects (claude 2.1.323). AbCdEf 폴더 세션 5개 + 하위 에이전트, AbCdEg 폴더 1개(stream 01-cards·02-resume 세션).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listSessions, readTranscript, type HistoryOptions } from '../server/history.ts';
import { APP, copyDir, inProcess } from './helpers.ts';

const FIX = path.join(APP, 'test', 'fixtures', 'history');
const F = '/tmp/plenum-rec-홍길동-AbCdEf';
const G = '/tmp/plenum-rec-홍길동-AbCdEg';
const DIR_F = '-tmp-plenum-rec-----AbCdEf';
const DIR_G = '-tmp-plenum-rec-----AbCdEg';
const S279 = '279fe3c2-3715-4f89-ac82-284e5c2f6842';
const S2959 = '2959b2b6-a31f-48da-9570-a6e50a9ab788';
const S4b6b = '4b6b568b-6d83-4d93-ba05-7c608b2d16f6';
const S76d6 = '76d66e6d-7e81-487d-a7c2-fa2fbb3bb61c';
const S9b9b = '9b9b276d-f1e7-4c81-82c9-d87128a70e31';
const S01 = 'b5b49096-5604-499f-a80b-49f35d8d09bb';

let root: string;
let home: string;
let cfgDir: string;
const opts = (more: Partial<HistoryOptions> = {}): HistoryOptions => ({ claudeHome: home, cfgDir, ...more });

function lines(file: string): any[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function writeLines(file: string, ls: any[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ls.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}
// 진짜 세션 파일을 다른 sid 로 복사(줄의 sessionId 도 바꿈). edit 로 줄을 고친다
function cloneSession(srcDir: string, srcSid: string, dstDir: string, dstSid: string, edit: (ls: any[]) => any[] = (x) => x) {
  const ls = lines(path.join(FIX, 'projects', srcDir, `${srcSid}.jsonl`)).map((l) => (l.sessionId ? { ...l, sessionId: dstSid } : l));
  writeLines(path.join(home, 'projects', dstDir, `${dstSid}.jsonl`), edit(ls));
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), '홍길동 테스트-'));
  home = path.join(root, '.claude 홈');
  cfgDir = path.join(root, '설정');
  copyDir(path.join(FIX, 'projects'), path.join(home, 'projects'));
  fs.mkdirSync(cfgDir, { recursive: true });
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('listSessions — 진짜 기록', () => {
  it('AbCdEf: 세션 5개 모두, 하위 에이전트 jsonl 은 세션이 아님, 값이 파일과 맞음', async () => {
    const list = await listSessions(F, opts());
    // lastAt 내림차순
    expect(list.map((s) => s.id)).toEqual([S9b9b, S4b6b, S76d6, S2959, S279]);
    expect(list.some((s) => s.id.startsWith('agent-'))).toBe(false);
    const by = Object.fromEntries(list.map((s) => [s.id, s]));

    // 279fe3c2: 0줄 queue-operation 02:02:52.396Z(첫 timestamp), 49줄 assistant "a.txt" 02:03:02.119Z(마지막 timestamp — 50~52줄은 timestamp 없음)
    // 사람 2줄(2줄 "No mode questions…", 44줄 "Which file did I choose earlier? One word.") + 글 있는 assistant id 2개(39줄 msg_011Cgz73KERz…, 49줄 msg_011Cgz73d7xa…)
    expect(by[S279]).toMatchObject({ titleSource: 'first', startedAt: '2026-11-13T02:02:52.396Z', lastAt: '2026-11-13T02:03:02.119Z', messages: 4, mode: null, running: null });
    expect(by[S279].title.startsWith('No mode questions, do not use Skill. Steps: 1) AskUserQuestion once:')).toBe(true);
    expect(Array.from(by[S279].title).length).toBe(80);
    // 2959b2b6: 사람 1(2줄) + 글 id 2(20줄 msg_011Cgz73t6cN…, 42줄 msg_011Cgz74Ru3g…). 끝 = 42줄 02:03:13.419Z (41줄 attachment 13.420 이 앞에 있지만 나온 순서로 끝)
    expect(by[S2959]).toMatchObject({ title: 'README.md 첫 줄을 "# fake project" 로 바꿔줘', startedAt: '2026-11-13T02:03:04.602Z', lastAt: '2026-11-13T02:03:13.419Z', messages: 3 });
    // 4b6b568b: 사람 2(2줄 질문, 18줄 "[Request interrupted by user]" text 블록), assistant 없음
    expect(by[S4b6b]).toMatchObject({ title: 'No mode questions. Write a 600 word story about a robot, slowly.', startedAt: '2026-11-13T02:03:45.442Z', lastAt: '2026-11-13T02:03:47.851Z', messages: 2 });
    // 76d66e6d: 사람 1(2줄. 22·25줄은 toolUseResult 있는 tool_result) + 글 id 1(34줄 "ALL DONE")
    expect(by[S76d6]).toMatchObject({ startedAt: '2026-11-13T02:03:16.344Z', lastAt: '2026-11-13T02:03:22.072Z', messages: 2 });
    // 9b9b276d: 2줄 <command-message> 로 시작하는 스킬 호출(빼지 않음), 3줄은 isMeta. 글 id 1(67줄)
    expect(by[S9b9b]).toMatchObject({ startedAt: '2026-11-13T02:03:48.997Z', lastAt: '2026-11-13T02:04:06.248Z', messages: 2 });
    expect(by[S9b9b].title).toBe('/jh-kit:start 테스트용 빈 레포 확인만'); // 태그 대신 "/이름 인자"
  });

  it('AbCdEg: 01 세션 하나', async () => {
    const list = await listSessions(G, opts());
    // 사람 2(2·49줄) + 글 id 2(44줄 msg_011Cgz7Ej3x…, 53줄 msg_011Cgz7F99o…)
    expect(list).toEqual([expect.objectContaining({ id: S01, startedAt: '2026-11-13T02:05:24.240Z', lastAt: '2026-11-13T02:05:38.516Z', messages: 4 })]);
  });

  it('폴더 이름이 같아도 cwd 가 다르면 섞이지 않는다', async () => {
    const sid = 'b5b49096-0000-4000-8000-0000000000aa';
    cloneSession(DIR_G, S01, DIR_F, sid); // cwd 는 AbCdEg 그대로, 폴더는 AbCdEf
    try {
      expect((await listSessions(F, opts())).map((s) => s.id)).not.toContain(sid);
      expect((await listSessions(G, opts())).map((s) => s.id)).toContain(sid);
    } finally { fs.rmSync(path.join(home, 'projects', DIR_F, `${sid}.jsonl`)); }
  });

  // 4b6b568b: 사람 줄은 2줄(질문)·18줄("[Request interrupted by user]") 둘. 명령 줄 = <command-name> 으로 시작하는 사람 메시지
  const USAGE = '<command-name>/usage</command-name>\n<command-message>usage</command-message>\n<command-args></command-args>';
  const MODEL = '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>';
  const asText = (l: any, content: string) => ({ ...l, message: { ...l.message, content } });

  it('명령 줄만 있는 세션(/usage 만)은 목록에서 뺀다', async () => {
    const sid = '4b6b568b-0000-4000-8000-0000000000bb';
    // 2줄을 /usage 로, 18줄(다른 사람 줄)은 지운다 → 진짜 사람 메시지 0
    cloneSession(DIR_F, S4b6b, DIR_F, sid, (ls) => ls.map((l, i) => (i === 2 ? asText(l, USAGE) : l)).filter((_l, i) => i !== 18));
    try {
      expect((await listSessions(F, opts())).map((s) => s.id)).not.toContain(sid);
    } finally { fs.rmSync(path.join(home, 'projects', DIR_F, `${sid}.jsonl`)); }
  });

  it('명령 줄(/model) 뒤 진짜 질문이 있으면 목록에 있고 제목은 그 질문', async () => {
    const sid = '4b6b568b-0000-4000-8000-0000000000be';
    // [/model, "버그 고쳐줘", (18줄)] — 2줄을 /model 로 바꾸고 바로 뒤에 같은 모양의 사람 줄을 넣는다
    cloneSession(DIR_F, S4b6b, DIR_F, sid, (ls) => ls.flatMap((l, i) => (i === 2 ? [asText(l, MODEL), asText({ ...l, uuid: 'u-bug' }, '버그 고쳐줘')] : [l])));
    try {
      expect((await listSessions(F, opts())).find((s) => s.id === sid)).toMatchObject({ title: '버그 고쳐줘', titleSource: 'first' });
    } finally { fs.rmSync(path.join(home, 'projects', DIR_F, `${sid}.jsonl`)); }
  });

  it('지난 기록: 명령 줄은 "/model"(인자 있으면 "/이름 인자") 한 줄, 명령 출력 줄은 건너뜀, XML 없음', async () => {
    const sid = '4b6b568b-0000-4000-8000-0000000000bf';
    const STDOUT = '<local-command-stdout>Set model to claude-opus-5-5</local-command-stdout>';
    const STDERR = '<local-command-stderr>오류</local-command-stderr>';
    const MODEL_ARG = '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>haiku</command-args>';
    // [/model, stdout, "버그 고쳐줘", /model haiku, stderr, (18줄)]
    cloneSession(DIR_F, S4b6b, DIR_F, sid, (ls) => ls.flatMap((l, i) => (i === 2 ? [
      asText(l, MODEL), asText({ ...l, uuid: 'u-out' }, STDOUT), asText({ ...l, uuid: 'u-bug' }, '버그 고쳐줘'),
      asText({ ...l, uuid: 'u-m2' }, MODEL_ARG), asText({ ...l, uuid: 'u-err' }, STDERR),
    ] : [l])));
    try {
      const users = (await readTranscript(F, sid, opts())).filter((x) => x.type === 'user').map((x: any) => x.text);
      expect(users.slice(0, 3)).toEqual(['/model', '버그 고쳐줘', '/model haiku']);
      expect(users.some((t) => /<\/?[a-z-]+>/.test(t))).toBe(false);
    } finally { fs.rmSync(path.join(home, 'projects', DIR_F, `${sid}.jsonl`)); }
  });

  it('ai-title 이 있으면 제목, custom-title 이 있으면 그게 우선', async () => {
    const sid = '76d66e6d-0000-4000-8000-0000000000cc';
    const file = path.join(home, 'projects', DIR_F, `${sid}.jsonl`);
    cloneSession(DIR_F, S76d6, DIR_F, sid, (ls) => [...ls, { type: 'ai-title', aiTitle: '하위 에이전트 두 개 실행', sessionId: sid }]);
    try {
      expect((await listSessions(F, opts())).find((s) => s.id === sid)).toMatchObject({ title: '하위 에이전트 두 개 실행', titleSource: 'ai' });
      fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: '내가 붙인 이름', sessionId: sid }) + '\n');
      fs.appendFileSync(file, JSON.stringify({ type: 'ai-title', aiTitle: '나중 AI 제목', sessionId: sid }) + '\n');
      expect((await listSessions(F, opts())).find((s) => s.id === sid)).toMatchObject({ title: '내가 붙인 이름', titleSource: 'ai' });
    } finally { fs.rmSync(file); }
  });

  it('Windows: 대소문자·끝 구분자 무시, 한글 이름이 다르면 다른 프로젝트', async () => {
    const sid = '2959b2b6-0000-4000-8000-0000000000dd';
    const dir = 'C--Users-----Proj';
    cloneSession(DIR_F, S2959, dir, sid, (ls) => ls.map((l) => (typeof l.cwd === 'string' ? { ...l, cwd: 'c:\\users\\홍길동\\proj\\' } : l)));
    try {
      expect((await listSessions('C:\\Users\\홍길동\\Proj', opts({ platform: 'win32' }))).map((s) => s.id)).toEqual([sid]);
      expect(await listSessions('C:\\Users\\김철수\\Proj', opts({ platform: 'win32' }))).toEqual([]);
    } finally { fs.rmSync(path.join(home, 'projects', dir), { recursive: true }); }
  });

  it('mode: sessions.json 이 먼저, 없으면 Skill 호출, 둘 다 없으면 null', async () => {
    const sid = '279fe3c2-0000-4000-8000-0000000000ee';
    // 39줄(assistant 글 줄)을 본떠 Skill tool_use 줄을 덧붙인다
    cloneSession(DIR_F, S279, DIR_F, sid, (ls) => [...ls, { ...ls[39], uuid: '00000000-0000-4000-8000-0000000000ef', message: { ...ls[39].message, id: 'msg_skill', content: [{ type: 'tool_use', id: 'toolu_skill', name: 'Skill', input: { skill: 'jh-kit:orchestrate' } }] } }]);
    fs.writeFileSync(path.join(cfgDir, 'sessions.json'), JSON.stringify({ [S2959]: { mode: '강화' } }));
    try {
      const by = Object.fromEntries((await listSessions(F, opts())).map((s) => [s.id, s]));
      expect(by[S2959].mode).toBe('강화');
      expect(by[sid].mode).toBe('기본');
      expect(by[S279].mode).toBe(null);
      fs.writeFileSync(path.join(cfgDir, 'sessions.json'), JSON.stringify({ [sid]: { mode: '최대' } }));
      expect((await listSessions(F, opts())).find((s) => s.id === sid)!.mode).toBe('최대');
    } finally {
      fs.rmSync(path.join(home, 'projects', DIR_F, `${sid}.jsonl`));
      fs.rmSync(path.join(cfgDir, 'sessions.json'));
    }
  });

  it('running 은 runningOf 결과, 기록 폴더가 없으면 빈 목록', async () => {
    const list = await listSessions(F, opts({ runningOf: (s) => (s === S279 ? 'chat' : null) }));
    expect(list.find((s) => s.id === S279)!.running).toBe('chat');
    expect(list.find((s) => s.id === S2959)!.running).toBe(null);
    expect(await listSessions(F, opts({ claudeHome: path.join(root, '없음') }))).toEqual([]);
  });

  it('JSON 이 아닌 줄은 건너뛴다', async () => {
    const sid = '4b6b568b-0000-4000-8000-0000000000ff';
    const file = path.join(home, 'projects', DIR_F, `${sid}.jsonl`);
    cloneSession(DIR_F, S4b6b, DIR_F, sid);
    fs.appendFileSync(file, '{깨진 줄\n\n');
    try {
      expect((await listSessions(F, opts())).find((s) => s.id === sid)).toMatchObject({ messages: 2, lastAt: '2026-11-13T02:03:47.851Z' });
    } finally { fs.rmSync(file); }
  });
});

describe('readTranscript', () => {
  it('01 세션: 질문 답 → 도구 → rm 거부 순서', async () => {
    const t = await readTranscript(G, S01, opts());
    // 2줄 사람 → 20줄 AskUserQuestion(21줄 answers "a.txt (Recommended)") → 27·29·33·36줄 Bash 4번 → 37줄 rm 거부(permissionDecision user_reject)
    // → 40줄 Bash ls → 44줄 글 → 49줄 사람 → 53줄 글
    expect(t.map((x) => x.type)).toEqual(['user', 'answered', 'tools', 'answered', 'tools', 'assistant-text', 'user', 'assistant-text']);
    // 접두어 없이 내용만, outcome 으로 구분(화면이 "답함: "·"거부함: " 을 붙인다)
    expect(t[1]).toEqual({ type: 'answered', kind: 'question', summary: 'a.txt', outcome: 'answered' });
    expect(t[2]).toEqual({ type: 'tools', names: ['Bash'], count: 4 });
    expect(t[3]).toEqual({ type: 'answered', kind: 'permission', summary: 'Bash rm a.txt', outcome: 'denied' });
    expect(t[4]).toEqual({ type: 'tools', names: ['Bash'], count: 1 });
    expect(t[6]).toEqual({ type: 'user', text: 'Which file did I choose earlier? One word.', at: '2026-11-13T02:05:37.477Z' });
    expect(t[7]).toEqual({ type: 'assistant-text', text: 'a.txt', at: '2026-11-13T02:05:38.516Z' });
  });

  it('승인된 rm 은 거부로 안 보이고, 답 없이 막힌 승인(stream closed)도 거부로 안 친다', async () => {
    const a = await readTranscript(F, S279, opts()); // 36줄 rm a.txt 는 승인돼 실행됨
    expect(a.filter((x) => x.type === 'answered').map((x: any) => x.kind)).toEqual(['question']);
    const b = await readTranscript(F, S9b9b, opts()); // 21·34·44·51줄 is_error, permissionDecision source config + toolDenialUnanswered
    expect(b.some((x) => x.type === 'answered')).toBe(false);
    expect(b.filter((x) => x.type === 'tools').map((x: any) => x.names)).toEqual([['Bash', 'Read']]);
  });

  it('모드 질문 답, 연속 도구 이름은 순서 유지 중복 제거', async () => {
    const t = await readTranscript(F, S2959, opts());
    expect(t.map((x) => x.type)).toEqual(['user', 'assistant-text', 'answered', 'tools', 'assistant-text']);
    expect(t[2]).toEqual({ type: 'answered', kind: 'question', summary: '모드 없음', outcome: 'answered' });
    expect(t[3]).toEqual({ type: 'tools', names: ['Bash', 'Read', 'Edit'], count: 3 });
  });

  it('잘못된 sid 400, 다른 프로젝트 세션은 404', async () => {
    await expect(readTranscript(F, '../x', opts())).rejects.toMatchObject({ status: 400 });
    await expect(readTranscript(F, S01, opts())).rejects.toMatchObject({ status: 404 });
  });
});

describe('라우트', () => {
  it('목록·기록·404·400, access-control 헤더 없음', async () => {
    const cfg = path.join(root, '서버 설정');
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ version: 1, projects: [{ id: 'p1', name: 'rec', path: F, source: 'local' }] }));
    const srv = await inProcess({ cfgDir: cfg, env: { ...process.env, CLAUDE_CONFIG_DIR: home } });
    try {
      const get = async (url: string) => {
        const r = await fetch(srv.base + url);
        const keys = [...r.headers.keys()].filter((k) => k.toLowerCase().startsWith('access-control-'));
        return { status: r.status, body: await r.json() as any, acHeaders: keys };
      };
      const list = await get('/api/projects/p1/sessions');
      expect(list.status).toBe(200);
      expect(list.body.map((s: any) => s.id)).toEqual([S9b9b, S4b6b, S76d6, S2959, S279]);
      const tr = await get(`/api/projects/p1/sessions/${S279}/transcript`);
      expect(tr.status).toBe(200);
      expect(tr.body[0]).toMatchObject({ type: 'user' });
      const noProj = await get('/api/projects/nope/sessions');
      expect(noProj.status).toBe(404);
      const badSid = await get('/api/projects/p1/sessions/not-a-uuid/transcript');
      expect(badSid.status).toBe(400);
      const otherSid = await get(`/api/projects/p1/sessions/${S01}/transcript`);
      expect(otherSid.status).toBe(404);
      for (const r of [list, tr, noProj, badSid, otherSid]) expect(r.acHeaders).toEqual([]);
    } finally { await srv.close(); }
  });
});

it('스킬로 시작한 첫 질문은 "/이름 인자" 로 보인다', async () => {
  const { promptLabel } = await import('../server/history.ts');
  expect(promptLabel('<command-message>jh-kit:start</command-message>\n<command-name>/jh-kit:start</command-name>\n<command-args>Plenum 3단계</command-args>')).toBe('/jh-kit:start Plenum 3단계');
  expect(promptLabel('그냥 질문')).toBe('그냥 질문');
});
