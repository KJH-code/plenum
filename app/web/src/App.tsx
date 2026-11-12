import { useCallback, useEffect, useState } from 'react';
import { api, type Versions } from './api';
import { href, useRoute } from './route';
import { Gear, Plus } from './icons';
import { Home } from './Home';
import { SettingsPage } from './Settings';
import { ProjectPage } from './Project';
import { AddProject } from './AddProject';

export function VersionBar({ v }: { v: Versions | null }) {
  if (!v) return <span className="version">버전 확인 중…</span>;
  if (!v.source) {
    return (
      <span className="version" data-testid="version">
        kit <a href={href.settings('kit')}>[kit 레포 경로 지정 안 됨]</a>
      </span>
    );
  }
  const short = (h: string | null) => (h ? h.slice(0, 12) : '[해시 없음]');
  const badge = {
    same: <span className="badge ok">같음</span>,
    'version-differs': <span className="badge warn">버전 다름</span>,
    'content-differs': <span className="badge warn">내용 다름</span>,
    unknown: <span className="badge">비교 못 함</span>,
  }[v.status];
  return (
    <span className="version" data-testid="version" title={`소스 ${short(v.source.hash)} · 설치본 ${v.installed ? short(v.installed.hash) : '-'}`}>
      <span>{v.plugin}</span>
      <span>소스 <b>{v.source.version}</b></span>
      <span>/</span>
      <span>설치본 <b>{v.installed ? v.installed.version : `[${v.installedProblem || '모름'}]`}</b></span>
      {badge}
    </span>
  );
}

export function App() {
  const route = useRoute();
  const [versions, setVersions] = useState<Versions | null>(null);
  const [adding, setAdding] = useState(false);
  const [reload, setReload] = useState(0);

  const refreshVersions = useCallback(() => {
    api.versions().then(setVersions).catch(() => setVersions(null));
  }, []);
  useEffect(refreshVersions, [refreshVersions, reload]);

  const onChanged = () => setReload((n) => n + 1);

  return (
    <div className="app">
      {route.page !== 'project' && (
        <header className="topbar">
          <a className="brand" href={href.home}>Plenum</a>
          <button type="button" className="navbtn" onClick={() => setAdding(true)}><Plus />프로젝트 추가</button>
          <a className="navbtn" href={href.settings('workers')}><Gear />설정</a>
          <div className="spacer" />
          <VersionBar v={versions} />
        </header>
      )}
      {route.page === 'home' && <Home reload={reload} onAdd={() => setAdding(true)} onChanged={onChanged} />}
      {route.page === 'settings' && <SettingsPage cat={route.cat} onChanged={onChanged} />}
      {route.page === 'project' && <ProjectPage id={route.id} />}
      {adding && <AddProject onClose={() => setAdding(false)} onAdded={() => { setAdding(false); onChanged(); }} />}
    </div>
  );
}
