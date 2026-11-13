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

// 5시간 한도 rejected (리셋은 resetsAt 초). null 이면 resetsAt 칸을 아예 뺀다(리셋 시각 모름)
export function limitScript(file: string, resetsAt: number | null) {
  const at = (n: number | null) => (n === null ? {} : { resetsAt: n });
  writeScript(file, [...HELLO, { dir: 'out', msg: INIT('aaaaaaaa-1111-4222-8333-444444444444') },
    { dir: 'out', msg: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', ...at(resetsAt), rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1, ...at(resetsAt), status: 'rejected' }, seven_day: { utilization: 0.41, ...at(resetsAt === null ? null : resetsAt + 86400 * 3), status: 'allowed' } } } } },
    { dir: 'out', msg: TEXT('msg_limit', '사용 한도에 걸렸다.') },
    { dir: 'out', msg: RESULT('사용 한도에 걸렸다.') }, { dir: 'exit', code: 0 }]);
}

// 글 한 번 답하고 끝(sid 세션). 이어 보내기·다시 시작 흐름용
export function replyScript(file: string, sid: string, reply: string) {
  writeScript(file, [...HELLO, { dir: 'out', msg: INIT(sid) },
    { dir: 'out', msg: TEXT(`msg_${reply.length}`, reply) }, { dir: 'out', msg: RESULT(reply) }, { dir: 'exit', code: 0 }]);
}

// 두 턴(sid 세션): 첫 글에 답한 뒤 다음 user 를 기다렸다 다시 답한다. 살아 있는 채팅에 이어하기(전달) 흐름용
export function twoTurnScript(file: string, sid: string) {
  writeScript(file, [...HELLO, { dir: 'out', msg: INIT(sid) },
    { dir: 'out', msg: TEXT('msg_turn1', '첫 턴 답') }, { dir: 'out', msg: RESULT('첫 턴 답') },
    { dir: 'in', msg: { type: 'user' } },
    { dir: 'out', msg: TEXT('msg_turn2', '둘째 턴 답') }, { dir: 'out', msg: RESULT('둘째 턴 답') }, { dir: 'exit', code: 0 }]);
}

// 승인 카드 하나를 내고 답을 기다린다(sid 세션). 카드 대기 채팅을 목록에서 이어하기(409 awaiting-card) 흐름용
export function cardScript(file: string, sid: string) {
  writeScript(file, [...HELLO, { dir: 'out', msg: INIT(sid) },
    { dir: 'out', msg: { type: 'control_request', request_id: 'card-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch 카드.txt', description: '카드 대기' }, permission_suggestions: [] } } },
    { dir: 'in', msg: { type: 'control_response', response: { request_id: 'card-1' } } },
    { dir: 'out', msg: TEXT('msg_card', '카드 답을 받았다') }, { dir: 'out', msg: RESULT('카드 답을 받았다') }, { dir: 'exit', code: 0 }]);
}

// 채팅이 처리 못 하는 control_request
export function unknownScript(file: string) {
  writeScript(file, [...HELLO, { dir: 'out', msg: INIT('bbbbbbbb-1111-4222-8333-444444444444') },
    { dir: 'out', msg: TEXT('msg_unknown', '확인할 게 있다.') },
    { dir: 'out', msg: { type: 'control_request', request_id: 'el-1', request: { subtype: 'elicit_something', foo: 1 } } },
    { dir: 'in', msg: { type: 'control_response', response: { request_id: 'el-1' } } },
    { dir: 'out', msg: RESULT('확인할 게 있다.') }, { dir: 'exit', code: 0 }]);
}

// 진짜 기록(fixtures/history) 한 세션을 claudeHome 으로 복사하고 줄의 cwd 를 이 프로젝트로 바꾼다.
// asSid: 다른 세션 ID 로 복사(녹화 채팅과 같은 ID 라 "실행 중"으로 잡히지 않게)
export function copyHistory(claudeHome: string, projectPath: string, folder: string, sid: string, asSid = sid) {
  const src = path.join(HISTORY, folder, `${sid}.jsonl`);
  const out = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean).map((l) => {
    const j = JSON.parse(l);
    if (typeof j.cwd === 'string') j.cwd = projectPath;
    if (j.sessionId === sid) j.sessionId = asSid;
    return JSON.stringify(j);
  });
  const dest = path.join(claudeHome, 'projects', 'e2e-project', `${asSid}.jsonl`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, out.join('\n') + '\n');
}
