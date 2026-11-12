// 서버 API. 모든 요청에 X-Plenum 헤더를 붙인다 (바꾸는 요청과 부작용 있는 GET /api/kit/remote 는 서버가 없으면 거부).
export interface Detection {
  exists: boolean;
  git: 'none' | 'empty' | 'ok';
  branch: string | null;
  github: { owner: string; repo: string; url: string } | null;
  hasClaudeMd: boolean;
  hasClaudeDir: boolean;
  parentRepo: string | null;
}
export interface Project { id: string; name: string; path: string; source: 'local' | 'github'; url?: string; detection: Detection }
export interface Settings { kitRepoPath: string | null; cloneDir: string; editorCommand: string; configDir: string }
export interface ModeUse { mode: string; fallback: boolean }
export interface Worker {
  name: string; file: string; stage: string; summary: string; description: string;
  model: string; effort: string; tools: string; maxTurns: number | null; isolation: string | null; modes: ModeUse[];
}
export type KitResult = {
  ok: true; repo: string; name: string; version: string; stages: string[]; workers: Worker[];
  options: { models: string[]; efforts: string[] };
  tiers: string[];
} | { ok: false; repo: string | null; message: string };
export interface Side { version: string; hash: string | null; lfHash: string | null; files: number; crFiles: number; path: string }
export interface Versions { plugin: string | null; source: Side | null; sourceProblem: string | null; installed: Side | null; installedProblem: string | null; status: 'same' | 'version-differs' | 'content-differs' | 'eol-differs' | 'unknown' }


// 아래는 서버 타입을 그대로 옮긴 것 (server/kitgit.ts RemoteStatus, server/kitedit.ts Preview, server/kitsave.ts SaveJob, server/install.ts InstallState)
export interface RemoteStatus {
  branch: string;
  dirty: string[];
  kitYamlDirty: boolean;
  ahead: number;
  behind: number;
  state: 'same' | 'ahead' | 'behind' | 'diverged' | 'no-remote';
  head: string;
  remote: string | null;
  fetchError: string | null;
  blockers: string[];
}
export interface PullResult { ok: boolean; message: string; remote: RemoteStatus }
export interface DiffLine { sign: '-' | '+'; text: string }
export interface PreviewFile { path: string; lines: DiffLine[] }
export interface Preview { files: PreviewFile[]; commitMessage: string; authorEmail: string | null; newVersion: string; from: { model: string; effort: string }; kitYamlEdited: boolean }
export type StepKey = 'check' | 'build' | 'commit' | 'push';
export type StepState = 'wait' | 'run' | 'ok' | 'warn' | 'fail' | 'skip';
export interface SaveError { kind: 'blocked' | 'compiler' | 'version' | 'tier' | 'build' | 'git' | 'other'; message: string; tier?: string; file?: string }
export interface SaveJob {
  id: number; worker: string; model: string; effort: string;
  status: 'idle' | 'running' | 'done' | 'failed' | 'push-failed' | 'cancelled';
  steps: { key: StepKey; state: StepState; detail: string }[];
  warnings: { file: string; line: number; message: string }[];
  error: SaveError | null;
  pushError: { kind: 'rejected' | 'other'; message: string } | null;
  baseSha: string | null; commit: { sha: string; short: string } | null;
  newVersion: string | null; commitMessage: string | null;
  notice: string | null;
}
export interface InstallStepResult { label: string; command: string; code: number | null; output: string; timedOut: boolean; error?: string }
export interface InstallState {
  status: 'idle' | 'running' | 'ok' | 'fail';
  steps: InstallStepResult[];
  message: string;
  claudePath: string | null;
  sourceVersion: string | null;
  installedVersion: string | null;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: method === 'GET' ? { 'X-Plenum': '1' } : { 'Content-Type': 'application/json', 'X-Plenum': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `응답을 읽지 못했다 (${res.status})` }));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data as T;
}

export const api = {
  settings: () => call<Settings>('GET', '/api/settings'),
  saveSettings: (s: Partial<Pick<Settings, 'kitRepoPath' | 'cloneDir' | 'editorCommand'>>) => call<Settings>('PUT', '/api/settings', s),
  projects: () => call<Project[]>('GET', '/api/projects'),
  addLocal: (path: string, name?: string) => call<Project>('POST', '/api/projects', { kind: 'local', path, name }),
  addGitHub: (url: string) => call<Project>('POST', '/api/projects', { kind: 'github', url }),
  remove: (id: string) => call<{ ok: true }>('DELETE', `/api/projects/${encodeURIComponent(id)}`),
  inspect: (path: string) => call<{ path: string; name: string; detection: Detection }>('POST', '/api/inspect', { path }),
  cloneTarget: (url: string) => call<{ repo: string; owner: string; dest: string; exists: boolean }>('POST', '/api/clone-target', { url }),
  claudeMd: (id: string) => call<{ text: string }>('GET', `/api/projects/${encodeURIComponent(id)}/claude-md`),
  openFolder: (id: string) => call<{ ok: true }>('POST', `/api/projects/${encodeURIComponent(id)}/open-folder`),
  openEditor: (id: string) => call<{ ok: true }>('POST', `/api/projects/${encodeURIComponent(id)}/open-editor`),
  workers: () => call<KitResult>('GET', '/api/kit/workers'),
  versions: () => call<Versions>('GET', '/api/versions'),
  remote: () => call<RemoteStatus>('GET', '/api/kit/remote'),
  pull: () => call<PullResult>('POST', '/api/kit/pull'),
  preview: (worker: string, model: string, effort: string) => call<Preview>('POST', '/api/kit/preview', { worker, model, effort }),
  startSave: (worker: string, model: string, effort: string) => call<SaveJob>('POST', '/api/kit/save', { worker, model, effort }),
  save: () => call<SaveJob>('GET', '/api/kit/save'),
  retrySave: () => call<SaveJob>('POST', '/api/kit/save/retry'),
  cancelSave: () => call<SaveJob>('POST', '/api/kit/save/cancel'),
  openKitFile: (file: string, line?: number) => call<{ ok: true }>('POST', '/api/kit/open', line ? { file, line } : { file }),
  startInstall: () => call<InstallState>('POST', '/api/install'),
  install: () => call<InstallState>('GET', '/api/install'),
};

// 서버 작업(저장·반영)을 짧은 간격으로 다시 읽는다. running 이 false 가 되면 멈춘다. 돌려주는 함수로도 멈춘다
export const POLL_MS = 400;
export function poll<T>(read: () => Promise<T>, running: (v: T) => boolean, onTick: (v: T) => void, onError: (e: Error) => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      const v = await read();
      if (stopped) return;
      onTick(v);
      if (running(v)) timer = setTimeout(tick, POLL_MS);
    } catch (e: any) {
      if (!stopped) onError(e instanceof Error ? e : new Error(String(e)));
    }
  };
  timer = setTimeout(tick, POLL_MS);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
