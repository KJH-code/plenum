// 지난 세션 라우트 (읽기 전용 GET).
//   GET /api/projects/:id/sessions                     → SessionSummary[]
//   GET /api/projects/:id/sessions/:sid/transcript     → TranscriptItem[]
import type { RouteCtx } from './app.ts';
import { listSessions, readTranscript, type HistoryOptions } from './history.ts';
import { findProject } from './projects.ts';
import { claudeHome } from './versions.ts';

export interface HistoryDeps {
  claudeHome?: string;                                         // 없으면 claudeHome(ctx.env)
  runningOf?(sessionId: string): 'chat' | 'terminal' | null;
  platform?: NodeJS.Platform;
}

export async function handleHistory(ctx: RouteCtx, deps: HistoryDeps = {}): Promise<boolean> {
  const [a, id, c, sid, e, extra] = ctx.parts;
  if (a !== 'projects' || !id || c !== 'sessions' || ctx.method !== 'GET' || extra !== undefined) return false;
  if (sid !== undefined && e !== 'transcript') return false;
  const project = findProject(ctx.cfg, id);
  const opts: HistoryOptions = { claudeHome: deps.claudeHome ?? claudeHome(ctx.env), cfgDir: ctx.cfgDir, platform: deps.platform, runningOf: deps.runningOf };
  if (sid === undefined) ctx.send(200, await listSessions(project.path, opts));
  else ctx.send(200, await readTranscript(project.path, sid, opts));
  return true;
}
