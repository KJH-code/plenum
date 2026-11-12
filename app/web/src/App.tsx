import { useCallback, useEffect, useState } from 'react';
import { api, type Versions } from './api';
import { href, useRoute } from './route';
import { Gear, Plus } from './icons';
import { Home } from './Home';
import { SettingsPage } from './Settings';
import { ProjectPage } from './Project';
import { AddProject } from './AddProject';
import type { Drafts } from './WorkerEdit';

export function VersionBar({ v }: { v: Versions | null }) {
  if (!v) return <span className="version">버전 확인 중…</span>;
  if (!v.source) {
    return (
      <span className="version" data-testid="version">
        kit <a href={href.settings('kit')}>[{v.sourceProblem || 'kit 레포 경로 지정 안 됨'}]</a>
      </span>
    );
  }
  const short = (h: string | null) => (h ? h.slice(0, 12) : '[해시 없음]');
  const badge = {
    same: <span className="badge ok">같음</span>,
    'version-differs': <a className="badge warn" href={href.settings('kit')}>버전 다름</a>,
    'content-differs': <a className="badge warn" href={href.settings('kit')}>내용 다름</a>,
    'eol-differs': <a className="badge warn" href={href.settings('kit')}>줄바꿈만 다름</a>,
    unknown: <a className="badge" href={href.settings('kit')}>비교 못 함</a>,
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

  // 워커 초안: 브라우저 메모리에만. 하나라도 남아 있으면 새로고침·닫기 때 묻는다
  const [drafts, setDrafts] = useState<Drafts>({});
  const unsaved = Object.keys(drafts).length;
  useEffect(() => {
    if (unsaved === 0) return;
    const onBefore = (e: BeforeUnloadEvent) => {
      const msg = `저장 안 한 변경 ${unsaved}개`; // 브라우저는 이 문구를 안 보여 줄 수 있다
      e.preventDefault();
      e.returnValue = msg;
      return msg;
    };
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, [unsaved]);

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
      {route.page === 'settings' && <SettingsPage cat={route.cat} onChanged={onChanged} versions={versions} refreshVersions={refreshVersions} drafts={drafts} setDrafts={setDrafts} />}
      {route.page === 'project' && <ProjectPage id={route.id} />}
      {adding && <AddProject onClose={() => setAdding(false)} onAdded={() => { setAdding(false); onChanged(); }} />}
    </div>
  );
}
