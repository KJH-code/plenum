// 프로젝트 창 안 채팅: `claude -p` stream-json 프로세스를 띄우고 stdout 줄을 ChatEvent 로 바꾼다.
// 줄 해석과 stdin 답 원문은 드라이버(provider/claude.ts)가 한다. 여기는 드라이버의 내부 이벤트를 지금의 ChatEvent·Card 로 펼치고
// 프로세스·상태·저장을 맡는다. 줄 모양 근거: test/fixtures/providers/claude/2.1.323/*.jsonl (진짜 claude 녹화). 모르는 줄(unknown)은 무시한다(죽지 않기).
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import {
  MIN_CLAUDE_VERSION, modeFromAnswer, modeFromSkill, toolLabel,
  type Card, type CardReply, type ChatConflict, type ChatEvent, type ChatInfo, type ChatRegistry, type ChatState, type LimitWindow, type Limits,
  type ModeName, type WorkerRun, limitGate,
} from './chatTypes.ts';
import { createClaudeDriver, limitsFromUsage, type ClaudeDriver } from './provider/claude.ts';
import type { ProviderEvent } from './provider/events.ts';
import { claudeCaps, type ClaudeCaps } from './claudecaps.ts';
import { UserError } from './errors.ts';
import { commandFor, resolveCommand } from './open.ts';
import { addPid, killTree, killTreeNow, ownerStartTime, removePid } from './proc.ts';
import { readLimits, saveLimits, updateSession } from './store.ts';

// 드라이버로 옮긴 것. 옛 위치(chat.ts)의 공개 export 를 유지한다 — 지금 저장소 안에서 여기로 import 하는 곳은 없다
export { DENIED, parseLimits } from './provider/claude.ts';

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
// 409 이유(화면이 이것으로 분기한다)
const AWAITING_CARD: ChatConflict = 'awaiting-card';
const TERMINAL_OPEN: ChatConflict = 'terminal-open';
const ENDED: ChatConflict = 'chat-ended';
const CARD_ANSWERED: ChatConflict = 'card-answered';

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

interface PendingCard { card: Card; resolved: boolean }
interface Chat {
  info: ChatInfo;
  projectId: string;
  child: ChildProcess;
  events: ChatEvent[];
  listeners: Set<(ev: ChatEvent) => void>;
  cards: Map<string, PendingCard>;
  workers: Map<string, WorkerRun>;
  driver: ClaudeDriver;
  closing: Promise<void> | null;
  exited: Promise<void>;
  stderr: string;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

// 플러그인 스킬 파일(프로젝트 밖) 읽기는 묻지 않는다. Read 만 — 쓰기·실행은 그대로 카드로 묻는다.
// claude 2.1.323 으로 확인: 이 규칙이 있으면 그 경로 Read 카드가 안 뜨고, 없으면 뜬다
export const PLUGIN_CACHE_READ = 'Read(~/.claude/plugins/cache/**)';

// 플러그인 캐시 폴더(<CLAUDE_CONFIG_DIR 또는 홈/.claude>/plugins/cache)의 Read 허용 규칙. 못 쓰면 null(카드로 묻는다 — 안전한 쪽).
// Claude Code 절대 경로 규칙은 `//` + 경로. Windows 는 드라이브 소문자·`/` 구분자(노트북 2.1.248 카드가 제안한 모양: //c/Users/…).
// POSIX 홈은 ~ 모양(2.1.323 확인). UNC·상대 경로는 규칙을 붙이지 않는다
export function pluginCacheRule(platform: NodeJS.Platform, homedir: string, configDir?: string): string | null {
  // 앞뒤 구분자·겹친 구분자를 걷은 경로 조각 + plugins/cache/**
  const rule = (prefix: string, rest: string) => {
    const r = rest.replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
    return `Read(//${prefix}${r ? `${r}/` : ''}plugins/cache/**)`;
  };
  if (platform === 'win32') {
    const base = configDir || `${homedir.replace(/[\\/]+$/, '')}\\.claude`;
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(base);
    if (!m) return null; // UNC(\\server\…)·상대 경로·드라이브만(C:)
    return rule(`${m[1].toLowerCase()}/`, m[2].replace(/\\/g, '/'));
  }
  if (!configDir) return PLUGIN_CACHE_READ;
  if (!configDir.startsWith('/') || configDir.startsWith('//')) return null; // 상대 경로·// 로 시작하는 이상한 경로
  return rule('', configDir);
}

// claude 실행 인자 (테스트가 모양을 본다). env 는 CLAUDE_CONFIG_DIR 만 본다
export function chatArgs(o: { model?: string; effort?: string; resume?: string }, env: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = process.platform, homedir: string = os.homedir()): string[] {
  // --permission-mode default: 사용자 설정의 defaultMode(acceptEdits 등)가 채팅에 새지 않게 명시한다
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', 'default'];
  const rule = pluginCacheRule(platform, homedir, env.CLAUDE_CONFIG_DIR || undefined);
  if (rule) args.push('--allowedTools', rule);
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
  void ownerStartTime(); // PID 파일 ownerStart: 서버 시작 때 한 번 읽어 둔다

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
    if (!s || !s.writable || c.info.state === 'ended') throw new UserError(409, '채팅이 끝났다', ENDED);
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
    write(c, c.driver.prompt(text));
    emit(c, { type: 'user', text });
  }

  function updateWorker(c: Chat, w: WorkerRun) { c.workers.set(w.id, w); emit(c, { type: 'worker', worker: { ...w } }); }

  // stdout 한 줄 → 드라이버 decode → 이벤트마다 apply
  function onLine(c: Chat, line: string) {
    for (const ev of c.driver.decode({ provider: 'claude', version: c.info.version, channel: 'stdout', text: line })) apply(c, ev);
  }

  // 내부 이벤트 → 지금의 ChatEvent·Card·상태·저장 (옮기기 전 onLine·onSystem·onControlRequest 와 같은 순서)
  function apply(c: Chat, ev: ProviderEvent) {
    switch (ev.type) {
      case 'sessionStarted': {
        const sid = ev.noSessionId ? null : ev.sessionId;
        const version = ev.version;
        c.info.sessionId = sid ?? c.info.sessionId;
        c.info.version = version;
        c.info.model = ev.model ?? c.info.model;
        emit(c, { type: 'init', sessionId: sid ?? '', version, model: ev.model, permissionMode: ev.permissionMode });
        if (version && compareVersion(version, MIN_CLAUDE_VERSION) < 0) {
          emit(c, { type: 'notice', level: 'warn', code: 'version-old', message: `claude ${version} 은 ${MIN_CLAUDE_VERSION} 보다 옛 버전이다 — 카드가 제대로 안 나올 수 있다. claude update 를 권한다` });
        }
        if (sid) { try { updateSession(cfgDir, sid, { version, plenum: true, projectId: c.projectId }); } catch { /* 무시 */ } }
        if (c.info.state === 'starting') setState(c, 'running');
        return;
      }
      case 'task': {
        const id = ev.parentToolCallId;
        if (!id) return;
        let w = c.workers.get(id);
        if (!w) {
          const type = ev.name ?? '';
          w = {
            id, worker: type, model: type ? deps.workerModel(type) : null,
            description: ev.description, background: ev.background, state: 'running', startedAt: Date.now(), endedAt: null,
          };
          updateWorker(c, w);
        }
        const end = ev.status === 'completed' ? 'done' : ev.status === 'failed' ? 'error' : null;
        if (end && w.state === 'running') updateWorker(c, { ...w, state: end, endedAt: Date.now() });
        return;
      }
      case 'message':
        if (ev.phase === 'chunk') emit(c, { type: 'text-delta', messageId: ev.messageId, index: ev.index ?? 0, text: ev.text });
        else emit(c, { type: 'assistant-text', messageId: ev.messageId, text: ev.text });
        return;
      case 'toolCall':
        if (ev.status === 'pending') {
          emit(c, { type: 'tool', toolUseId: ev.toolCallId, name: ev.toolName ?? '', input: ev.rawInput, parentToolUseId: ev.parentToolCallId ?? null });
          // 원래 name 이 문자열 'Skill' 일 때만(옛 코드 b.name === 'Skill'). ["Skill"] 같은 값은 String() 으로 같아져도 아니다
          if (ev.toolName === 'Skill' && !ev.toolNameNotString && isObj(ev.rawInput)) {
            const mode = modeFromSkill(ev.rawInput.skill);
            if (mode) setMode(c, mode);
          }
        } else if (ev.output) {
          emit(c, { type: 'tool-result', toolUseId: ev.toolCallId, isError: ev.output.isError, text: ev.output.text });
        }
        return;
      case 'elicitation': {
        const questions = ev.questions.map(({ allowFreeText: _f, ...q }) => q);
        const toolUseId = ev.ext?.claude.toolUseId;
        const card: Card = { kind: 'question', requestId: ev.requestId, ...(toolUseId ? { toolUseId } : {}), questions, isModeQuestion: questions.some((q) => q.options.some((op) => /^모드 없음/.test(op.label.trim()))) };
        addCard(c, card);
        return;
      }
      case 'requestPermission': {
        const toolUseId = ev.ext?.claude.toolUseId;
        const diff = ev.diff?.[0];
        const card: Card = {
          kind: 'permission', requestId: ev.requestId, ...(toolUseId ? { toolUseId } : {}), toolName: ev.toolCall.toolName ?? '', input: ev.toolCall.rawInput,
          ...(typeof ev.reason === 'string' ? { description: ev.reason } : {}),
          sessionRules: ev.ext?.claude.sessionRules ?? [],
          sessionAllow: ev.options.some((o) => o.optionId === 'allow_session'),
          remembers: ev.ext?.claude.remembers === true,
          ...(diff ? { diff } : {}),
        };
        addCard(c, card);
        return;
      }
      case 'permissionAutoAllowed': {
        // 세션 허용한 같은 명령: 드라이버가 만든 allow 답을 그대로 쓰고(안 쓰면 claude 가 멈춘다) 줄 하나만 남긴다. 카드·상태는 건드리지 않는다
        try { write(c, ev.reply); } catch { /* 끝남 */ }
        const toolName = ev.toolCall.toolName ?? '';
        const input = ev.toolCall.rawInput;
        const command = isObj(input) && typeof input.command === 'string' ? input.command : null;
        const toolUseId = ev.ext?.claude.toolUseId;
        emit(c, { type: 'autoAllowed', toolName, summary: command !== null ? `${toolName} ${command}` : toolLabel(toolName, input), requestId: ev.requestId, ...(toolUseId ? { toolUseId } : {}) });
        return;
      }
      case 'usage': {
        const l = limitsFromUsage(ev);
        limits = l;
        try { saveLimits(cfgDir, l); } catch { /* 설정 폴더 문제로 채팅을 멈추지 않는다 */ }
        emit(c, { type: 'limits', limits: l });
        if (l.rejected) emit(c, { type: 'notice', level: 'warn', code: 'limit-rejected', message: `사용 한도에 걸렸다 (${l.rejected.window})` });
        return;
      }
      case 'turnEnd':
        emit(c, { type: 'result', subtype: ev.rawSubtype, isError: ev.isError, text: ev.text, denials: ev.deniedCount ?? 0 });
        // 턴이 끝났으니 claude 가 더 기다리지 않는다
        cancelPending(c);
        setState(c, 'idle');
        return;
      case 'unknown': {
        // 답을 기다리는 모르는 요청만(decode 가 예외를 잡은 control_request 도 같다): 드라이버가 만든 거절 답을 쓰고 터미널로 열기 안내.
        // 그 밖의 unknown 은 버린다(P1)
        if (!ev.answeredWithDefault || ev.requestId === undefined) return;
        const requestId = ev.requestId;
        try { write(c, ev.reply); } catch { /* 끝남 */ }
        const subtype = ev.hint ?? '';
        // 이미 있는 카드와 같은 id(드라이버가 새 요청만 거절함): 기존 카드는 그대로 두고 안내만
        if (c.cards.has(requestId)) {
          emit(c, { type: 'notice', level: 'warn', code: 'other', message: `같은 id(${requestId})의 요청이 또 와서 새 요청을 거절했다 — 먼저 뜬 카드는 그대로 답할 수 있다` });
          return;
        }
        const card: Card = { kind: 'unknown', requestId, subtype, version: c.info.version };
        c.cards.set(requestId, { card, resolved: true });
        emit(c, { type: 'card', card });
        emit(c, { type: 'notice', level: 'warn', code: 'unknown-request', message: `처리하지 못하는 요청(${subtype})이 와서 거절했다 — 터미널로 열어서 이어 하기` });
        return;
      }
      default:
        return;
    }
  }

  function addCard(c: Chat, card: Card) {
    c.cards.set(card.requestId, { card, resolved: false });
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
    // 이어할 세션의 채팅이 닫는 중이면 끝나기를 기다린 뒤(최대 closeWaitMs) 보통 경로로 — 새로 띄운다
    const closingChat = typeof opts?.resume === 'string' ? liveBySession(opts.resume) : null;
    if (closingChat && isClosing(closingChat)) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([closingChat.exited, new Promise<void>((r) => { timer = setTimeout(r, closeWaitMs); })]);
      clearTimeout(timer);
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
        if (pendingCount(live)) throw new UserError(409, CARD_PENDING, AWAITING_CARD, { chatId: live.info.chatId });
        return { ...send(live.info.chatId, text), forwarded: true };
      }
      if (deps.terminalAlive(resume)) throw new UserError(409, '이 세션은 터미널에서 열려 있다 — 터미널을 닫고 다시', TERMINAL_OPEN);
    }
    const limitWarnings = gate();
    const resolved = resolveCommand('claude', env, platform);
    if (!resolved) throw new UserError(400, 'claude 를 PATH 에서 못 찾았다 — Claude Code 를 설치하고 Plenum 을 다시 시작');
    let cmd;
    try { cmd = commandFor(resolved, chatArgs({ model, effort, resume }, env, platform), platform); } catch (e: any) { throw new UserError(400, e.message); }
    const child = spawn(cmd.cmd, cmd.args, {
      cwd: project.path, env: chatEnv(env), stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, windowsVerbatimArguments: !!cmd.verbatim, detached: platform !== 'win32',
    });
    const chatId = randomUUID();
    let resolveExited!: () => void;
    const c: Chat = {
      info: { chatId, projectId: project.id, sessionId: resume ?? null, state: 'starting', mode: null, model: model ?? null, effort: effort ?? null, version: null, lastSeq: 0 },
      projectId: project.id, child, events: [], listeners: new Set(), cards: new Map(), workers: new Map(),
      driver: createClaudeDriver(), closing: null, exited: new Promise<void>((r) => { resolveExited = r; }), stderr: '',
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

    write(c, c.driver.initialize());
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
    // 끝난 채팅은 카드가 취소(resolved)돼 있다 → 끝남을 먼저 본다
    if (c.info.state === 'ended') throw new UserError(409, '채팅이 끝났다', ENDED);
    if (p.resolved) throw new UserError(409, '이미 답한 카드', CARD_ANSWERED);
    const card = p.card;
    let msg: unknown;
    let outcome: 'allow' | 'allow-session' | 'deny' | 'answered';
    let detail: string | undefined;
    switch (reply.action) {
      case 'allow':
        msg = c.driver.answerPermission(reply.requestId, { outcome: 'selected', optionId: 'allow_once' });
        outcome = 'allow';
        break;
      case 'allow-session': {
        if (card.kind !== 'permission' || !(card.sessionAllow ?? card.sessionRules.length > 0)) throw new UserError(400, '이 세션 동안 허용할 규칙이 없다');
        msg = c.driver.answerPermission(reply.requestId, { outcome: 'selected', optionId: 'allow_session' });
        outcome = 'allow-session';
        break;
      }
      case 'deny': {
        const reason = typeof reply.reason === 'string' ? reply.reason.trim() : '';
        // 거부 문구("사용자가 직접 거부했다")는 드라이버가 붙인다
        msg = c.driver.answerPermission(reply.requestId, { outcome: 'selected', optionId: 'reject_once', ...(reason ? { message: reason } : {}) });
        outcome = 'deny';
        detail = reason || undefined;
        break;
      }
      case 'answer': {
        if (card.kind !== 'question') throw new UserError(400, '질문 카드가 아니다');
        const answers = reply.answers;
        if (!isObj(answers) || Object.values(answers).some((v) => typeof v !== 'string')) throw new UserError(400, 'answers 는 질문 → 답 글자');
        msg = c.driver.answerQuestion(reply.requestId, { action: 'accept', answers });
        outcome = 'answered';
        detail = Object.keys(answers).sort().map((k) => answers[k]).join(', ');
        break;
      }
      default:
        throw new UserError(400, `모르는 action: ${String((reply as any).action)}`);
    }
    write(c, msg);
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

  // close 가 불렸거나 stdin 이 닫혔다 — 곧 끝난다
  function isClosing(c: Chat): boolean { return !!c.closing || !c.child.stdin?.writable; }

  function liveBySession(sessionId: string): Chat | null {
    for (const c of chats.values()) if (c.info.sessionId === sessionId && c.info.state !== 'ended') return c;
    return null;
  }

  function send(chatId: string, text: string) {
    const c = must(chatId);
    if (typeof text !== 'string' || !text.trim()) throw new UserError(400, '보낼 글이 비어 있다');
    if (c.info.state === 'ended') throw new UserError(409, '채팅이 끝났다 — 새로 시작하거나 이어하기', ENDED);
    const limitWarnings = gate();
    sendUser(c, text);
    setState(c, pendingCount(c) ? 'waiting' : 'running');
    warnLimit(c, limitWarnings);
    const warnings = [...limitWarnings, ...concurrent(c)];
    return { chat: info(c), warnings };
  }

  function interrupt(chatId: string): ChatInfo {
    const c = must(chatId);
    write(c, c.driver.interrupt());
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
