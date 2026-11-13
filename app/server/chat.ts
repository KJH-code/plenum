// 프로젝트 창 안 채팅: `claude -p` stream-json 프로세스를 띄우고 stdout 줄을 ChatEvent 로 바꾼다.
// 질문·승인(can_use_tool)은 카드로 내보내고, 답은 control_response 로 stdin 에 돌려준다.
// 줄 모양 근거: test/fixtures/stream/*.jsonl (진짜 claude 녹화). 모르는 줄은 무시한다(죽지 않기).
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import {
  MIN_CLAUDE_VERSION, modeFromAnswer, modeFromSkill,
  type Card, type CardReply, type ChatEvent, type ChatInfo, type ChatRegistry, type ChatState, type LimitWindow, type Limits,
  type ModeName, type Question, type SessionRule, type WorkerRun, limitGate,
} from './chatTypes.ts';
import { claudeCaps, type ClaudeCaps } from './claudecaps.ts';
import { UserError } from './errors.ts';
import { commandFor, resolveCommand } from './open.ts';
import { addPid, killTree, killTreeNow, removePid } from './proc.ts';
import { readLimits, saveLimits, updateSession } from './store.ts';

export interface ChatDeps {
  terminalAlive(sessionId: string): boolean;
  workerModel(subagentType: string): string | null;
  caps(): Promise<ClaudeCaps>;                             // --effort 지원 여부 (effort 를 줄 때만 본다)
}
export interface StartOptions { text: string; model?: string; effort?: string; resume?: string }
export interface StartResult { chat: ChatInfo; warnings: string[]; forwarded?: boolean }
export interface ChatManagerOptions {
  cfgDir: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  closeWaitMs?: number;
  deps?: Partial<ChatDeps>;
}
// 이벤트 본문(seq·at 은 매니저가 붙인다)
type EventBody = ChatEvent extends infer E ? (E extends any ? Omit<E, 'seq' | 'at'> : never) : never;

export interface ChatManager extends ChatRegistry {
  // 이어하기 대상이 이미 살아 있는 채팅이면 글을 그 채팅에 보내고 forwarded: true
  start(project: { id: string; path: string }, opts: StartOptions): Promise<StartResult>;
  respond(chatId: string, reply: CardReply): ChatInfo;
  send(chatId: string, text: string): { chat: ChatInfo; warnings: string[] };
  interrupt(chatId: string): ChatInfo;
  subscribe(chatId: string, afterSeq: number, listener: (ev: ChatEvent) => void): () => void;
  list(projectId: string): ChatInfo[];
  get(chatId: string): ChatInfo | null;
  getLimits(): Limits | null;
  shutdownAll(capMs?: number): Promise<void>;          // 모든 채팅 close 병렬, 전체 상한(기본 10초)이 넘으면 트리째 종료
  killAllNow(): void;
}

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_RE = /^[a-z0-9.\-\[\]]{1,60}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONCURRENT = '같은 프로젝트에서 응답 중인 세션이 있다 — 같은 파일을 동시에 고칠 수 있다';
const SHUTDOWN_CAP_MS = 10000;
export const LIMIT_UNKNOWN_RESET = '사용 한도에 걸렸다는 신호가 왔지만 리셋 시각을 모른다 — 보내기는 막지 않는다';
const CARD_PENDING = '답을 기다리는 카드가 있다 — 그 채팅에서 먼저 답하기';

// "2.1.248" 비교. 숫자가 아닌 꼬리는 버린다
export function compareVersion(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((x) => parseInt(x, 10));
  const pb = b.split(/[.\-+]/).map((x) => parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

interface PendingCard { card: Card; input: unknown; resolved: boolean }
interface Chat {
  info: ChatInfo;
  projectId: string;
  child: ChildProcess;
  events: ChatEvent[];
  listeners: Set<(ev: ChatEvent) => void>;
  cards: Map<string, PendingCard>;
  workers: Map<string, WorkerRun>;
  taskToTool: Map<string, string>;
  lastMessageId: string | null;
  intN: number;
  closing: Promise<void> | null;
  exited: Promise<void>;
  stderr: string;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
  return '';
}

function workerEnd(status: unknown): 'done' | 'error' | null {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'killed' || status === 'error') return 'error';
  return null;
}

function limitWindow(w: unknown): LimitWindow | undefined {
  if (!isObj(w) || typeof w.utilization !== 'number') return undefined;
  return { pct: Math.round(w.utilization * 1000) / 10, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null, status: str(w.status) };
}

export function parseLimits(info: unknown, now = Date.now()): Limits | null {
  if (!isObj(info)) return null;
  const uw = isObj(info.unifiedWindows) ? info.unifiedWindows : {};
  const limits: Limits = { fiveHour: limitWindow(uw.five_hour), sevenDay: limitWindow(uw.seven_day), receivedAt: now, rejected: null };
  for (const name of Object.keys(uw).sort()) {
    const w = uw[name];
    if (isObj(w) && w.status === 'rejected') { limits.rejected = { window: name, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null }; break; }
  }
  if (!limits.rejected && info.status === 'rejected') {
    limits.rejected = { window: str(info.rateLimitType) ?? 'unknown', resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null };
  }
  return limits;
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

// claude 실행 인자 (테스트가 모양을 본다)
export function chatArgs(o: { model?: string; effort?: string; resume?: string }): string[] {
  // --permission-mode default: 사용자 설정의 defaultMode(acceptEdits 등)가 채팅에 새지 않게 명시한다
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', 'default'];
  if (o.model) args.push('--model', o.model);
  if (o.effort) args.push('--effort', o.effort);
  if (o.resume) args.push('--resume', o.resume);
  return args;
}

// 받은 env 에서 지금 세션 표시만 뺀다 (Plenum 을 Claude Code 안에서 띄웠을 때 자식이 그 세션으로 착각하지 않게).
// PLENUM_NOTIFY=0: 채팅 claude 의 훅이 Plenum 에 알리지 않게 한다(jh-kit 2.2.0 훅). init 보다 먼저 온 SessionStart 가
// 터미널 세션으로 잡혀 유령이 되는 것 방지. 새 객체에만 넣는다 — 서버·터미널 env 는 그대로
export function chatEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k === 'CLAUDE_CODE_SESSION_ID' || k === 'CLAUDE_CODE_REMOTE_SESSION_ID') continue;
    out[k] = v;
  }
  out.PLENUM_NOTIFY = '0';
  return out;
}

export function createChatManager(o: ChatManagerOptions): ChatManager {
  const { cfgDir, env } = o;
  const platform = o.platform ?? process.platform;
  const closeWaitMs = o.closeWaitMs ?? 8000;
  const deps: ChatDeps = { terminalAlive: () => false, workerModel: () => null, caps: () => claudeCaps(env, platform), ...o.deps };
  const chats = new Map<string, Chat>();
  const globalListeners = new Set<(chat: ChatInfo, ev: ChatEvent) => void>();
  let limits: Limits | null = readLimits(cfgDir);

  const info = (c: Chat): ChatInfo => ({ ...c.info });
  const must = (chatId: string): Chat => {
    const c = chats.get(chatId);
    if (!c) throw new UserError(404, '없는 채팅');
    return c;
  };

  function emit(c: Chat, body: EventBody) {
    const ev = { ...body, seq: c.info.lastSeq + 1, at: Date.now() } as ChatEvent;
    c.info.lastSeq = ev.seq;
    // 끝난 글이 오면 같은 메시지의 조각을 버퍼에서 지운다(재생을 가볍게)
    if (ev.type === 'assistant-text') c.events = c.events.filter((e) => !(e.type === 'text-delta' && e.messageId === ev.messageId));
    c.events.push(ev);
    for (const l of [...c.listeners]) { try { l(ev); } catch { /* 구독자 오류는 무시 */ } }
    const snap = info(c);
    for (const l of [...globalListeners]) { try { l(snap, ev); } catch { /* 무시 */ } }
  }
  function setState(c: Chat, state: ChatState) {
    if (c.info.state === state || c.info.state === 'ended') return;
    c.info.state = state;
    emit(c, { type: 'state', state });
  }
  function setMode(c: Chat, mode: ModeName) {
    c.info.mode = mode;
    emit(c, { type: 'mode', mode });
    if (c.info.sessionId) updateSession(cfgDir, c.info.sessionId, { mode, projectId: c.projectId });
  }
  function write(c: Chat, msg: unknown) {
    const s = c.child.stdin;
    if (!s || !s.writable || c.info.state === 'ended') throw new UserError(409, '채팅이 끝났다');
    s.write(JSON.stringify(msg) + '\n');
  }
  function pendingCount(c: Chat) { let n = 0; for (const p of c.cards.values()) if (!p.resolved) n++; return n; }
  function cancelPending(c: Chat) {
    for (const p of c.cards.values()) {
      if (p.resolved) continue;
      p.resolved = true;
      emit(c, { type: 'card-resolved', requestId: p.card.requestId, outcome: 'cancelled' });
    }
  }
  function concurrent(c: Chat): string[] {
    for (const other of chats.values()) {
      if (other !== c && other.projectId === c.projectId && (other.info.state === 'running' || other.info.state === 'waiting')) {
        emit(c, { type: 'notice', level: 'warn', code: 'concurrent', message: CONCURRENT });
        return [CONCURRENT];
      }
    }
    return [];
  }
  // 한도 규칙(limitGate): blocked → 429, warn → 막지 않고 경고(warnings + notice). c 가 없으면 검사만
  function gate(): string[] {
    const g = limitGate(limits);
    if (g.kind === 'blocked') throw new UserError(429, `사용 한도에 걸렸다 — ${new Date(g.resetsAt * 1000).toISOString()} 이후에 다시`);
    return g.kind === 'warn' ? [LIMIT_UNKNOWN_RESET] : [];
  }
  function warnLimit(c: Chat, warnings: string[]) {
    if (warnings.includes(LIMIT_UNKNOWN_RESET)) emit(c, { type: 'notice', level: 'warn', code: 'limit-rejected', message: LIMIT_UNKNOWN_RESET });
  }
  function sendUser(c: Chat, text: string) {
    write(c, { type: 'user', message: { role: 'user', content: text } });
    emit(c, { type: 'user', text });
  }

  function updateWorker(c: Chat, w: WorkerRun) { c.workers.set(w.id, w); emit(c, { type: 'worker', worker: { ...w } }); }

  function onLine(c: Chat, line: string) {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    if (!isObj(m)) return;
    switch (m.type) {
      case 'system': return onSystem(c, m);
      case 'stream_event': {
        const e = m.event;
        if (!isObj(e) || m.parent_tool_use_id != null) return;
        if (e.type === 'message_start' && isObj(e.message) && typeof e.message.id === 'string') c.lastMessageId = e.message.id;
        if (e.type === 'content_block_delta' && isObj(e.delta) && e.delta.type === 'text_delta' && typeof e.delta.text === 'string') {
          const messageId = str(m.api_message_id) ?? c.lastMessageId;
          if (messageId) emit(c, { type: 'text-delta', messageId, index: Number(e.index) || 0, text: e.delta.text });
        }
        return;
      }
      case 'assistant': {
        const msg = m.message;
        if (!isObj(msg) || !Array.isArray(msg.content)) return;
        const parent = str(m.parent_tool_use_id);
        for (const b of msg.content) {
          if (!isObj(b)) continue;
          if (b.type === 'text' && typeof b.text === 'string' && parent === null && typeof msg.id === 'string') {
            emit(c, { type: 'assistant-text', messageId: msg.id, text: b.text });
          } else if (b.type === 'tool_use' && typeof b.id === 'string') {
            emit(c, { type: 'tool', toolUseId: b.id, name: String(b.name ?? ''), input: b.input, parentToolUseId: parent });
            if (b.name === 'Skill' && isObj(b.input)) {
              const mode = modeFromSkill(b.input.skill);
              if (mode) setMode(c, mode);
            }
          }
        }
        return;
      }
      case 'user': {
        const content = isObj(m.message) ? m.message.content : null;
        if (!Array.isArray(content)) return;
        for (const b of content) {
          if (isObj(b) && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            emit(c, { type: 'tool-result', toolUseId: b.tool_use_id, isError: !!b.is_error, text: toolResultText(b.content).slice(0, 2000) });
          }
        }
        return;
      }
      case 'control_request': return onControlRequest(c, m);
      case 'rate_limit_event': {
        const l = parseLimits(m.rate_limit_info);
        if (!l) return;
        limits = l;
        try { saveLimits(cfgDir, l); } catch { /* 설정 폴더 문제로 채팅을 멈추지 않는다 */ }
        emit(c, { type: 'limits', limits: l });
        if (l.rejected) emit(c, { type: 'notice', level: 'warn', code: 'limit-rejected', message: `사용 한도에 걸렸다 (${l.rejected.window})` });
        return;
      }
      case 'result': {
        emit(c, {
          type: 'result', subtype: String(m.subtype ?? ''), isError: !!m.is_error,
          text: str(m.result), denials: Array.isArray(m.permission_denials) ? m.permission_denials.length : 0,
        });
        // 턴이 끝났으니 claude 가 더 기다리지 않는다
        cancelPending(c);
        setState(c, 'idle');
        return;
      }
      default: return;
    }
  }

  function onSystem(c: Chat, m: any) {
    if (m.subtype === 'init') {
      const sid = str(m.session_id);
      const version = str(m.claude_code_version);
      c.info.sessionId = sid ?? c.info.sessionId;
      c.info.version = version;
      c.info.model = str(m.model) ?? c.info.model;
      emit(c, { type: 'init', sessionId: sid ?? '', version, model: str(m.model), permissionMode: str(m.permissionMode) });
      if (version && compareVersion(version, MIN_CLAUDE_VERSION) < 0) {
        emit(c, { type: 'notice', level: 'warn', code: 'version-old', message: `claude ${version} 은 ${MIN_CLAUDE_VERSION} 보다 옛 버전이다 — 카드가 제대로 안 나올 수 있다. claude update 를 권한다` });
      }
      if (sid) { try { updateSession(cfgDir, sid, { version, plenum: true, projectId: c.projectId }); } catch { /* 무시 */ } }
      if (c.info.state === 'starting') setState(c, 'running');
      return;
    }
    if (m.subtype === 'task_started' || m.subtype === 'task_progress' || m.subtype === 'task_updated' || m.subtype === 'task_notification') {
      const taskId = str(m.task_id);
      const id = str(m.tool_use_id) ?? (taskId ? c.taskToTool.get(taskId) ?? null : null);
      if (!id) return;
      if (taskId) c.taskToTool.set(taskId, id);
      let w = c.workers.get(id);
      if (!w) {
        const type = str(m.subagent_type) ?? '';
        w = {
          id, worker: type, model: type ? deps.workerModel(type) : null,
          description: m.subtype === 'task_started' ? str(m.description) : null,
          background: !!m.is_backgrounded, state: 'running', startedAt: Date.now(), endedAt: null,
        };
        updateWorker(c, w);
      }
      const end = m.subtype === 'task_updated' ? workerEnd(isObj(m.patch) ? m.patch.status : null)
        : m.subtype === 'task_notification' ? workerEnd(m.status) : null;
      if (end && w.state === 'running') updateWorker(c, { ...w, state: end, endedAt: Date.now() });
    }
  }

  function onControlRequest(c: Chat, m: any) {
    const requestId = str(m.request_id);
    const req = m.request;
    if (!requestId || !isObj(req)) return;
    if (req.subtype !== 'can_use_tool') {
      try { write(c, { type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'Plenum 채팅이 처리하지 못하는 요청' } }); } catch { /* 끝남 */ }
      const subtype = String(req.subtype ?? '');
      const card: Card = { kind: 'unknown', requestId, subtype, version: c.info.version };
      c.cards.set(requestId, { card, input: null, resolved: true });
      emit(c, { type: 'card', card });
      emit(c, { type: 'notice', level: 'warn', code: 'unknown-request', message: `처리하지 못하는 요청(${subtype})이 와서 거절했다 — 터미널로 열어서 이어 하기` });
      return;
    }
    const toolName = String(req.tool_name ?? '');
    const toolUseId = str(req.tool_use_id) ?? undefined;
    let card: Card;
    if (toolName === 'AskUserQuestion') {
      const questions = questionsFrom(req.input);
      card = { kind: 'question', requestId, ...(toolUseId ? { toolUseId } : {}), questions, isModeQuestion: questions.some((q) => q.options.some((op) => /^모드 없음/.test(op.label.trim()))) };
    } else {
      const diff = diffFrom(toolName, req.input);
      card = {
        kind: 'permission', requestId, ...(toolUseId ? { toolUseId } : {}), toolName, input: req.input,
        ...(typeof req.description === 'string' ? { description: req.description } : {}),
        sessionRules: sessionRulesFrom(req.permission_suggestions),
        ...(diff ? { diff } : {}),
      };
    }
    c.cards.set(requestId, { card, input: req.input, resolved: false });
    emit(c, { type: 'card', card });
    setState(c, 'waiting');
  }

  function finishExit(c: Chat, code: number | null, signal: string | null) {
    if (c.info.state === 'ended') return;
    if (c.child.pid) { try { removePid(cfgDir, c.child.pid); } catch { /* 무시 */ } }
    cancelPending(c);
    emit(c, { type: 'exit', code, signal });
    if (code !== 0 && !c.closing) {
      const tail = c.stderr.trim().split(/\r?\n/).slice(-3).join(' / ');
      emit(c, { type: 'notice', level: 'error', code: 'exit', message: `claude 가 끝났다 (종료 코드 ${code ?? signal})${tail ? ` — ${tail}` : ''}` });
    }
    setState(c, 'ended');
  }

  // effort 를 주면 이 claude 가 --effort 를 아는지 먼저 본다(노트북 2.1.248 에는 없을 수 있다). 나머지는 startNow 가 동기로
  async function start(project: { id: string; path: string }, opts: StartOptions): Promise<StartResult> {
    const effort = opts?.effort ?? undefined;
    if (effort !== undefined && typeof effort === 'string' && EFFORTS.includes(effort)) {
      const caps = await deps.caps();
      if (caps.found && !caps.effort) throw new UserError(400, `이 Claude Code 버전에는 --effort 가 없다${caps.version ? ` (${caps.version})` : ''} — 노력도 없이 시작하거나 claude update`);
    }
    return startNow(project, opts);
  }

  function startNow(project: { id: string; path: string }, opts: StartOptions): StartResult {
    const text = typeof opts.text === 'string' ? opts.text : '';
    if (!text.trim()) throw new UserError(400, '보낼 글이 비어 있다');
    const model = opts.model ?? undefined;
    const effort = opts.effort ?? undefined;
    const resume = opts.resume ?? undefined;
    if (model !== undefined && (typeof model !== 'string' || !MODEL_RE.test(model))) throw new UserError(400, `모델 이름이 이상하다: ${String(model)}`);
    if (effort !== undefined && (typeof effort !== 'string' || !EFFORTS.includes(effort))) throw new UserError(400, `effort 는 ${EFFORTS.join('·')} 중 하나: ${String(effort)}`);
    if (resume !== undefined && (typeof resume !== 'string' || !UUID_RE.test(resume))) throw new UserError(400, `세션 ID 모양이 아니다: ${String(resume)}`);
    if (resume) {
      // 이미 살아 있는 채팅이면 새로 띄우지 않고 글을 그 채팅에 보낸다(카드가 답을 기다리면 보내지 않음)
      const live = liveBySession(resume);
      if (live) {
        if (pendingCount(live)) throw new UserError(409, CARD_PENDING);
        return { ...send(live.info.chatId, text), forwarded: true };
      }
      if (deps.terminalAlive(resume)) throw new UserError(409, '이 세션은 터미널에서 열려 있다 — 터미널을 닫고 다시');
    }
    const limitWarnings = gate();
    const resolved = resolveCommand('claude', env, platform);
    if (!resolved) throw new UserError(400, 'claude 를 PATH 에서 못 찾았다 — Claude Code 를 설치하고 Plenum 을 다시 시작');
    let cmd;
    try { cmd = commandFor(resolved, chatArgs({ model, effort, resume }), platform); } catch (e: any) { throw new UserError(400, e.message); }
    const child = spawn(cmd.cmd, cmd.args, {
      cwd: project.path, env: chatEnv(env), stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, windowsVerbatimArguments: !!cmd.verbatim, detached: platform !== 'win32',
    });
    const chatId = randomUUID();
    let resolveExited!: () => void;
    const c: Chat = {
      info: { chatId, projectId: project.id, sessionId: resume ?? null, state: 'starting', mode: null, model: model ?? null, effort: effort ?? null, version: null, lastSeq: 0 },
      projectId: project.id, child, events: [], listeners: new Set(), cards: new Map(), workers: new Map(), taskToTool: new Map(),
      lastMessageId: null, intN: 0, closing: null, exited: new Promise<void>((r) => { resolveExited = r; }), stderr: '',
    };
    chats.set(chatId, c);
    if (child.pid) { try { addPid(cfgDir, child.pid, { platform }).catch(() => {}); } catch { /* 무시 */ } }
    emit(c, { type: 'state', state: 'starting' });

    const dec = new StringDecoder('utf8');
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
      buf += dec.write(d);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.trim()) { try { onLine(c, line); } catch { /* 한 줄 처리 실패로 죽지 않기 */ } }
      }
    });
    child.stderr!.on('data', (d: Buffer) => { c.stderr = (c.stderr + d.toString('utf8')).slice(-4000); });
    child.stdin!.on('error', () => { /* EPIPE: 프로세스가 먼저 끝남 */ });
    let exitInfo: { code: number | null; signal: string | null } | null = null;
    const done = () => {
      if (!exitInfo) return;
      const rest = buf + dec.end();
      buf = '';
      if (rest.trim()) { try { onLine(c, rest.trim()); } catch { /* 무시 */ } }
      finishExit(c, exitInfo.code, exitInfo.signal);
      resolveExited();
    };
    child.once('error', (e) => {
      emit(c, { type: 'notice', level: 'error', code: 'exit', message: `claude 를 실행하지 못했다: ${e.message}` });
      exitInfo = exitInfo ?? { code: null, signal: null };
      done();
    });
    // close 는 출력까지 다 읽힌 뒤. 손자가 파이프를 붙잡으면 close 가 안 오므로 exit 뒤 2초면 끊는다
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal };
      const t = setTimeout(() => { child.stdout!.destroy(); child.stderr!.destroy(); done(); }, 2000);
      t.unref();
      child.once('close', () => { clearTimeout(t); done(); });
    });

    write(c, { type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } });
    sendUser(c, text);
    warnLimit(c, limitWarnings);
    const warnings = [...limitWarnings, ...concurrent(c)];
    return { chat: info(c), warnings };
  }

  function respond(chatId: string, reply: CardReply): ChatInfo {
    const c = must(chatId);
    if (!isObj(reply) || typeof reply.requestId !== 'string') throw new UserError(400, 'requestId 가 없다');
    const p = c.cards.get(reply.requestId);
    if (!p) throw new UserError(404, '없는 카드');
    if (p.resolved) throw new UserError(409, '이미 답한 카드');
    if (c.info.state === 'ended') throw new UserError(409, '채팅이 끝났다');
    const card = p.card;
    let response: Record<string, unknown>;
    let outcome: 'allow' | 'allow-session' | 'deny' | 'answered';
    let detail: string | undefined;
    switch (reply.action) {
      case 'allow':
        response = { behavior: 'allow', updatedInput: p.input };
        outcome = 'allow';
        break;
      case 'allow-session': {
        if (card.kind !== 'permission' || card.sessionRules.length === 0) throw new UserError(400, '이 세션 동안 허용할 규칙이 없다');
        response = { behavior: 'allow', updatedInput: p.input, updatedPermissions: [{ type: 'addRules', rules: card.sessionRules, behavior: 'allow', destination: 'session' }] };
        outcome = 'allow-session';
        break;
      }
      case 'deny': {
        const reason = typeof reply.reason === 'string' ? reply.reason.trim() : '';
        response = { behavior: 'deny', message: reason || '사용자가 거부했다' };
        outcome = 'deny';
        detail = reason || undefined;
        break;
      }
      case 'answer': {
        if (card.kind !== 'question') throw new UserError(400, '질문 카드가 아니다');
        const answers = reply.answers;
        if (!isObj(answers) || Object.values(answers).some((v) => typeof v !== 'string')) throw new UserError(400, 'answers 는 질문 → 답 글자');
        response = { behavior: 'allow', updatedInput: { ...(isObj(p.input) ? p.input : {}), answers } };
        outcome = 'answered';
        detail = Object.keys(answers).sort().map((k) => answers[k]).join(', ');
        break;
      }
      default:
        throw new UserError(400, `모르는 action: ${String((reply as any).action)}`);
    }
    write(c, { type: 'control_response', response: { subtype: 'success', request_id: reply.requestId, response } });
    p.resolved = true;
    emit(c, { type: 'card-resolved', requestId: reply.requestId, outcome, ...(detail !== undefined ? { detail } : {}) });
    if (reply.action === 'answer' && card.kind === 'question' && card.isModeQuestion) {
      for (const v of Object.values(reply.answers)) {
        const mode = modeFromAnswer(v);
        if (mode) { setMode(c, mode); break; }
      }
    }
    if (c.info.state === 'waiting' && pendingCount(c) === 0) setState(c, 'running');
    return info(c);
  }

  function liveBySession(sessionId: string): Chat | null {
    for (const c of chats.values()) if (c.info.sessionId === sessionId && c.info.state !== 'ended') return c;
    return null;
  }

  function send(chatId: string, text: string) {
    const c = must(chatId);
    if (typeof text !== 'string' || !text.trim()) throw new UserError(400, '보낼 글이 비어 있다');
    if (c.info.state === 'ended') throw new UserError(409, '채팅이 끝났다 — 새로 시작하거나 이어하기');
    const limitWarnings = gate();
    sendUser(c, text);
    setState(c, pendingCount(c) ? 'waiting' : 'running');
    warnLimit(c, limitWarnings);
    const warnings = [...limitWarnings, ...concurrent(c)];
    return { chat: info(c), warnings };
  }

  function interrupt(chatId: string): ChatInfo {
    const c = must(chatId);
    c.intN++;
    write(c, { type: 'control_request', request_id: `int-${c.intN}`, request: { subtype: 'interrupt' } });
    return info(c);
  }

  function close(chatId: string): Promise<void> {
    const c = must(chatId);
    if (c.info.state === 'ended') return Promise.resolve();
    if (c.closing) return c.closing;
    c.closing = (async () => {
      // stdin 만 닫으면 턴을 끝까지 돈다(녹화 06) → 응답 중이면 먼저 멈춘다
      if (c.info.state === 'running' || c.info.state === 'waiting') { try { interrupt(chatId); } catch { /* 끝남 */ } }
      try { c.child.stdin!.end(); } catch { /* 무시 */ }
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([c.exited.then(() => false), new Promise<boolean>((r) => { timer = setTimeout(() => r(true), closeWaitMs); })]);
      clearTimeout(timer);
      if (timedOut && c.child.pid) {
        await killTree(c.child.pid, platform);
        await c.exited;
      }
    })();
    return c.closing;
  }

  async function shutdownAll(capMs = SHUTDOWN_CAP_MS) {
    const live = [...chats.values()].filter((c) => c.info.state !== 'ended');
    if (!live.length) return;
    let timer: NodeJS.Timeout | undefined;
    const all = Promise.all(live.map((c) => close(c.info.chatId).catch(() => {})));
    const capped = await Promise.race([all.then(() => false), new Promise<boolean>((r) => { timer = setTimeout(() => r(true), Math.min(capMs, SHUTDOWN_CAP_MS)); })]);
    clearTimeout(timer);
    if (capped) {
      // 상한을 넘기면 트리째 죽이고 종료를 잠깐(2초) 기다린다. 못 보면 PID 파일에서라도 지운다(죽였으므로)
      await Promise.all(live.filter((c) => c.info.state !== 'ended' && c.child.pid).map(async (c) => {
        await killTree(c.child.pid!, platform);
        let t: NodeJS.Timeout | undefined;
        await Promise.race([c.exited, new Promise<void>((r) => { t = setTimeout(r, 2000); })]);
        clearTimeout(t);
        try { removePid(cfgDir, c.child.pid!); } catch { /* 무시 */ }
      }));
    }
  }

  function killAllNow() {
    for (const c of chats.values()) {
      if (c.info.state !== 'ended' && c.child.pid) {
        killTreeNow(c.child.pid, platform);
        try { removePid(cfgDir, c.child.pid); } catch { /* 무시 */ }
      }
    }
  }

  return {
    start, respond, send, interrupt, close, shutdownAll, killAllNow,
    subscribe(chatId, afterSeq, listener) {
      const c = must(chatId);
      for (const ev of c.events) if (ev.seq > afterSeq) listener(ev);
      c.listeners.add(listener);
      return () => { c.listeners.delete(listener); };
    },
    onEvent(listener) { globalListeners.add(listener); return () => { globalListeners.delete(listener); }; },
    list: (projectId) => [...chats.values()].filter((c) => c.projectId === projectId && c.info.state !== 'ended').map(info),
    get: (chatId) => { const c = chats.get(chatId); return c ? info(c) : null; },
    // 살아 있는(ended 아님) 채팅만. 끝난 채팅은 지난 세션 목록의 running·터미널로 열기·이어하기에서 없는 것으로 본다
    findBySession(sessionId) { const c = liveBySession(sessionId); return c ? info(c) : null; },
    isPlenumChat: (sessionId) => liveBySession(sessionId) !== null,
    getLimits: () => limits,
  };
}
