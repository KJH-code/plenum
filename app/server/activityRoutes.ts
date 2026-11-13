// 작동 중·훅·터미널로 열기 라우트.
//   POST /api/hook                                      훅 알림 (틀린 본문도 200 — 훅은 실패를 무시한다)
//   GET  /api/projects/:id/activity                     ProjectActivity
//   POST /api/projects/:id/sessions/:sid/terminal       (돌고 있는 채팅을 끝까지 닫고) 외부 터미널에서 claude --resume
//   POST /api/projects/:id/sessions/:sid/forget-terminal 터미널 세션을 현황에서 바로 뺀다("이미 닫았다")
import type { RouteCtx } from './app.ts';
import type { Activity } from './activity.ts';
import type { ChatRegistry, ProjectActivity } from './chatTypes.ts';
import { UserError } from './errors.ts';
import type { Launcher } from './open.ts';
import { findProject } from './projects.ts';
import { terminalCommand } from './terminal.ts';

export interface ActivityDeps {
  activity: Activity;
  chats?: ChatRegistry;
  launcher: Launcher;
  platform?: NodeJS.Platform;
  isFile?: (f: string) => boolean;
}

export const TRUST_HINT = '처음 여는 폴더면 터미널에 "이 폴더를 믿나요(trust)" 창이 먼저 뜬다 — 믿는다고 고르면 세션이 이어진다';

export async function handleActivity(ctx: RouteCtx, deps: ActivityDeps): Promise<boolean> {
  const { method, parts } = ctx;
  const [a, b, c, d, e] = parts;

  if (a === 'hook' && !b && method === 'POST') {
    let body: unknown;
    try { body = await ctx.body(); } catch { body = null; }
    ctx.send(200, deps.activity.ingestHook(body));
    return true;
  }

  if (a !== 'projects' || !b) return false;

  if (c === 'activity' && !d && method === 'GET') {
    const p = findProject(ctx.cfg, b);
    const out: ProjectActivity = { projectId: p.id, sessions: deps.activity.forProject(p.path) };
    ctx.send(200, out);
    return true;
  }

  if (c === 'sessions' && d && !parts[5] && method === 'POST') {
    if (e === 'forget-terminal') {
      findProject(ctx.cfg, b);
      ctx.send(200, { ok: true, forgotten: deps.activity.forgetTerminal(d) });
      return true;
    }
    if (e === 'terminal') {
      const p = findProject(ctx.cfg, b);
      // 같은 세션을 두 프로세스가 이어 쓰지 않게: 채팅을 먼저 끝까지 닫는다
      let closedChat = false;
      const chat = deps.chats?.findBySession(d) ?? null;
      if (chat && chat.state !== 'ended') {
        await deps.chats!.close(chat.chatId);
        closedChat = true;
      }
      let t;
      try { t = terminalCommand({ cwd: p.path, sessionId: d, platform: deps.platform, env: ctx.env, isFile: deps.isFile }); }
      catch (err: any) { throw new UserError(400, err.message); }
      if (!t.command) {
        ctx.send(200, { closedChat, launched: false, via: t.via, display: t.display, message: TRUST_HINT });
        return true;
      }
      const r = await deps.launcher(t.command, 'terminal');
      if (!r.ok) {
        ctx.send(500, { error: `터미널을 못 열었다: ${r.message} — 아래 두 줄을 터미널에 붙여 넣는다`, closedChat, launched: false, via: t.via, display: t.display });
        return true;
      }
      ctx.send(200, { closedChat, launched: true, via: t.via, display: t.display, message: TRUST_HINT });
      return true;
    }
  }
  return false;
}
