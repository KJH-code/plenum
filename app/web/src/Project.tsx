import { useEffect, useState } from 'react';
import { api, type Project } from './api';
import { GitBadges, iconColor, initial } from './common';
import { Back } from './icons';
import { href } from './route';

export function ProjectPage({ id }: { id: string }) {
  const [p, setP] = useState<Project | null | undefined>(undefined);
  const [view, setView] = useState<'sessions' | 'files'>('sessions');
  useEffect(() => { api.projects().then((ps) => setP(ps.find((x) => x.id === id) ?? null)).catch(() => setP(null)); }, [id]);
  if (p === undefined) return <p className="hint" style={{ padding: 20 }}>불러오는 중…</p>;
  if (p === null) return <p style={{ padding: 20 }}>목록에 없는 프로젝트다. <a href={href.home}>홈으로</a></p>;
  return (
    <>
      <header className="topbar" style={{ gap: 10, minHeight: 48 }}>
        <a href={href.home} className="navbtn" aria-label="홈으로"><Back /></a>
        <div style={{ width: 26, height: 26, borderRadius: 6, background: iconColor(p.name), display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, color: '#FFFFFF' }}>{initial(p.name)}</div>
        <span style={{ fontWeight: 600 }}>{p.name}</span>
        <span className="hint" style={{ color: 'var(--fg-muted)' }}>{p.detection.branch ?? '[브랜치]'}</span>
        <GitBadges p={p} />
        <div className="spacer" />
        <span className="hint" style={{ color: 'var(--fg-muted)' }}>워커 작동 중 [n] · 이번 세션 한도 [n%]</span>
      </header>
      <div className="project">
        <nav className="ribbon" aria-label="보기 전환">
          <button type="button" aria-pressed={view === 'sessions'} aria-label="세션" onClick={() => setView('sessions')}>세</button>
          <button type="button" aria-pressed={view === 'files'} aria-label="파일" onClick={() => setView('files')}>파</button>
        </nav>
        <aside className="pside" aria-label={view === 'sessions' ? '세션' : '파일'}>
          {view === 'sessions' ? (
            <>
              <h2>세션</h2>
              <button type="button" className="btn" disabled>새 세션 · 이후 단계</button>
              <p className="placeholder" style={{ margin: '6px' }}>[세션 목록]</p>
              <h2>작동 중인 워커</h2>
              <p className="placeholder" style={{ margin: '6px' }}>[작동 중인 워커]</p>
            </>
          ) : (
            <>
              <h2>파일</h2>
              <p className="placeholder" style={{ margin: '6px' }}>[레포 파일 트리]</p>
              <p className="hint mono" style={{ margin: '6px', overflowWrap: 'anywhere' }}>{p.path}</p>
            </>
          )}
        </aside>
        <main className="pmain">
          <div className="bar-top">
            <span className="btn" aria-disabled="true">[세션 이름]</span>
            <span className="badge">모드: [모드]</span>
            <div className="spacer" />
            <span className="hint">채팅은 이후 단계</span>
          </div>
          <div className="chat"><p className="placeholder">[오케스트레이터 채팅]</p></div>
          <div className="composer">
            <label htmlFor="composer" className="sr-only">오케스트레이터에게 보내기</label>
            <textarea id="composer" rows={2} placeholder="오케스트레이터에게 보내기 (이후 단계)" disabled />
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn" disabled>모드 ▾</button>
              <div className="spacer" />
              <button type="button" className="btn primary" disabled>보내기</button>
            </div>
          </div>
        </main>
      </div>
    </>
  );
}
