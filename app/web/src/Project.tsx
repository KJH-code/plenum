import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type ActiveSession, type ChatInfo, type ClaudeCaps, type Limits, type Project, type SessionSummary, type TerminalResult } from './api';
import { Chat, type Target } from './Chat';
import { GitBadges, iconColor, initial } from './common';
import { Back } from './icons';
import { LimitsBar } from './Limits';
import { EFFORTS, MODELS, SessionSide } from './SessionSide';
import { href } from './route';

const ACTIVITY_MS = 2000;
const store = {
  get(k: string, allowed: string[]): string { try { const v = localStorage.getItem(k) ?? ''; return allowed.includes(v) ? v : ''; } catch { return ''; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* 저장 못 해도 동작 */ } },
};

// ── 터미널로 열기 확인창 ─────────────────────────────────
function TerminalDialog({ projectId, sid, chatLive, onClose, onDone }: { projectId: string; sid: string; chatLive: boolean; onClose(): void; onDone(): void }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<TerminalResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  const win = typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent);
  useEffect(() => { first.current?.focus(); }, [res]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  const go = async () => {
    setBusy(true); setErr(null);
    try { setRes(await api.terminal(projectId, sid)); }
    catch (e: any) {
      setErr(e.message);
      if (e instanceof ApiError && e.data && Array.isArray(e.data.display)) setRes(e.data as TerminalResult);
    } finally { setBusy(false); onDone(); }
  };
  const copy = async () => {
    if (!res) return;
    try { await navigator.clipboard.writeText(res.display.join('\n')); setCopied(true); } catch { setCopied(false); }
  };
  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog narrow" role="dialog" aria-modal="true" aria-labelledby="term-title" data-testid="terminal-dialog">
        <div className="dhead"><h1 id="term-title">터미널로 열기</h1></div>
        <div className="dbody">
          {!res && (
            <span>
              같은 세션을 {win ? 'Windows Terminal' : '터미널'}에서 이어서 연다.
              {chatLive && <> 기록이 섞이지 않게 <b>채팅 쪽은 먼저 끝낸다.</b></>}
            </span>
          )}
          {busy && chatLive && <p className="hint" role="status">채팅을 끝내는 중…</p>}
          {res && (
            <>
              {res.closedChat && <span className="muted">채팅을 끝냈다.</span>}
              {res.launched ? <span>{res.via === 'wt' ? 'Windows Terminal' : '터미널'}을 열었다.</span>
                : res.via === 'manual' ? <span>이 두 줄을 터미널에 붙여 넣는다.</span> : null}
              <pre className="cmd" data-testid="terminal-lines">{res.display.join('\n')}</pre>
              {!res.launched && <div><button type="button" className="btn small" onClick={copy}>{copied ? '복사함' : '복사'}</button></div>}
            </>
          )}
          <span className="hint">처음 여는 폴더면 터미널에 "이 폴더를 믿나요" 창이 먼저 뜬다.</span>
          {err && <p className="error" role="alert">{err}</p>}
        </div>
        <div className="dfoot">
          {res ? (
            <button ref={first} type="button" className="btn" onClick={onClose}>닫기</button>
          ) : (
            <>
              <button ref={first} type="button" className="btn" disabled={busy} onClick={onClose}>취소</button>
              <button type="button" className="btn primary" disabled={busy} onClick={go}>{chatLive ? '채팅 끝내고 터미널로' : '터미널로'}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function ProjectPage({ id }: { id: string }) {
  const [p, setP] = useState<Project | null | undefined>(undefined);
  const [view, setView] = useState<'sessions' | 'files'>('sessions');
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sessionsErr, setSessionsErr] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatInfo[]>([]);
  const [activity, setActivity] = useState<ActiveSession[]>([]);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [caps, setCaps] = useState<ClaudeCaps | null>(null);
  const [model, setModel] = useState(() => store.get('plenum.chat.model', MODELS));
  const [effort, setEffort] = useState(() => store.get('plenum.chat.effort', EFFORTS));
  const [target, setTarget] = useState<Target | null>(null);
  const [targetKey, setTargetKey] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [term, setTerm] = useState<{ sid: string; chatLive: boolean } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => { api.projects().then((ps) => setP(ps.find((x) => x.id === id) ?? null)).catch(() => setP(null)); }, [id]);

  const refresh = useCallback(() => {
    api.sessions(id).then((s) => { setSessions(s); setSessionsErr(null); }).catch((e) => setSessionsErr(e.message));
    api.chats(id).then(setChats).catch(() => {});
  }, [id]);

  // 진입: 세션·채팅·한도·claude 기능. 돌고 있는 채팅이 있으면 그 채팅에 다시 붙는다(새로고침)
  useEffect(() => {
    refresh();
    api.limits().then((r) => setLimits(r.limits)).catch(() => {});
    api.caps().then(setCaps).catch(() => setCaps(null));
    api.chats(id).then((cs) => {
      setChats(cs);
      const last = cs[cs.length - 1];
      setTarget((t) => t ?? (last ? { kind: 'chat', chatId: last.chatId } : { kind: 'new', n: 0 }));
    }).catch(() => setTarget((t) => t ?? { kind: 'new', n: 0 }));
  }, [id, refresh]);

  // 작동 중: 2초마다, 탭이 숨겨지면 멈춘다
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => { setNow(Date.now()); api.activity(id).then((a) => setActivity(a.sessions)).catch(() => {}); };
    const startPoll = () => { if (!timer) { tick(); timer = setInterval(tick, ACTIVITY_MS); } };
    const stopPoll = () => { if (timer) { clearInterval(timer); timer = undefined; } };
    const onVis = () => (document.hidden ? stopPoll() : startPoll());
    if (!document.hidden) startPoll();
    document.addEventListener('visibilitychange', onVis);
    return () => { stopPoll(); document.removeEventListener('visibilitychange', onVis); };
  }, [id]);

  const go = (t: Target) => { setTarget(t); setTargetKey((k) => k + 1); };
  const newOptions = useCallback(() => ({
    ...(model ? { model } : {}),
    ...(effort && caps?.effort ? { effort } : {}),   // --effort 가 없는 claude 에는 저장된 값도 보내지 않는다
  }), [model, effort, caps]);

  const openTerminal = useCallback(async (sid: string) => {
    let cs = chats;
    try { cs = await api.chats(id); setChats(cs); } catch { /* 목록을 못 읽으면 가진 것으로 */ }
    setTerm({ sid, chatLive: cs.some((c) => c.sessionId === sid && c.state !== 'ended') });
  }, [chats, id]);

  if (p === undefined) return <p className="hint" style={{ padding: 20 }}>불러오는 중…</p>;
  if (p === null) return <p style={{ padding: 20 }}>목록에 없는 프로젝트다. <a href={href.home}>홈으로</a></p>;

  const currentChat = target?.kind === 'chat' ? chats.find((c) => c.chatId === target.chatId) : undefined;
  const selected = picked ?? (target?.kind === 'past' ? target.sid : currentChat?.sessionId ?? null);
  const pickedSession = sessions?.find((s) => s.id === picked) ?? null;
  const onPick = (s: SessionSummary) => {
    const c = chats.find((x) => x.sessionId === s.id && x.state !== 'ended');
    if (c) { setPicked(null); if (!(target?.kind === 'chat' && target.chatId === c.chatId)) go({ kind: 'chat', chatId: c.chatId }); return; }
    setPicked(s.id);
  };

  return (
    <>
      <header className="topbar" style={{ gap: 10, minHeight: 48 }}>
        <a href={href.home} className="navbtn" aria-label="홈으로"><Back /></a>
        <div style={{ width: 26, height: 26, borderRadius: 6, background: iconColor(p.name), display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#FFFFFF' }}>{initial(p.name)}</div>
        <span style={{ fontWeight: 600 }}>{p.name}</span>
        <span className="hint" style={{ color: 'var(--fg-muted)' }}>{p.detection.branch ?? '[브랜치]'}</span>
        <GitBadges p={p} />
        <div className="spacer" />
        <LimitsBar limits={limits} />
      </header>
      <div className="project">
        <nav className="ribbon" aria-label="보기 전환">
          <button type="button" aria-pressed={view === 'sessions'} aria-label="세션" onClick={() => setView('sessions')}>세</button>
          <button type="button" aria-pressed={view === 'files'} aria-label="파일" onClick={() => setView('files')}>파</button>
        </nav>
        {view === 'sessions' ? (
          <SessionSide
            sessions={sessions} sessionsErr={sessionsErr} selected={selected}
            pastPicked={!!pickedSession && !pickedSession.running}
            activity={activity} caps={caps} model={model} effort={effort} now={now}
            onModel={(m) => { setModel(m); store.set('plenum.chat.model', m); }}
            onEffort={(e) => { setEffort(e); store.set('plenum.chat.effort', e); }}
            onNew={() => { setPicked(null); go({ kind: 'new', n: Date.now() }); }}
            onPick={onPick}
            onResume={(sid) => { setPicked(null); go({ kind: 'past', sid }); }}
            onTerminal={(sid) => { void openTerminal(sid); }}
          />
        ) : (
          <aside className="pside" aria-label="파일">
            <h2>파일</h2>
            <p className="placeholder" style={{ margin: '6px' }}>[레포 파일 트리]</p>
            <p className="hint mono" style={{ margin: '6px', overflowWrap: 'anywhere' }}>{p.path}</p>
          </aside>
        )}
        {target ? (
          <Chat key={targetKey} projectId={p.id} projectPath={p.path} target={target} sessions={sessions ?? []} chats={chats} limits={limits}
            newOptions={newOptions} onLimits={setLimits} onChanged={refresh} onTerminal={(sid) => { void openTerminal(sid); }}
            onOpenChat={(chatId, draft) => { setPicked(null); go({ kind: 'chat', chatId, ...(draft ? { draft } : {}) }); }} />
        ) : <main className="pmain"><p className="hint" style={{ padding: 20 }}>불러오는 중…</p></main>}
      </div>
      {term && <TerminalDialog projectId={p.id} sid={term.sid} chatLive={term.chatLive} onClose={() => setTerm(null)} onDone={refresh} />}
    </>
  );
}
