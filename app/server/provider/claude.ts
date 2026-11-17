// Claude Code 직접 드라이버: `claude -p --input-format stream-json --output-format stream-json` 의 stdout 한 줄을
// 내부 이벤트(provider/events.ts)로 바꾸고, stdin 에 쓸 답 원문을 만든다. 채팅마다 하나 만든다(상태: 메시지 id·작업 id·카드 입력).
// 줄 모양 근거: test/fixtures/providers/claude/2.1.323/*.jsonl (진짜 claude 녹화). 모르는 줄은 'unknown' 으로 올린다.
import { toolLabel, type LimitWindow as ChatLimitWindow, type Limits, type Question, type SessionRule } from '../chatTypes.ts';
import type {
  Driver, LimitWindow, PermissionOption, PermissionOutcome, ProviderEvent, QuestionOutcome, Raw, StopReason, ToolKind, UnknownEvent, UsageEvent,
} from './events.ts';

// 거부 deny message 머리. "훅이 막았다"로 읽히지 않게(2.1.248 haiku) 사람이 거부했다고 못 박는다
export const DENIED = '사용자가 직접 거부했다(훅 아님)';
// 처리하지 못하는 control_request 에 돌려주는 error 문구
const UNHANDLED = 'Plenum 채팅이 처리하지 못하는 요청';

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// ── 분기 도달 계측 (계약 테스트가 fixture 전체를 돈 뒤 안 닿은 분기를 출력한다). 동작에는 쓰지 않는다
export const BRANCHES = [
  'parse', 'throw',
  'system/init', 'system/task', 'system/task-no-id', 'system/other',
  'stream/no-event', 'stream/sub', 'stream/message_start', 'stream/text_delta', 'stream/text_delta-no-id', 'stream/other',
  'assistant/no-content', 'assistant/text', 'assistant/tool_use', 'assistant/other-block',
  'user/no-content', 'user/tool_result',
  'control_request/field', 'control_request/question', 'control_request/permission', 'control_request/permission-session', 'control_request/other',
  'control_response',
  'rate_limit/field', 'rate_limit/usage', 'rate_limit/rejected',
  'result',
  'unknown-type',
] as const;
export type Branch = (typeof BRANCHES)[number];
export const branchHits = new Map<Branch, number>();
const hit = (b: Branch) => { branchHits.set(b, (branchHits.get(b) ?? 0) + 1); };

// ── 칸 변환 (옮기기 전 chat.ts 와 같은 규칙) ─────────────
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
  return '';
}

// task_updated patch.status / task_notification status → 끝 상태. 끝이 아니면 running
function taskStatus(status: unknown): 'running' | 'completed' | 'failed' {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'killed' || status === 'error') return 'failed';
  return 'running';
}

const pctOf = (u: number) => Math.round(u * 1000) / 10;
function windowStatus(s: string | null): LimitWindow['status'] {
  if (s === 'rejected') return 'rejected';
  if (s === 'allowed_warning') return 'warning';
  if (s === 'allowed') return 'ok';
  return null;
}
const WINDOW_LABEL: Record<string, string> = { five_hour: '5시간', seven_day: '7일' };

// rate_limit_info → 창 목록 + 걸린 창. info 가 객체가 아니면 null
function usageFrom(info: unknown): { windows: LimitWindow[]; rejected: { window: string; resetsAt: number | null } | null } | null {
  if (!isObj(info)) return null;
  const uw = isObj(info.unifiedWindows) ? info.unifiedWindows : {};
  const windows: LimitWindow[] = [];
  for (const id of Object.keys(uw)) {
    const w = uw[id];
    if (!isObj(w) || typeof w.utilization !== 'number') continue;
    const rawStatus = str(w.status);
    windows.push({ id, label: WINDOW_LABEL[id] ?? id, usedPct: pctOf(w.utilization), resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null, status: windowStatus(rawStatus), rawStatus });
  }
  let rejected: { window: string; resetsAt: number | null } | null = null;
  for (const name of Object.keys(uw).sort()) {
    const w = uw[name];
    if (isObj(w) && w.status === 'rejected') { rejected = { window: name, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null }; break; }
  }
  if (!rejected && info.status === 'rejected') {
    rejected = { window: str(info.rateLimitType) ?? 'unknown', resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null };
  }
  return { windows, rejected };
}

// usage 이벤트 → 지금 화면의 Limits (five_hour·seven_day 만, 칸이 없으면 undefined)
export function limitsFromUsage(u: { windows?: LimitWindow[]; rejected?: { window: string; resetsAt: number | null } | null }, now = Date.now()): Limits {
  const win = (id: string): ChatLimitWindow | undefined => {
    const w = (u.windows ?? []).find((x) => x.id === id);
    return w && w.usedPct !== null ? { pct: w.usedPct, resetsAt: w.resetsAt, status: w.rawStatus ?? null } : undefined;
  };
  return { fiveHour: win('five_hour'), sevenDay: win('seven_day'), receivedAt: now, rejected: u.rejected ?? null };
}

export function parseLimits(info: unknown, now = Date.now()): Limits | null {
  const u = usageFrom(info);
  return u ? limitsFromUsage(u, now) : null;
}

function questionsFrom(input: unknown): Question[] {
  const qs = isObj(input) && Array.isArray(input.questions) ? input.questions : [];
  return qs.filter(isObj).map((q) => ({
    question: String(q.question ?? ''),
    ...(typeof q.header === 'string' ? { header: q.header } : {}),
    multiSelect: !!q.multiSelect,
    options: (Array.isArray(q.options) ? q.options : []).filter(isObj).map((o: any) => ({
      label: String(o.label ?? ''),
      ...(typeof o.description === 'string' ? { description: o.description } : {}),
      recommended: /\((추천|Recommended)\)/i.test(String(o.label ?? '')),
    })),
  }));
}

function diffFrom(toolName: string, input: unknown): { path: string; old: string; new: string } | undefined {
  if (!isObj(input)) return undefined;
  const p = String(input.file_path ?? '');
  if (toolName === 'Edit') return { path: p, old: String(input.old_string ?? ''), new: String(input.new_string ?? '') };
  if (toolName === 'Write') return { path: p, old: '', new: String(input.content ?? '') };
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits.filter(isObj) : [];
    return { path: p, old: edits.map((e: any) => String(e.old_string ?? '')).join('\n'), new: edits.map((e: any) => String(e.new_string ?? '')).join('\n') };
  }
  return undefined;
}

// "이 세션 동안 허용"에 쓸 규칙: permission_suggestions 중 addRules 의 rules 만. setMode 등은 버린다
// (그대로 session 으로 보내면 setMode acceptEdits 까지 가서 그 뒤 rm 이 승인 없이 실행된다)
function sessionRulesFrom(suggestions: unknown): SessionRule[] {
  const out: SessionRule[] = [];
  for (const s of Array.isArray(suggestions) ? suggestions : []) {
    if (!isObj(s) || s.type !== 'addRules' || !Array.isArray(s.rules)) continue;
    for (const r of s.rules) {
      if (isObj(r) && typeof r.toolName === 'string') out.push({ toolName: r.toolName, ...(typeof r.ruleContent === 'string' ? { ruleContent: r.ruleContent } : {}) });
    }
  }
  return out;
}

// 도구 이름 → kind. 승인 카드·요약은 이름이 아니라 command 칸 유무로 다루므로(Windows PowerShell) 여기 값은 참고용
const TOOL_KIND: Record<string, ToolKind> = {
  Read: 'read', NotebookRead: 'read', Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit',
  Grep: 'search', Glob: 'search', LS: 'search', Bash: 'execute', PowerShell: 'execute', WebFetch: 'fetch', WebSearch: 'fetch',
};
const kindOf = (name: string, input: unknown): ToolKind => TOOL_KIND[name] ?? (isObj(input) && typeof input.command === 'string' ? 'execute' : 'other');

// interrupted: 이번 턴에 드라이버가 interrupt() 원문을 만들었음. 그 뒤 오는 error_during_execution 은 사용자가 멈춘 것(cancelled)
function stopReasonOf(subtype: string, isError: boolean, interrupted: boolean): StopReason {
  if (interrupted && subtype === 'error_during_execution') return 'cancelled';
  if (subtype === 'error_max_turns') return 'max_turn_requests';
  if (isError || subtype.startsWith('error')) return 'error';
  return 'end_turn';
}

// decode 안에서 예외가 난 줄: 원문을 다시 안전하게 읽어 답을 기다리는 control_request 인지 본다.
// JSON.parse 결과라 getter 는 없다. 그래도 String() 은 쓰지 않는다({toString:1} 같은 값에서 또 터진다) — typeof 검사만
function thrownRequest(text: string): { requestId: string; subtype: string | null } | null {
  let m: unknown;
  try { m = JSON.parse(text); } catch { return null; }
  if (!isObj(m) || m.type !== 'control_request' || typeof m.request_id !== 'string') return null;
  const sub = isObj(m.request) ? m.request.subtype : undefined;
  return { requestId: m.request_id, subtype: typeof sub === 'string' ? sub : null };
}

// ── 드라이버 ────────────────────────────────────────────
export function createClaudeDriver() {
  let lastMessageId: string | null = null;
  let sessionId: string | null = null;
  const taskToTool = new Map<string, string>();
  const pending = new Map<string, { input: unknown; sessionRules: SessionRule[] }>();
  let intN = 0;
  let interrupted = false;                     // 이번 턴에 interrupt() 를 만들었음. result 를 받으면 내린다
  let thrown = 0;                              // decode 가 안에서 잡은 예외 수(계약 테스트 (b) 가 0 인지 본다)

  const base = () => ({ seq: 0, at: 0, sessionId });
  const unknown = (raw: Raw, reason: UnknownEvent['reason'], hint: string | null, extra: Partial<UnknownEvent> = {}): UnknownEvent =>
    ({ ...base(), type: 'unknown', raw, reason, hint, answeredWithDefault: false, ...extra });
  const success = (requestId: string, response: Record<string, unknown>) =>
    ({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  // 처리하지 못하는 요청에 돌려주는 거절 답(답을 안 하면 claude 가 멈춘다)
  const unhandled = (requestId: string) =>
    ({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: UNHANDLED } });

  function decodeSystem(raw: Raw, m: Record<string, any>): ProviderEvent[] {
    if (m.subtype === 'init') {
      hit('system/init');
      const sid = str(m.session_id);
      if (sid !== null) sessionId = sid;
      const permissionMode = str(m.permissionMode);
      return [{
        ...base(), type: 'sessionStarted', sessionId: sid ?? '', model: str(m.model), mode: permissionMode, resumed: false,
        version: str(m.claude_code_version), permissionMode, ...(sid === null ? { noSessionId: true as const } : {}),
      }];
    }
    if (m.subtype === 'task_started' || m.subtype === 'task_progress' || m.subtype === 'task_updated' || m.subtype === 'task_notification') {
      const taskId = str(m.task_id);
      const id = str(m.tool_use_id) ?? (taskId ? taskToTool.get(taskId) ?? null : null);
      if (!id) { hit('system/task-no-id'); return []; }
      hit('system/task');
      if (taskId) taskToTool.set(taskId, id);
      const status = m.subtype === 'task_updated' ? taskStatus(isObj(m.patch) ? m.patch.status : null)
        : m.subtype === 'task_notification' ? taskStatus(m.status) : 'running';
      return [{
        ...base(), type: 'task', ext: true, taskId: taskId ?? '', parentToolCallId: id, name: str(m.subagent_type),
        description: m.subtype === 'task_started' ? str(m.description) : null, status, background: !!m.is_backgrounded,
      }];
    }
    hit('system/other');
    return [unknown(raw, 'event', `system/${String(m.subtype ?? '')}`)];
  }

  function decodeControlRequest(raw: Raw, m: Record<string, any>): ProviderEvent[] {
    const requestId = str(m.request_id);
    const req = m.request;
    if (!requestId || !isObj(req)) { hit('control_request/field'); return [unknown(raw, 'field', 'control_request')]; }
    if (req.subtype !== 'can_use_tool') {
      hit('control_request/other');
      // 답을 안 하면 claude 가 멈춘다 → error 로 거절하는 답을 같이 올린다(앱이 쓴다)
      return [unknown(raw, 'event', String(req.subtype ?? ''), { answeredWithDefault: true, reply: unhandled(requestId), requestId })];
    }
    const toolName = String(req.tool_name ?? '');
    const toolUseId = str(req.tool_use_id) ?? undefined;
    if (toolName === 'AskUserQuestion') {
      hit('control_request/question');
      pending.set(requestId, { input: req.input, sessionRules: [] });
      return [{
        ...base(), type: 'elicitation', mode: 'form', requestId,
        questions: questionsFrom(req.input).map((q) => ({ ...q, allowFreeText: true })),
        ext: { claude: { ...(toolUseId !== undefined ? { toolUseId } : {}) } },
      }];
    }
    hit('control_request/permission');
    const sessionRules = sessionRulesFrom(req.permission_suggestions);
    pending.set(requestId, { input: req.input, sessionRules });
    const options: PermissionOption[] = [{ optionId: 'allow_once', name: '허용', kind: 'allow_once', scope: 'once' }];
    if (sessionRules.length) {
      hit('control_request/permission-session');
      options.push({ optionId: 'allow_session', name: '이 세션 동안 허용', kind: 'allow_always', scope: 'session' });
    }
    options.push({ optionId: 'reject_once', name: '거부', kind: 'reject_once', scope: 'once' });
    const diff = diffFrom(toolName, req.input);
    return [{
      ...base(), type: 'requestPermission', requestId,
      toolCall: { toolCallId: toolUseId ?? '', title: toolLabel(toolName, req.input), kind: kindOf(toolName, req.input), toolName, rawInput: req.input },
      options,
      ...(diff ? { diff: [diff] } : {}),
      ...(typeof req.description === 'string' ? { reason: req.description } : {}),
      ext: { claude: { sessionRules, ...(toolUseId !== undefined ? { toolUseId } : {}) } },
    }];
  }

  function decodeLine(raw: Raw): ProviderEvent[] {
    let m: any;
    try { m = JSON.parse(raw.text); } catch { hit('parse'); return [unknown(raw, 'parse', null)]; }
    if (!isObj(m)) { hit('parse'); return [unknown(raw, 'parse', null)]; }
    switch (m.type) {
      case 'system': return decodeSystem(raw, m);
      case 'stream_event': {
        const e = m.event;
        if (!isObj(e)) { hit('stream/no-event'); return [unknown(raw, 'field', 'stream_event')]; }
        if (m.parent_tool_use_id != null) { hit('stream/sub'); return []; }
        if (e.type === 'message_start' && isObj(e.message) && typeof e.message.id === 'string') { hit('stream/message_start'); lastMessageId = e.message.id; return []; }
        if (e.type === 'content_block_delta' && isObj(e.delta) && e.delta.type === 'text_delta' && typeof e.delta.text === 'string') {
          const messageId = str(m.api_message_id) ?? lastMessageId;
          if (!messageId) { hit('stream/text_delta-no-id'); return []; }
          hit('stream/text_delta');
          return [{ ...base(), type: 'message', role: 'agent', phase: 'chunk', messageId, index: Number(e.index) || 0, text: e.delta.text }];
        }
        hit('stream/other');
        return [];
      }
      case 'assistant': {
        const msg = m.message;
        if (!isObj(msg) || !Array.isArray(msg.content)) { hit('assistant/no-content'); return [unknown(raw, 'field', 'assistant')]; }
        const parent = str(m.parent_tool_use_id);
        const out: ProviderEvent[] = [];
        for (const b of msg.content) {
          if (!isObj(b)) continue;
          if (b.type === 'text' && typeof b.text === 'string' && parent === null && typeof msg.id === 'string') {
            hit('assistant/text');
            out.push({ ...base(), type: 'message', role: 'agent', phase: 'final', messageId: msg.id, text: b.text });
          } else if (b.type === 'tool_use' && typeof b.id === 'string') {
            hit('assistant/tool_use');
            const name = String(b.name ?? '');
            out.push({
              ...base(), type: 'toolCall', toolCallId: b.id, title: toolLabel(name, b.input), kind: kindOf(name, b.input), status: 'pending', toolName: name, rawInput: b.input, parentToolCallId: parent,
              ...(typeof b.name === 'string' ? {} : { toolNameNotString: true as const }),
            });
          } else hit('assistant/other-block');
        }
        return out;
      }
      case 'user': {
        const content = isObj(m.message) ? m.message.content : null;
        if (!Array.isArray(content)) { hit('user/no-content'); return []; }
        const out: ProviderEvent[] = [];
        for (const b of content) {
          if (isObj(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            hit('user/tool_result');
            const isError = !!b.is_error;
            out.push({ ...base(), type: 'toolCall', toolCallId: b.tool_use_id, title: '', kind: 'other', status: isError ? 'failed' : 'completed', output: { text: toolResultText(b.content).slice(0, 2000), isError } });
          }
        }
        return out;
      }
      case 'control_request': return decodeControlRequest(raw, m);
      // 우리가 보낸 initialize·interrupt 에 대한 claude 의 답. 쓸 값이 없다
      case 'control_response': hit('control_response'); return [];
      case 'rate_limit_event': {
        const u = usageFrom(m.rate_limit_info);
        if (!u) { hit('rate_limit/field'); return [unknown(raw, 'field', 'rate_limit_event')]; }
        hit('rate_limit/usage');
        if (u.rejected) hit('rate_limit/rejected');
        const ev: UsageEvent = { ...base(), type: 'usage', windows: u.windows, ext: true, rejected: u.rejected };
        return [ev];
      }
      case 'result': {
        hit('result');
        const rawSubtype = String(m.subtype ?? '');
        const isError = !!m.is_error;
        const wasInterrupted = interrupted;
        interrupted = false;
        return [{
          ...base(), type: 'turnEnd', stopReason: stopReasonOf(rawSubtype, isError, wasInterrupted), text: str(m.result),
          deniedCount: Array.isArray(m.permission_denials) ? m.permission_denials.length : 0, rawSubtype, isError,
        }];
      }
      default:
        hit('unknown-type');
        return [unknown(raw, 'event', String(m.type ?? ''))];
    }
  }

  const driver: Driver & { stats: () => { thrown: number } } = {
    kind: 'claude-stream',
    decode(raw: Raw): ProviderEvent[] {
      try { return decodeLine(raw); } catch {
        hit('throw');
        thrown++;
        // 답을 기다리는 요청이면 반드시 거절로 답한다(안 하면 claude 가 영원히 기다린다)
        const r = thrownRequest(raw.text);
        if (r) return [unknown(raw, 'field', r.subtype, { thrown: true, answeredWithDefault: true, reply: unhandled(r.requestId), requestId: r.requestId })];
        return [unknown(raw, 'field', null, { thrown: true })];
      }
    },
    /** decode 가 안에서 잡은 예외 수. 0 이 아니면 드라이버 버그(계약 테스트 (b)) */
    stats: () => ({ thrown }),
    answerPermission(requestId: string, o: PermissionOutcome) {
      const p = pending.get(requestId);
      if (o.outcome === 'selected' && o.optionId === 'allow_once') return success(requestId, { behavior: 'allow', updatedInput: p?.input });
      if (o.outcome === 'selected' && o.optionId === 'allow_session') {
        return success(requestId, { behavior: 'allow', updatedInput: p?.input, updatedPermissions: [{ type: 'addRules', rules: p?.sessionRules ?? [], behavior: 'allow', destination: 'session' }] });
      }
      // 거부(그리고 cancelled·모르는 optionId): "사용자가" 를 밝힌다 — 그냥 message 만 주면 Claude 가 훅이 막은 것으로 이해했다(노트북 2.1.248)
      const reason = o.outcome === 'selected' ? o.message : undefined;
      return success(requestId, { behavior: 'deny', message: reason ? `${DENIED}. 이유: ${reason}` : `${DENIED}.` });
    },
    answerQuestion(requestId: string, o: QuestionOutcome) {
      if (o.action !== 'accept') return success(requestId, { behavior: 'deny', message: `${DENIED}.` });
      const input = pending.get(requestId)?.input;
      return success(requestId, { behavior: 'allow', updatedInput: { ...(isObj(input) ? input : {}), answers: o.answers } });
    },
    interrupt() {
      intN++;
      interrupted = true;
      return { type: 'control_request', request_id: `int-${intN}`, request: { subtype: 'interrupt' } };
    },
    initialize() {
      return { type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } };
    },
    prompt(text: string) {
      return { type: 'user', message: { role: 'user', content: text } };
    },
  };
  return driver;
}
export type ClaudeDriver = ReturnType<typeof createClaudeDriver>;
