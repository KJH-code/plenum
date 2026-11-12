import { useEffect, useState } from 'react';
import { api, type Project } from './api';
import { GitBadges, NotGitNotice, ParentRepoNotice, iconColor, initial, subtitle } from './common';
import { Play, Plus } from './icons';
import { href } from './route';

export function Home({ reload, onAdd, onChanged }: { reload: number; onAdd: () => void; onChanged: () => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    api.projects().then((ps) => {
      setProjects(ps);
      setSelected((cur) => (cur && ps.some((p) => p.id === cur) ? cur : ps[0]?.id ?? null));
    }).catch((e) => setError(e.message));
  }, [reload]);

  const sel = projects?.find((p) => p.id === selected) || null;

  return (
    <>
      <div className="home">
        <main>
          <section aria-label="프로젝트">
            <div className="section-title"><h2>프로젝트</h2><div className="rule" /></div>
            {error && <p className="error">{error}</p>}
            <div className="tiles">
              {projects?.map((p) => (
                <button key={p.id} type="button" className="tile" aria-pressed={p.id === selected} onClick={() => setSelected(p.id)}
                  onDoubleClick={() => { window.location.hash = href.project(p.id); }} data-testid="tile">
                  <div className="icon" style={{ background: iconColor(p.name) }}>{initial(p.name)}</div>
                  <div className="name">{p.name}</div>
                  <div className="sub">{subtitle(p)}</div>
                  <div><GitBadges p={p} /></div>
                </button>
              ))}
              <button type="button" className="tile add" onClick={onAdd}>
                <Plus />
                <span>프로젝트 추가</span>
                <span className="hint">GitHub 레포 · 로컬 폴더</span>
              </button>
            </div>
          </section>

          <section aria-label="작동 중">
            <div className="section-title"><h2>작동 중</h2><span className="hint">세션 [n] · 워커 [n]</span><div className="rule" /></div>
            <div className="list-box"><div className="row placeholder">[작동 중인 세션·워커 — 세션 실행은 이후 단계]</div></div>
          </section>
        </main>
        {sel && <SidePanel p={sel} onChanged={onChanged} />}
      </div>
      <section className="limits" aria-label="한도 사용량">
        <span style={{ fontWeight: 600 }}>한도</span>
        {['5시간 한도', '주간 한도', '주간 · Opus'].map((l) => (
          <div className="limit" key={l}><span style={{ width: 90 }}>{l}</span><div className="bar" /><span>[n%]</span></div>
        ))}
      </section>
    </>
  );
}

function SidePanel({ p, onChanged }: { p: Project; onChanged: () => void }) {
  const [msg, setMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [doc, setDoc] = useState<string | null>(null);
  useEffect(() => { setMsg(null); setDoc(null); }, [p.id]);
  const d = p.detection;
  const act = (f: () => Promise<unknown>, ok: string) => async () => {
    setMsg(null);
    try { await f(); setMsg({ kind: 'ok', text: ok }); } catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  };
  return (
    <aside className="panel" aria-label="선택한 프로젝트">
      <div className="head">
        <div className="bigicon" style={{ background: iconColor(p.name) }}>{initial(p.name)}</div>
        <div style={{ fontWeight: 600, fontSize: 15 }}>{p.name}</div>
        <div className="hint" style={{ color: 'var(--fg-muted)' }}>{subtitle(p)}</div>
        <div className="path mono" data-testid="project-path">{p.path}</div>
        <div><GitBadges p={p} /></div>
      </div>
      {d.exists && d.git === 'none' && <NotGitNotice />}
      {d.exists && d.git === 'none' && d.parentRepo && <ParentRepoNotice parent={d.parentRepo} />}
      <a className="btn primary" href={href.project(p.id)}><Play />열기</a>
      <button type="button" className="action" disabled={!d.exists} onClick={act(() => api.openFolder(p.id), '폴더를 열었다')}>폴더 열기</button>
      <button type="button" className="action" disabled={!d.hasClaudeMd} title={d.hasClaudeMd ? undefined : 'CLAUDE.md가 없다'}
        onClick={async () => { setMsg(null); try { setDoc((await api.claudeMd(p.id)).text); } catch (e: any) { setMsg({ kind: 'error', text: e.message }); } }}>
        CLAUDE.md 보기{!d.hasClaudeMd && ' (없음)'}
      </button>
      <button type="button" className="action" disabled={!d.exists} onClick={act(() => api.openEditor(p.id), '에디터를 열었다')}>외부 에디터로 열기</button>
      {d.github
        ? <a className="action" href={d.github.url} target="_blank" rel="noreferrer">GitHub에서 보기</a>
        : <button type="button" className="action" disabled title="GitHub 원격이 없다">GitHub에서 보기 (원격 없음)</button>}
      <button type="button" className="action" onClick={async () => {
        if (!window.confirm(`"${p.name}"을 목록에서 뺄까? 폴더는 지우지 않는다.`)) return;
        try { await api.remove(p.id); onChanged(); } catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
      }}>목록에서 빼기</button>
      {msg && <p className={msg.kind === 'error' ? 'error' : 'hint'} role="status">{msg.text}</p>}
      {doc !== null && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setDoc(null)}>
          <div className="dialog" role="dialog" aria-label="CLAUDE.md" onClick={(e) => e.stopPropagation()}>
            <div className="dhead"><h1>CLAUDE.md · {p.name}</h1><button type="button" className="btn ghost" onClick={() => setDoc(null)}>닫기</button></div>
            <div className="dbody"><pre className="doc">{doc}</pre></div>
          </div>
        </div>
      )}
    </aside>
  );
}
