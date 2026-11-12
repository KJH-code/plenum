// 로컬 HTTP 서버. 127.0.0.1에만 묶는다.
// 다른 사이트가 브라우저를 통해 이 서버를 부르지 못하게: Host가 127.0.0.1/localhost가 아니면 거부(DNS rebinding),
// 바꾸는 요청(POST·PUT·DELETE)은 X-Plenum 헤더가 있어야 한다(사용자 정의 헤더는 CORS preflight가 필요한데 응답하지 않는다).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, loadConfig, saveConfig } from './config.ts';
import { detect } from './git.ts';
import { readKit } from './kit.ts';
import { folderCommand, editorCommand, launch } from './open.ts';
import { addGitHub, addLocal, cloneTarget, findProject, listProjects, readClaudeMd, removeProject, UserError } from './projects.ts';
import { compareVersions } from './versions.ts';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png' };

export interface ServerOptions { cfgDir?: string; env?: NodeJS.ProcessEnv; launcher?: typeof launch }

function send(res: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1024 * 1024) throw new UserError(413, '요청이 너무 크다');
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new UserError(400, 'JSON이 아니다'); }
}

function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.replace(/:\d+$/, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.normalize(path.join(DIST, urlPath));
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('웹이 빌드되지 않았다 — app/ 에서 npm run build');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

export function createHandler(opts: ServerOptions = {}) {
  const cfgDir = opts.cfgDir ?? configDir(opts.env);
  const env = opts.env ?? process.env;
  const launcher = opts.launcher ?? launch;

  async function api(req: http.IncomingMessage, res: http.ServerResponse, parts: string[]) {
    const method = req.method || 'GET';
    if (method !== 'GET' && req.headers['x-plenum'] !== '1') throw new UserError(403, 'X-Plenum 헤더가 없는 요청');
    const cfg = loadConfig(cfgDir);
    const [a, b, c] = parts;

    if (a === 'settings' && !b) {
      if (method === 'GET') return send(res, 200, { kitRepoPath: cfg.kitRepoPath, cloneDir: cfg.cloneDir, editorCommand: cfg.editorCommand, configDir: cfgDir });
      if (method === 'PUT') {
        const body = await readBody(req);
        if (body.kitRepoPath !== undefined) {
          if (body.kitRepoPath !== null && (typeof body.kitRepoPath !== 'string' || !body.kitRepoPath.trim())) throw new UserError(400, 'kit 레포 경로가 비어 있다');
          cfg.kitRepoPath = body.kitRepoPath === null ? null : path.resolve(body.kitRepoPath.trim());
        }
        if (body.cloneDir !== undefined) {
          if (typeof body.cloneDir !== 'string' || !body.cloneDir.trim()) throw new UserError(400, 'clone 폴더가 비어 있다');
          cfg.cloneDir = path.resolve(body.cloneDir.trim());
        }
        if (body.editorCommand !== undefined) {
          if (typeof body.editorCommand !== 'string' || !body.editorCommand.trim()) throw new UserError(400, '에디터 명령이 비어 있다');
          cfg.editorCommand = body.editorCommand.trim();
        }
        saveConfig(cfg, cfgDir);
        return send(res, 200, { kitRepoPath: cfg.kitRepoPath, cloneDir: cfg.cloneDir, editorCommand: cfg.editorCommand, configDir: cfgDir });
      }
    }

    if (a === 'kit' && b === 'workers' && method === 'GET') return send(res, 200, readKit(cfg.kitRepoPath));

    if (a === 'versions' && method === 'GET') {
      const k = readKit(cfg.kitRepoPath);
      return send(res, 200, compareVersions(cfg.kitRepoPath, k.ok ? { name: k.name, version: k.version } : null, env));
    }

    if (a === 'inspect' && method === 'POST') {
      const body = await readBody(req);
      if (typeof body.path !== 'string' || !body.path.trim()) throw new UserError(400, '폴더 경로가 비어 있다');
      const dir = path.resolve(body.path.trim());
      return send(res, 200, { path: dir, name: path.basename(dir), detection: await detect(dir) });
    }

    if (a === 'clone-target' && method === 'POST') {
      const body = await readBody(req);
      const t = cloneTarget(cfg, String(body.url || ''));
      return send(res, 200, { repo: t.ref.repo, owner: t.ref.owner, dest: t.dest, exists: fs.existsSync(t.dest) });
    }

    if (a === 'projects') {
      if (!b && method === 'GET') return send(res, 200, await listProjects(cfg));
      if (!b && method === 'POST') {
        const body = await readBody(req);
        const p = body.kind === 'github' ? await addGitHub(cfgDir, String(body.url || '')) : body.kind === 'local' ? await addLocal(cfgDir, body.path, body.name) : null;
        if (!p) throw new UserError(400, 'kind는 local 또는 github');
        return send(res, 201, { ...p, detection: await detect(p.path) });
      }
      if (b && !c && method === 'DELETE') { removeProject(cfgDir, b); return send(res, 200, { ok: true }); }
      if (b && c === 'claude-md' && method === 'GET') return send(res, 200, { text: readClaudeMd(findProject(cfg, b)) });
      if (b && c === 'open-folder' && method === 'POST') {
        const r = await launcher(folderCommand(findProject(cfg, b).path));
        if (!r.ok) throw new UserError(500, r.message);
        return send(res, 200, { ok: true });
      }
      if (b && c === 'open-editor' && method === 'POST') {
        const r = await launcher(editorCommand(cfg.editorCommand, findProject(cfg, b).path));
        if (!r.ok) throw new UserError(500, `${r.message} — 설정 › 일반에서 에디터 명령을 확인`);
        return send(res, 200, { ok: true });
      }
    }
    throw new UserError(404, `없는 API: ${method} /api/${parts.join('/')}`);
  }

  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      if (!hostAllowed(req.headers.host)) throw new UserError(403, 'Host가 127.0.0.1·localhost가 아니다');
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        const parts = url.pathname.slice(5).split('/').filter(Boolean).map(decodeURIComponent);
        await api(req, res, parts);
      } else if (req.method === 'GET') serveStatic(req, res);
      else throw new UserError(405, '허용하지 않는 메서드');
    } catch (e: any) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof UserError) send(res, e.status, { error: e.message });
      else send(res, 500, { error: `서버 오류: ${e && e.message ? e.message : String(e)}` });
    }
  };
}

// 4317부터 빈 포트를 찾는다 (최대 20칸).
export function listen(handler: http.RequestListener, startPort = 4317, host = '127.0.0.1'): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    let port = startPort;
    const tryPort = () => {
      const server = http.createServer(handler);
      server.once('error', (e: any) => {
        if (e.code === 'EADDRINUSE' && port < startPort + 20 && startPort !== 0) { port++; tryPort(); }
        else reject(e);
      });
      server.listen(port, host, () => resolve({ server, port: (server.address() as any).port }));
    };
    tryPort();
  });
}
