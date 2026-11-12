// 서버 API. 바꾸는 요청에는 X-Plenum 헤더를 붙인다 (서버가 없으면 거부).
export interface Detection {
  exists: boolean;
  git: 'none' | 'empty' | 'ok';
  branch: string | null;
  github: { owner: string; repo: string; url: string } | null;
  hasClaudeMd: boolean;
  hasClaudeDir: boolean;
}
export interface Project { id: string; name: string; path: string; source: 'local' | 'github'; url?: string; detection: Detection }
export interface Settings { kitRepoPath: string | null; cloneDir: string; editorCommand: string; configDir: string }
export interface ModeUse { mode: string; fallback: boolean }
export interface Worker {
  name: string; file: string; stage: string; summary: string; description: string;
  model: string; effort: string; tools: string; maxTurns: number | null; isolation: string | null; modes: ModeUse[];
}
export type KitResult = { ok: true; repo: string; name: string; version: string; stages: string[]; workers: Worker[] } | { ok: false; repo: string | null; message: string };
export interface Side { version: string; hash: string | null; files: number; path: string }
export interface Versions { plugin: string | null; source: Side | null; sourceProblem: string | null; installed: Side | null; installedProblem: string | null; status: 'same' | 'version-differs' | 'content-differs' | 'unknown' }

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Plenum': '1' },
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
};
