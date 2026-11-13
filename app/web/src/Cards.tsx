import { useState } from 'react';
import type { Card, CardReply, Question } from './api';

// 카드 답 결과 (card-resolved). null 이면 아직 답하지 않음
export interface Resolved { outcome: 'allow' | 'allow-session' | 'deny' | 'answered' | 'cancelled'; detail?: string }
type Reply = (r: CardReply) => Promise<void>;

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

// 보내는 중·오류 한 줄을 같이 다루는 답 보내기
function useSend(onReply: Reply) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async (r: CardReply) => {
    setBusy(true); setErr(null);
    try { await onReply(r); } catch (e: any) { setErr(e?.message || String(e)); } finally { setBusy(false); }
  };
  return { busy, err, send };
}

// ── 질문 카드 ─────────────────────────────────────────
export function QuestionCard({ card, resolved, onReply }: { card: Extract<Card, { kind: 'question' }>; resolved: Resolved | null; onReply: Reply }) {
  const { busy, err, send } = useSend(onReply);
  const qs = card.questions;
  // 질문 하나·한 개 고르기면 누르는 즉시 보낸다. 아니면 고른 뒤 "보내기"
  const instant = qs.length === 1 && !qs[0].multiSelect;
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const open = !resolved;
  const answerOf = (i: number): string => (other[i]?.trim() ? other[i].trim() : (picked[i] ?? []).join(', '));
  const allAnswered = qs.every((_, i) => answerOf(i) !== '');
  const submit = (answers: Record<string, string>) => send({ requestId: card.requestId, action: 'answer', answers });
  const submitAll = () => submit(Object.fromEntries(qs.map((q, i) => [q.question, answerOf(i)])));
  const toggle = (i: number, q: Question, label: string) => {
    setPicked((p) => {
      const cur = p[i] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
      return { ...p, [i]: next };
    });
  };
  return (
    <div role="group" aria-label="질문" className={`card${open ? ' pending' : ''}`} data-testid="question-card">
      {qs.map((q, i) => (
        <div key={i} className="qgroup">
          <div className="card-head">
            {q.header && <span className="tag">{q.header}</span>}
            <span className="card-title">{q.question}</span>
            {q.multiSelect && open && <span className="hint">여러 개 고를 수 있다</span>}
          </div>
          {open && (
            <>
              <div className="opts">
                {q.options.map((o, k) => (
                  <button key={k} type="button" className={`opt${o.recommended ? ' rec' : ''}`} disabled={busy}
                    aria-pressed={instant ? undefined : (picked[i] ?? []).includes(o.label)}
                    onClick={() => (instant ? submit({ [q.question]: o.label }) : toggle(i, q, o.label))}>
                    <span className="opt-label">{o.label}</span>
                    {o.description && <span className="opt-desc">{o.description}</span>}
                  </button>
                ))}
              </div>
              <div className="row-wrap">
                <label htmlFor={`q-other-${card.requestId}-${i}`} className="sr-only">기타 — 직접 입력</label>
                <input id={`q-other-${card.requestId}-${i}`} className="input grow" type="text" placeholder="기타 — 직접 입력" disabled={busy}
                  value={other[i] ?? ''} onChange={(e) => setOther((o) => ({ ...o, [i]: e.target.value }))}
                  onKeyDown={(e) => { if (instant && e.key === 'Enter' && !e.nativeEvent.isComposing && other[i]?.trim()) submit({ [q.question]: other[i].trim() }); }} />
                {instant && <button type="button" className="btn" disabled={busy || !other[i]?.trim()} onClick={() => submit({ [q.question]: other[i].trim() })}>보내기</button>}
              </div>
            </>
          )}
        </div>
      ))}
      {open && !instant && (
        <div className="row-end"><button type="button" className="btn primary" disabled={busy || !allAnswered} onClick={submitAll}>보내기</button></div>
      )}
      {resolved && <span className={resolved.outcome === 'cancelled' ? 'muted' : 'ok-text'} data-testid="card-result">{resolved.outcome === 'cancelled' ? '답하기 전에 턴이 끝났다' : `→ ${resolved.detail ?? ''}`}</span>}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

// ── 승인 카드 ─────────────────────────────────────────
function permTitle(tool: string): string {
  if (tool === 'Bash') return '명령을 실행해도 될까?';
  if (tool === 'Edit' || tool === 'MultiEdit') return '파일을 고쳐도 될까?';
  if (tool === 'Write') return '파일을 써도 될까?';
  return `${tool} 도구를 써도 될까?`;
}
function permBody(tool: string, input: unknown): string {
  if (isObj(input)) {
    if (tool === 'Bash' && typeof input.command === 'string') return input.command;
    if (typeof input.file_path === 'string') return input.file_path;
    if (typeof input.path === 'string') return input.path;
    if (typeof input.url === 'string') return input.url;
  }
  const s = JSON.stringify(input ?? null, null, 2) ?? '';
  return s.length > 800 ? `${s.slice(0, 800)}…` : s;
}
export function resolvedText(r: Resolved): string {
  switch (r.outcome) {
    case 'allow': return '허용';
    case 'allow-session': return '허용 · 이 세션 동안 다시 묻지 않음';
    case 'deny': return r.detail ? `거부함 · "${r.detail}"를 Claude에게 전달` : '거부함';
    case 'answered': return `→ ${r.detail ?? ''}`;
    case 'cancelled': return '답하기 전에 턴이 끝났다';
  }
}

export function PermissionCard({ card, resolved, cwd, onReply }: { card: Extract<Card, { kind: 'permission' }>; resolved: Resolved | null; cwd: string; onReply: Reply }) {
  const { busy, err, send } = useSend(onReply);
  const [denyOpen, setDenyOpen] = useState(false);
  const [reason, setReason] = useState('');
  const open = !resolved;
  const rules = card.sessionRules.map((r) => r.ruleContent ?? r.toolName).join(', ');
  const deny = () => send({ requestId: card.requestId, action: 'deny', ...(reason.trim() ? { reason: reason.trim() } : {}) });
  return (
    <div role="group" aria-label="승인 요청" className={`card${open ? ' pending' : ''}`} data-testid="permission-card">
      <div className="card-head"><span className="tag warn">승인</span><span className="card-title">{permTitle(card.toolName)}</span></div>
      <code className="cmd">{permBody(card.toolName, card.input)}</code>
      <span className="meta">{[card.toolName, card.description, `작업 폴더 ${cwd}`].filter(Boolean).join(' · ')}</span>
      {card.diff && (
        <details className="diff-fold">
          <summary>바뀌는 내용 보기</summary>
          <div className="diff">
            <div className="dfile">{card.diff.path}</div>
            {card.diff.old !== '' && card.diff.old.split('\n').map((l, i) => <div key={`d${i}`} className="del">- {l}</div>)}
            {card.diff.new.split('\n').map((l, i) => <div key={`a${i}`} className="add">+ {l}</div>)}
          </div>
        </details>
      )}
      {open && (
        <>
          <div className="row-wrap">
            <button type="button" className="btn primary" disabled={busy} onClick={() => send({ requestId: card.requestId, action: 'allow' })}>허용</button>
            {card.sessionRules.length > 0 && (
              <button type="button" className="btn" disabled={busy} onClick={() => send({ requestId: card.requestId, action: 'allow-session' })}>
                이 세션 동안 <code>{rules}</code> 허용
              </button>
            )}
            <button type="button" className="btn danger" disabled={busy} aria-expanded={denyOpen} onClick={() => setDenyOpen((v) => !v)}>거부…</button>
          </div>
          {denyOpen && (
            <div className="row-wrap">
              <label htmlFor={`deny-${card.requestId}`} className="sr-only">거부 이유</label>
              <input id={`deny-${card.requestId}`} className="input grow danger" type="text" autoFocus placeholder="이유 (비워도 됨) — 예: 테스트는 내가 돌릴게"
                value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) deny(); }} />
              <button type="button" className="btn danger" disabled={busy} onClick={deny}>거부 보내기</button>
            </div>
          )}
        </>
      )}
      {resolved && <span className={resolved.outcome === 'deny' ? 'bad-text' : resolved.outcome === 'cancelled' ? 'muted' : 'ok-text'} data-testid="card-result">{resolvedText(resolved)}</span>}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

// ── 처리 못 하는 요청 ───────────────────────────────────
export function UnknownCard({ card, onTerminal }: { card: Extract<Card, { kind: 'unknown' }>; onTerminal: (() => void) | null }) {
  return (
    <div role="alert" className="card unknown" data-testid="unknown-card">
      <span>채팅에서 다룰 수 없는 요청이 왔다 (Claude Code {card.version ?? '버전 모름'} · 처음 보는 형식). 같은 세션을 터미널에서 이어서 처리한다.</span>
      {onTerminal && <button type="button" className="btn warn" onClick={onTerminal}>터미널로 열기</button>}
    </div>
  );
}
