import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig, type Config, type ProjectEntry } from './config.ts';
import { detect, parseGitHubUrl, clone, type Detection } from './git.ts';

import { UserError } from './errors.ts';
import { absolutePath } from './paths.ts';
export { UserError };

export interface ProjectView extends ProjectEntry { detection: Detection }

export async function listProjects(cfg: Config): Promise<ProjectView[]> {
  return Promise.all(cfg.projects.map(async (p) => ({ ...p, detection: await detect(p.path) })));
}

const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

function addEntry(cfgDir: string | undefined, entry: Omit<ProjectEntry, 'id'>): ProjectEntry {
  const cfg = loadConfig(cfgDir);
  if (cfg.projects.some((p) => samePath(p.path, entry.path))) throw new UserError(409, `이미 목록에 있다: ${entry.path}`);
  const full: ProjectEntry = { id: crypto.randomUUID(), ...entry };
  cfg.projects.push(full);
  saveConfig(cfg, cfgDir);
  return full;
}

export async function addLocal(cfgDir: string | undefined, input: string, name?: string): Promise<ProjectEntry> {
  const dir = absolutePath(input, '폴더 경로');
  if (!fs.existsSync(dir)) throw new UserError(400, `폴더가 없다: ${dir}`);
  if (!fs.statSync(dir).isDirectory()) throw new UserError(400, `폴더가 아니다: ${dir}`);
  return addEntry(cfgDir, { name: (name && name.trim()) || path.basename(dir), path: dir, source: 'local' });
}

export function cloneTarget(cfg: Config, url: string): { ref: NonNullable<ReturnType<typeof parseGitHubUrl>>; dest: string } {
  const ref = parseGitHubUrl(url);
  if (!ref) throw new UserError(400, 'GitHub 레포 주소가 아니다 (https://github.com/<owner>/<repo> 꼴)');
  return { ref, dest: path.join(cfg.cloneDir, ref.repo) };
}

export async function addGitHub(cfgDir: string | undefined, url: string): Promise<ProjectEntry> {
  const cfg = loadConfig(cfgDir);
  const { ref, dest } = cloneTarget(cfg, url);
  if (cfg.projects.some((p) => samePath(p.path, dest))) throw new UserError(409, `이미 목록에 있다: ${dest}`);
  if (fs.existsSync(dest)) throw new UserError(409, `clone할 폴더가 이미 있다: ${dest} — 로컬 폴더로 추가하거나 설정에서 clone 폴더를 바꾼다`);
  fs.mkdirSync(cfg.cloneDir, { recursive: true });
  const r = await clone(url.trim(), dest);
  if (!r.ok) throw new UserError(502, `clone 실패: ${r.message}`);
  return addEntry(cfgDir, { name: ref.repo, path: dest, source: 'github', url: ref.url });
}

export function removeProject(cfgDir: string | undefined, id: string): void {
  const cfg = loadConfig(cfgDir);
  const before = cfg.projects.length;
  cfg.projects = cfg.projects.filter((p) => p.id !== id);
  if (cfg.projects.length === before) throw new UserError(404, '목록에 없는 프로젝트');
  saveConfig(cfg, cfgDir); // 목록에서만 뺀다. 폴더는 건드리지 않는다
}

export function findProject(cfg: Config, id: string): ProjectEntry {
  const p = cfg.projects.find((x) => x.id === id);
  if (!p) throw new UserError(404, '목록에 없는 프로젝트');
  return p;
}

export function readClaudeMd(p: ProjectEntry): string {
  const file = path.join(p.path, 'CLAUDE.md');
  if (!fs.existsSync(file)) throw new UserError(404, 'CLAUDE.md가 없다');
  const buf = fs.readFileSync(file);
  if (buf.length > 512 * 1024) throw new UserError(413, 'CLAUDE.md가 512KB보다 크다');
  return buf.toString('utf8');
}
