import { useEffect, useState } from 'react';
import { api, type Detection } from './api';
import { NotGitNotice, ParentRepoNotice } from './common';
import { Close } from './icons';

const gitText = (d: Detection) => (!d.exists ? '폴더 없음' : d.git === 'none' ? '아님' : d.git === 'empty' ? '커밋 없음' : `있음 · ${d.branch || '[브랜치 없음]'}`);

export function AddProject({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [tab, setTab] = useState<'github' | 'local'>('local');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 로컬
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [found, setFound] = useState<{ path: string; name: string; detection: Detection } | null>(null);
  // GitHub
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState<{ dest: string; exists: boolean } | null>(null);

  useEffect(() => { setError(null); }, [tab]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const inspect = async () => {
    setError(null); setFound(null);
    try { const r = await api.inspect(path); setFound(r); setName(r.name); } catch (e: any) { setError(e.message); }
  };
  const checkUrl = async (u: string) => {
    setUrl(u); setTarget(null); setError(null);
    if (!u.trim()) return;
    try { setTarget(await api.cloneTarget(u)); } catch (e: any) { setError(e.message); }
  };
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      if (tab === 'local') await api.addLocal(found ? found.path : path, name || undefined);
      else await api.addGitHub(url);
      onAdded();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const canSubmit = !busy && (tab === 'local' ? !!found && found.detection.exists : !!target && !target.exists);

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-title">
        <div className="dhead">
          <h1 id="add-title">프로젝트 추가</h1>
          <button type="button" className="btn ghost" aria-label="닫기" onClick={onClose} disabled={busy}><Close /></button>
        </div>
        <div className="tabs" role="tablist" aria-label="추가 방법">
          <button type="button" role="tab" className="tab" aria-selected={tab === 'github'} onClick={() => setTab('github')}>GitHub에서</button>
          <button type="button" role="tab" className="tab" aria-selected={tab === 'local'} onClick={() => setTab('local')}>로컬 폴더에서</button>
        </div>
        <div className="dbody">
          {tab === 'local' ? (
            <>
              <div className="form-row">
                <label className="field">폴더 경로
                  <input className="input mono" value={path} onChange={(e) => { setPath(e.target.value); setFound(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') inspect(); }} placeholder="C:\Users\…\프로젝트 폴더" />
                </label>
                <button type="button" className="btn" onClick={inspect} disabled={!path.trim()}>확인</button>
              </div>
              <span className="hint">폴더 선택 창(찾아보기)은 데스크톱 앱으로 포장할 때 생긴다. 지금은 경로를 붙여 넣는다.</span>
              {found && (
                <>
                  <section aria-label="감지 결과" className="detect">
                    <div><span>git</span><b>{gitText(found.detection)}</b></div>
                    <div><span>GitHub</span>{found.detection.github ? `${found.detection.github.owner}/${found.detection.github.repo}` : '없음'}</div>
                    <div><span>CLAUDE.md</span>{found.detection.hasClaudeMd ? '있음' : '없음'}</div>
                    <div><span>.claude/</span>{found.detection.hasClaudeDir ? '있음' : '없음'}</div>
                  </section>
                  {found.detection.exists && found.detection.git === 'none' && <NotGitNotice />}
                  {found.detection.exists && found.detection.git === 'none' && found.detection.parentRepo && <ParentRepoNotice parent={found.detection.parentRepo} />}
                  <label className="field">표시 이름
                    <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
                  </label>
                </>
              )}
            </>
          ) : (
            <>
              <label className="field">GitHub 레포 주소
                <input className="input mono" value={url} onChange={(e) => checkUrl(e.target.value)} placeholder="https://github.com/<owner>/<repo>" />
              </label>
              {target && (
                <div className="detect" style={{ gridTemplateColumns: '1fr' }}>
                  <div><span>clone 위치</span><span className="mono">{target.dest}</span></div>
                  {target.exists && <div className="error">이 폴더가 이미 있다. 로컬 폴더로 추가하거나 설정 › 일반에서 clone 폴더를 바꾼다.</div>}
                </div>
              )}
              <span className="hint">비공개 레포는 이 PC의 git 자격 증명으로 받는다.</span>
            </>
          )}
          {busy && tab === 'github' && <p className="hint" role="status">clone 중…</p>}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
        <div className="dfoot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>취소</button>
          <button type="button" className="btn primary" onClick={submit} disabled={!canSubmit}>{tab === 'github' ? 'clone 후 추가' : '추가'}</button>
        </div>
      </div>
    </div>
  );
}
