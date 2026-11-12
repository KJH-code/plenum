// 워커 model·effort 저장 파이프라인: 검사 → 빌드 → commit → push. 한 번에 하나만 돈다.
// 검사가 끝날 때까지 레포에 쓰지 않는다. 빌드·commit 이 실패하면 손댄 경로만 되돌린다.
// push 가 거부되면 자동으로 합치지 않고 멈춘다 → retry(받아와서 다시) 또는 cancel(커밋 취소).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserError } from './errors.ts';
import { EditError, mapWarning, planSave, readVersions, type SavePlan } from './kitedit.ts';
import { headSha, kitGit, porcelain, pullFastForward, remoteStatus, undoOwnCommit } from './kitgit.ts';
import { commandFor, resolveCommand, runCommand } from './open.ts';
import { run } from './run.ts';

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
}
export interface SaveInput { worker: string; model: string; effort: string }
export interface SaveHooks { beforePush?: () => Promise<void> }

const STEPS: StepKey[] = ['check', 'build', 'commit', 'push'];
const COMPILE_MS = 120000;

let job: SaveJob | null = null;
let jobRepo: string | null = null;
let running: Promise<void> | null = null;
let nextId = 1;
let busy = false; // retry·cancel 이 되돌리는 중

const blank = (id: number, input: Partial<SaveInput>, status: SaveJob['status']): SaveJob => ({
  id, worker: input.worker ?? '', model: input.model ?? '', effort: input.effort ?? '', status,
  steps: STEPS.map((key) => ({ key, state: 'wait' as StepState, detail: '' })),
  warnings: [], error: null, pushError: null, baseSha: null, commit: null, newVersion: null, commitMessage: null,
});

const snapshot = (j: SaveJob): SaveJob => structuredClone(j);

export function getSave(): SaveJob {
  return job ? snapshot(job) : blank(0, {}, 'idle');
}

// 테스트용: 상태 초기화
export function resetSaveState() {
  job = null; jobRepo = null; running = null; nextId = 1; busy = false;
}

// 테스트용: 돌고 있는 저장이 끝날 때까지
export async function saveSettled(): Promise<SaveJob> {
  while (running) await running;
  return getSave();
}

export const compilerBin = (repo: string) => path.join(repo, 'node_modules', 'plenum', 'bin', 'plenum-compile');

// fs.cpSync 대신 (Windows 한글 경로 아래에 파일을 안 만들었다)
function copyDir(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

class StepFail extends Error {
  constructor(public err: SaveError) { super(err.message); }
}
const fail = (kind: SaveError['kind'], message: string, extra: Partial<SaveError> = {}) => new StepFail({ kind, message, ...extra });
const outText = (s: string) => s.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' / ');

// 컴파일러 ERROR 줄 → 오류. 계층 행이 없으면 tier
function compileError(stderr: string, stdout: string): StepFail {
  const line = stderr.split(/\r?\n/).find((l) => l.startsWith('ERROR ')) ?? '';
  const msg = line ? line.slice(6).trim() : outText(stderr || stdout) || '컴파일러가 실패했다';
  const t = /계층 행 없음: (.+?) — kit\.yaml tiers/.exec(msg);
  if (t) return fail('tier', `kit.yaml tiers에 "${t[1]}" 행이 없다 — kit/kit.yaml tiers에 행을 추가한 뒤 다시 저장한다`, { tier: t[1], file: 'kit/kit.yaml' });
  if (/tiers/.test(msg)) return fail('tier', msg, { file: 'kit/kit.yaml' });
  return fail('build', `빌드 실패: ${msg}`);
}

export function startSave(repo: string, input: SaveInput, opts: { hooks?: SaveHooks } = {}): SaveJob {
  if (running || busy) throw new UserError(409, '저장이 이미 진행 중이다');
  const j = blank(nextId++, input, 'running');
  job = j;
  jobRepo = repo;
  // 다음 틱에 시작한다 — 돌려주는 상태는 언제나 시작 직후(running)
  const p = Promise.resolve().then(() => pipeline(repo, j, input, opts.hooks ?? {})).finally(() => { if (running === p) running = null; });
  running = p;
  return snapshot(j);
}

async function pipeline(repo: string, j: SaveJob, input: SaveInput, hooks: SaveHooks) {
  const step = (k: StepKey) => j.steps.find((s) => s.key === k)!;
  let current: StepKey = 'check';
  let wrote = false; // 진짜 레포에 쓰기 시작했는지 (롤백 필요)
  let plan: SavePlan | null = null;
  const begin = (k: StepKey, detail = '') => { current = k; step(k).state = 'run'; step(k).detail = detail; };
  try {
    // 1. 검사 — 레포에 쓰지 않는다
    begin('check', '검사');
    const bin = compilerBin(repo);
    if (!fs.existsSync(bin)) throw fail('compiler', `kit 레포에 컴파일러가 없다 (node_modules/plenum/bin/plenum-compile) — kit 레포에서 npm ci 필요`);
    const st = await remoteStatus(repo, { fetch: true });
    if (st.blockers.length) throw fail('blocked', st.blockers.join(' / '));
    j.baseSha = st.head;
    try { plan = planSave(repo, input.worker, input.model, input.effort); } catch (e: any) {
      if (e instanceof EditError) throw fail(e.kind, e.message);
      throw e;
    }
    j.newVersion = plan.newVersion;
    j.commitMessage = plan.commitMessage;
    if (!plan.tiers.includes(plan.tier)) {
      throw fail('tier', `kit.yaml tiers에 "${plan.tier}" 행이 없다 — kit/kit.yaml tiers에 행을 추가한 뒤 다시 저장한다`, { tier: plan.tier, file: 'kit/kit.yaml' });
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plenum-save-'));
    try {
      const tmpKit = path.join(tmp, 'kit');
      const tmpOut = path.join(tmp, 'out');
      copyDir(path.join(repo, 'kit'), tmpKit);
      fs.writeFileSync(path.join(tmp, ...plan.workerFile.split('/')), plan.newWorkerText);
      fs.writeFileSync(path.join(tmpKit, 'kit.yaml'), plan.newKitYaml);
      const r = await run(process.execPath, [bin, '--kit', tmpKit, '--out', tmpOut, '--json'], { cwd: repo, timeoutMs: COMPILE_MS });
      if (r.code !== 0) throw compileError(r.stderr, r.stdout);
      let parsed: { files: number; warnings: { file: string; line: number; message: string }[] };
      try { parsed = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() || ''); } catch { throw fail('build', `컴파일러 출력을 읽지 못했다: ${outText(r.stdout)}`); }
      j.warnings = (parsed.warnings || []).map((w) => mapWarning(repo, tmpKit, w, tmpOut));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    step('check').state = j.warnings.length ? 'warn' : 'ok';
    step('check').detail = j.warnings.length ? `plenum-compile --json · 경고 ${j.warnings.length}개` : 'plenum-compile --json';

    // 2. 빌드 — 여기부터 레포에 쓴다
    begin('build', 'npm version patch · plenum-compile');
    wrote = true;
    fs.writeFileSync(path.join(repo, ...plan.workerFile.split('/')), plan.newWorkerText);
    fs.writeFileSync(path.join(repo, 'kit', 'kit.yaml'), plan.newKitYaml);
    const npm = resolveCommand('npm');
    if (!npm) throw fail('other', 'npm을 PATH에서 못 찾았다');
    let cmd;
    try { cmd = commandFor(npm, ['version', 'patch', '--no-git-tag-version']); } catch (e: any) { throw fail('other', e.message); }
    const nv = await runCommand(cmd, { cwd: repo, timeoutMs: COMPILE_MS });
    if (nv.code !== 0) throw fail('other', `npm version patch 실패${nv.timedOut ? '(시간 초과)' : ''}: ${nv.error ?? outText(nv.output)}`);
    const v = readVersions(repo);
    if (v.packageJson !== plan.newVersion || v.lockTop !== plan.newVersion || v.lockRoot !== plan.newVersion) {
      throw fail('version', `npm version 뒤 버전이 ${plan.newVersion}이 아니다 — package.json ${v.packageJson}, package-lock.json ${v.lockTop} (packages[""] ${v.lockRoot})`);
    }
    const b = await run(process.execPath, [bin], { cwd: repo, timeoutMs: COMPILE_MS });
    if (b.code !== 0) throw compileError(b.stderr, b.stdout);
    step('build').state = 'ok';

    // 3. commit — 손댄 경로만
    begin('commit', 'git commit');
    const paths = touchedPaths(plan);
    const add = await kitGit(repo, ['add', '--', ...paths]);
    if (add.code !== 0) throw fail('git', `git add 실패: ${outText(add.stderr)}`);
    const staged = await kitGit(repo, ['diff', '--cached', '--name-only', '-z']);
    if (staged.code !== 0) throw fail('git', `스테이징 목록을 읽지 못했다: ${outText(staged.stderr)}`);
    const files = staged.stdout.split('\0').filter(Boolean);
    const extra = files.filter((f) => !paths.includes(f) && !f.startsWith('build/claude-code/'));
    if (extra.length) throw fail('git', `예상하지 않은 파일이 스테이징됐다: ${extra.join(', ')}`);
    if (files.length === 0) throw fail('git', '커밋할 변경이 없다');
    const c = await kitGit(repo, ['commit', '-q', '-m', plan.commitMessage]);
    if (c.code !== 0) throw fail('git', `git commit 실패: ${outText(c.stderr || c.stdout)}`);
    const sha = await headSha(repo);
    j.commit = { sha, short: sha.slice(0, 7) };
    wrote = false; // 커밋됐다 — 이제 롤백 대상이 아니다
    step('commit').state = 'ok';
    step('commit').detail = `커밋 ${j.commit.short} · 파일 ${files.length}개`;

    // 4. push
    begin('push', 'origin main');
    if (hooks.beforePush) await hooks.beforePush();
    const p = await kitGit(repo, ['push', 'origin', 'main'], 120000);
    if (p.code !== 0) {
      const out = `${p.stderr}\n${p.stdout}`;
      const rejected = /\[rejected\]|non-fast-forward|fetch first/.test(out);
      j.pushError = {
        kind: rejected ? 'rejected' : 'other',
        message: rejected ? '원격에 새 커밋이 있어서 push가 거부됐다 — 받아와서 다시 push 하거나 커밋을 취소한다' : `push 실패: ${outText(out)}`,
      };
      step('push').state = 'fail';
      j.status = 'push-failed';
      return;
    }
    step('push').state = 'ok';
    j.status = 'done';
  } catch (e: any) {
    const err: SaveError = e instanceof StepFail ? e.err : { kind: 'other', message: `예상하지 못한 오류: ${e && e.message ? e.message : String(e)}` };
    if (wrote && plan) {
      const left = await rollback(repo, plan);
      if (left) err.message += ` (되돌린 뒤에도 남은 변경: ${left})`;
      else err.message += ' — 레포는 저장 전으로 되돌렸다';
    }
    step(current).state = 'fail';
    for (const s of j.steps) if (s.state === 'wait') s.state = 'skip';
    j.error = err;
    j.status = 'failed';
  }
}

function touchedPaths(plan: SavePlan): string[] {
  return [plan.workerFile, 'kit/kit.yaml', 'package.json', 'package-lock.json', 'build/claude-code'];
}

// 손댄 경로만 HEAD 로 되돌린다. 남은 변경이 있으면 그 목록, 없으면 null
async function rollback(repo: string, plan: SavePlan): Promise<string | null> {
  const paths = touchedPaths(plan);
  await kitGit(repo, ['reset', '-q', '--', ...paths]);
  await kitGit(repo, ['checkout', 'HEAD', '--', ...paths]);
  await kitGit(repo, ['clean', '-fdq', '--', 'build/claude-code']);
  try {
    const left = await porcelain(repo);
    return left.length ? left.join(', ') : null;
  } catch (e: any) { return e.message; }
}

function needPushFailed(repo: string, what: string): SaveJob {
  if (running || busy) throw new UserError(409, '저장이 진행 중이다');
  if (!job || job.status !== 'push-failed') throw new UserError(409, `${what}는 push가 실패한 저장에서만 할 수 있다`);
  if (jobRepo !== repo) throw new UserError(409, 'push가 실패한 저장의 kit 레포가 지금 설정과 다르다');
  if (!job.commit || !job.baseSha) throw new UserError(409, '되돌릴 커밋 정보가 없다');
  return job;
}

// 받아와서 다시 push: 우리 커밋을 되돌리고 → 원격을 받고 → 같은 입력으로 처음부터 (버전은 새 base 기준 +1)
export async function retrySave(repo: string, opts: { hooks?: SaveHooks } = {}): Promise<SaveJob> {
  const j = needPushFailed(repo, '다시 push');
  busy = true;
  try {
    return await retryLocked(repo, j, opts);
  } finally { busy = false; }
}

async function retryLocked(repo: string, j: SaveJob, opts: { hooks?: SaveHooks }): Promise<SaveJob> {
  const undo = await undoOwnCommit(repo, j.commit!.sha, j.baseSha!);
  if (!undo.ok) throw new UserError(409, undo.message);
  j.commit = null;
  const st = await remoteStatus(repo, { fetch: true });
  if (st.state === 'behind') {
    const pull = await pullFastForward(repo);
    if (!pull.ok) {
      j.status = 'failed';
      j.error = { kind: 'git', message: `커밋은 되돌렸지만 받아오지 못했다: ${pull.message}` };
      return snapshot(j);
    }
  }
  busy = false;
  return startSave(repo, { worker: j.worker, model: j.model, effort: j.effort }, opts);
}

// 커밋 취소: 우리 커밋을 되돌리고 끝
export async function cancelSave(repo: string): Promise<SaveJob> {
  const j = needPushFailed(repo, '커밋 취소');
  busy = true;
  try {
    const undo = await undoOwnCommit(repo, j.commit!.sha, j.baseSha!);
    if (!undo.ok) throw new UserError(409, undo.message);
    j.status = 'cancelled';
    return snapshot(j);
  } finally { busy = false; }
}
