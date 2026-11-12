import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { api, type Settings, type Versions } from './api';
import { href } from './route';
import { Back } from './icons';
import { InstallPanel } from './InstallPanel';
import { Workers, type Drafts } from './WorkerEdit';

const CATS: [id: string, label: string][] = [
  ['general', '일반'], ['kit', 'kit'], ['workers', '워커'], ['modes', '모드'], ['providers', '모델 · 프로바이더'], ['rules', '규칙'], ['account', '계정 · 한도'],
];

export function SettingsPage({ cat, onChanged, versions, refreshVersions, drafts, setDrafts }: {
  cat: string; onChanged: () => void; versions: Versions | null; refreshVersions: () => void;
  drafts: Drafts; setDrafts: Dispatch<SetStateAction<Drafts>>;
}) {
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
        {cat === 'kit' && settings && <KitSettings s={settings} save={save} v={versions} refreshVersions={refreshVersions} />}
        {cat === 'workers' && settings && <Workers kitPath={settings.kitRepoPath} versions={versions} refreshVersions={refreshVersions} drafts={drafts} setDrafts={setDrafts} />}
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

function KitSettings({ s, save, v, refreshVersions }: { s: Settings; save: (p: Partial<Settings>) => Promise<void>; v: Versions | null; refreshVersions: () => void }) {
  return (
    <>
      <h1>kit</h1>
      <PathField label="kit 레포 경로" value={s.kitRepoPath ?? ''} onSave={(val) => save({ kitRepoPath: val })}
        hint="kit 레포를 clone한 폴더의 전체 경로 (kit/kit.yaml 과 build/claude-code/ 가 있어야 한다). owner/repo·상대 경로는 받지 않는다" />
      {v && <VersionDetail v={v} refreshVersions={refreshVersions} />}
    </>
  );
}

function VersionDetail({ v, refreshVersions }: { v: Versions; refreshVersions: () => void }) {
  // 반영을 누른 뒤 같음이 돼도 결과는 보이게: 한 번 version-differs였으면 패널을 남긴다
  const [showInstall, setShowInstall] = useState(v.status === 'version-differs');
  useEffect(() => { if (v.status === 'version-differs') setShowInstall(true); }, [v.status]);
  const row = (label: string, side: Versions['source'], problem: string | null) => (
    <div><span>{label}</span>{side
      ? <span className="mono">{side.version} · 파일 {side.files} · 해시 {side.hash ? side.hash.slice(0, 12) : '[없음]'}{side.crFiles > 0 ? ` · CRLF 파일 ${side.crFiles}` : ''}<br />{side.path}</span>
      : <span>[{problem || '모름'}]</span>}</div>
  );
  const crSide = v.source && v.installed ? (v.source.crFiles > 0 ? 'source' : v.installed.crFiles > 0 ? 'installed' : null) : null;
  return (
    <section aria-label="소스와 설치본" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <h2 style={{ margin: 0, fontSize: 15 }}>소스와 설치본</h2>
      <div className="detect" style={{ gridTemplateColumns: '1fr' }}>
        {row('소스', v.source, v.sourceProblem)}
        {row('설치본', v.installed, v.installedProblem)}
      </div>
      {v.status === 'eol-differs' && (
        <div className="notice" role="note" data-testid="eol-notice">
          <div>
            <b>줄바꿈(CRLF/LF)만 다르다 — 내용은 같다</b>
            {crSide === 'source' ? (
              <>
                <div>소스(kit 레포 클론)에 CRLF 파일이 {v.source!.crFiles}개 있다. <code>.gitattributes</code>가 생기기 전에 받은 Windows 클론에서 생긴다. kit 레포에서 커밋 안 한 변경이 없는지 확인한 뒤:</div>
                <pre className="doc">{'git status\ngit rm -r -q --cached .\ngit reset -q --hard'}</pre>
                <div className="hint">git reset --hard 는 커밋 안 한 변경을 지운다. git status 가 깨끗할 때만.</div>
              </>
            ) : crSide === 'installed' ? (
              <>
                <div>설치본에 CRLF 파일이 {v.installed!.crFiles}개 있다. 설치본을 다시 받는다:</div>
                <pre className="doc">{`claude plugin marketplace update kjh-code\nclaude plugin update ${v.plugin}@kjh-code`}</pre>
              </>
            ) : <div>[어느 쪽에 CR이 있는지 모름]</div>}
          </div>
        </div>
      )}
      {v.status === 'content-differs' && <p className="hint">버전은 같은데 파일 내용이 다르다. 소스를 고친 뒤 버전을 안 올렸거나, 설치본이 옛 커밋이다.</p>}
      {v.status === 'version-differs' && <p className="hint">설치본({v.installed?.version ?? '[모름]'})이 소스({v.source?.version ?? '[모름]'})와 다르다. 아래 버튼이 두 명령을 차례로 돌린다.</p>}
      {showInstall && <InstallPanel plugin={v.plugin} onFinished={refreshVersions} />}
    </section>
  );
}
