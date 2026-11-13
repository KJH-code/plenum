import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  api, ApiError, ServerDownError, SERVER_DOWN,
  type Card, type CardReply, type ChatConflict, type ChatEvent, type ChatInfo, type ChatState, type Limits, type ModeName, type SessionSummary, type TranscriptItem, type WorkerRun,
} from './api';
import { PermissionCard, QuestionCard, UnknownCard, type Resolved } from './Cards';
import { clock, LIMIT_WARN, limitGate, windowName } from './Limits';
import { Markdown } from './Markdown';

// ── 채팅 이벤트 → 화면 줄 (seq 순서대로 한 번씩 적용) ─────────────
export interface ToolRun { id: string; name: string; input: unknown; result: { isError: boolean; text: string } | null }
export type Item =
  | { k: 'user'; key: string; text: string }
  | { k: 'text'; key: string; messageId: string; text: string; final: boolean }
  | { k: 'tools'; key: string; tools: ToolRun[] }
  | { k: 'workers'; key: string; ids: string[] }
  | { k: 'card'; key: string; card: Card; resolved: Resolved | null }
  | { k: 'notice'; key: string; level: 'info' | 'warn' | 'error'; message: string };
export interface ChatView {
  lastSeq: number;
  items: Item[];
  workers: Record<string, WorkerRun>;
  state: ChatState | null;
  mode: ModeName | null;
  sessionId: string | null;
  model: string | null;
  turnWorkers: Item | null;   // 이번 턴(사용자 메시지 하나)의 워커 표
  gen: number;                // 끝난 채팅을 같은 세션으로 다시 시작하면 seq 가 1부터 → 줄 key 가 겹치지 않게
}
export const emptyView = (): ChatView => ({ lastSeq: 0, items: [], workers: {}, state: null, mode: null, sessionId: null, model: null, turnWorkers: null, gen: 0 });

// 받은 이벤트 하나를 적용한다 (view 를 고친다). 이미 본 seq 는 버린다
export function applyEvent(v: ChatView, ev: ChatEvent): boolean {
  if (ev.seq <= v.lastSeq) return false;
  v.lastSeq = ev.seq;
  const key = `e${v.gen}.${ev.seq}`;
  const last = v.items[v.items.length - 1];
  switch (ev.type) {
    case 'init': v.sessionId = ev.sessionId || v.sessionId; v.model = ev.model ?? v.model; break;
    case 'user': v.items.push({ k: 'user', key, text: ev.text }); v.turnWorkers = null; break;
    case 'text-delta': {
      const it = v.items.find((x) => x.k === 'text' && x.messageId === ev.messageId && !x.final) as Extract<Item, { k: 'text' }> | undefined;
      if (it) it.text += ev.text;
      else v.items.push({ k: 'text', key, messageId: ev.messageId, text: ev.text, final: false });
      break;
    }
    case 'assistant-text': {
      const i = v.items.findIndex((x) => x.k === 'text' && x.messageId === ev.messageId && !x.final);
      if (i >= 0) v.items[i] = { ...(v.items[i] as Extract<Item, { k: 'text' }>), text: ev.text, final: true };
      else v.items.push({ k: 'text', key, messageId: ev.messageId, text: ev.text, final: true });
      break;
    }
    case 'tool': {
      if (ev.parentToolUseId) break; // 하위 에이전트 안의 도구는 워커 표가 대신한다
      const run: ToolRun = { id: ev.toolUseId, name: ev.name, input: ev.input, result: null };
      if (last && last.k === 'tools') last.tools.push(run);
      else v.items.push({ k: 'tools', key, tools: [run] });
      break;
    }
    case 'tool-result': {
      for (const it of v.items) if (it.k === 'tools') for (const t of it.tools) if (t.id === ev.toolUseId) t.result = { isError: ev.isError, text: ev.text };
      break;
    }
    case 'card': v.items.push({ k: 'card', key, card: ev.card, resolved: null }); break;
    case 'card-resolved': {
      const it = v.items.find((x) => x.k === 'card' && x.card.requestId === ev.requestId) as Extract<Item, { k: 'card' }> | undefined;
      if (it) it.resolved = { outcome: ev.outcome, ...(ev.detail !== undefined ? { detail: ev.detail } : {}) };
      break;
    }
    case 'worker': {
      const known = !!v.workers[ev.worker.id];
      v.workers[ev.worker.id] = ev.worker;
      if (known) break;
      if (!v.turnWorkers) { v.turnWorkers = { k: 'workers', key, ids: [] }; v.items.push(v.turnWorkers); }
      (v.turnWorkers as Extract<Item, { k: 'workers' }>).ids.push(ev.worker.id);
      break;
    }
    case 'mode': v.mode = ev.mode; break;
    case 'state': v.state = ev.state; break;
    case 'notice':
      if (ev.code !== 'unknown-request') v.items.push({ k: 'notice', key, level: ev.level, message: ev.message }); // 모르는 요청은 카드가 안내한다
      break;
    default: break;
  }
  return true;
}

export const pendingCard = (v: ChatView): Card | null => {
  for (const it of v.items) if (it.k === 'card' && !it.resolved && it.card.kind !== 'unknown') return it.card;
  return null;
};
const live = (s: ChatState | null) => s === 'starting' || s === 'running' || s === 'waiting';

// ── 도구 한 줄 요약 ───────────────────────────────────
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const base = (p: string) => p.split(/[\\/]/).pop() || p;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
export function toolLabel(name: string, input: unknown): string {
  const i = isObj(input) ? input : {};
  if (typeof i.file_path === 'string') return `${name} ${base(i.file_path)}`;
  if (name === 'Grep' && typeof i.pattern === 'string') return `${name} "${cut(i.pattern, 30)}"`;
  if (name === 'Glob' && typeof i.pattern === 'string') return `${name} ${cut(i.pattern, 30)}`;
  if (name === 'Bash' && typeof i.command === 'string') return `${name} ${cut(i.command, 30)}`;
  if (name === 'Agent' && typeof i.description === 'string') return `${name} ${cut(i.description, 30)}`;
  if (name === 'Skill' && typeof i.skill === 'string') return `${name} ${i.skill}`;
  return name;
}
const summary = (labels: string[]) => `도구 ${labels.length}번 · ${labels.slice(0, 4).join(', ')}${labels.length > 4 ? ' …' : ''}`;

function Tools({ tools }: { tools: ToolRun[] }) {
  return (
    <details className="tools" data-testid="tools">
      <summary>{summary(tools.map((t) => toolLabel(t.name, t.input)))}</summary>
      <div className="tools-body">
        {tools.map((t) => (
          <div key={t.id} className="tool-run">
            <div><b>{t.name}</b> {cut(JSON.stringify(t.input ?? null) ?? '', 300)}</div>
            {t.result && <div className={t.result.isError ? 'bad-text' : 'muted'}>{cut(t.result.text, 300) || '(결과 없음)'}</div>}
          </div>
        ))}
      </div>
    </details>
  );
}

const shortWorker = (w: string) => w.replace(/^[^:]+:/, '');
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export function workerState(w: WorkerRun, now: number): string {
  if (w.state === 'running') return `실행 중 · ${elapsed(now - w.startedAt)}`;
  if (w.state === 'error') return '오류';
  return w.endedAt ? `끝남 · ${elapsed(w.endedAt - w.startedAt)}` : '끝남';
}
function Workers({ ids, workers, now }: { ids: string[]; workers: Record<string, WorkerRun>; now: number }) {
  return (
    <div className="wtable-chat" role="table" aria-label="워커 진행" data-testid="worker-table">
      {ids.map((id) => {
        const w = workers[id];
        if (!w) return null;
        return (
          <div key={id} role="row" className="wrow-chat" data-state={w.state} data-testid="worker-run">
            <span role="cell" className={`dot ${w.state}`} aria-hidden="true" />
            <span role="cell" className="mono wname">{shortWorker(w.worker) || '[워커]'}</span>
            <span role="cell" className="wdesc">{w.description ?? ''}{w.background ? ' (백그라운드)' : ''}</span>
            <span role="cell" className="wstate">{workerState(w, now)}</span>
          </div>
        );
      })}
    </div>
  );
}

function Bubble({ text }: { text: string }) { return <div className="bubble">{text}</div>; }
function ClaudeLabel() { return <div className="claude-label">Claude</div>; }

// 지난 카드 한 줄. 서버가 접두어 없이 summary + outcome 을 준다. outcome 이 없으면(옛 서버) summary 그대로
export function answeredLabel(it: { summary: string; outcome?: 'answered' | 'denied' }): string {
  if (!it.outcome) return it.summary;
  return it.outcome === 'denied' ? `거부함: ${it.summary}` : `답함: ${it.summary}`;
}

// 지난 기록(읽기 전용)
function PastItems({ items }: { items: TranscriptItem[] }) {
  const out: ReactNode[] = [];
  let prevUser = true;
  items.forEach((it, i) => {
    if (it.type === 'user') { out.push(<Bubble key={i} text={it.text} />); prevUser = true; return; }
    if (prevUser) out.push(<ClaudeLabel key={`l${i}`} />);
    prevUser = false;
    if (it.type === 'assistant-text') out.push(<Markdown key={i} text={it.text} />);
    else if (it.type === 'tools') out.push(<details key={i} className="tools"><summary>{summary(it.names)}</summary><div className="tools-body mono">{it.names.join(', ')}</div></details>);
    else out.push(<span key={i} className="answered" data-testid="past-answered">{answeredLabel(it)}</span>);
  });
  return <div className="past" data-testid="past-transcript">{out}</div>;
}

// ── 409 분기: 서버가 준 reason 으로만 고른다 ─────────────────
// awaiting-card → 그 채팅으로 가기(본문 chatId), terminal-open → "이미 닫았다", chat-ended·그 밖 → 오류 문구.
// 409 가 아니면 null(부른 쪽이 오류 문구만 보인다)
export type ConflictAction =
  | { kind: 'go-chat'; chatId: string; message: string }
  | { kind: 'terminal'; sid: string }
  | { kind: 'ended'; message: string }
  | { kind: 'error'; message: string };
export function conflictAction(e: unknown, sid: string | null): ConflictAction | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const reason = e.reason as ChatConflict | null;
  if (reason === 'awaiting-card' && e.chatId) return { kind: 'go-chat', chatId: e.chatId, message: e.message };
  if (reason === 'terminal-open' && sid) return { kind: 'terminal', sid };
  if (reason === 'chat-ended') return { kind: 'ended', message: e.message };
  return { kind: 'error', message: e.message };
}

// ── 채팅 화면 ─────────────────────────────────────────
export type Target = { kind: 'new'; n: number } | { kind: 'past'; sid: string } | { kind: 'chat'; chatId: string; draft?: string }; // draft: 입력창에 미리 넣을 글
export interface ChatProps {
  projectId: string;
  projectPath: string;
  target: Target;
  sessions: SessionSummary[];
  chats: ChatInfo[];
  limits: Limits | null;
  newOptions: () => { model?: string; effort?: string };
  onLimits(l: Limits): void;
  onChanged(): void;                                   // 세션 목록·실행 중 채팅을 다시 읽을 때
  onTerminal(sessionId: string): void;
  onOpenChat(chatId: string, draft?: string): void;   // 다른(살아 있는) 채팅 화면으로 바꾼다
}

export function Chat(props: ChatProps) {
  const { projectId, target } = props;
  const [chatId, setChatId] = useState<string | null>(target.kind === 'chat' ? target.chatId : null);
  const viewRef = useRef<ChatView>(emptyView());
  const [, setTick] = useState(0);
  const rerender = () => setTick((n) => n + 1);
  const [past, setPast] = useState<TranscriptItem[] | null>(null);
  const [pastErr, setPastErr] = useState<string | null>(null);
  const [text, setText] = useState(target.kind === 'chat' ? target.draft ?? '' : '');
  const [sending, setSending] = useState(false);
  const [warn, setWarn] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [termBlocked, setTermBlocked] = useState<{ text: string; sid: string } | null>(null); // 터미널에서 열려 있어 409 로 막힌 글과 그 세션
  const [cardBlocked, setCardBlocked] = useState<{ chatId: string; message: string } | null>(null); // 이어할 채팅이 카드 답을 기다려 409
  const [down, setDown] = useState(false);
  const [meta, setMeta] = useState<{ model: string | null; effort: string | null } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const endRef = useRef<HTMLDivElement>(null);
  const cbRef = useRef(props);
  cbRef.current = props;

  const resumeSid = target.kind === 'past' ? target.sid : null;

  // 지난 기록
  useEffect(() => {
    if (!resumeSid) return;
    api.transcript(projectId, resumeSid).then(setPast).catch((e) => setPastErr(e.message));
  }, [projectId, resumeSid]);

  // 이벤트 스트림: 끊기면 1초 뒤 마지막 seq 로 다시 붙는다. 다시 붙기도 실패하면 서버가 꺼졌는지 본다
  useEffect(() => {
    if (!chatId) return;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let fails = 0;
    const probe = async () => {
      try {
        const list = await api.chats(projectId);
        if (stopped) return;
        setDown(false);
        // 서버는 살아 있는데 이벤트를 못 받으면(서버를 다시 켜서 채팅이 사라짐) 그만 붙는다
        if (fails >= 3 && !list.some((c) => c.chatId === chatId)) {
          stopped = true;
          clearTimeout(timer);
          const v = viewRef.current;
          v.state = 'ended';
          v.items.push({ k: 'notice', key: `gone${Date.now()}`, level: 'warn', message: '서버에 이 채팅이 없다 (서버를 다시 켜면 채팅은 끝난다) — 이어하기로 다시 연다' });
          rerender();
          cbRef.current.onChanged();
        }
      } catch (e) {
        if (!stopped && e instanceof ServerDownError) setDown(true);
      }
    };
    const connect = () => {
      if (stopped) return;
      es = new EventSource(`/api/chats/${encodeURIComponent(chatId)}/events?after=${viewRef.current.lastSeq}`);
      es.onopen = () => { fails = 0; setDown(false); };
      es.onmessage = (m) => {
        let ev: ChatEvent;
        try { ev = JSON.parse(m.data); } catch { return; }
        if (!applyEvent(viewRef.current, ev)) return;
        if (ev.type === 'limits') cbRef.current.onLimits(ev.limits);
        if (ev.type === 'init' || ev.type === 'result' || ev.type === 'exit') cbRef.current.onChanged();
        rerender();
      };
      es.onerror = () => {
        es?.close();
        if (stopped) return;
        fails++;
        if (fails >= 2) void probe();
        timer = setTimeout(connect, 1000);
      };
    };
    connect();
    return () => { stopped = true; clearTimeout(timer); es?.close(); };
  }, [chatId, projectId]);

  const v = viewRef.current;
  const running = live(v.state);
  const hasWorkersRunning = Object.values(v.workers).some((w) => w.state === 'running');
  // 한도 규칙(서버와 같은 limitGate): blocked → 보내기 막음, warn → 경고 줄만
  const gate = limitGate(props.limits, now);
  const rej = gate.kind === 'blocked' ? gate : null;
  // 시간 표시(워커 경과·한도 리셋)를 1초마다
  useEffect(() => {
    if (!hasWorkersRunning && !rej) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasWorkersRunning, !!rej]);

  // 새 줄이 오면 아래로
  const count = v.items.length + (past?.length ?? 0);
  const lastText = (() => { const l = v.items[v.items.length - 1]; return l && l.k === 'text' ? l.text.length : 0; })();
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [count, lastText]);

  const sessionId = v.sessionId ?? resumeSid;
  const session = props.sessions.find((s) => s.id === sessionId) ?? null;
  const firstUser = v.items.find((x) => x.k === 'user') as Extract<Item, { k: 'user' }> | undefined;
  const title = session?.title ?? firstUser?.text ?? (target.kind === 'new' ? '새 세션' : '세션');
  const mode = v.mode ?? session?.mode ?? null;
  const pend = pendingCard(v);
  const info = props.chats.find((c) => c.chatId === chatId);
  const mainModel = meta?.model ?? info?.model ?? v.model;
  const mainEffort = meta?.effort ?? info?.effort ?? null;

  async function start(body: string, resume: string | null) {
    const opts = cbRef.current.newOptions();
    const r = await api.startChat(projectId, { text: body, ...opts, ...(resume ? { resume } : {}) });
    // 이어할 세션이 이미 살아 있는 채팅이면 서버가 글을 그 채팅에 보냈다 → 그 채팅 화면으로
    if (r.forwarded) { cbRef.current.onChanged(); cbRef.current.onOpenChat(r.chat.chatId); return; }
    // 같은 세션을 다시 시작해도 앞 줄은 그대로 둔다
    const old = viewRef.current;
    viewRef.current = { ...emptyView(), items: old.items, workers: old.workers, mode: old.mode, sessionId: old.sessionId, gen: old.gen + 1 };
    setMeta({ model: r.chat.model, effort: r.chat.effort });
    setChatId(r.chat.chatId);
    setWarn(r.warnings);
    cbRef.current.onChanged();
  }

  async function send(body = text) {
    const t = body.trim();
    if (!t || sending) return;
    setSending(true); setErr(null); setWarn([]); setTermBlocked(null); setCardBlocked(null);
    // 새 세션, 이어하기, 끝난 채팅을 같은 세션으로 다시 — 이어할 세션 ID
    const resume = chatId ? v.sessionId : resumeSid;
    try {
      if (chatId && v.state !== 'ended') {
        const r = await api.send(chatId, t);
        setWarn(r.warnings);
      } else {
        await start(t, resume);
      }
      setText('');
    } catch (e: any) {
      // 409 는 서버가 준 reason 으로만 가른다(목록을 다시 읽으면 그사이 바뀐 상태와 경쟁한다). 입력 글은 그대로 둔다
      const a = conflictAction(e, resume ?? null);
      if (a?.kind === 'go-chat') setCardBlocked({ chatId: a.chatId, message: a.message });
      else if (a?.kind === 'terminal') setTermBlocked({ text: t, sid: a.sid });
      else setErr(e.message);
    } finally { setSending(false); }
  }

  async function forgetAndRetry() {
    if (!termBlocked) return;
    setSending(true); setErr(null);
    try {
      await api.forgetTerminal(projectId, termBlocked.sid);
      await start(termBlocked.text, termBlocked.sid);
      setTermBlocked(null); setText('');
    } catch (e: any) { setErr(e.message); } finally { setSending(false); }
  }

  const reply = async (r: CardReply) => { if (chatId) await api.respond(chatId, r); };
  const openTerm = sessionId ? () => props.onTerminal(sessionId) : null;

  // 상단 상태 배지
  let status: { text: string; cls: string } | null = null;
  if (rej) status = { text: '한도 초과', cls: 'bad' };
  else if (v.state === 'waiting') status = { text: pend?.kind === 'question' ? '답을 기다림' : '승인을 기다림', cls: 'warn' };
  else if (v.state === 'starting' || v.state === 'running') status = { text: '응답 중…', cls: '' };
  else if (v.state === 'idle' || v.state === 'ended') status = { text: '끝남', cls: '' };

  // 메시지 줄
  const rows: ReactNode[] = [];
  let prevUser = true;
  for (const it of v.items) {
    if (it.k === 'user') { rows.push(<Bubble key={it.key} text={it.text} />); prevUser = true; continue; }
    if (it.k === 'notice') { rows.push(<p key={it.key} className={`chat-notice ${it.level}`} role={it.level === 'info' ? undefined : 'alert'}>{it.message}</p>); continue; }
    if (prevUser) rows.push(<ClaudeLabel key={`l${it.key}`} />);
    prevUser = false;
    if (it.k === 'text') rows.push(<div key={it.key} data-testid="assistant-text" data-final={it.final}><Markdown text={it.text} /></div>);
    else if (it.k === 'tools') rows.push(<Tools key={it.key} tools={it.tools} />);
    else if (it.k === 'workers') rows.push(<Workers key={it.key} ids={it.ids} workers={v.workers} now={now} />);
    else if (it.card.kind === 'question') rows.push(<QuestionCard key={it.key} card={it.card} resolved={it.resolved} onReply={reply} />);
    else if (it.card.kind === 'permission') rows.push(<PermissionCard key={it.key} card={it.card} resolved={it.resolved} cwd={props.projectPath} onReply={reply} />);
    else rows.push(<UnknownCard key={it.key} card={it.card} onTerminal={openTerm} />);
  }

  const empty = !chatId && target.kind === 'new';
  return (
    <main className="pmain">
      <div className="bar-top">
        <span className="chat-title" data-testid="chat-title">{title}</span>
        <span className="badge" data-testid="mode-badge">모드: {mode ?? '—'}</span>
        {(chatId || resumeSid) && <span className="hint muted" data-testid="chat-model">메인 {mainModel ?? '기본값'}{mainEffort ? ` · ${mainEffort}` : ''}</span>}
        {status && <span className={`badge ${status.cls}`} data-testid="chat-status" data-state={v.state ?? ''}>{status.text}</span>}
        <div className="spacer" />
        {openTerm && <button type="button" className="btn small" onClick={openTerm}>터미널로 열기</button>}
      </div>
      <div className="chat" aria-live="polite">
        <div className="chat-inner">
          {down && <p className="chat-notice error" role="alert" data-testid="server-down">{SERVER_DOWN}</p>}
          {empty && <p className="hint chat-empty">첫 메시지를 보내면 새 세션이 시작된다.</p>}
          {resumeSid && !past && !pastErr && <p className="hint">지난 기록을 읽는 중…</p>}
          {pastErr && <p className="error" role="alert">{pastErr}</p>}
          {past && <PastItems items={past} />}
          {resumeSid && !chatId && past && <p className="hint">지난 기록이다. 메시지를 보내면 이 세션을 이어서 시작한다.</p>}
          {rows}
          {rej && (
            <div role="alert" className="card bad" data-testid="limit-rejected">
              {windowName(rej.window)} 한도를 다 썼다. {rej.resetsAt ? `${clock(rej.resetsAt)}에 다시 열린다.` : '다시 열리는 시각은 모른다.'} 채팅·터미널 둘 다 같은 한도라 기다려야 한다.
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>
      <div className="composer-wrap">
        {gate.kind === 'warn' && <p className="warn-line" role="alert" data-testid="limit-warn">{LIMIT_WARN}</p>}
        {warn.filter((w) => !(gate.kind === 'warn' && w.startsWith(LIMIT_WARN))).map((w, i) => <p key={i} className="warn-line" role="alert">{w}</p>)}
        {termBlocked && (
          <div className="warn-line row-wrap" role="alert">
            <span>이 세션은 터미널에서 열려 있다. 터미널을 닫은 뒤 이어한다.</span>
            <button type="button" className="btn small" disabled={sending} onClick={forgetAndRetry}>이미 닫았다</button>
          </div>
        )}
        {cardBlocked && (
          <div className="warn-line row-wrap" data-testid="card-blocked">
            <span>{cardBlocked.message}</span>
            <button type="button" className="btn small" onClick={() => props.onOpenChat(cardBlocked.chatId, text)}>그 채팅으로 가기</button>
          </div>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        <div className="composer">
          <label htmlFor="composer" className="sr-only">메시지</label>
          <textarea id="composer" rows={2} placeholder="메시지 · / 로 명령" value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!rej) void send(); } }} />
          <div className="row-wrap">
            <button type="button" className="btn small" onClick={() => { setText((t) => (t.startsWith('/jh-kit:start') ? t : `/jh-kit:start ${t}`)); document.getElementById('composer')?.focus(); }}>/jh-kit:start</button>
            <div className="spacer" />
            {chatId && running && <button type="button" className="btn small danger" onClick={() => { api.interrupt(chatId).catch((e) => setErr(e.message)); }}>중단</button>}
            <button type="button" className="btn primary small" disabled={!text.trim() || sending || !!rej} onClick={() => void send()}>보내기</button>
          </div>
        </div>
      </div>
    </main>
  );
}
