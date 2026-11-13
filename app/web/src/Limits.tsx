import type { LimitWindow, Limits } from './api';

// 유닉스 초 → "HH:MM" (오늘이 아니면 "MM-DD HH:MM")
export function clock(sec: number, now = Date.now()): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return new Date(now).toDateString() === d.toDateString() ? hm : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}
export const windowName = (w: string) => (w === 'five_hour' ? '5시간' : w === 'seven_day' ? '주간' : w);

// 지금 막혀 있는 한도 (리셋 시각이 지났으면 아님)
export function activeRejection(l: Limits | null, now = Date.now()): Limits['rejected'] {
  const r = l?.rejected;
  if (!r) return null;
  if (r.resetsAt !== null && r.resetsAt * 1000 <= now) return null;
  return r;
}

function Bar({ name, w }: { name: string; w: LimitWindow | undefined }) {
  const pct = w ? Math.max(0, Math.min(100, w.pct)) : 0;
  const full = !!w && (w.status === 'rejected' || w.pct >= 100);
  return (
    <span className="lim" data-testid={`limit-${name}`}>
      {name}
      <span className="lim-track" role="meter" aria-label={`${name} 한도 사용량`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={w ? Math.round(pct) : undefined}>
        {w && <span className={`lim-fill${full ? ' full' : ''}`} style={{ width: `${pct}%` }} />}
      </span>
      <b className={full ? 'bad-text' : undefined}>{w ? `${Math.round(w.pct)}%` : '—'}</b>
    </span>
  );
}

export function LimitsBar({ limits }: { limits: Limits | null }) {
  const reset = limits?.fiveHour?.resetsAt;
  return (
    <div className="limits-top" aria-label="한도">
      <span>한도</span>
      <Bar name="5시간" w={limits?.fiveHour} />
      <Bar name="주간" w={limits?.sevenDay} />
      <span className="hint">
        {limits ? `${clock(Math.floor(limits.receivedAt / 1000))} 기준` : '—'}
        {reset ? ` · 5시간 창 ${clock(reset)} 리셋` : ''}
      </span>
    </div>
  );
}
