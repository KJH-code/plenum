// 설정 › 워커: 목록에서 행을 고르면 아래 수정란에 열린다. AI·노력도만 고치고,
// 저장은 확인창 → 검사·빌드·commit·push(서버 저장 파이프라인) → 끝/실패 패널 → 설치본에 반영.
// 초안은 워커별로 브라우저 메모리에만 둔다(App이 들고 있어 설정 분류를 옮겨 다녀도 남는다).
import { Fragment, useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { api, poll, type KitResult, type Preview, type RemoteStatus, type SaveJob, type StepState, type Versions, type Worker } from './api';
import { href } from './route';
import { InstallPanel } from './InstallPanel';

export interface Draft { model: string; effort: string }
export type Drafts = Record<string, Draft>;

const STEP_LABEL: Record<string, string> = { check: '검사', build: '빌드', commit: 'commit', push: 'push' };
const STATE_ICON: Record<StepState, string> = { wait: '○', run: '…', ok: '✓', warn: '!', fail: '✕', skip: '–' };
const STATE_TEXT: Record<StepState, string> = { wait: '대기', run: '진행 중', ok: '끝', warn: '경고', fail: '실패', skip: '건너뜀' };

const fmtModes = (w: Worker) => w.modes.length === 0 ? <span className="placeholder">[쓰는 모드 없음]</span>
  : w.modes.map((m, i) => <Fragment key={`${m.mode}-${m.fallback}`}>{i > 0 && '·'}<span className={m.fallback ? 'fb' : undefined}>{m.fallback ? `${m.mode}(대체)` : m.mode}</span></Fragment>);
const modesText = (w: Worker) => w.modes.map((m) => (m.fallback ? `${m.mode}(대체)` : m.mode)).join('·');
const withCurrent = (opts: string[], cur: string) => (opts.includes(cur) ? opts : [...opts, cur]);

export function Workers({ kitPath, versions, refreshVersions, drafts, setDrafts }: {
  kitPath: string | null;
  versions: Versions | null;
  refreshVersions: () => void;
  drafts: Drafts;
  setDrafts: Dispatch<SetStateAction<Drafts>>;
}) {
  const [kit, setKit] = useState<KitResult | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [remoteErr, setRemoteErr] = useState<string | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullMsg, setPullMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<{ p: Preview; worker: string; model: string; effort: string; version: string } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [job, setJob] = useState<SaveJob | null>(null);
  const [acting, setActing] = useState(false); // retry·cancel 요청 중
  const stopPoll = useRef<(() => void) | null>(null);
  const editorRef = useRef<HTMLElement | null>(null);

  const loadKit = useCallback(() => api.workers().then(setKit).catch((e) => setKit({ ok: false, repo: kitPath, message: e.message })), [kitPath]);
  const loadRemote = useCallback(() => {
    setRemote(null);
    setRemoteErr(null);
    api.remote().then(setRemote).catch((e) => setRemoteErr(e.message));
  }, []);

  const ended = useCallback((j: SaveJob) => {
    if (j.status === 'done') {
      setDrafts((d) => { const n = { ...d }; delete n[j.worker]; return n; });
      loadKit();
      refreshVersions();
    }
    loadRemote();
  }, [loadKit, loadRemote, refreshVersions, setDrafts]);

  const follow = useCallback((j: SaveJob) => {
    setJob(j);
    stopPoll.current?.();
    if (j.status !== 'running') { ended(j); return; }
    stopPoll.current = poll(api.save, (s) => s.status === 'running', (s) => {
      setJob(s);
      if (s.status !== 'running') ended(s);
    }, (e) => setActionErr(`저장 상태를 읽지 못했다: ${e.message}`));
  }, [ended]);

  useEffect(() => { loadKit(); }, [loadKit]);
  useEffect(() => {
    if (!kit || !kit.ok) return;
    loadRemote();
  }, [kit?.ok, kit && kit.ok ? kit.repo : null, loadRemote]);
  // 다른 화면에서 시작한 저장이 아직 돌고 있거나, push가 실패한 채 남아 있으면 이어서 보여 준다
  useEffect(() => {
    let alive = true;
    api.save().then((s) => {
      if (!alive) return;
      if (s.status === 'running') follow(s);
      else if (s.status === 'push-failed') setJob(s);
    }).catch(() => { /* 저장 상태를 못 읽으면 패널 없이 */ });
    return () => { alive = false; stopPoll.current?.(); };
  }, [follow]);
  // 목록을 다시 읽은 뒤 원래 값과 같아진 초안은 지운다
  useEffect(() => {
    if (!kit || !kit.ok) return;
    setDrafts((d) => {
      let changed = false;
      const n = { ...d };
      for (const w of kit.workers) {
        const x = n[w.name];
        if (x && x.model === w.model && x.effort === w.effort) { delete n[w.name]; changed = true; }
      }
      return changed ? n : d;
    });
  }, [kit, setDrafts]);

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

  const locked = job?.status === 'running' || acting;
  const draftOf = (w: Worker): Draft => drafts[w.name] ?? { model: w.model, effort: w.effort };
  const isDirty = (w: Worker) => { const d = draftOf(w); return d.model !== w.model || d.effort !== w.effort; };
  const dirtyCount = kit.workers.filter(isDirty).length;
  const groups = kit.stages.map((s) => ({ stage: s, items: kit.workers.filter((w) => w.stage === s) })).filter((g) => g.items.length > 0);
  const cur = kit.workers.find((w) => w.name === sel) ?? null;

  const pick = (name: string) => {
    if (locked) return;
    setSel(name);
    setActionErr(null);
    requestAnimationFrame(() => editorRef.current?.scrollIntoView({ block: 'nearest' }));
  };
  const setField = (w: Worker, key: keyof Draft, value: string) => {
    const next = { ...draftOf(w), [key]: value };
    setDrafts((d) => {
      const n = { ...d };
      if (next.model === w.model && next.effort === w.effort) delete n[w.name];
      else n[w.name] = next;
      return n;
    });
  };
  const openFile = async (file: string, line?: number) => {
    setActionErr(null);
    try { await api.openKitFile(file, line); } catch (e: any) { setActionErr(e.message); }
  };
  const pull = async () => {
    setPulling(true);
    setPullMsg(null);
    try {
      const r = await api.pull();
      setPullMsg({ ok: r.ok, text: r.message });
      setRemote(r.remote);
      if (r.ok) { loadKit(); refreshVersions(); }
    } catch (e: any) { setPullMsg({ ok: false, text: e.message }); } finally { setPulling(false); }
  };
  const openPreview = async (w: Worker) => {
    const d = draftOf(w);
    setActionErr(null);
    setPreviewing(true);
    try { setPreview({ p: await api.preview(w.name, d.model, d.effort), worker: w.name, ...d, version: kit.version }); } catch (e: any) { setActionErr(e.message); } finally { setPreviewing(false); }
  };
  const confirmSave = async () => {
    if (!preview) return;
    const { worker, model, effort } = preview;
    setPreview(null);
    setActionErr(null);
    try { follow(await api.startSave(worker, model, effort)); } catch (e: any) { setActionErr(e.message); }
  };
  const retry = async () => {
    setActing(true);
    setActionErr(null);
    try { follow(await api.retrySave()); } catch (e: any) { setActionErr(e.message); } finally { setActing(false); }
  };
  const cancel = async () => {
    setActing(true);
    setActionErr(null);
    try { setJob(await api.cancelSave()); loadRemote(); } catch (e: any) { setActionErr(e.message); } finally { setActing(false); }
  };

  const remoteOk = !!remote && remote.blockers.length === 0;
  const onlyBehind = !!remote && remote.state === 'behind' && remote.blockers.length === 1;
  const remoteLine = remoteErr ? <span className="error">원격을 확인하지 못했다: {remoteErr}</span>
    : !remote ? <span className="hint">원격 main 확인 중…</span>
    : remoteOk ? <span className="muted">원격 main과 같음 (<span className="mono">{remote.head.slice(0, 7)}</span>) · 저장 직전에 다시 확인한다</span>
    : onlyBehind ? <span className="warn-text">원격 main이 {remote.behind}커밋 앞섰다 · 받아온 뒤에 저장할 수 있다</span>
    : <span className="warn-text">{remote.blockers.join(' / ')}</span>;

  return (
    <>
      <div className="title-row">
        <h1>워커 ({kit.workers.length})</h1>
        <span className="muted">kit: {kit.name} {kit.version} · 단계별 · 행을 고르면 아래 수정란에 열린다</span>
      </div>
      <div className="wtable">
        <table aria-label="워커 목록">
          <thead><tr><th>이름</th><th>하는 일</th><th>AI</th><th>노력도</th><th>쓰는 모드</th></tr></thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.stage}>
                <tr className="group" data-testid="stage-group"><td colSpan={5}>{g.stage} <span className="count">· {g.items.length}</span></td></tr>
                {g.items.map((w) => {
                  const on = w.name === sel;
                  const d = draftOf(w);
                  return (
                    <tr key={w.name} className="wrow" data-selected={on} data-locked={locked} onClick={() => pick(w.name)} data-testid="worker-row">
                      <td>
                        <button type="button" className="rowpick mono" aria-pressed={on} disabled={locked} onClick={(e) => { e.stopPropagation(); pick(w.name); }}>{w.name}</button>
                        {isDirty(w) && <span className="dirty" data-testid="dirty-mark">● 수정 중</span>}
                      </td>
                      <td className="muted">{w.summary}</td>
                      <td><span className={`chip ${d.model}`}>{d.model}</span></td>
                      <td>{d.effort}</td>
                      <td className="muted">{fmtModes(w)}</td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <section className="editor" aria-labelledby="editor-title" ref={editorRef} data-testid="worker-editor">
        <div className="row-wrap">
          <h2 id="editor-title">수정</h2>
          {cur ? (
            <>
              <span className="mono" data-testid="editor-name">{cur.name}</span>
              <span className="mono hint" data-testid="editor-file">{cur.file}</span>
            </>
          ) : <span className="hint">목록에서 행을 고른다</span>}
          {dirtyCount > 0 && <span className="badge warn" data-testid="unsaved-count">저장 안 한 변경 {dirtyCount}개</span>}
          <span className="spacer" />
          {cur && <button type="button" className="btn ghost" onClick={() => openFile(cur.file)}>외부 에디터로 열기</button>}
        </div>

        {cur && <Editor w={cur} d={draftOf(cur)} kit={kit} locked={locked} setField={setField} />}

        <div className="row-wrap edit-foot">
          <span role="status" data-testid="remote-line">{remoteLine}</span>
          {remote?.state === 'behind' && (
            <button type="button" className="btn" disabled={pulling || locked} onClick={pull}>{pulling ? '받아오는 중…' : '받아오기 (git pull)'}</button>
          )}
          <span className="spacer" />
          <button type="button" className="btn ghost" disabled={!cur || !isDirty(cur) || locked}
            onClick={() => cur && setDrafts((d) => { const n = { ...d }; delete n[cur.name]; return n; })}>되돌리기</button>
          <button type="button" className="btn primary" disabled={!cur || !isDirty(cur) || locked || !remoteOk || previewing}
            onClick={() => cur && openPreview(cur)}>{previewing ? '확인 중…' : '저장…'}</button>
        </div>
        {pullMsg && <p className={pullMsg.ok ? 'ok-text' : 'error'} role="status">{pullMsg.text}</p>}
        {actionErr && <p className="error" role="alert">{actionErr}</p>}

        {job && job.status !== 'idle' && (
          <SaveResult job={job} acting={acting} versions={versions} plugin={kit.name}
            onOpen={openFile} onRetry={retry} onCancel={cancel} onClose={() => setJob(null)} onInstalled={refreshVersions} />
        )}
      </section>

      {preview && <SaveDialog preview={preview} onCancel={() => setPreview(null)} onConfirm={confirmSave} />}
    </>
  );
}

function Editor({ w, d, kit, locked, setField }: {
  w: Worker; d: Draft; kit: Extract<KitResult, { ok: true }>; locked: boolean;
  setField: (w: Worker, key: keyof Draft, value: string) => void;
}) {
  const modelChanged = d.model !== w.model;
  const effortChanged = d.effort !== w.effort;
  const toFable = d.model === 'fable' && w.model !== 'fable';
  return (
    <>
      <div className="efields">
        <div className="efield">
          <label htmlFor="edit-model">AI</label>
          <select id="edit-model" className={`input${modelChanged ? ' changed' : ''}`} data-changed={modelChanged} value={d.model} disabled={locked}
            onChange={(e) => setField(w, 'model', e.target.value)}>
            {withCurrent(kit.options.models, w.model).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <span className={modelChanged ? 'was changed' : 'was'}>원래: {w.model}</span>
        </div>
        <div className="efield">
          <label htmlFor="edit-effort">노력도</label>
          <select id="edit-effort" className={`input${effortChanged ? ' changed' : ''}`} data-changed={effortChanged} value={d.effort} disabled={locked}
            onChange={(e) => setField(w, 'effort', e.target.value)}>
            {withCurrent(kit.options.efforts, w.effort).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <span className={effortChanged ? 'was changed' : 'was'}>원래: {w.effort}</span>
        </div>
        <div className="efield">
          <span className="k">도구 · 최대 턴</span>
          <span className="readonly mono">{w.tools || '[도구 칸 없음]'} · {w.maxTurns ?? '[maxTurns 없음]'}</span>
          <span className="was">외부 에디터에서 고친다</span>
        </div>
        <div className="efield">
          <span className="k">격리 · 하는 일</span>
          <span className="readonly">{w.isolation ?? '없음'} · {w.summary}</span>
          <span className="was">외부 에디터에서 고친다</span>
        </div>
        <div className="efield wide">
          <span className="k">description</span>
          <span className="readonly">{w.description || '[description 없음]'}</span>
        </div>
      </div>
      {(modelChanged || effortChanged) && (
        <div className="note" data-testid="mode-note">
          {w.modes.length
            ? <>이 워커를 쓰는 모드: <b>{modesText(w)}</b>. 저장하면 이 모드들의 품질과 한도 사용량이 함께 바뀐다.</>
            : <>이 워커를 쓰는 모드가 없다 (modes·/check 표에 없음).</>}
        </div>
      )}
      {toFable && (
        <div className="notice" role="alert" data-testid="fable-warn">
          <div>
            Fable은 훅이 ORCHESTRATE_FABLE=1일 때만 허용한다. 극한 모드가 아닌 모드에서 이 워커를 부르면 막힌다.
            {!w.name.endsWith('-fable') && ' 막혔을 때 Opus 짝 안내도 없다(훅 OPUS_PAIR는 3단계에서 워커 칸으로 옮긴다).'}
          </div>
        </div>
      )}
    </>
  );
}

function SaveDialog({ preview, onCancel, onConfirm }: {
  preview: { p: Preview; worker: string; version: string };
  onCancel: () => void; onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  const { p } = preview;
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="save-title" data-testid="save-dialog">
        <div className="dhead"><h1 id="save-title">저장 확인</h1></div>
        <div className="dbody">
          <span className="muted">이 줄들이 바뀌고, 검사 → 빌드 → commit → push 순서로 진행된다.</span>
          <div className="diff mono">
            {p.files.filter((f) => f.lines.length > 0).map((f) => (
              <Fragment key={f.path}>
                <div className="dfile">{f.path}</div>
                {f.lines.map((l, i) => <div key={i} className={l.sign === '-' ? 'del' : 'add'}>{l.sign} {l.text}</div>)}
              </Fragment>
            ))}
          </div>
          <span className="muted">버전은 저장마다 patch가 하나씩 오른다 ({preview.version} → {p.newVersion}).</span>
          <div className="commit-box">
            <span className="hint">커밋 메시지</span>
            <span className="mono" data-testid="commit-message">{p.commitMessage}</span>
            <span className="hint" data-testid="author-email">작성자 {p.authorEmail ?? '[git user.email 없음]'}</span>
          </div>
        </div>
        <div className="dfoot">
          <button type="button" className="btn" ref={cancelRef} onClick={onCancel}>취소</button>
          <button type="button" className="btn primary" onClick={onConfirm}>commit · push</button>
        </div>
      </div>
    </div>
  );
}

function SaveResult({ job, acting, versions, plugin, onOpen, onRetry, onCancel, onClose, onInstalled }: {
  job: SaveJob; acting: boolean; versions: Versions | null; plugin: string;
  onOpen: (file: string, line?: number) => void; onRetry: () => void; onCancel: () => void; onClose: () => void; onInstalled: () => void;
}) {
  const e = job.error;
  const leftovers = !!e && /되돌린 뒤에도 남은 변경/.test(e.message);
  const installedLine = !versions ? '[설치본 버전 확인 중]'
    : versions.status === 'same' && versions.installed ? `설치본도 ${versions.installed.version}로 소스와 같다.`
    : versions.installed ? `설치본은 아직 ${versions.installed.version}이라 Claude Code에는 반영 전이다.`
    : `설치본: [${versions.installedProblem || '모름'}]`;
  return (
    <div className="run" data-testid="save-run" data-status={job.status}>
      <span className="hint">{job.worker} · {job.model} {job.effort}</span>
      <ol className="steps" aria-label="저장 단계">
        {job.steps.map((s) => (
          <li key={s.key} className="step" data-state={s.state} data-testid={`step-${s.key}`}>
            <div className="step-head"><span className="step-icon" aria-hidden="true">{STATE_ICON[s.state]}</span>{STEP_LABEL[s.key]}<span className="sr-only">: {STATE_TEXT[s.state]}</span></div>
            <div className="hint mono">{s.state === 'skip' ? '건너뜀' : s.state === 'wait' ? '대기' : s.detail || STATE_TEXT[s.state]}</div>
          </li>
        ))}
      </ol>

      {job.status === 'running' && <p className="hint" role="status">저장하는 중…</p>}

      {job.warnings.length > 0 && (
        <div className="notice" data-testid="save-warnings">
          <div>
            <b>WARN {job.warnings.length}개 (막지 않음)</b>
            <ul className="warn-list">
              {job.warnings.map((w, i) => (
                <li key={i}>
                  <span className="mono">{w.file}:{w.line}</span> — {w.message}{' '}
                  <button type="button" className="btn ghost small" aria-label={`외부 에디터로 그 줄 열기: ${w.file}:${w.line}`} onClick={() => onOpen(w.file, w.line)}>외부 에디터로 그 줄 열기</button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {job.status === 'failed' && e && (
        <div className="result bad" role="alert" data-testid="save-failed">
          {e.kind === 'tier' && e.tier ? (
            <div>빌드 ERROR · 계층 <b>{e.tier}</b>가 kit.yaml의 tiers에 없다. 처음 쓰는 조합이면 tiers에 행을 하나 추가해야 한다.</div>
          ) : <div>{e.message}</div>}
          {e.kind === 'tier' && (
            <div><button type="button" className="btn" onClick={() => onOpen(e.file ?? 'kit/kit.yaml')}>kit.yaml 열기</button></div>
          )}
          <div className="muted">
            {leftovers ? '되돌린 뒤에도 레포에 남은 변경이 있다 — 위 목록을 확인한다.'
              : e.kind === 'tier' ? '아무것도 바뀌지 않았다. 워커 파일은 원래대로다.' : '아무것도 바뀌지 않았다.'}
          </div>
        </div>
      )}

      {job.status === 'push-failed' && (
        <div className="result bad" role="alert" data-testid="push-failed">
          <div>
            push 실패 · {job.pushError?.kind === 'rejected' ? '원격 main이 그사이 앞섰다.' : (job.pushError?.message ?? '[이유 모름]')}{' '}
            커밋 <span className="mono">{job.commit?.short ?? '[커밋 모름]'}</span>는 로컬에만 있다.
          </div>
          <div className="row-wrap">
            <button type="button" className="btn" disabled={acting} onClick={onRetry}>받아와서 다시 push</button>
            <button type="button" className="btn" disabled={acting} onClick={onCancel}>커밋 취소</button>
          </div>
        </div>
      )}

      {job.status === 'cancelled' && (
        <p className="muted" role="status" data-testid="save-cancelled">커밋을 취소했다. 레포는 저장 전으로 돌아갔고, 바꾼 값은 "수정 중"으로 남아 있다.</p>
      )}

      {job.status === 'done' && (
        <div className="result ok" data-testid="save-done">
          <div className="ok-text" role="status">저장 끝 · 커밋 <span className="mono">{job.commit?.short ?? '[커밋 모름]'}</span> push됨.</div>
          <div className="muted">{installedLine}</div>
          <InstallPanel plugin={plugin} onFinished={onInstalled} />
        </div>
      )}

      {job.status !== 'running' && job.status !== 'push-failed' && (
        <div className="row-end"><button type="button" className="btn" disabled={acting} onClick={onClose}>닫기</button></div>
      )}
    </div>
  );
}
