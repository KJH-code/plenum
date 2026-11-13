// 채팅 e2e·스크린샷 준비: 진짜 녹화 경로, 합성 대본(한도 rejected·모르는 요청), 지난 세션 기록 복사.
import fs from 'node:fs';
import path from 'node:path';
import { APP } from '../test/helpers.ts';
import { writeScript } from '../test/fakeclaudeStream.ts';

export const REC = (name: string) => path.join(APP, 'test', 'fixtures', 'stream', name);
const HISTORY = path.join(APP, 'test', 'fixtures', 'history', 'projects');

const HELLO = [{ dir: 'in', msg: { type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } } }, { dir: 'in', msg: { type: 'user' } }] as const;
const INIT = (sid: string) => ({ type: 'system', subtype: 'init', session_id: sid, claude_code_version: '2.1.323', model: 'claude-haiku-5-5', permissionMode: 'default' });
const RESULT = (text: string) => ({ type: 'result', subtype: 'success', is_error: false, result: text, permission_denials: [] });
const TEXT = (id: string, text: string) => ({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null });

// 5시간 한도 rejected (리셋은 resetsAt 초)
export function limitScript(file: string, resetsAt: number) {
  writeScript(file, [...HELLO, { dir: 'out', msg: INIT('aaaaaaaa-1111-4222-8333-444444444444') },
    { dir: 'out', msg: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, resetsAt, status: 'rejected' }, seven_day: { utilization: 0.41, resetsAt: resetsAt + 86400 * 3, status: 'allowed' } } } } },
    { dir: 'out', msg: TEXT('msg_limit', '사용 한도에 걸렸다.') },
    { dir: 'out', msg: RESULT('사용 한도에 걸렸다.') }, { dir: 'exit', code: 0 }]);
}

// 채팅이 처리 못 하는 control_request
export function unknownScript(file: string) {
  writeScript(file, [...HELLO, { dir: 'out', msg: INIT('bbbbbbbb-1111-4222-8333-444444444444') },
    { dir: 'out', msg: TEXT('msg_unknown', '확인할 게 있다.') },
    { dir: 'out', msg: { type: 'control_request', request_id: 'el-1', request: { subtype: 'elicit_something', foo: 1 } } },
    { dir: 'in', msg: { type: 'control_response', response: { request_id: 'el-1' } } },
    { dir: 'out', msg: RESULT('확인할 게 있다.') }, { dir: 'exit', code: 0 }]);
}

// 진짜 기록(fixtures/history) 한 세션을 claudeHome 으로 복사하고 줄의 cwd 를 이 프로젝트로 바꾼다
export function copyHistory(claudeHome: string, projectPath: string, folder: string, sid: string) {
  const src = path.join(HISTORY, folder, `${sid}.jsonl`);
  const out = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean).map((l) => {
    const j = JSON.parse(l);
    if (typeof j.cwd === 'string') j.cwd = projectPath;
    return JSON.stringify(j);
  });
  const dest = path.join(claudeHome, 'projects', 'e2e-project', `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, out.join('\n') + '\n');
}
