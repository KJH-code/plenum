// 채팅 라우트. 이벤트는 SSE(GET /api/chats/:chatId/events?after=N)로, 나머지는 JSON.
// GET 이 아닌 요청의 X-Plenum 검사·Host 검사는 app.ts 가 먼저 한다. Access-Control-* 헤더는 보내지 않는다.
import type { RouteCtx } from './app.ts';
import type { ChatManager } from './chat.ts';
import { UserError } from './errors.ts';
import { findProject } from './projects.ts';

const PING_MS = 15000;

function afterSeq(ctx: RouteCtx): number {
  const url = new URL(ctx.req.url || '/', 'http://127.0.0.1');
  const q = url.searchParams.get('after');
  const h = ctx.req.headers['last-event-id'];
  const raw = q ?? (typeof h === 'string' ? h : null);
  const n = raw === null ? 0 : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function events(ctx: RouteCtx, mgr: ChatManager, chatId: string) {
  if (!mgr.get(chatId)) throw new UserError(404, '없는 채팅');
  const { req, res } = ctx;
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.flushHeaders();
  const off = mgr.subscribe(chatId, afterSeq(ctx), (ev) => { res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`); });
  const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
  const stop = () => { clearInterval(ping); off(); };
  req.once('close', stop);
  res.once('close', stop);
}

export async function handleChat(ctx: RouteCtx, mgr: ChatManager): Promise<boolean> {
  const { method, parts } = ctx;
  const [a, b, c, d] = parts;

  if (a === 'limits' && !b && method === 'GET') { ctx.send(200, { limits: mgr.getLimits() }); return true; }

  if (a === 'projects' && b && c === 'chats' && !d) {
    if (method === 'GET') { findProject(ctx.cfg, b); ctx.send(200, mgr.list(b)); return true; }
    if (method === 'POST') {
      const p = findProject(ctx.cfg, b);
      const body = await ctx.body();
      const r = mgr.start({ id: p.id, path: p.path }, { text: body.text, model: body.model ?? undefined, effort: body.effort ?? undefined, resume: body.resume ?? undefined });
      ctx.send(201, r);
      return true;
    }
    return false;
  }

  if (a === 'chats' && b && c && !d) {
    if (c === 'events' && method === 'GET') { events(ctx, mgr, b); return true; }
    if (method !== 'POST') return false;
    if (c === 'send') { const body = await ctx.body(); const r = mgr.send(b, body.text); ctx.send(200, { ok: true, chat: r.chat, warnings: r.warnings }); return true; }
    if (c === 'respond') { const body = await ctx.body(); ctx.send(200, mgr.respond(b, body)); return true; }
    if (c === 'interrupt') { ctx.send(200, mgr.interrupt(b)); return true; }
    if (c === 'close') {
      if (!mgr.get(b)) throw new UserError(404, '없는 채팅');
      await mgr.close(b);
      ctx.send(200, mgr.get(b));
      return true;
    }
  }
  return false;
}
