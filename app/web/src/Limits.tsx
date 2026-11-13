import type { LimitWindow, Limits } from './api';
export { limitGate } from '../../server/chatTypes';

// 유닉스 초 → "HH:MM" (오늘이 아니면 "MM-DD HH:MM")
export function clock(sec: number, now = Date.now()): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return new Date(now).toDateString() === d.toDateString() ? hm : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}
export const windowName = (w: string) => (w === 'five_hour' ? '5시간' : w === 'seven_day' ? '주간' : w);

// 한도 신호는 왔지만 리셋 시각을 모를 때(limitGate warn) 입력창 위에 보이는 줄. 서버 경고(같은 말로 시작)와 겹치면 하나만
export const LIMIT_WARN = '사용 한도에 걸렸다는 신호가 왔지만 리셋 시각을 모른다';

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
