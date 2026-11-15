import type { CardReply, ChatInfo, Limits, ProjectActivity, SessionSummary, TranscriptItem } from '../../server/chatTypes';
export type * from '../../server/chatTypes';

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

// 서버가 꺼져 있을 때(fetch 자체가 던짐: "Failed to fetch"·"NetworkError…"·"Load failed") 화면 곳곳이 같은 문구를 보이게
export const SERVER_DOWN = 'Plenum 서버가 꺼져 있음 — 터미널에서 다시 켜기';
export class ServerDownError extends Error {
  constructor() { super(SERVER_DOWN); this.name = 'ServerDownError'; }
}
// 서버가 답한 4xx·5xx. 본문(data)도 들고 있다(터미널로 열기 실패 응답의 display 등)
export class ApiError extends Error {
  status: number;
  data: any;
  reason: string | null;  // 서버가 준 기계용 이유(채팅 409 는 ChatConflict)
  chatId: string | null;  // awaiting-card 일 때 그 살아 있는 채팅
  constructor(message: string, status: number, data: any) {
    super(message); this.name = 'ApiError'; this.status = status; this.data = data;
    this.reason = data && typeof data.reason === 'string' ? data.reason : null;
    this.chatId = data && typeof data.chatId === 'string' ? data.chatId : null;
  }
}

export async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: method === 'GET' ? { 'X-Plenum': '1' } : { 'Content-Type': 'application/json', 'X-Plenum': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ServerDownError();
  }
  const data = await res.json().catch(() => ({ error: `응답을 읽지 못했다 (${res.status})` }));
  if (!res.ok) throw new ApiError(data.error || `요청 실패 (${res.status})`, res.status, data);
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
  // 3단계: 채팅·지난 세션·작동 중·한도
  caps: () => call<ClaudeCaps>('GET', '/api/claude/capabilities'),
  limits: () => call<{ limits: Limits | null }>('GET', '/api/limits'),
  sessions: (id: string) => call<SessionSummary[]>('GET', `${P(id)}/sessions`),
  transcript: (id: string, sid: string) => call<TranscriptItem[]>('GET', `${P(id)}/sessions/${encodeURIComponent(sid)}/transcript`),
  chats: (id: string) => call<ChatInfo[]>('GET', `${P(id)}/chats`),
  activity: (id: string) => call<ProjectActivity>('GET', `${P(id)}/activity`),
  startChat: (id: string, body: { text: string; model?: string; effort?: string; resume?: string }) => call<{ chat: ChatInfo; warnings: string[]; forwarded?: boolean }>('POST', `${P(id)}/chats`, body),
  send: (chatId: string, text: string) => call<{ ok: true; chat: ChatInfo; warnings: string[] }>('POST', `${C(chatId)}/send`, { text }),
  respond: (chatId: string, reply: CardReply) => call<ChatInfo>('POST', `${C(chatId)}/respond`, reply),
  interrupt: (chatId: string) => call<ChatInfo>('POST', `${C(chatId)}/interrupt`),
  terminal: (id: string, sid: string) => call<TerminalResult>('POST', `${P(id)}/sessions/${encodeURIComponent(sid)}/terminal`),
  forgetTerminal: (id: string, sid: string) => call<{ ok: true; forgotten: boolean }>('POST', `${P(id)}/sessions/${encodeURIComponent(sid)}/forget-terminal`),
};
const P = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
const C = (chatId: string) => `/api/chats/${encodeURIComponent(chatId)}`;
// server/claudecaps.ts ClaudeCaps, server/activityRoutes.ts 터미널로 열기 응답
export interface ClaudeCaps { found: boolean; version: string | null; effort: boolean }
export interface TerminalResult { closedChat: boolean; launched: boolean; via: 'wt' | 'cmd' | 'manual'; display: string[]; message?: string }

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
