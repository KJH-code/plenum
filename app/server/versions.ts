// 소스(kit 레포의 kit.yaml version + build/claude-code)와 설치본(Claude Code 마켓플레이스 설치)의 버전·내용 해시 비교.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MARKETPLACE = 'kjh-code';

// 트리 해시: 정렬한 상대경로마다 "경로 NUL 내용sha256 LF"를 이어 sha256. 권한 비트는 넣지 않는다(Windows엔 없다).
export function treeHash(dir: string): { hash: string; files: number } | null {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const files: string[] = [];
  (function walk(d: string, rel: string) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) files.push(r);
    }
  })(dir, '');
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const h = crypto.createHash('sha256');
  for (const f of files) {
    const c = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
    h.update(`${f}\0${c}\n`);
  }
  return { hash: h.digest('hex'), files: files.length };
}

export function claudeHome(env = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
}

export interface Side { version: string; hash: string | null; files: number; path: string }

export interface VersionView {
  plugin: string | null;
  source: Side | null;
  sourceProblem: string | null;
  installed: Side | null;
  installedProblem: string | null;
  status: 'same' | 'version-differs' | 'content-differs' | 'unknown';
}

function readInstalled(plugin: string, home: string): { side: Side | null; problem: string | null } {
  const file = path.join(home, 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(file)) return { side: null, problem: '설치본 못 찾음' };
  let data: any;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e: any) { return { side: null, problem: `installed_plugins.json을 못 읽음 — ${e.message}` }; }
  const list = data && data.plugins && data.plugins[`${plugin}@${MARKETPLACE}`];
  if (!Array.isArray(list) || list.length === 0) return { side: null, problem: '설치본 못 찾음' };
  const entry = list.find((x: any) => x && x.scope === 'user') || list[0];
  const installPath = String(entry.installPath || '');
  const t = installPath ? treeHash(installPath) : null;
  return {
    side: { version: String(entry.version ?? ''), hash: t ? t.hash : null, files: t ? t.files : 0, path: installPath },
    problem: t ? null : `설치 폴더가 없음: ${installPath}`,
  };
}

export function compareVersions(kitRepo: string | null, kitInfo: { name: string; version: string } | null, env = process.env): VersionView {
  const view: VersionView = { plugin: kitInfo ? kitInfo.name : null, source: null, sourceProblem: null, installed: null, installedProblem: null, status: 'unknown' };
  if (!kitRepo || !kitInfo) {
    view.sourceProblem = 'kit 레포 경로가 없음';
    view.installedProblem = '소스를 모르면 설치본 이름도 모름';
    return view;
  }
  const build = path.join(kitRepo, 'build', 'claude-code');
  const t = treeHash(build);
  view.source = { version: kitInfo.version, hash: t ? t.hash : null, files: t ? t.files : 0, path: build };
  if (!t) view.sourceProblem = `build/claude-code가 없음 — npm run build`;
  const inst = readInstalled(kitInfo.name, claudeHome(env));
  view.installed = inst.side;
  view.installedProblem = inst.problem;
  if (view.source && view.installed) {
    if (view.source.version !== view.installed.version) view.status = 'version-differs';
    else if (view.source.hash && view.installed.hash) view.status = view.source.hash === view.installed.hash ? 'same' : 'content-differs';
  }
  return view;
}
