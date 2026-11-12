import { Fragment, useEffect, useState } from 'react';
import { api, type KitResult, type Settings, type Worker } from './api';
import { href } from './route';
import { Back } from './icons';

const CATS: [id: string, label: string][] = [
  ['general', '일반'], ['kit', 'kit'], ['workers', '워커'], ['modes', '모드'], ['providers', '모델 · 프로바이더'], ['rules', '규칙'], ['account', '계정 · 한도'],
];

export function SettingsPage({ cat, onChanged }: { cat: string; onChanged: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.settings().then(setSettings).catch((e) => setError(e.message)); }, []);
  const save = async (patch: Partial<Settings>) => {
    const s = await api.saveSettings(patch);
    setSettings(s);
    onChanged();
  };
  return (
    <div className="settings">
      <nav aria-label="설정 분류">
        <a href={href.home} className="navbtn" style={{ padding: '10px 20px', height: 'auto' }}><Back />홈</a>
        {CATS.map(([id, label]) => <a key={id} href={href.settings(id)} aria-current={cat === id ? 'page' : undefined}>{label}</a>)}
      </nav>
      <main>
        {error && <p className="error">{error}</p>}
        {cat === 'general' && settings && <General s={settings} save={save} />}
        {cat === 'kit' && settings && <KitSettings s={settings} save={save} />}
        {cat === 'workers' && settings && <Workers kitPath={settings.kitRepoPath} />}
        {!['general', 'kit', 'workers'].includes(cat) && (
          <>
            <h1>{CATS.find((c) => c[0] === cat)?.[1] ?? cat}</h1>
            <p className="placeholder">[이후 단계에서 열린다]</p>
          </>
        )}
      </main>
    </div>
  );
}

function PathField({ label, value, onSave, hint, mono = true }: { label: string; value: string; onSave: (v: string) => Promise<void>; hint?: string; mono?: boolean }) {
  const [v, setV] = useState(value);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  useEffect(() => setV(value), [value]);
  return (
    <div>
      <div className="form-row">
        <label className="field">{label}
          <input className={`input${mono ? ' mono' : ''}`} value={v} onChange={(e) => { setV(e.target.value); setMsg(null); }} />
        </label>
        <button type="button" className="btn" disabled={v === value || !v.trim()} onClick={async () => {
          try { await onSave(v); setMsg({ kind: 'ok', text: '저장했다' }); } catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
        }}>저장</button>
      </div>
      {hint && <div className="hint">{hint}</div>}
      {msg && <div className={msg.kind === 'error' ? 'error' : 'hint'} role="status">{msg.text}</div>}
    </div>
  );
}

function General({ s, save }: { s: Settings; save: (p: Partial<Settings>) => Promise<void> }) {
  return (
    <>
      <h1>일반</h1>
      <PathField label="GitHub clone 폴더" value={s.cloneDir} onSave={(v) => save({ cloneDir: v })} hint="GitHub 주소로 추가하면 이 폴더 아래 <레포 이름>으로 clone한다" />
      <PathField label="외부 에디터 명령" value={s.editorCommand} onSave={(v) => save({ editorCommand: v })} hint="폴더 경로를 인자로 받는 명령. VS Code는 code" mono={false} />
      <p className="hint">설정 파일: <span className="mono">{s.configDir}</span></p>
    </>
  );
}

function KitSettings({ s, save }: { s: Settings; save: (p: Partial<Settings>) => Promise<void> }) {
  return (
    <>
      <h1>kit</h1>
      <PathField label="kit 레포 경로" value={s.kitRepoPath ?? ''} onSave={(v) => save({ kitRepoPath: v })} hint="kit/kit.yaml 과 build/claude-code/ 가 있는 레포 (예: jh-kit 클론)" />
    </>
  );
}

const fmtModes = (w: Worker) => w.modes.length === 0 ? <span className="placeholder">[쓰는 모드 없음]</span>
  : w.modes.map((m, i) => <Fragment key={`${m.mode}-${m.fallback}`}>{i > 0 && '·'}<span className={m.fallback ? 'fb' : undefined}>{m.fallback ? `${m.mode}(대체)` : m.mode}</span></Fragment>);

export function Workers({ kitPath }: { kitPath: string | null }) {
  const [kit, setKit] = useState<KitResult | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { api.workers().then(setKit).catch((e) => setKit({ ok: false, repo: kitPath, message: e.message })); }, [kitPath]);

  if (!kit) return <p className="hint">kit 읽는 중…</p>;
  if (!kit.ok) {
    return (
      <>
        <h1>워커</h1>
        <p className="error" role="alert">{kit.message}</p>
        <p><a href={href.settings('kit')}>설정 › kit에서 kit 레포 경로 지정</a></p>
      </>
    );
  }
  const groups = kit.stages.map((s) => ({ stage: s, items: kit.workers.filter((w) => w.stage === s) })).filter((g) => g.items.length > 0);
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 12 }}>
        <h1>워커 ({kit.workers.length})</h1>
        <span className="hint" style={{ color: 'var(--fg-muted)' }}>kit: {kit.name} {kit.version} · 단계별 · 행을 누르면 펼쳐진다</span>
      </div>
      <div className="workers-wrap">
        <div className="wtable">
          <table aria-label="워커 목록">
            <thead><tr><th style={{ width: 36 }}><span className="sr-only">펼치기</span></th><th>이름</th><th>하는 일</th><th>AI</th><th>노력도</th><th>쓰는 모드</th></tr></thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.stage}>
                  <tr className="group" data-testid="stage-group"><td colSpan={6}>{g.stage} <span className="count">· {g.items.length}</span></td></tr>
                  {g.items.map((w) => {
                    const isOpen = open === w.name;
                    const toggle = () => setOpen(isOpen ? null : w.name);
                    return (
                      <Fragment key={w.name}>
                        <tr className="wrow" data-open={isOpen} onClick={toggle} data-testid="worker-row">
                          <td><button type="button" className="toggle" aria-expanded={isOpen} aria-label={`${isOpen ? '접기' : '펼치기'}: ${w.name}`} onClick={(e) => { e.stopPropagation(); toggle(); }}>{isOpen ? '▾' : '▸'}</button></td>
                          <td className="mono">{w.name}</td>
                          <td className="muted">{w.summary}</td>
                          <td><span className={`chip ${w.model}`}>{w.model}</span></td>
                          <td>{w.effort}</td>
                          <td className="muted">{fmtModes(w)}</td>
                        </tr>
                        {isOpen && (
                          <tr><td colSpan={6} style={{ padding: 0 }}>
                            <div className="detail" data-testid="worker-detail">
                              <div><div className="k">AI · 노력도</div>{w.model} · {w.effort}</div>
                              <div><div className="k">도구</div><span className="mono">{w.tools || '[도구 칸 없음]'}</span></div>
                              <div><div className="k">최대 턴 · 격리</div>{w.maxTurns ?? '[maxTurns 없음]'} · {w.isolation ?? '없음'}</div>
                              <div><div className="k">원본 파일</div><span className="mono">{w.file}</span></div>
                              <div className="wide"><div className="k">description</div>{w.description}</div>
                            </div>
                          </td></tr>
                        )}
                      </Fragment>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <aside className="side-actions" aria-label="워커 동작">
          {['외부 에디터로 열기', '빌드', '설치본에 반영', '워커 추가', '복제', '삭제'].map((l) => <button key={l} type="button" className="btn" disabled>{l}</button>)}
          <span className="hint">편집·빌드는 이후 단계</span>
        </aside>
      </div>
    </>
  );
}
