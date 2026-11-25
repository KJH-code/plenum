// "이 세션 동안 허용"을 Plenum 이 기억해서 같은 명령을 대신 허용한다(D안). 키 = (도구, 명령 글자 그대로, 작업 폴더#세대).
// 드라이버 단위(a~i) + 채팅 매니저(가짜 claude) + 카드 렌더.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { changesDirectory, createClaudeDriver } from '../server/provider/claude.ts';
import type { ProviderEvent, Raw } from '../server/provider/events.ts';
import { createChatManager, type ChatManager } from '../server/chat.ts';
import type { Card, ChatEvent } from '../server/chatTypes.ts';
import { PermissionCard, resolvedText } from '../web/src/Cards.tsx';
import { applyEvent, emptyView } from '../web/src/Chat.tsx';
import { makeFakeStreamClaude, writeScript } from './fakeclaudeStream.ts';

const raw = (m: unknown): Raw => ({ provider: 'claude', version: '2.1.248', channel: 'stdout', text: JSON.stringify(m) });
const INIT = (cwd?: string) => ({ type: 'system', subtype: 'init', session_id: 's-1', claude_code_version: '2.1.248', model: 'claude-haiku', permissionMode: 'default', ...(cwd !== undefined ? { cwd } : {}) });
const PS_A = 'New-Item -ItemType File -Force .\\ps-a.txt';
const WORK = 'C:\\Users\\홍길동\\AppData\\Local\\Temp\\plenum-rec-홍길동-AbCdEf\\proj';
// Windows 2.1.248 ⓐ: 폴더 안 쓰기 → addDirectories + setMode 만, addRules 없음
const SUGG_DIRS = [
  { type: 'addDirectories', directories: [WORK], destination: 'session' },
  { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
];
const req = (id: string, toolName: string, input: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'control_request', request_id: id,
  request: { subtype: 'can_use_tool', tool_name: toolName, input, tool_use_id: `tu-${id}`, ...extra },
});
const toolUse = (id: string, name: string, input: unknown) => ({
  type: 'assistant', message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null,
});
const one = (evs: ProviderEvent[]) => { expect(evs).toHaveLength(1); return evs[0]; };
const optionIds = (ev: ProviderEvent) => (ev.type === 'requestPermission' ? ev.options.map((o) => o.optionId) : null);

function started(cwd: string | undefined = WORK) {
  const d = createClaudeDriver();
  d.decode(raw(INIT(cwd)));
  return d;
}
// 세션 허용을 누른 뒤의 드라이버와 그 답
function allowedOnce(d: ReturnType<typeof createClaudeDriver>, toolName = 'PowerShell', command = PS_A, extra: Record<string, unknown> = {}) {
  const ev = one(d.decode(raw(req('r-1', toolName, { command, description: '파일 만들기' }, { permission_suggestions: SUGG_DIRS, ...extra }))));
  expect(ev.type).toBe('requestPermission');
  return d.answerPermission('r-1', { outcome: 'selected', optionId: 'allow_session' }) as any;
}

describe('드라이버: 세션 허용 기억', () => {
  it('(a) 세션 허용 뒤 같은 (도구, 명령, 폴더) → permissionAutoAllowed + allow 답 원문, pending 없음', () => {
    const d = started();
    allowedOnce(d);
    const input = { command: PS_A, description: '다른 설명이어도 같은 키' };
    const ev = one(d.decode(raw(req('r-2', 'PowerShell', input, { permission_suggestions: SUGG_DIRS }))));
    expect(ev).toEqual({
      seq: 0, at: 0, sessionId: 's-1', type: 'permissionAutoAllowed', requestId: 'r-2',
      toolCall: { toolCallId: 'tu-r-2', title: 'PowerShell New-Item -ItemType File -Force…', kind: 'execute', toolName: 'PowerShell', rawInput: input },
      reply: { type: 'control_response', response: { subtype: 'success', request_id: 'r-2', response: { behavior: 'allow', updatedInput: input } } },
      ext: { claude: { toolUseId: 'tu-r-2' } },
    });
    // pending 에 없음: 나중에 같은 id 로 답을 만들면 updatedInput 이 비어 있다
    expect((d.answerPermission('r-2', { outcome: 'selected', optionId: 'allow_once' }) as any).response.response.updatedInput).toBeUndefined();
    // 세 번째도 자동
    expect(one(d.decode(raw(req('r-3', 'PowerShell', { command: PS_A })))).type).toBe('permissionAutoAllowed');
  });

  it('(b) 다른 명령·다른 도구·글자 하나 다른 명령 → requestPermission', () => {
    const d = started();
    allowedOnce(d);
    expect(one(d.decode(raw(req('r-2', 'PowerShell', { command: 'New-Item -ItemType File -Force .\\ps-b.txt' })))).type).toBe('requestPermission');
    expect(one(d.decode(raw(req('r-3', 'Bash', { command: PS_A })))).type).toBe('requestPermission');
    expect(one(d.decode(raw(req('r-4', 'PowerShell', { command: `${PS_A} ` })))).type).toBe('requestPermission');
  });

  it('(c) 폴더를 바꾸는 tool_use(Set-Location) 뒤 같은 명령 → requestPermission (ⓔ). 다른 tool_use 는 세대를 안 올린다', () => {
    const d = started();
    d.decode(raw(toolUse('t-0', 'PowerShell', { command: PS_A })));
    allowedOnce(d);
    d.decode(raw(toolUse('t-1', 'PowerShell', { command: 'New-Item -ItemType Directory -Force .\\sub' })));
    expect(one(d.decode(raw(req('r-2', 'PowerShell', { command: PS_A })))).type).toBe('permissionAutoAllowed');
    d.decode(raw(toolUse('t-2', 'PowerShell', { command: 'Set-Location .\\sub' })));
    const ev = one(d.decode(raw(req('r-3', 'PowerShell', { command: PS_A }))));
    expect(ev.type).toBe('requestPermission');
    expect(optionIds(ev)).toEqual(['allow_once', 'allow_session', 'reject_once']);
    // 새 세대에서 다시 세션 허용 → 그 세대에서는 자동
    d.answerPermission('r-3', { outcome: 'selected', optionId: 'allow_session' });
    expect(one(d.decode(raw(req('r-4', 'PowerShell', { command: PS_A })))).type).toBe('permissionAutoAllowed');
    // 폴더를 바꾸는 말이 없는 다른 도구 입력(문자열 command 아님)은 세대에 영향 없음
    d.decode(raw(toolUse('t-3', 'Read', { file_path: 'cd' })));
    expect(one(d.decode(raw(req('r-5', 'PowerShell', { command: PS_A })))).type).toBe('permissionAutoAllowed');
  });

  it('(d) 요청에 cwd 칸이 있으면 init 의 cwd 대신 그것을 쓴다', () => {
    const d = started();
    allowedOnce(d, 'PowerShell', PS_A, { cwd: 'C:\\다른 폴더' });
    // 같은 cwd 칸 → 자동
    expect(one(d.decode(raw(req('r-2', 'PowerShell', { command: PS_A }, { cwd: 'C:\\다른 폴더' })))).type).toBe('permissionAutoAllowed');
    // 칸 없음 = init 의 cwd(WORK) → 다른 폴더라 카드
    expect(one(d.decode(raw(req('r-3', 'PowerShell', { command: PS_A })))).type).toBe('requestPermission');
    // 칸이 있어도 다른 값이면 카드
    expect(one(d.decode(raw(req('r-4', 'PowerShell', { command: PS_A }, { cwd: WORK + '\\sub' })))).type).toBe('requestPermission');
    // init 에 cwd 가 없고 요청에도 없으면 '' 로 같은 키(그래도 자동 허용은 같은 채팅 안에서만)
    const e = started(undefined);
    allowedOnce(e);
    expect(one(e.decode(raw(req('r-2', 'PowerShell', { command: PS_A })))).type).toBe('permissionAutoAllowed');
  });

  it('(e) addRules 제안이 없는 세션 허용 답: allow + updatedInput 뿐(updatedPermissions 없음)', () => {
    const d = started();
    const ans = allowedOnce(d);
    expect(ans).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'r-1', response: { behavior: 'allow', updatedInput: { command: PS_A, description: '파일 만들기' } } } });
    expect(JSON.stringify(ans)).not.toContain('updatedPermissions');
  });

  it('(f) addRules 제안이 있으면 그 rules 만 session 으로. addDirectories·setMode 는 절대 없다', () => {
    const d = started();
    const sugg = [
      { type: 'addRules', rules: [{ toolName: 'PowerShell', ruleContent: 'New-Item -ItemType File -Force $env:TEMP\\plenum-ps-x.txt' }], behavior: 'allow', destination: 'localSettings' },
      ...SUGG_DIRS,
    ];
    const command = 'New-Item -ItemType File -Force $env:TEMP\\plenum-ps-x.txt';
    const ev = one(d.decode(raw(req('r-1', 'PowerShell', { command }, { permission_suggestions: sugg }))));
    expect(ev.type === 'requestPermission' && ev.ext?.claude.sessionRules).toEqual([{ toolName: 'PowerShell', ruleContent: command }]);
    const ans = d.answerPermission('r-1', { outcome: 'selected', optionId: 'allow_session' }) as any;
    expect(ans.response.response.updatedPermissions).toEqual([{ type: 'addRules', rules: [{ toolName: 'PowerShell', ruleContent: command }], behavior: 'allow', destination: 'session' }]);
    const s = JSON.stringify(ans);
    for (const bad of ['addDirectories', 'setMode', 'acceptEdits', 'localSettings']) expect(s).not.toContain(bad);
    // 그래도 Plenum 이 기억한다(Claude Code 가 다시 물으면 자동 허용, ⓒ)
    const again = one(d.decode(raw(req('r-2', 'PowerShell', { command }, { permission_suggestions: sugg }))));
    expect(again.type).toBe('permissionAutoAllowed');
    expect(JSON.stringify(again.type === 'permissionAutoAllowed' ? again.reply : null)).not.toContain('updatedPermissions');
  });

  it('(g) 명령 도구가 아니고(Edit 등) sessionRules 도 없으면 allow_session 옵션 없음. 명령 도구는 제안이 없어도 있음', () => {
    const d = started();
    const edit = one(d.decode(raw(req('r-1', 'Edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' }, { permission_suggestions: SUGG_DIRS }))));
    expect(optionIds(edit)).toEqual(['allow_once', 'reject_once']);
    const notStr = one(d.decode(raw(req('r-2', 'PowerShell', { command: ['ls'] }))));
    expect(optionIds(notStr)).toEqual(['allow_once', 'reject_once']);
    const ps = one(d.decode(raw(req('r-3', 'PowerShell', { command: PS_A }))));
    expect(optionIds(ps)).toEqual(['allow_once', 'allow_session', 'reject_once']);
    // 명령 도구 아님 + 세션 허용(옛 경로): 기억하지 않는다 → 같은 요청은 다시 카드
    const w = one(d.decode(raw(req('r-4', 'WebFetch', { url: 'https://example.invalid' }, { permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'WebFetch' }], behavior: 'allow', destination: 'localSettings' }] }))));
    expect(optionIds(w)).toEqual(['allow_once', 'allow_session', 'reject_once']);
    d.answerPermission('r-4', { outcome: 'selected', optionId: 'allow_session' });
    expect(one(d.decode(raw(req('r-5', 'WebFetch', { url: 'https://example.invalid' })))).type).toBe('requestPermission');
    // 한 번 허용·거부는 기억하지 않는다
    d.answerPermission('r-3', { outcome: 'selected', optionId: 'allow_once' });
    expect(one(d.decode(raw(req('r-6', 'PowerShell', { command: PS_A })))).type).toBe('requestPermission');
    d.answerPermission('r-6', { outcome: 'selected', optionId: 'reject_once' });
    expect(one(d.decode(raw(req('r-7', 'PowerShell', { command: PS_A })))).type).toBe('requestPermission');
  });

  it('(h) 새 드라이버(이어하기 = 새 프로세스)는 기억이 없다', () => {
    const d = started();
    allowedOnce(d);
    expect(one(d.decode(raw(req('r-2', 'PowerShell', { command: PS_A })))).type).toBe('permissionAutoAllowed');
    const next = started();
    expect(one(next.decode(raw(req('r-2', 'PowerShell', { command: PS_A })))).type).toBe('requestPermission');
  });

  it.each([
    ['cd x', true], ['Set-Location .\\sub', true], ['sl ..', true], ['pushd x', true], ['a; cd b', true],
    ['git commit -m "cd"', true],      // 따옴표 안도 잡는다(오탐 = 카드 한 번 더, 안전한 쪽)
    ['echo abcd', false],
    ['CD ..', true], ['cd..', true], ['chdir /tmp', true], ['  Push-Location C:\\x', true], ['Pop-Location', true], ['popd', true],
    ['make && cd out', true], ['ls | cd', true], ['(cd x; ls)', true], ['ls\ncd x', true],
    ['', false], ['New-Item -ItemType File -Force .\\ps-a.txt', false], ['echo cd', false], ['cdk deploy', false], ['sl-tool', false],
    ['Get-ChildItem .\\sl', false], ['Set-LocationX', false],
  ])('(i) changesDirectory(%j) = %s', (cmd, want) => {
    expect(changesDirectory(cmd)).toBe(want);
  });

  it('(상-1) description 말고 다른 칸이 다르면 카드(dangerouslyDisableSandbox·run_in_background·timeout), 칸 순서만 다르면 같은 키', () => {
    const d = started();
    allowedOnce(d, 'Bash', 'touch a.txt');
    for (const extra of [{ dangerouslyDisableSandbox: true }, { run_in_background: true }, { timeout: 1000 }]) {
      expect(one(d.decode(raw(req(`r-${JSON.stringify(extra)}`, 'Bash', { command: 'touch a.txt', ...extra })))).type).toBe('requestPermission');
    }
    expect(one(d.decode(raw(req('r-desc', 'Bash', { description: '다른 설명', command: 'touch a.txt' })))).type).toBe('permissionAutoAllowed');
    // 중첩 객체도 키 정렬: 순서만 다르면 같다
    const e = started();
    e.decode(raw(req('r-1', 'PowerShell', { command: 'x', opt: { b: 1, a: [2, { d: 1, c: 2 }] } })));
    e.answerPermission('r-1', { outcome: 'selected', optionId: 'allow_session' });
    expect(one(e.decode(raw(req('r-2', 'PowerShell', { opt: { a: [2, { c: 2, d: 1 }], b: 1 }, command: 'x' })))).type).toBe('permissionAutoAllowed');
    // 배열 순서가 다르면 다른 키
    expect(one(e.decode(raw(req('r-3', 'PowerShell', { command: 'x', opt: { b: 1, a: [{ d: 1, c: 2 }, 2] } })))).type).toBe('requestPermission');
  });

  it('(상-1) Bash·PowerShell 말고 command 도구(MCP 등)는 기억하지 않는다: addRules 가 있으면 버튼은 있지만 remembers 아님', () => {
    const d = started();
    const mcp = 'mcp__ssh__run';
    const sugg = [{ type: 'addRules', rules: [{ toolName: mcp }], behavior: 'allow', destination: 'localSettings' }];
    const ev = one(d.decode(raw(req('r-1', mcp, { command: 'ls', host: 'h1' }, { permission_suggestions: sugg }))));
    expect(optionIds(ev)).toEqual(['allow_once', 'allow_session', 'reject_once']);
    expect(ev.type === 'requestPermission' && ev.ext?.claude.remembers).toBe(false);
    const ans = d.answerPermission('r-1', { outcome: 'selected', optionId: 'allow_session' }) as any;
    expect(ans.response.response.updatedPermissions).toEqual([{ type: 'addRules', rules: [{ toolName: mcp }], behavior: 'allow', destination: 'session' }]);
    expect(one(d.decode(raw(req('r-2', mcp, { command: 'ls', host: 'h1' }, { permission_suggestions: sugg })))).type).toBe('requestPermission');
    // 제안이 없는 MCP command 도구는 세션 허용 버튼도 없다
    expect(optionIds(one(d.decode(raw(req('r-3', mcp, { command: 'ls', host: 'h1' })))))).toEqual(['allow_once', 'reject_once']);
    // Bash·PowerShell 은 remembers
    const b = one(d.decode(raw(req('r-4', 'Bash', { command: 'ls' }))));
    expect(b.type === 'requestPermission' && b.ext?.claude.remembers).toBe(true);
  });

  it('(3) blocked_path 만 다르면 카드, 같으면 자동 허용', () => {
    const d = started();
    allowedOnce(d, 'PowerShell', PS_A, { blocked_path: 'C:\\밖\\a.txt' });
    expect(one(d.decode(raw(req('r-2', 'PowerShell', { command: PS_A }, { blocked_path: 'C:\\밖\\a.txt' })))).type).toBe('permissionAutoAllowed');
    expect(one(d.decode(raw(req('r-3', 'PowerShell', { command: PS_A }, { blocked_path: 'C:\\밖\\b.txt' })))).type).toBe('requestPermission');
    expect(one(d.decode(raw(req('r-4', 'PowerShell', { command: PS_A })))).type).toBe('requestPermission');
    // 반대로: blocked_path 없이 허용한 것에 blocked_path 가 붙어 오면 카드
    const e = started();
    allowedOnce(e);
    expect(one(e.decode(raw(req('r-2', 'PowerShell', { command: PS_A }, { blocked_path: 'C:\\x' })))).type).toBe('requestPermission');
  });

  it.each(['Agent', 'Task'])('(4) %s tool_use 뒤 같은 명령 → 카드', (name) => {
    const d = started();
    allowedOnce(d);
    expect(one(d.decode(raw(req('r-2', 'PowerShell', { command: PS_A })))).type).toBe('permissionAutoAllowed');
    d.decode(raw(toolUse('t-a', name, { description: '하위 작업', prompt: 'cd 없음', subagent_type: 'general-purpose' })));
    expect(one(d.decode(raw(req('r-3', 'PowerShell', { command: PS_A })))).type).toBe('requestPermission');
  });

  it('(5) 답하기 전 같은 request_id 재사용 → 두 번째는 unknown + 거절 답, 첫 카드의 세션 허용은 첫 요청 키로', () => {
    const d = started();
    expect(one(d.decode(raw(req('r-1', 'PowerShell', { command: PS_A })))).type).toBe('requestPermission');
    const dup = one(d.decode(raw(req('r-1', 'PowerShell', { command: 'Remove-Item -Recurse -Force .\\' }))));
    expect(dup).toMatchObject({ type: 'unknown', reason: 'field', hint: 'can_use_tool/duplicate-id', answeredWithDefault: true, requestId: 'r-1',
      reply: { type: 'control_response', response: { subtype: 'error', request_id: 'r-1', error: 'Plenum 채팅이 처리하지 못하는 요청' } } });
    const ans = d.answerPermission('r-1', { outcome: 'selected', optionId: 'allow_session' }) as any;
    expect(ans.response.response.updatedInput).toEqual({ command: PS_A });
    expect(one(d.decode(raw(req('r-2', 'PowerShell', { command: PS_A })))).type).toBe('permissionAutoAllowed');
    expect(one(d.decode(raw(req('r-3', 'PowerShell', { command: 'Remove-Item -Recurse -Force .\\' })))).type).toBe('requestPermission');
    // 답한 뒤(또는 턴이 끝난 뒤)에는 같은 id 가 새 요청으로 받아진다
    expect(one(d.decode(raw(req('r-1', 'PowerShell', { command: 'Get-Date' })))).type).toBe('requestPermission');
    expect(one(d.decode(raw(req('r-q', 'Bash', { command: 'ls' })))).type).toBe('requestPermission');
    d.decode(raw({ type: 'result', subtype: 'success', is_error: false, result: '', permission_denials: [] }));
    expect(one(d.decode(raw(req('r-q', 'Bash', { command: 'ls' })))).type).toBe('requestPermission');
    expect(d.stats().thrown).toBe(0);
  });

  it('decode 는 예외 없이: 자동 허용 경로에서도 답 원문이 반드시 있다', () => {
    const d = started();
    allowedOnce(d);
    const ev = one(d.decode(raw(req('r-2', 'PowerShell', { command: PS_A }))));
    expect(ev.type === 'permissionAutoAllowed' && (ev.reply as any).response.request_id).toBe('r-2');
    expect(d.stats().thrown).toBe(0);
  });
});

// ── 채팅 매니저 (가짜 claude) ─────────────────────────────
const managers: ChatManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((m) => m.shutdownAll())); });

function waitEvent<T extends ChatEvent['type']>(m: ChatManager, chatId: string, type: T, pred: (e: Extract<ChatEvent, { type: T }>) => boolean = () => true, ms = 15000): Promise<Extract<ChatEvent, { type: T }>> {
  return new Promise((resolve, reject) => {
    let off = () => {};
    const t = setTimeout(() => { off(); reject(new Error(`${type} 이벤트가 ${ms}ms 안에 안 왔다`)); }, ms);
    let done = false;
    off = m.subscribe(chatId, 0, (e) => {
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

describe('채팅 매니저: 자동 허용', () => {
  it('세션 허용 → 같은 명령은 카드 없이 autoAllowed + stdin 에 allow 답, 다른 명령은 카드', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), '홍길동 세션허용-'));
    const projDir = path.join(root, '내 프로젝트');
    fs.mkdirSync(projDir);
    const fake = makeFakeStreamClaude(path.join(root, '가짜'));
    const file = path.join(root, 'auto.jsonl');
    const PS_B = 'New-Item -ItemType File -Force .\\ps-b.txt';
    writeScript(file, [
      { dir: 'in', msg: { type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } } }, { dir: 'in', msg: { type: 'user' } },
      { dir: 'out', msg: INIT(projDir) },
      { dir: 'out', msg: toolUse('tu-r-1', 'PowerShell', { command: PS_A }) },
      { dir: 'out', msg: req('r-1', 'PowerShell', { command: PS_A }, { permission_suggestions: SUGG_DIRS }) },
      { dir: 'in', msg: { type: 'control_response', response: { request_id: 'r-1' } } },
      { dir: 'out', msg: toolUse('tu-r-2', 'PowerShell', { command: PS_A }) },
      { dir: 'out', msg: req('r-2', 'PowerShell', { command: PS_A }, { permission_suggestions: SUGG_DIRS }) },
      { dir: 'in', msg: { type: 'control_response', response: { request_id: 'r-2' } } },
      { dir: 'out', msg: req('r-3', 'PowerShell', { command: PS_B }) },
      { dir: 'in', msg: { type: 'control_response', response: { request_id: 'r-3' } } },
      { dir: 'out', msg: { type: 'result', subtype: 'success', is_error: false, result: '끝', permission_denials: [] } },
      { dir: 'exit', code: 0 },
    ]);
    const m = createChatManager({ cfgDir: path.join(root, '설정'), env: fake.env({ script: file }), closeWaitMs: 3000 });
    managers.push(m);
    const id = (await m.start({ id: 'p1', path: projDir }, { text: '시작' })).chat.chatId;

    const c1 = await waitEvent(m, id, 'card', (e) => e.card.requestId === 'r-1');
    const pc1 = c1.card as Extract<Card, { kind: 'permission' }>;
    expect(pc1.sessionRules).toEqual([]);
    expect(pc1.sessionAllow).toBe(true);
    expect(pc1.remembers).toBe(true);
    m.respond(id, { requestId: 'r-1', action: 'allow-session' });

    const auto = await waitEvent(m, id, 'autoAllowed');
    expect(auto).toMatchObject({ type: 'autoAllowed', toolName: 'PowerShell', summary: `PowerShell ${PS_A}`, requestId: 'r-2', toolUseId: 'tu-r-2' });
    const c3 = await waitEvent(m, id, 'card', (e) => e.card.requestId === 'r-3');
    expect((c3.card as any).input.command).toBe(PS_B);
    expect(m.get(id)!.state).toBe('waiting');
    m.respond(id, { requestId: 'r-3', action: 'allow' });
    await waitEvent(m, id, 'result');

    const evs = events(m, id);
    expect(evs.filter((e) => e.type === 'card').map((e) => (e as any).card.requestId)).toEqual(['r-1', 'r-3']);
    // 자동 허용은 카드 대기 수·상태에 영향 없음: r-1 답 뒤 waiting 이 풀린 다음 r-3 에서만 다시 waiting
    expect(evs.filter((e) => e.type === 'state').map((e) => (e as any).state)).toEqual(['starting', 'running', 'waiting', 'running', 'waiting', 'running', 'idle']);
    const answers = fake.stdin().filter((x) => x.type === 'control_response');
    expect(answers).toEqual([
      { type: 'control_response', response: { subtype: 'success', request_id: 'r-1', response: { behavior: 'allow', updatedInput: { command: PS_A } } } },
      { type: 'control_response', response: { subtype: 'success', request_id: 'r-2', response: { behavior: 'allow', updatedInput: { command: PS_A } } } },
      { type: 'control_response', response: { subtype: 'success', request_id: 'r-3', response: { behavior: 'allow', updatedInput: { command: PS_B } } } },
    ]);
    // 자동 허용한 요청에는 답할 카드가 없다
    await expect(Promise.resolve().then(() => m.respond(id, { requestId: 'r-2', action: 'allow' }))).rejects.toMatchObject({ status: 404 });
    // 화면: 자동 허용 줄
    const v = emptyView();
    for (const e of evs) applyEvent(v, e);
    expect(v.items.filter((x) => x.k === 'auto')).toEqual([{ k: 'auto', key: expect.any(String), summary: `PowerShell ${PS_A}` }]);
  }, 30000);

  it('세션 허용 옵션이 없는 카드(Edit, 제안 없음)에 allow-session → 400', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), '홍길동 세션허용-'));
    const projDir = path.join(root, 'p');
    fs.mkdirSync(projDir);
    const fake = makeFakeStreamClaude(path.join(root, '가짜'));
    const file = path.join(root, 'edit.jsonl');
    writeScript(file, [
      { dir: 'in', msg: { type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } } }, { dir: 'in', msg: { type: 'user' } },
      { dir: 'out', msg: INIT(projDir) },
      { dir: 'out', msg: req('r-1', 'Edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' }, { permission_suggestions: SUGG_DIRS }) },
      { dir: 'in', msg: { type: 'control_response', response: { request_id: 'r-1' } } },
      { dir: 'out', msg: { type: 'result', subtype: 'success', is_error: false, result: '끝', permission_denials: [] } },
      { dir: 'exit', code: 0 },
    ]);
    const m = createChatManager({ cfgDir: path.join(root, '설정'), env: fake.env({ script: file }), closeWaitMs: 3000 });
    managers.push(m);
    const id = (await m.start({ id: 'p1', path: projDir }, { text: '시작' })).chat.chatId;
    const c = await waitEvent(m, id, 'card');
    expect((c.card as any).sessionAllow).toBe(false);
    expect((c.card as any).remembers).toBe(false);
    await expect(Promise.resolve().then(() => m.respond(id, { requestId: 'r-1', action: 'allow-session' }))).rejects.toMatchObject({ status: 400 });
    m.respond(id, { requestId: 'r-1', action: 'allow' });
    await waitEvent(m, id, 'result');
  }, 30000);
});

describe('채팅 매니저: 같은 request_id 재사용', () => {
  it('두 번째 요청은 stdin 에 거절, 첫 카드는 그대로 답할 수 있다', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), '홍길동 같은id-'));
    const projDir = path.join(root, 'p');
    fs.mkdirSync(projDir);
    const fake = makeFakeStreamClaude(path.join(root, '가짜'));
    const file = path.join(root, 'dup.jsonl');
    writeScript(file, [
      { dir: 'in', msg: { type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } } }, { dir: 'in', msg: { type: 'user' } },
      { dir: 'out', msg: INIT(projDir) },
      { dir: 'out', msg: req('r-1', 'Bash', { command: 'ls' }) },
      { dir: 'out', msg: req('r-1', 'Bash', { command: 'rm -rf x' }) },
      { dir: 'in', msg: { type: 'control_response', response: { request_id: 'r-1' } } },
      { dir: 'in', msg: { type: 'control_response', response: { request_id: 'r-1' } } },
      { dir: 'out', msg: { type: 'result', subtype: 'success', is_error: false, result: '끝', permission_denials: [] } },
      { dir: 'exit', code: 0 },
    ]);
    const m = createChatManager({ cfgDir: path.join(root, '설정'), env: fake.env({ script: file }), closeWaitMs: 3000 });
    managers.push(m);
    const id = (await m.start({ id: 'p1', path: projDir }, { text: '시작' })).chat.chatId;
    await waitEvent(m, id, 'card');
    await waitEvent(m, id, 'notice', (e) => e.code === 'other');
    m.respond(id, { requestId: 'r-1', action: 'allow' });
    await waitEvent(m, id, 'result');
    const evs = events(m, id);
    expect(evs.filter((e) => e.type === 'card').map((e) => (e as any).card.input.command)).toEqual(['ls']);
    expect(fake.stdin().filter((x) => x.type === 'control_response')).toEqual([
      { type: 'control_response', response: { subtype: 'error', request_id: 'r-1', error: 'Plenum 채팅이 처리하지 못하는 요청' } },
      { type: 'control_response', response: { subtype: 'success', request_id: 'r-1', response: { behavior: 'allow', updatedInput: { command: 'ls' } } } },
    ]);
  }, 30000);
});

// ── 카드 렌더 ───────────────────────────────────────────
type Perm = Extract<Card, { kind: 'permission' }>;
const render = (extra: Partial<Perm>) => renderToStaticMarkup(createElement(PermissionCard, {
  card: { kind: 'permission', requestId: 'r-1', toolName: 'PowerShell', input: { command: PS_A }, sessionRules: [], ...extra },
  resolved: null, cwd: 'C:\\Users\\홍길동\\프로젝트', onReply: async () => {},
}));

describe('카드: 세션 허용 버튼', () => {
  it('sessionRules 가 있으면 규칙을 보인다', () => {
    const html = render({ sessionAllow: true, sessionRules: [{ toolName: 'PowerShell', ruleContent: 'Get-Date' }] });
    expect(html).toContain('이 세션 동안 <code>Get-Date</code> 허용');
  });
  it('sessionRules 가 없고 세션 허용 옵션이 있으면 "같은 명령"', () => {
    const html = render({ sessionAllow: true });
    expect(html).toContain('이 세션 동안 같은 명령 허용');
  });
  it('옵션이 없으면 버튼 없음. sessionAllow 가 없는 옛 카드는 sessionRules 유무로', () => {
    expect(render({ sessionAllow: false })).not.toContain('이 세션 동안');
    expect(render({})).not.toContain('이 세션 동안');
    expect(render({ sessionRules: [{ toolName: 'Bash', ruleContent: 'ls' }] })).toContain('이 세션 동안 <code>ls</code> 허용');
  });
  it('답한 뒤 문구: remembers 면 "Plenum이 대신 허용", 아니면 예전 문구', () => {
    expect(resolvedText({ outcome: 'allow-session' }, true)).toBe('허용 · 이 세션 동안 같은 명령은 Plenum이 대신 허용');
    expect(resolvedText({ outcome: 'allow-session' }, false)).toBe('허용 · 이 세션 동안 다시 묻지 않음');
    expect(resolvedText({ outcome: 'allow-session' })).toBe('허용 · 이 세션 동안 다시 묻지 않음');
    const done = (extra: Partial<Perm>) => renderToStaticMarkup(createElement(PermissionCard, {
      card: { kind: 'permission', requestId: 'r-1', toolName: 'PowerShell', input: { command: PS_A }, sessionRules: [], ...extra },
      resolved: { outcome: 'allow-session' }, cwd: 'C:\\x', onReply: async () => {},
    }));
    expect(done({ sessionAllow: true, remembers: true })).toContain('같은 명령은 Plenum이 대신 허용');
    expect(done({ sessionAllow: true, remembers: false, sessionRules: [{ toolName: 'mcp__x', ruleContent: 'y' }] })).toContain('이 세션 동안 다시 묻지 않음');
  });
  it('remembers 가 아니고 rules 도 없으면 버튼 없음(sessionAllow 없는 카드에서도)', () => {
    expect(render({ remembers: false })).not.toContain('이 세션 동안');
    expect(render({ remembers: true })).toContain('이 세션 동안 같은 명령 허용');
  });
});

describe('toolLabel: 명령 도구는 이름 + 명령', () => {
  it('PowerShell 도 명령을 붙인다(Bash 는 그대로)', async () => {
    const { toolLabel } = await import('../server/chatTypes.ts');
    expect(toolLabel('PowerShell', { command: 'New-Item -ItemType File -Force .\\ps-a.txt' })).toBe('PowerShell New-Item -ItemType File -Force…');
    expect(toolLabel('Bash', { command: 'ls -la' })).toBe('Bash ls -la');
    expect(toolLabel('WebFetch', { url: 'x' })).toBe('WebFetch');
  });
});
