import type { ActiveSession, SessionSummary } from './api';
import type { ClaudeCaps } from './api';
import { ModelChip, workerState } from './Chat';

export const MODELS = ['', 'opus', 'sonnet', 'haiku'];
export const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
export const DEFAULT_LABEL = '기본값';

// ISO → "HH:MM"(오늘) · "어제 HH:MM" · "MM-DD"
export function when(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  const today = new Date(now);
  const yest = new Date(now - 86400000);
  if (d.toDateString() === today.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.toDateString() === yest.toDateString()) return `어제 ${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function meta(s: SessionSummary): string {
  const parts = [s.mode ?? null, s.running ? (s.running === 'terminal' ? '터미널에서 실행 중' : '실행 중') : when(s.lastAt ?? s.startedAt), `메시지 ${s.messages}`];
  return parts.filter(Boolean).join(' · ');
}

export interface SideProps {
  sessions: SessionSummary[] | null;
  sessionsErr: string | null;
  selected: string | null;                  // 고른 세션 줄
  pastPicked: boolean;                      // 고른 줄이 지난 세션이면 이어하기·터미널로 열기
  activity: ActiveSession[];
  caps: ClaudeCaps | null;
  model: string;
  effort: string;
  now: number;
  onModel(m: string): void;
  onEffort(e: string): void;
  onNew(): void;
  onPick(s: SessionSummary): void;
  onResume(sid: string): void;
  onTerminal(sid: string): void;
}

export function SessionSide(p: SideProps) {
  const workers = p.activity.flatMap((a) => a.workers.map((w) => ({ w, s: a })));
  return (
    <aside className="pside" aria-label="세션">
      <button type="button" className="btn new-session" onClick={p.onNew}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>새 세션
      </button>
      <div className="new-opts" data-caps={p.caps ? (p.caps.effort ? 'effort' : 'no-effort') : 'loading'}>
        <div className="field">
          <label htmlFor="new-model">모델</label>
          <select id="new-model" className="input" value={p.model} onChange={(e) => p.onModel(e.target.value)}>
            {MODELS.map((m) => <option key={m} value={m}>{m || DEFAULT_LABEL}</option>)}
          </select>
        </div>
        {p.caps?.effort && (
          <div className="field">
            <label htmlFor="new-effort">노력도</label>
            <select id="new-effort" className="input" value={p.effort} onChange={(e) => p.onEffort(e.target.value)}>
              {EFFORTS.map((m) => <option key={m} value={m}>{m || DEFAULT_LABEL}</option>)}
            </select>
          </div>
        )}
      </div>
      {p.caps && !p.caps.found && <p className="error" role="alert">PATH 에서 claude 를 못 찾았다</p>}

      <h2>세션</h2>
      <div className="slist" data-testid="session-list">
        {p.sessionsErr && <p className="error" role="alert">{p.sessionsErr}</p>}
        {!p.sessions && !p.sessionsErr && <p className="hint">불러오는 중…</p>}
        {p.sessions && p.sessions.length === 0 && <p className="hint">지난 세션이 없다</p>}
        {p.sessions?.map((s) => {
          const on = s.id === p.selected;
          return (
            <div key={s.id} className={`srow${on ? ' on' : ''}`} data-testid="session-row" data-sid={s.id}>
              <button type="button" className="spick" aria-pressed={on} onClick={() => p.onPick(s)}>
                <span className="stitle"><span className={`dot ${s.running ? 'running' : 'idle'}`} aria-hidden="true" /><span className="ell">{s.title}</span></span>
                <span className="smeta">{meta(s)}</span>
              </button>
              {on && p.pastPicked && (
                <div className="row-wrap sacts">
                  <button type="button" className="btn small grow" onClick={() => p.onResume(s.id)}>이어하기</button>
                  <button type="button" className="btn small grow" onClick={() => p.onTerminal(s.id)}>터미널로 열기</button>
                </div>
              )}
            </div>
          );
        })}
        <span className="hint side-note">명령만 친 세션(/usage 등)은 숨김</span>
      </div>

      <h2>작동 중</h2>
      <div className="alist" data-testid="activity">
        {workers.length === 0 && <p className="hint side-note">작동 중인 워커 없음</p>}
        {workers.map(({ w, s }) => (
          <div key={`${s.sessionId}:${w.id}`} className="arow" data-testid="activity-row">
            <span className={`dot ${w.state}`} aria-hidden="true" />
            <span className="mono aname ell">{w.worker.replace(/^[^:]+:/, '') || '[워커]'}</span>
            <ModelChip model={w.model} />
            <span className="astate">{workerState(w, p.now)}</span>
          </div>
        ))}
        <span className="hint side-note">채팅 세션은 출력에서, 터미널 세션은 jh-kit 훅 알림으로</span>
      </div>
    </aside>
  );
}
