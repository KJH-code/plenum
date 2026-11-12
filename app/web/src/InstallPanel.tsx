// "설치본에 반영": POST /api/install → GET /api/install 폴링. 설정 › 워커(저장 끝 패널)와 설정 › kit(버전 다름)에서 같이 쓴다.
import { useEffect, useRef, useState } from 'react';
import { api, poll, type InstallState } from './api';

export function InstallPanel({ plugin, onFinished }: { plugin: string | null; onFinished: () => void }) {
  const [state, setState] = useState<InstallState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const finished = useRef(onFinished);
  finished.current = onFinished;

  const follow = (first: InstallState) => {
    setState(first);
    stop.current?.();
    if (first.status !== 'running') { finished.current(); return; }
    stop.current = poll(api.install, (s) => s.status === 'running', (s) => {
      setState(s);
      if (s.status !== 'running') finished.current();
    }, (e) => setError(e.message));
  };

  // 다른 화면에서 시작한 반영이 아직 돌고 있으면 이어서 보여 준다
  useEffect(() => {
    let alive = true;
    api.install().then((s) => { if (alive && s.status === 'running') follow(s); }).catch(() => { /* 상태를 못 읽으면 버튼만 둔다 */ });
    return () => { alive = false; stop.current?.(); };
  }, []);

  const running = state?.status === 'running';
  const start = async () => {
    setError(null);
    try { follow(await api.startInstall()); } catch (e: any) { setError(e.message); }
  };
  const name = plugin ?? '[플러그인 이름 모름]';
  return (
    <div className="install" data-testid="install-panel">
      <div className="row-wrap">
        <button type="button" className="btn primary" disabled={running || state?.status === 'ok'} onClick={start}>
          {running ? '반영 중…' : state?.status === 'ok' ? '반영됨' : '설치본에 반영'}
        </button>
        <span className="hint mono">claude plugin marketplace update kjh-code → claude plugin update {name}@kjh-code</span>
      </div>
      <span className="hint">이미 열려 있는 Claude Code 세션은 다시 시작해야 새 설정을 읽는다.</span>
      {error && <p className="error" role="alert">{error}</p>}
      {state && state.status !== 'idle' && (
        <div className="install-result" data-testid="install-result" data-status={state.status}>
          {state.steps.map((s) => (
            <div key={s.command} className="install-step">
              <div><b>{s.label}</b> <span className="mono">{s.command}</span> · <span className={s.code === 0 && !s.timedOut && !s.error ? 'ok' : 'bad'}>
                {s.timedOut ? '시간 초과' : s.error ? s.error : `종료 코드 ${s.code ?? '[없음]'}`}
              </span></div>
              <details>
                <summary>출력</summary>
                <pre className="doc">{s.output || '[출력 없음]'}</pre>
              </details>
            </div>
          ))}
          {state.status === 'running' && <p className="hint" role="status">{state.message || '설치본에 반영하는 중'}…</p>}
          {state.status === 'ok' && <p className="ok-text" role="status">설치본도 {state.installedVersion ?? state.sourceVersion}로 맞췄다.</p>}
          {state.status === 'fail' && <p className="error" role="alert">{state.message}</p>}
        </div>
      )}
    </div>
  );
}
