// "이 세션 동안 허용"을 Plenum 이 기억해서 같은 명령을 대신 허용한다(D안).
// 키 = (도구, description 뺀 입력 전체, Plenum PreToolUse 훅이 알려 준 실제 폴더, blocked_path). 폴더를 모르면 자동 허용·기억 없음.
// 드라이버 단위 + 훅 명령 + chatArgs + 채팅 매니저(가짜 claude) + 카드 렌더.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createClaudeDriver } from '../server/provider/claude.ts';
import type { ProviderEvent, Raw } from '../server/provider/events.ts';
import { chatArgs, cleanupHookFiles, createChatManager, hookCommand, hookDir, hookPathOk, hookSettings, newHookNonce, prepareHookSettings, type ChatManager } from '../server/chat.ts';
import type { Card, ChatEvent } from '../server/chatTypes.ts';
import { PermissionCard, resolvedText } from '../web/src/Cards.tsx';
import { applyEvent, emptyView } from '../web/src/Chat.tsx';
import { makeFakeStreamClaude, writeScript } from './fakeclaudeStream.ts';

const raw = (m: unknown): Raw => ({ provider: 'claude', version: '2.1.248', channel: 'stdout', text: JSON.stringify(m) });
const INIT = (cwd?: string) => ({ type: 'system', subtype: 'init', session_id: 's-1', claude_code_version: '2.1.248', model: 'claude-haiku', permissionMode: 'default', ...(cwd !== undefined ? { cwd } : {}) });
const PS_A = 'New-Item -ItemType File -Force .\\ps-a.txt';
const WORK = 'C:\\Users\\홍길동\\AppData\\Local\\Temp\\plenum-rec-홍길동-AbCdEf\\proj';
const NONCE = '0123456789abcdef0123456789abcdef';
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
// 우리 훅이 낸 hook_response (2.1.332 녹화 모양). stdout 에 표시 줄
const mark = (i: string, t: string, c: string, nonce = NONCE) => `PLENUM_CWD ${nonce} ${JSON.stringify({ c, i, t })}\n`;
const hookResp = (stdout: string, name = 'PreToolUse:PowerShell', event = 'PreToolUse') => ({
  type: 'system', subtype: 'hook_response', hook_id: 'h-1', hook_name: name, hook_event: event, output: stdout, stdout, stderr: '', exit_code: 0, outcome: 'success',
  uuid: 'u-1', session_id: 's-1',
});
const one = (evs: ProviderEvent[]) => { expect(evs).toHaveLength(1); return evs[0]; };
const optionIds = (ev: ProviderEvent) => (ev.type === 'requestPermission' ? ev.options.map((o) => o.optionId) : null);
type D = ReturnType<typeof createClaudeDriver>;

function started(nonce: string | null = NONCE) {
  const d = createClaudeDriver({ hookNonce: nonce });
  d.decode(raw(INIT(WORK)));
  return d;
}
// 우리 훅이 cwd 를 알려 준 뒤(Bash·PowerShell) 승인 요청. cwd 가 null 이면 훅 줄 없이
function ask(d: D, id: string, toolName: string, input: unknown, extra: Record<string, unknown> = {}, cwd: string | null = WORK) {
  if (cwd !== null && (toolName === 'Bash' || toolName === 'PowerShell')) {
    expect(d.decode(raw(hookResp(mark(`tu-${id}`, toolName, cwd), `PreToolUse:${toolName}`)))).toEqual([]);
  }
  return one(d.decode(raw(req(id, toolName, input, extra))));
}
// 세션 허용을 누른 뒤의 답
function allowedOnce(d: D, toolName = 'PowerShell', command = PS_A, extra: Record<string, unknown> = {}, cwd: string | null = WORK) {
  const ev = ask(d, 'r-1', toolName, { command, description: '파일 만들기' }, { permission_suggestions: SUGG_DIRS, ...extra }, cwd);
  expect(ev.type).toBe('requestPermission');
  return d.answerPermission('r-1', { outcome: 'selected', optionId: 'allow_session' }) as any;
}
const remembers = (ev: ProviderEvent) => (ev.type === 'requestPermission' ? ev.ext?.claude.remembers : undefined);

describe('드라이버: 세션 허용 기억 (훅 cwd)', () => {
  it('(a) 우리 nonce 로 cwd 가 온 뒤 세션 허용 → 같은 cwd·같은 입력 → permissionAutoAllowed + allow 답 원문, pending 없음', () => {
    const d = started();
    allowedOnce(d);
    const input = { command: PS_A, description: '다른 설명이어도 같은 키' };
    const ev = ask(d, 'r-2', 'PowerShell', input, { permission_suggestions: SUGG_DIRS });
    expect(ev).toEqual({
      seq: 0, at: 0, sessionId: 's-1', type: 'permissionAutoAllowed', requestId: 'r-2',
      toolCall: { toolCallId: 'tu-r-2', title: 'PowerShell New-Item -ItemType File -Force…', kind: 'execute', toolName: 'PowerShell', rawInput: input },
      reply: { type: 'control_response', response: { subtype: 'success', request_id: 'r-2', response: { behavior: 'allow', updatedInput: input } } },
      ext: { claude: { toolUseId: 'tu-r-2' } },
    });
    expect((d.answerPermission('r-2', { outcome: 'selected', optionId: 'allow_once' }) as any).response.response.updatedInput).toBeUndefined();
    expect(ask(d, 'r-3', 'PowerShell', { command: PS_A }).type).toBe('permissionAutoAllowed');
  });

  it('(b) cwd 가 바뀌면 카드(ⓔ: Set-Location 뒤 같은 명령). 그 폴더에서 다시 세션 허용하면 그 폴더에서는 자동', () => {
    const d = started();
    allowedOnce(d);
    const ev = ask(d, 'r-2', 'PowerShell', { command: PS_A }, {}, `${WORK}\\sub`);
    expect(ev.type).toBe('requestPermission');
    expect(remembers(ev)).toBe(true);
    d.answerPermission('r-2', { outcome: 'selected', optionId: 'allow_session' });
    expect(ask(d, 'r-3', 'PowerShell', { command: PS_A }, {}, `${WORK}\\sub`).type).toBe('permissionAutoAllowed');
    expect(ask(d, 'r-4', 'PowerShell', { command: PS_A }, {}, WORK).type).toBe('permissionAutoAllowed');
    // 요청의 cwd 칸·init 의 cwd 는 보지 않는다
    expect(ask(d, 'r-5', 'PowerShell', { command: PS_A }, { cwd: WORK }, 'C:\\다른 폴더').type).toBe('requestPermission');
  });

  it('(c) hook_response 가 없으면 기억된 키여도 카드, 세션 허용해도 remembers false(기억 안 함)', () => {
    const d = started();
    allowedOnce(d);
    const ev = ask(d, 'r-2', 'PowerShell', { command: PS_A }, {}, null);
    expect(ev.type).toBe('requestPermission');
    expect(remembers(ev)).toBe(false);
    // addRules 도 없으면 세션 허용 버튼 자체가 없다
    expect(optionIds(ev)).toEqual(['allow_once', 'reject_once']);
    // 훅 없는 Bash + addRules: 버튼은 있지만(Claude Code 규칙) 기억하지 않는다
    const e = started();
    const sugg = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], behavior: 'allow', destination: 'localSettings' }];
    const b = ask(e, 'r-1', 'Bash', { command: 'ls' }, { permission_suggestions: sugg }, null);
    expect(optionIds(b)).toEqual(['allow_once', 'allow_session', 'reject_once']);
    expect(remembers(b)).toBe(false);
    e.answerPermission('r-1', { outcome: 'selected', optionId: 'allow_session' });
    expect(ask(e, 'r-2', 'Bash', { command: 'ls' }).type).toBe('requestPermission');
    // nonce 없이 만든 드라이버(훅을 안 붙인 채팅)는 표시 줄을 믿지 않는다
    const n = started(null);
    expect(one(n.decode(raw(hookResp(mark('tu-r-1', 'PowerShell', WORK))))).type).toBe('unknown');
    expect(remembers(one(n.decode(raw(req('r-1', 'PowerShell', { command: PS_A })))))).toBe(false);
  });

  it('(d) 다른 훅이 PLENUM_CWD 와 틀린 nonce 를 찍으면 무시 → 카드', () => {
    const d = started();
    allowedOnce(d);
    const fake = one(d.decode(raw(hookResp(mark('tu-r-2', 'PowerShell', WORK, 'ffffffffffffffffffffffffffffffff')))));
    expect(fake.type).toBe('unknown');
    expect(remembers(one(d.decode(raw(req('r-2', 'PowerShell', { command: PS_A })))))).toBe(false);
    // nonce 가 비었거나 접두어만 같은 것(우리 nonce 뒤에 글자가 더 붙음)도 무시
    for (const stdout of [`PLENUM_CWD  ${JSON.stringify({ c: WORK, i: 'tu-r-3', t: 'PowerShell' })}`, mark('tu-r-3', 'PowerShell', WORK, `${NONCE}0`), ` ${mark('tu-r-3', 'PowerShell', WORK)}`]) {
      expect(one(d.decode(raw(hookResp(stdout)))).type).toBe('unknown');
    }
    expect(one(d.decode(raw(req('r-3', 'PowerShell', { command: PS_A })))).type).toBe('requestPermission');
    // 다른 훅 글과 섞여 와도 우리 줄은 줄 단위로 찾는다
    expect(d.decode(raw(hookResp(`다른 훅 출력\n${mark('tu-r-4', 'PowerShell', WORK)}`)))).toEqual([]);
    expect(one(d.decode(raw(req('r-4', 'PowerShell', { command: PS_A })))).type).toBe('permissionAutoAllowed');
  });

  it.each([['PreToolUse:Read', 'PreToolUse'], ['PostToolUse:PowerShell', 'PostToolUse'], ['PreToolUse:PowerShell', 'PostToolUse'], ['PreToolUse:mcp__x', 'PreToolUse']])('(e) nonce 가 맞아도 hook_name %s · hook_event %s 면 무시', (name, event) => {
    const d = started();
    allowedOnce(d);
    expect(one(d.decode(raw(hookResp(mark('tu-r-2', 'PowerShell', WORK), name, event)))).type).toBe('unknown');
    expect(one(d.decode(raw(req('r-2', 'PowerShell', { command: PS_A })))).type).toBe('requestPermission');
  });

  it('(f) 같은 id 에 우리 nonce 로 두 값 → 모름 → 카드(remembers false). 같은 값 두 번은 그대로', () => {
    const d = started();
    allowedOnce(d);
    d.decode(raw(hookResp(mark('tu-r-2', 'PowerShell', WORK))));
    d.decode(raw(hookResp(mark('tu-r-2', 'PowerShell', 'C:\\x'))));
    d.decode(raw(hookResp(mark('tu-r-2', 'PowerShell', WORK))));   // 다시 원래 값이 와도 모름 그대로
    const ev = one(d.decode(raw(req('r-2', 'PowerShell', { command: PS_A }))));
    expect(ev.type).toBe('requestPermission');
    expect(remembers(ev)).toBe(false);
    d.decode(raw(hookResp(mark('tu-r-3', 'PowerShell', WORK))));
    d.decode(raw(hookResp(mark('tu-r-3', 'PowerShell', WORK))));
    expect(one(d.decode(raw(req('r-3', 'PowerShell', { command: PS_A })))).type).toBe('permissionAutoAllowed');
  });

  it('(g) 표시 줄의 t 가 hook_name 의 도구와 다르면 무시. 칸 모양이 틀려도 무시', () => {
    const d = started();
    allowedOnce(d);
    expect(one(d.decode(raw(hookResp(mark('tu-r-2', 'Bash', WORK), 'PreToolUse:PowerShell')))).type).toBe('unknown');
    expect(one(d.decode(raw(hookResp(`PLENUM_CWD ${NONCE} ${JSON.stringify({ c: 1, i: 'tu-r-2', t: 'PowerShell' })}`)))).type).toBe('unknown');
    expect(one(d.decode(raw(hookResp(`PLENUM_CWD ${NONCE} {깨진`)))).type).toBe('unknown');
    expect(one(d.decode(raw(req('r-2', 'PowerShell', { command: PS_A })))).type).toBe('requestPermission');
    // 요청의 tool_name 이 Bash 인데 훅은 PowerShell 로 그 id 를 알려 줌 → 키 도구는 요청 쪽(Bash) 이라 PowerShell 기억과 다르다
    expect(ask(d, 'r-3', 'Bash', { command: PS_A }).type).toBe('requestPermission');
  });

  it.each(['Agent', 'Task'])('(h) %s tool_use 뒤 기억을 모두 비운다 → 카드', (name) => {
    const d = started();
    allowedOnce(d);
    expect(ask(d, 'r-2', 'PowerShell', { command: PS_A }).type).toBe('permissionAutoAllowed');
    d.decode(raw(toolUse('t-a', name, { description: '하위 작업', prompt: '무엇이든', subagent_type: 'general-purpose' })));
    expect(ask(d, 'r-3', 'PowerShell', { command: PS_A }).type).toBe('requestPermission');
    // 다른 tool_use(cd 포함)는 기억을 건드리지 않는다(폴더는 훅 cwd 가 맡는다)
    d.answerPermission('r-3', { outcome: 'selected', optionId: 'allow_session' });
    d.decode(raw(toolUse('t-b', 'PowerShell', { command: 'Set-Location .\\sub' })));
    expect(ask(d, 'r-4', 'PowerShell', { command: PS_A }).type).toBe('permissionAutoAllowed');
  });

  it('다른 명령·다른 도구·글자 하나 다른 명령 → 카드. 새 드라이버(이어하기)는 기억 없음', () => {
    const d = started();
    allowedOnce(d);
    expect(ask(d, 'r-2', 'PowerShell', { command: 'New-Item -ItemType File -Force .\\ps-b.txt' }).type).toBe('requestPermission');
    expect(ask(d, 'r-3', 'Bash', { command: PS_A }).type).toBe('requestPermission');
    expect(ask(d, 'r-4', 'PowerShell', { command: `${PS_A} ` }).type).toBe('requestPermission');
    expect(ask(started(), 'r-5', 'PowerShell', { command: PS_A }).type).toBe('requestPermission');
  });

  it('addRules 제안이 없는 세션 허용 답: updatedPermissions 없음. 있으면 rules 만 session, addDirectories·setMode 는 절대 없다', () => {
    const d = started();
    const ans = allowedOnce(d);
    expect(ans).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'r-1', response: { behavior: 'allow', updatedInput: { command: PS_A, description: '파일 만들기' } } } });
    const e = started();
    const command = 'New-Item -ItemType File -Force $env:TEMP\\plenum-ps-x.txt';
    const sugg = [{ type: 'addRules', rules: [{ toolName: 'PowerShell', ruleContent: command }], behavior: 'allow', destination: 'localSettings' }, ...SUGG_DIRS];
    ask(e, 'r-1', 'PowerShell', { command }, { permission_suggestions: sugg });
    const a2 = e.answerPermission('r-1', { outcome: 'selected', optionId: 'allow_session' }) as any;
    expect(a2.response.response.updatedPermissions).toEqual([{ type: 'addRules', rules: [{ toolName: 'PowerShell', ruleContent: command }], behavior: 'allow', destination: 'session' }]);
    for (const bad of ['addDirectories', 'setMode', 'acceptEdits', 'localSettings']) expect(JSON.stringify(a2)).not.toContain(bad);
    const again = ask(e, 'r-2', 'PowerShell', { command }, { permission_suggestions: sugg });
    expect(again.type).toBe('permissionAutoAllowed');
    expect(JSON.stringify(again.type === 'permissionAutoAllowed' ? again.reply : null)).not.toContain('updatedPermissions');
  });

  it('명령 도구가 아니면(Edit·WebFetch·MCP) 기억하지 않는다. 한 번 허용·거부도 기억하지 않는다', () => {
    const d = started();
    expect(optionIds(ask(d, 'r-1', 'Edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' }, { permission_suggestions: SUGG_DIRS }))).toEqual(['allow_once', 'reject_once']);
    expect(optionIds(ask(d, 'r-2', 'PowerShell', { command: ['ls'] }))).toEqual(['allow_once', 'reject_once']);
    const mcp = 'mcp__ssh__run';
    const sugg = [{ type: 'addRules', rules: [{ toolName: mcp }], behavior: 'allow', destination: 'localSettings' }];
    const ev = ask(d, 'r-3', mcp, { command: 'ls', host: 'h1' }, { permission_suggestions: sugg });
    expect(optionIds(ev)).toEqual(['allow_once', 'allow_session', 'reject_once']);
    expect(remembers(ev)).toBe(false);
    d.answerPermission('r-3', { outcome: 'selected', optionId: 'allow_session' });
    expect(ask(d, 'r-4', mcp, { command: 'ls', host: 'h1' }, { permission_suggestions: sugg }).type).toBe('requestPermission');
    const ps = ask(d, 'r-5', 'PowerShell', { command: PS_A });
    expect(optionIds(ps)).toEqual(['allow_once', 'allow_session', 'reject_once']);
    expect(remembers(ps)).toBe(true);
    d.answerPermission('r-5', { outcome: 'selected', optionId: 'allow_once' });
    expect(ask(d, 'r-6', 'PowerShell', { command: PS_A }).type).toBe('requestPermission');
    d.answerPermission('r-6', { outcome: 'selected', optionId: 'reject_once' });
    expect(ask(d, 'r-7', 'PowerShell', { command: PS_A }).type).toBe('requestPermission');
  });

  it('description 말고 다른 칸이 다르면 카드(dangerouslyDisableSandbox·run_in_background·timeout), 키 순서만 다르면 같은 키', () => {
    const d = started();
    allowedOnce(d, 'Bash', 'touch a.txt');
    for (const [i, extra] of [{ dangerouslyDisableSandbox: true }, { run_in_background: true }, { timeout: 1000 }].entries()) {
      expect(ask(d, `r-x${i}`, 'Bash', { command: 'touch a.txt', ...extra }).type).toBe('requestPermission');
    }
    expect(ask(d, 'r-desc', 'Bash', { description: '다른 설명', command: 'touch a.txt' }).type).toBe('permissionAutoAllowed');
    const e = started();
    ask(e, 'r-1', 'PowerShell', { command: 'x', opt: { b: 1, a: [2, { d: 1, c: 2 }] } });
    e.answerPermission('r-1', { outcome: 'selected', optionId: 'allow_session' });
    expect(ask(e, 'r-2', 'PowerShell', { opt: { a: [2, { c: 2, d: 1 }], b: 1 }, command: 'x' }).type).toBe('permissionAutoAllowed');
    expect(ask(e, 'r-3', 'PowerShell', { command: 'x', opt: { b: 1, a: [{ d: 1, c: 2 }, 2] } }).type).toBe('requestPermission');
  });

  it('blocked_path 만 다르면 카드, 같으면 자동 허용', () => {
    const d = started();
    allowedOnce(d, 'PowerShell', PS_A, { blocked_path: 'C:\\밖\\a.txt' });
    expect(ask(d, 'r-2', 'PowerShell', { command: PS_A }, { blocked_path: 'C:\\밖\\a.txt' }).type).toBe('permissionAutoAllowed');
    expect(ask(d, 'r-3', 'PowerShell', { command: PS_A }, { blocked_path: 'C:\\밖\\b.txt' }).type).toBe('requestPermission');
    expect(ask(d, 'r-4', 'PowerShell', { command: PS_A }).type).toBe('requestPermission');
  });

  it('답하기 전 같은 request_id 재사용 → 두 번째는 unknown + 거절 답, 첫 카드의 세션 허용은 첫 요청 키로', () => {
    const d = started();
    expect(ask(d, 'r-1', 'PowerShell', { command: PS_A }).type).toBe('requestPermission');
    const dup = one(d.decode(raw(req('r-1', 'PowerShell', { command: 'Remove-Item -Recurse -Force .\\' }))));
    expect(dup).toMatchObject({ type: 'unknown', reason: 'field', hint: 'can_use_tool/duplicate-id', answeredWithDefault: true, requestId: 'r-1',
      reply: { type: 'control_response', response: { subtype: 'error', request_id: 'r-1', error: 'Plenum 채팅이 처리하지 못하는 요청' } } });
    const ans = d.answerPermission('r-1', { outcome: 'selected', optionId: 'allow_session' }) as any;
    expect(ans.response.response.updatedInput).toEqual({ command: PS_A });
    expect(ask(d, 'r-2', 'PowerShell', { command: PS_A }).type).toBe('permissionAutoAllowed');
    expect(ask(d, 'r-3', 'PowerShell', { command: 'Remove-Item -Recurse -Force .\\' }).type).toBe('requestPermission');
    expect(ask(d, 'r-1', 'PowerShell', { command: 'Get-Date' }).type).toBe('requestPermission');
    expect(ask(d, 'r-q', 'Bash', { command: 'ls' }).type).toBe('requestPermission');
    d.decode(raw({ type: 'result', subtype: 'success', is_error: false, result: '', permission_denials: [] }));
    expect(ask(d, 'r-q', 'Bash', { command: 'ls' }).type).toBe('requestPermission');
    expect(d.stats().thrown).toBe(0);
  });
});

// ── 훅 명령·chatArgs ─────────────────────────────────────
const run = (file: string, args: string[], input: string) => new Promise<{ code: number | null; stdout: string }>((resolve) => {
  const child = execFile(file, args, { timeout: 10000 }, (err, stdout) => resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0, stdout }));
  child.stdin!.end(input);
});

describe('폴더 훅 명령', () => {
  it('(j) 큰따옴표는 코드 감싸기 2개뿐, $·백틱·! 없음, 끝 낱말이 nonce. nonce 는 16진수만', () => {
    const n = newHookNonce();
    expect(n).toMatch(/^[0-9a-f]{32}$/);
    expect(newHookNonce()).not.toBe(n);
    const cmd = hookCommand(n);
    expect(cmd.split('"').length - 1).toBe(2);
    expect(cmd.startsWith('node -e "')).toBe(true);
    expect(cmd.endsWith(`" ${n}`)).toBe(true);
    for (const bad of ['$', '`', '!', '%', '^', '\r', '\n']) expect(cmd).not.toContain(bad);
    expect(() => hookCommand('a b')).toThrow();
    expect(() => hookCommand('x"; rm -rf /')).toThrow();
    const s = JSON.parse(hookSettings(n));
    expect(s).toEqual({ hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: cmd, timeout: 5 }] }] } });
  });

  it.skipIf(process.platform === 'win32')('(j) sh -c 로 실제로 돌리면 stdin JSON → 표시 줄 한 줄, 깨진 입력·빈 입력은 아무것도 안 쓰고 exit 0', async () => {
    const n = newHookNonce();
    const cmd = hookCommand(n);
    const input = { session_id: 's', cwd: '/tmp/홍길동 폴더/sub', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls "$HOME" `x` !' }, tool_use_id: 'toolu_1' };
    const ok = await run('sh', ['-c', cmd], JSON.stringify(input));
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe(`PLENUM_CWD ${n} ${JSON.stringify({ c: '/tmp/홍길동 폴더/sub', i: 'toolu_1', t: 'Bash' })}\n`);
    // 드라이버가 그 줄을 받아들인다
    const d = createClaudeDriver({ hookNonce: n });
    expect(d.decode(raw(hookResp(ok.stdout, 'PreToolUse:Bash')))).toEqual([]);
    for (const bad of ['{깨진', '', 'null']) {
      const r = await run('sh', ['-c', cmd], bad);
      expect(r).toEqual({ code: 0, stdout: '' });
    }
  });

  it('(i) chatArgs: hookSettingsPath 가 있으면 --include-hook-events + --settings <경로>, 없거나 null 이면 없음', () => {
    const p = '/home/홍길동/.config/plenum/hooks/x.json';
    expect(chatArgs({ model: 'haiku', hookSettingsPath: p }, {}, 'linux', '/home/홍길동').slice(-3)).toEqual(['--include-hook-events', '--settings', p]);
    for (const off of [chatArgs({ model: 'haiku', hookSettingsPath: null }, {}, 'linux', '/home/홍길동'), chatArgs({ model: 'haiku' }, {}, 'linux', '/home/홍길동')]) {
      expect(off).not.toContain('--include-hook-events');
      expect(off).not.toContain('--settings');
    }
  });

  it('prepareHookSettings: <dir>/<id>.json 에 새 nonce 설정을 쓴다(폴더 만듦, 0600). cleanupHookFiles 는 .json 만 지운다', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), '홍길동 훅파일-'));
    const dir = path.join(root, '없는 폴더', 'hooks');
    const a = prepareHookSettings(dir, 'chat-1');
    const b = prepareHookSettings(dir, 'chat-2');
    expect(a.path).toBe(path.join(dir, 'chat-1.json'));
    expect(a.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(a.nonce).not.toBe(b.nonce);
    expect(fs.readFileSync(a.path, 'utf8')).toBe(hookSettings(a.nonce));
    if (process.platform !== 'win32') expect(fs.statSync(a.path).mode & 0o777).toBe(0o600);
    expect(() => prepareHookSettings(dir, '../밖')).toThrow();
    expect(hookPathOk(a.path)).toBe(true);
    for (const bad of ['C:\\a"b', 'C:\\100%\\x', 'a\nb']) expect(hookPathOk(bad)).toBe(false);
    // 정리: hooks/ 의 .json 만
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
    expect(hookDir(path.join(root, '없는 폴더'))).toBe(dir);
    cleanupHookFiles(path.join(root, '없는 폴더'));
    expect(fs.readdirSync(dir)).toEqual(['keep.txt']);
    cleanupHookFiles(path.join(root, '아예 없음')); // 폴더가 없어도 조용히
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
      { dir: 'out', msg: hookResp(mark('tu-r-1', 'PowerShell', projDir, '__PLENUM_NONCE__')) },
      { dir: 'out', msg: req('r-1', 'PowerShell', { command: PS_A }, { permission_suggestions: SUGG_DIRS }) },
      { dir: 'in', msg: { type: 'control_response', response: { request_id: 'r-1' } } },
      { dir: 'out', msg: toolUse('tu-r-2', 'PowerShell', { command: PS_A }) },
      { dir: 'out', msg: hookResp(mark('tu-r-2', 'PowerShell', projDir, '__PLENUM_NONCE__')) },
      { dir: 'out', msg: req('r-2', 'PowerShell', { command: PS_A }, { permission_suggestions: SUGG_DIRS }) },
      { dir: 'in', msg: { type: 'control_response', response: { request_id: 'r-2' } } },
      // 하위 폴더로 옮긴 뒤 같은 명령: 훅 cwd 가 다르다 → 카드
      { dir: 'out', msg: hookResp(mark('tu-r-3', 'PowerShell', path.join(projDir, 'sub'), '__PLENUM_NONCE__')) },
      { dir: 'out', msg: req('r-3', 'PowerShell', { command: PS_A }) },
      { dir: 'in', msg: { type: 'control_response', response: { request_id: 'r-3' } } },
      // 다른 명령
      { dir: 'out', msg: hookResp(mark('tu-r-4', 'PowerShell', projDir, '__PLENUM_NONCE__')) },
      { dir: 'out', msg: req('r-4', 'PowerShell', { command: PS_B }) },
      { dir: 'in', msg: { type: 'control_response', response: { request_id: 'r-4' } } },
      { dir: 'out', msg: { type: 'result', subtype: 'success', is_error: false, result: '끝', permission_denials: [] } },
      { dir: 'exit', code: 0 },
    ]);
    const cfgDir = path.join(root, '설정');
    // 이전 실행의 잔여 파일: 매니저를 만들 때 지운다
    fs.mkdirSync(hookDir(cfgDir), { recursive: true });
    fs.writeFileSync(path.join(hookDir(cfgDir), 'old-chat.json'), '{}');
    const m = createChatManager({ cfgDir, env: fake.env({ script: file, helpHooks: true }), closeWaitMs: 3000 });
    expect(fs.readdirSync(hookDir(cfgDir))).toEqual([]);
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
    expect((c3.card as any).input.command).toBe(PS_A);
    expect(m.get(id)!.state).toBe('waiting');
    m.respond(id, { requestId: 'r-3', action: 'allow' });
    const c4 = await waitEvent(m, id, 'card', (e) => e.card.requestId === 'r-4');
    expect((c4.card as any).input.command).toBe(PS_B);
    m.respond(id, { requestId: 'r-4', action: 'allow' });
    await waitEvent(m, id, 'result');

    // 받은 인자: 훅 플래그와 settings, 그 nonce 로 드라이버가 대조했다
    const args = fake.argsCalls()[0].args;
    expect(args).toContain('--include-hook-events');
    // --settings 는 <설정 폴더>/hooks/<chatId>.json 파일 경로. 채팅이 사는 동안 있고 끝나면 지운다
    const settingsPath = args[args.indexOf('--settings') + 1];
    expect(settingsPath).toBe(path.join(hookDir(cfgDir), `${id}.json`));
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.PreToolUse[0].matcher).toBe('Bash|PowerShell');
    const evs = events(m, id);
    expect(evs.filter((e) => e.type === 'card').map((e) => (e as any).card.requestId)).toEqual(['r-1', 'r-3', 'r-4']);
    // 우리 훅 줄은 카드·이벤트를 만들지 않는다
    expect(evs.filter((e) => e.type === 'notice')).toEqual([]);
    // 자동 허용은 카드 대기 수·상태에 영향 없음
    expect(evs.filter((e) => e.type === 'state').map((e) => (e as any).state)).toEqual(['starting', 'running', 'waiting', 'running', 'waiting', 'running', 'waiting', 'running', 'idle']);
    const answers = fake.stdin().filter((x) => x.type === 'control_response');
    expect(answers).toEqual([
      { type: 'control_response', response: { subtype: 'success', request_id: 'r-1', response: { behavior: 'allow', updatedInput: { command: PS_A } } } },
      { type: 'control_response', response: { subtype: 'success', request_id: 'r-2', response: { behavior: 'allow', updatedInput: { command: PS_A } } } },
      { type: 'control_response', response: { subtype: 'success', request_id: 'r-3', response: { behavior: 'allow', updatedInput: { command: PS_A } } } },
      { type: 'control_response', response: { subtype: 'success', request_id: 'r-4', response: { behavior: 'allow', updatedInput: { command: PS_B } } } },
    ]);
    // 자동 허용한 요청에는 답할 카드가 없다
    await expect(Promise.resolve().then(() => m.respond(id, { requestId: 'r-2', action: 'allow' }))).rejects.toMatchObject({ status: 404 });
    // 화면: 자동 허용 줄
    const v = emptyView();
    for (const e of evs) applyEvent(v, e);
    expect(v.items.filter((x) => x.k === 'auto')).toEqual([{ k: 'auto', key: expect.any(String), summary: `PowerShell ${PS_A}` }]);
    await m.close(id);
    expect(m.get(id)!.state).toBe('ended');
    expect(fs.existsSync(settingsPath)).toBe(false);
  }, 30000);

  it.each(['100%', 'a"b'].filter((n) => process.platform !== 'win32' || !n.includes('"')))('설정 폴더 경로에 %s 가 있으면 훅 없음(인자·파일 없음) + 안내, remembers false', async (bad) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), '홍길동 훅경로-'));
    const projDir = path.join(root, 'p');
    fs.mkdirSync(projDir);
    const fake = makeFakeStreamClaude(path.join(root, '가짜'));
    const file = path.join(root, 'bad.jsonl');
    writeScript(file, [
      { dir: 'in', msg: { type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } } }, { dir: 'in', msg: { type: 'user' } },
      { dir: 'out', msg: INIT(projDir) },
      { dir: 'out', msg: hookResp(mark('tu-r-1', 'PowerShell', projDir, '__PLENUM_NONCE__')) },
      { dir: 'out', msg: req('r-1', 'PowerShell', { command: PS_A }) },
      { dir: 'in', msg: { type: 'control_response', response: { request_id: 'r-1' } } },
      { dir: 'out', msg: { type: 'result', subtype: 'success', is_error: false, result: '끝', permission_denials: [] } },
      { dir: 'exit', code: 0 },
    ]);
    const cfgDir = path.join(root, `설정 ${bad}`);
    const m = createChatManager({ cfgDir, env: fake.env({ script: file, helpHooks: true }), closeWaitMs: 3000 });
    managers.push(m);
    const id = (await m.start({ id: 'p1', path: projDir }, { text: '시작' })).chat.chatId;
    const c = await waitEvent(m, id, 'card');
    expect((c.card as any).remembers).toBe(false);
    m.respond(id, { requestId: 'r-1', action: 'allow' });
    await waitEvent(m, id, 'result');
    const args = fake.argsCalls()[0].args;
    expect(args).not.toContain('--include-hook-events');
    expect(args).not.toContain('--settings');
    expect(fs.existsSync(hookDir(cfgDir))).toBe(false);
    expect(events(m, id).some((e) => e.type === 'notice' && e.level === 'warn' && e.message.includes('폴더 훅을 붙이지 않았다'))).toBe(true);
  }, 30000);

  it('(i) claude 도움말에 --include-hook-events 가 없으면 플래그·settings 없음 → 훅 줄이 와도 자동 허용 없음(remembers false)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), '홍길동 훅없음-'));
    const projDir = path.join(root, 'p');
    fs.mkdirSync(projDir);
    const fake = makeFakeStreamClaude(path.join(root, '가짜'));
    const file = path.join(root, 'nohook.jsonl');
    writeScript(file, [
      { dir: 'in', msg: { type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } } }, { dir: 'in', msg: { type: 'user' } },
      { dir: 'out', msg: INIT(projDir) },
      { dir: 'out', msg: hookResp(mark('tu-r-1', 'PowerShell', projDir, '__PLENUM_NONCE__')) },
      { dir: 'out', msg: req('r-1', 'PowerShell', { command: PS_A }) },
      { dir: 'in', msg: { type: 'control_response', response: { request_id: 'r-1' } } },
      { dir: 'out', msg: { type: 'result', subtype: 'success', is_error: false, result: '끝', permission_denials: [] } },
      { dir: 'exit', code: 0 },
    ]);
    const m = createChatManager({ cfgDir: path.join(root, '설정'), env: fake.env({ script: file }), closeWaitMs: 3000 });
    managers.push(m);
    const id = (await m.start({ id: 'p1', path: projDir }, { text: '시작' })).chat.chatId;
    const c = await waitEvent(m, id, 'card');
    expect((c.card as any).remembers).toBe(false);
    expect((c.card as any).sessionAllow).toBe(false);
    m.respond(id, { requestId: 'r-1', action: 'allow' });
    await waitEvent(m, id, 'result');
    const args = fake.argsCalls()[0].args;
    expect(args).not.toContain('--include-hook-events');
    expect(args).not.toContain('--settings');
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
