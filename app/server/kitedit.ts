// 워커 model·effort 저장의 파일 편집 부분. 원문 줄을 그대로 두고 바뀌는 줄의 값만 바꾼다 (YAML로 다시 직렬화하지 않는다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { run } from './run.ts';

const require = createRequire(import.meta.url);
const KIT_LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'compiler', 'lib', 'kit.js');
const kitLib: { loadKit: (dir: string) => any; EFFORTS: string[]; tierOf: (w: { model: string; effort: string }) => string } = require(KIT_LIB);

export const MODELS = ['opus', 'sonnet', 'haiku', 'fable'];
export const EFFORTS: string[] = [...kitLib.EFFORTS];
export const tierOf = (model: string, effort: string) => kitLib.tierOf({ model, effort });
export const loadKit = kitLib.loadKit;

// 텍스트 파일 판정: 앞 8000바이트에 NUL 없음 (git과 같은 판정)
const isText = (buf: Buffer) => !buf.subarray(0, 8000).includes(0);
export const toLf = (s: string) => s.replace(/\r\n/g, '\n');

// kit 폴더 복사. lf(rel) 이 참인 텍스트 파일은 CRLF → LF 로 바꿔 쓴다. 실행 비트는 유지(컴파일러가 본다).
// fs.cpSync 대신 (Windows 한글 경로 아래에 파일을 안 만들었다)
export function copyKit(src: string, dest: string, lf: (rel: string) => boolean, rel = '') {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) copyKit(s, d, lf, r);
    else if (e.isFile()) {
      const buf = fs.readFileSync(s);
      fs.writeFileSync(d, lf(r) && isText(buf) && buf.includes(0x0d) ? Buffer.from(toLf(buf.toString('latin1')), 'latin1') : buf);
      fs.chmodSync(d, fs.statSync(s).mode & 0o777);
    }
  }
}

// kit 읽기. Windows git(core.autocrlf=true)은 체크아웃할 때 LF를 CRLF로 바꾸는데, 컴파일러의 머리말 파서는
// 첫 줄이 정확히 '---' 여야 해서 CRLF 워커 파일을 못 읽는다. LF로 바꾼 임시 사본에서 읽는다(원본은 그대로).
export function loadKitLf(kitDir: string): any {
  if (!fs.existsSync(path.join(kitDir, 'kit.yaml'))) return loadKit(kitDir); // 컴파일러의 "kit.yaml이 없음" 오류 그대로
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plenum-kit-'));
  try {
    copyKit(kitDir, path.join(tmp, 'kit'), () => true);
    return loadKit(path.join(tmp, 'kit'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 저장 검사에서 나는 오류. kind는 SaveError.kind 로 그대로 간다
export class EditError extends Error {
  constructor(public kind: 'blocked' | 'version' | 'other', message: string) { super(message); }
}

export interface WorkerFields { model: string; effort: string }

// 머리말 = 맨 앞 '---' 줄과 그다음 '---' 줄 사이. 줄 끝 \r 은 비교에서만 뗀다
function frontmatterRange(lines: string[]): { start: number; end: number } {
  const bare = (l: string) => l.replace(/\r$/, '');
  if (lines.length === 0 || bare(lines[0]) !== '---') throw new Error('머리말(---)이 없다');
  for (let i = 1; i < lines.length; i++) if (bare(lines[i]) === '---') return { start: 1, end: i };
  throw new Error('머리말 끝(---)이 없다');
}

// key: 값 [# 주석] [\r] — 값만 바꾼다. 따옴표가 있으면 그 모양을 유지
const fieldRe = (key: string) => new RegExp(`^(${key}:[ \\t]*)(["']?)([A-Za-z0-9.]*)\\2([ \\t]*(?:#[^\\r]*)?)(\\r?)$`);

function findField(lines: string[], range: { start: number; end: number }, key: string): number {
  const idx: number[] = [];
  for (let i = range.start; i < range.end; i++) if (lines[i].startsWith(`${key}:`)) idx.push(i);
  if (idx.length === 0) throw new Error(`머리말에 ${key}: 줄이 없다`);
  if (idx.length > 1) throw new Error(`머리말에 ${key}: 줄이 ${idx.length}번 있다`);
  if (!fieldRe(key).test(lines[idx[0]])) throw new Error(`머리말 ${key}: 줄을 읽을 수 없다: ${lines[idx[0]].replace(/\r$/, '')}`);
  return idx[0];
}

export function checkValues(model: unknown, effort: unknown) {
  if (typeof model !== 'string' || !MODELS.includes(model)) throw new Error(`모르는 model: ${String(model)} (허용: ${MODELS.join(', ')})`);
  if (typeof effort !== 'string' || !EFFORTS.includes(effort)) throw new Error(`모르는 effort: ${String(effort)} (허용: ${EFFORTS.join(', ')})`);
}

export function getWorkerFields(text: string): WorkerFields {
  const lines = text.split('\n');
  const range = frontmatterRange(lines);
  const get = (key: string) => fieldRe(key).exec(lines[findField(lines, range, key)])![3];
  return { model: get('model'), effort: get('effort') };
}

export function setWorkerFields(text: string, v: WorkerFields): string {
  checkValues(v.model, v.effort);
  const lines = text.split('\n');
  const range = frontmatterRange(lines);
  for (const [key, value] of [['model', v.model], ['effort', v.effort]] as const) {
    const i = findField(lines, range, key);
    lines[i] = lines[i].replace(fieldRe(key), (_m, pre, q, _old, post, cr) => `${pre}${q}${value}${q}${post}${cr}`);
  }
  return lines.join('\n');
}

export function bumpPatch(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`버전 꼴이 x.y.z가 아니다: ${v}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

const versionRe = /^(version:[ \t]*)(["']?)(\d+\.\d+\.\d+)\2([ \t]*(?:#[^\r]*)?)(\r?)$/;

function kitYamlVersionLine(lines: string[]): number {
  const idx = lines.map((l, i) => (l.startsWith('version:') ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) throw new Error('kit.yaml에 version: 줄이 없다');
  if (idx.length > 1) throw new Error(`kit.yaml에 version: 줄이 ${idx.length}번 있다`);
  if (!versionRe.test(lines[idx[0]])) throw new Error(`kit.yaml version 줄이 "x.y.z" 꼴이 아니다: ${lines[idx[0]].replace(/\r$/, '')}`);
  return idx[0];
}

export function getKitYamlVersion(text: string): string {
  const lines = text.split('\n');
  return versionRe.exec(lines[kitYamlVersionLine(lines)])![3];
}

export function setKitYamlVersion(text: string, newVersion: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(newVersion)) throw new Error(`버전 꼴이 x.y.z가 아니다: ${newVersion}`);
  const lines = text.split('\n');
  const i = kitYamlVersionLine(lines);
  lines[i] = lines[i].replace(versionRe, (_m, pre, q, _old, post, cr) => `${pre}${q}${newVersion}${q}${post}${cr}`);
  return lines.join('\n');
}

export interface Versions { kitYaml: string | null; packageJson: string | null; lockTop: string | null; lockRoot: string | null }

export function readVersions(repo: string): Versions {
  const v: Versions = { kitYaml: null, packageJson: null, lockTop: null, lockRoot: null };
  try { v.kitYaml = getKitYamlVersion(fs.readFileSync(path.join(repo, 'kit', 'kit.yaml'), 'utf8')); } catch { /* 없음 */ }
  try { const p = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')); v.packageJson = typeof p.version === 'string' ? p.version : null; } catch { /* 없음 */ }
  try {
    const l = JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'));
    v.lockTop = typeof l.version === 'string' ? l.version : null;
    v.lockRoot = l.packages && l.packages[''] && typeof l.packages[''].version === 'string' ? l.packages[''].version : null;
  } catch { /* 없음 */ }
  return v;
}

// 네 값이 모두 있고 같으면 null, 아니면 사람이 읽을 이유
export function versionProblem(v: Versions): string | null {
  const show = (x: string | null) => x ?? '없음';
  const all = [v.kitYaml, v.packageJson, v.lockTop, v.lockRoot];
  if (all.every((x) => x !== null && x === v.kitYaml)) return null;
  return `버전이 서로 다르다 — kit/kit.yaml ${show(v.kitYaml)}, package.json ${show(v.packageJson)}, package-lock.json ${show(v.lockTop)} (packages[""] ${show(v.lockRoot)}). 같게 맞춰 커밋한 뒤 다시 저장한다`;
}

export function commitMessage(worker: string, from: WorkerFields, to: WorkerFields, newVersion: string): string {
  const parts: string[] = [];
  if (from.model !== to.model) parts.push(`model ${from.model} → ${to.model}`);
  if (from.effort !== to.effort) parts.push(`effort ${from.effort} → ${to.effort}`);
  return `${worker}: ${parts.join(', ')} (${newVersion})`;
}

// 저장 계획: 무엇을 어떻게 바꾸는지. 레포에 쓰지 않는다
export interface SavePlan {
  worker: string;
  workerFile: string;       // 레포 기준 (kit/workers/<파일>)
  from: WorkerFields;
  to: WorkerFields;
  tier: string;             // 새 계층 (예: Sonnet high)
  tiers: string[];          // kit.yaml tiers
  oldWorkerText: string;
  newWorkerText: string;
  oldKitYaml: string;
  newKitYaml: string;
  version: string;
  newVersion: string;
  commitMessage: string;
}

export function planSave(repo: string, worker: unknown, model: unknown, effort: unknown): SavePlan {
  if (typeof worker !== 'string' || !worker) throw new EditError('blocked', '워커 이름이 비어 있다');
  try { checkValues(model, effort); } catch (e: any) { throw new EditError('blocked', e.message); }
  let kit: any;
  try { kit = loadKitLf(path.join(repo, 'kit')); } catch (e: any) { throw new EditError('other', `kit을 읽지 못했다 — ${e.message}`); }
  const w = kit.workers.get(worker);
  if (!w) throw new EditError('blocked', `워커가 없다: ${worker}`);
  const workerFile = `kit/workers/${w.file}`;
  const oldWorkerText = fs.readFileSync(path.join(repo, ...workerFile.split('/')), 'utf8');
  let from: WorkerFields;
  let newWorkerText: string;
  const to = { model: model as string, effort: effort as string };
  try {
    from = getWorkerFields(oldWorkerText);
    newWorkerText = setWorkerFields(oldWorkerText, to);
  } catch (e: any) { throw new EditError('other', `${workerFile}: ${e.message}`); }
  if (from.model === to.model && from.effort === to.effort) throw new EditError('blocked', `바뀌는 것이 없다 (${worker}는 이미 ${to.model} ${to.effort})`);
  const versions = readVersions(repo);
  const vp = versionProblem(versions);
  if (vp) throw new EditError('version', vp);
  const version = versions.kitYaml!;
  let newVersion: string;
  let newKitYaml: string;
  const oldKitYaml = fs.readFileSync(path.join(repo, 'kit', 'kit.yaml'), 'utf8');
  try {
    newVersion = bumpPatch(version);
    newKitYaml = setKitYamlVersion(oldKitYaml, newVersion);
  } catch (e: any) { throw new EditError('version', e.message); }
  const tiers = (Array.isArray(kit.meta.tiers) ? kit.meta.tiers : []).map((r: any) => String(r && r.tier));
  return {
    worker, workerFile, from, to, tier: tierOf(to.model, to.effort), tiers,
    oldWorkerText, newWorkerText, oldKitYaml, newKitYaml, version, newVersion,
    commitMessage: commitMessage(worker, from, to, newVersion),
  };
}

export interface DiffLine { sign: '-' | '+'; text: string }
export interface PreviewFile { path: string; lines: DiffLine[] }
export interface Preview { files: PreviewFile[]; commitMessage: string; authorEmail: string | null; newVersion: string; from: WorkerFields }

// 바뀌는 줄만 (줄 수가 같은 편집이라 같은 번호끼리 비교)
function changedLines(a: string, b: string): DiffLine[] {
  const la = a.split('\n');
  const lb = b.split('\n');
  const out: DiffLine[] = [];
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] === lb[i]) continue;
    if (la[i] !== undefined) out.push({ sign: '-', text: la[i].replace(/\r$/, '') });
    if (lb[i] !== undefined) out.push({ sign: '+', text: lb[i].replace(/\r$/, '') });
  }
  return out;
}

// package.json·package-lock.json 의 version 줄 (npm version 이 바꿀 줄). 원문에서 찾고, 못 찾으면 모양만 만든다
function jsonVersionLines(text: string, from: string, to: string, lock: boolean): DiffLine[] {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const picked: string[] = [];
  const top = lines.find((l) => /^ {2}"version":/.test(l));
  if (top) picked.push(top);
  if (lock) {
    const root = lines.findIndex((l) => /^\s*"": \{/.test(l));
    const v = root >= 0 ? lines.slice(root + 1).find((l) => /^\s*"version":/.test(l)) : undefined;
    if (v) picked.push(v);
  }
  if (picked.length === 0) picked.push(`  "version": "${from}",`);
  return picked.flatMap((l) => [{ sign: '-' as const, text: l }, { sign: '+' as const, text: l.replace(`"${from}"`, `"${to}"`) }]);
}

export async function previewSave(repo: string, worker: unknown, model: unknown, effort: unknown): Promise<Preview> {
  const plan = planSave(repo, worker, model, effort);
  const read = (f: string) => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return ''; } };
  const email = await run('git', ['config', 'user.email'], { cwd: repo, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return {
    files: [
      { path: plan.workerFile, lines: changedLines(plan.oldWorkerText, plan.newWorkerText) },
      { path: 'kit/kit.yaml', lines: changedLines(plan.oldKitYaml, plan.newKitYaml) },
      { path: 'package.json', lines: jsonVersionLines(read('package.json'), plan.version, plan.newVersion, false) },
      { path: 'package-lock.json', lines: jsonVersionLines(read('package-lock.json'), plan.version, plan.newVersion, true) },
    ],
    commitMessage: plan.commitMessage,
    authorEmail: email.code === 0 && email.stdout.trim() ? email.stdout.trim() : null,
    newVersion: plan.newVersion,
    from: plan.from,
  };
}

export interface Warning { file: string; line: number; message: string }

// 컴파일러 WARN 의 file·line 은 build 기준이다(표 자리표시가 펼쳐져 kit 원본 줄과 다를 수 있다).
// build 파일의 그 줄 텍스트를 kit 쪽 같은 상대경로 파일에서 찾아 첫 일치 줄 번호를 쓴다. 못 찾으면 build 경로 그대로.
// tmpKitDir 는 <tmp>/kit, build 는 outDir(기본 <tmp>/out).
export function mapWarning(repo: string, tmpKitDir: string, w: Warning, outDir = path.join(path.dirname(tmpKitDir), 'out')): Warning {
  const parts = w.file.split('/');
  const lineAt = (f: string, n: number) => { try { const l = fs.readFileSync(f, 'utf8').split('\n')[n - 1]; return l === undefined ? null : l.replace(/\r$/, ''); } catch { return null; } };
  const text = lineAt(path.join(outDir, ...parts), w.line);
  if (text !== null) {
    for (const kitDir of [tmpKitDir, path.join(repo, 'kit')]) {
      let src: string;
      try { src = fs.readFileSync(path.join(kitDir, ...parts), 'utf8'); } catch { continue; }
      const i = src.split('\n').findIndex((l) => l.replace(/\r$/, '') === text);
      if (i >= 0) return { file: `kit/${w.file}`, line: i + 1, message: w.message };
    }
  }
  return { file: `build/claude-code/${w.file}`, line: w.line, message: w.message };
}
