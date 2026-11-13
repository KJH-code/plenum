// 프로젝트별 "작동 중": 터미널 세션(jh-kit 훅이 POST /api/hook 로 알림) + Plenum 채팅 세션(ChatRegistry 이벤트).
// 시작·끝은 id 로만 짝을 맞춘다(워커 = agent_id 또는 Agent tool_use id). 이름·순서로 찾으면 끝을 못 찾아 유령이 남는다.
// 턴이 끝나면(Stop·result) 끝난 워커는 지우고 running 워커는 남긴다 — 백그라운드 에이전트는 자기 끝 이벤트까지 남는다.
import type { ActiveSession, ActivityView, ChatEvent, ChatInfo, ChatRegistry } from './chatTypes.ts';
import { modeFromSkill } from './chatTypes.ts';
import { samePath } from './pathkey.ts';
import { updateSession } from './store.ts';

export const GHOST_MS = 12 * 60 * 60 * 1000; // 마지막 훅 뒤 이만큼 조용하면 닫힌 것으로 본다(SessionEnd 를 못 받은 경우)
export const HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd'] as const;
export type HookEvent = typeof HOOK_EVENTS[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ENDED = 1000; // 세션당 기억하는 끝난 워커 id 수

export type HookResult = { ok: true } | { ok: false; ignored: string };

export interface Activity extends ActivityView {
  ingestHook(body: unknown): HookResult;
  forgetTerminal(sessionId: string): boolean;
  registerChatProject(chatId: string, projectPath: string): void;
  dispose(): void;
}

export interface ActivityOptions {
  cfgDir: string;
  chats?: ChatRegistry;
  workerModel?: (agentType: string) => string | null;
  now?: () => number;
  platform?: NodeJS.Platform;
}

interface Hook {
  event: HookEvent; session_id: string; cwd?: string; transcript_path?: string; source?: string; reason?: string;
  agent_type?: string; agent_id?: string; skill?: string;
}

interface TerminalSession { view: ActiveSession; cwd: string | null; transcriptPath: string | null; lastAt: number; ended: Set<string> }
interface ChatSession { view: ActiveSession; ended: Set<string> }

// 칸 이름 → 최대 길이. 문자열이 아니거나 길면 본문 전체를 버린다.
const LIMITS: Record<string, number> = { cwd: 4096, transcript_path: 4096, source: 64, reason: 64, agent_type: 256, agent_id: 256 };

function parseHook(body: unknown): Hook | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'JSON 객체가 아니다';
  const b = body as Record<string, unknown>;
  if (typeof b.event !== 'string' || !(HOOK_EVENTS as readonly string[]).includes(b.event)) return `모르는 event: ${String(b.event).slice(0, 64)}`;
  if (typeof b.session_id !== 'string' || !UUID.test(b.session_id)) return 'session_id 가 UUID 가 아니다';
  const h: Hook = { event: b.event as HookEvent, session_id: b.session_id.toLowerCase() };
  for (const [k, max] of Object.entries(LIMITS)) {
    const v = b[k];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || v.length > max) return `${k} 가 문자열이 아니거나 너무 길다`;
    (h as any)[k] = v;
  }
  const ti = b.tool_input;
  if (ti !== undefined && ti !== null) {
    if (typeof ti !== 'object' || Array.isArray(ti)) return 'tool_input 이 객체가 아니다';
    const s = (ti as Record<string, unknown>).skill;
    if (s !== undefined && s !== null) {
      if (typeof s !== 'string' || s.length > 256) return 'tool_input.skill 이 문자열이 아니거나 너무 길다';
      h.skill = s;
    }
  }
  if ((h.event === 'SubagentStart' || h.event === 'SubagentStop') && !h.agent_id) return 'agent_id 가 없다';
  return h;
}

function copy(s: ActiveSession): ActiveSession { return { ...s, workers: s.workers.map((w) => ({ ...w })) }; }
function remember(set: Set<string>, id: string) {
  set.add(id);
  if (set.size > MAX_ENDED) set.delete(set.values().next().value as string);
}
// 턴 끝: 끝난(done·error) 워커는 지우고 running 은 남긴다
function dropFinished(s: ActiveSession) { s.workers = s.workers.filter((w) => w.state === 'running'); }

export function createActivity(opts: ActivityOptions): Activity {
  const now = opts.now ?? Date.now;
  const workerModel = opts.workerModel ?? (() => null);
  const chats = opts.chats;
  const terminals = new Map<string, TerminalSession>();
  const chatSessions = new Map<string, ChatSession>(); // chatId →
  const chatProjects = new Map<string, string>();       // chatId → 프로젝트 경로

  const alive = (t: TerminalSession) => now() - t.lastAt < GHOST_MS;

  function terminal(h: Hook, t: number): TerminalSession {
    let s = terminals.get(h.session_id);
    if (!s) {
      s = {
        view: { sessionId: h.session_id, source: 'terminal', chatId: null, title: null, mode: null, state: 'running', workers: [], since: t },
        cwd: null, transcriptPath: null, lastAt: t, ended: new Set(),
      };
      terminals.set(h.session_id, s);
    }
    if (h.cwd) s.cwd = h.cwd;
    if (h.transcript_path) s.transcriptPath = h.transcript_path;
    s.lastAt = t;
    return s;
  }

  function ingestHook(body: unknown): HookResult {
    const h = parseHook(body);
    if (typeof h === 'string') return { ok: false, ignored: h };
    // 채팅 세션은 stream 이 진실 — 훅까지 받으면 두 번 센다
    if (chats?.isPlenumChat(h.session_id)) return { ok: false, ignored: 'Plenum 채팅 세션' };
    const t = now();
    if (h.event === 'SessionEnd') {
      terminals.delete(h.session_id);
      return { ok: true };
    }
    const s = terminal(h, t);
    const v = s.view;
    switch (h.event) {
      case 'SessionStart':
        break;
      case 'PreToolUse': {
        v.state = 'running';
        const mode = modeFromSkill(h.skill);
        if (mode && mode !== v.mode) {
          v.mode = mode;
          try { updateSession(opts.cfgDir, h.session_id, { mode }); } catch { /* 저장 실패해도 현황은 유지 */ }
        }
        break;
      }
      case 'SubagentStart': {
        v.state = 'running';
        const id = h.agent_id!;
        // 끝 이벤트가 먼저 왔던 id 면 되살리지 않는다(유령 방지)
        if (s.ended.has(id) || v.workers.some((w) => w.id === id)) break;
        const type = h.agent_type ?? '';
        v.workers.push({ id, worker: type, model: workerModel(type), description: null, background: false, state: 'running', startedAt: t, endedAt: null });
        break;
      }
      case 'SubagentStop': {
        const id = h.agent_id!;
        remember(s.ended, id);
        const w = v.workers.find((x) => x.id === id);
        if (w) { w.state = 'done'; w.endedAt = t; }
        else {
          const type = h.agent_type ?? '';
          v.workers.push({ id, worker: type, model: workerModel(type), description: null, background: false, state: 'done', startedAt: t, endedAt: t });
        }
        break;
      }
      case 'Stop':
        v.state = 'idle';
        dropFinished(v);
        break;
    }
    return { ok: true };
  }

  function onChatEvent(chat: ChatInfo, ev: ChatEvent) {
    const id = chat.chatId;
    if (ev.type === 'exit') {
      chatSessions.delete(id);
      chatProjects.delete(id);
      return;
    }
    let s = chatSessions.get(id);
    if (ev.type === 'init') {
      if (!s) {
        s = { view: { sessionId: ev.sessionId, source: 'chat', chatId: id, title: null, mode: chat.mode ?? null, state: 'running', workers: [], since: ev.at }, ended: new Set() };
        chatSessions.set(id, s);
      } else s.view.sessionId = ev.sessionId;
      return;
    }
    if (!s) return; // init 전 이벤트는 세션 ID 가 없어 보일 수 없다
    const v = s.view;
    switch (ev.type) {
      case 'worker': {
        const w = ev.worker;
        if (w.state !== 'running') remember(s.ended, w.id);
        else if (s.ended.has(w.id)) break;
        const i = v.workers.findIndex((x) => x.id === w.id);
        if (i >= 0) v.workers[i] = { ...w };
        else v.workers.push({ ...w });
        break;
      }
      case 'mode': v.mode = ev.mode; break;
      case 'state':
        if (ev.state === 'waiting') v.state = 'waiting';
        else if (ev.state === 'running') v.state = 'running';
        break;
      case 'result':
        v.state = 'idle';
        dropFinished(v);
        break;
    }
  }
  const unsubscribe = chats ? chats.onEvent(onChatEvent) : () => {};

  return {
    ingestHook,
    forgetTerminal(sessionId) { return terminals.delete(String(sessionId).toLowerCase()); },
    registerChatProject(chatId, projectPath) { chatProjects.set(chatId, projectPath); },
    terminalAlive(sessionId) {
      const s = terminals.get(String(sessionId).toLowerCase());
      return !!s && alive(s);
    },
    forProject(projectPath) {
      const out: ActiveSession[] = [];
      for (const [sid, s] of terminals) {
        if (!alive(s)) { terminals.delete(sid); continue; } // 유령 정리
        if (s.cwd && samePath(s.cwd, projectPath, opts.platform)) out.push(copy(s.view));
      }
      for (const [chatId, s] of chatSessions) {
        const p = chatProjects.get(chatId);
        if (p && samePath(p, projectPath, opts.platform)) out.push(copy(s.view));
      }
      return out.sort((a, b) => a.since - b.since || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
    },
    dispose() { unsubscribe(); },
  };
}
