// kit 레포 git 상태·받아오기·우리 커밋 되돌리기. 모든 git 은 셸 없이 인자 배열로, 비밀번호 묻기는 끈다.
import { run, type RunResult } from './run.ts';

const NET_MS = 120000;

export function kitGit(repo: string, args: string[], timeoutMs = 30000): Promise<RunResult> {
  return run('git', args, { cwd: repo, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeoutMs });
}

const lastLine = (r: RunResult) => (r.stderr.trim() || r.stdout.trim()).split(/\r?\n/).filter(Boolean).slice(-2).join(' / ') || `종료 코드 ${r.code}`;

export interface RemoteStatus {
  branch: string;
  dirty: string[];
  ahead: number;
  behind: number;
  state: 'same' | 'ahead' | 'behind' | 'diverged' | 'no-remote';
  head: string;
  remote: string | null;
  fetchError: string | null;
  blockers: string[];
}

export async function porcelain(repo: string): Promise<string[]> {
  const r = await kitGit(repo, ['status', '--porcelain']);
  if (r.code !== 0) throw new Error(`git status 실패: ${lastLine(r)}`);
  return r.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
}

export async function headSha(repo: string): Promise<string> {
  const r = await kitGit(repo, ['rev-parse', 'HEAD']);
  if (r.code !== 0) throw new Error(`HEAD를 읽지 못했다: ${lastLine(r)}`);
  return r.stdout.trim();
}

export async function remoteStatus(repo: string, opts: { fetch?: boolean } = {}): Promise<RemoteStatus> {
  const doFetch = opts.fetch ?? true;
  const br = await kitGit(repo, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const branch = br.code === 0 ? br.stdout.trim() : 'HEAD';
  const head = await headSha(repo);
  const dirty = await porcelain(repo);
  const blockers: string[] = [];
  if (branch !== 'main') blockers.push(branch === 'HEAD' ? '브랜치가 아닌 커밋에 있다(detached HEAD) — main으로 바꾼다' : `현재 브랜치가 main이 아니다 (${branch}) — main으로 바꾼다`);
  if (dirty.length) blockers.push(`작업 트리에 커밋 안 된 변경이 있다 (${dirty.length}개: ${dirty.slice(0, 3).map((l) => l.slice(3)).join(', ')}${dirty.length > 3 ? ' …' : ''}) — 커밋하거나 되돌린다`);

  let fetchError: string | null = null;
  const url = await kitGit(repo, ['remote', 'get-url', 'origin']);
  if (url.code !== 0) {
    blockers.push('원격 origin이 없다');
    return { branch, dirty, ahead: 0, behind: 0, state: 'no-remote', head, remote: null, fetchError, blockers };
  }
  if (doFetch) {
    const f = await kitGit(repo, ['fetch', 'origin'], NET_MS);
    if (f.code !== 0) {
      fetchError = lastLine(f);
      blockers.push(`원격을 확인하지 못했다: ${fetchError}`);
    }
  }
  const rm = await kitGit(repo, ['rev-parse', '--verify', '-q', 'refs/remotes/origin/main']);
  if (rm.code !== 0) {
    if (!fetchError) blockers.push('원격에 main 브랜치(origin/main)가 없다');
    return { branch, dirty, ahead: 0, behind: 0, state: 'no-remote', head, remote: null, fetchError, blockers };
  }
  const remote = rm.stdout.trim();
  const c = await kitGit(repo, ['rev-list', '--left-right', '--count', 'HEAD...refs/remotes/origin/main']);
  if (c.code !== 0) throw new Error(`원격과 비교하지 못했다: ${lastLine(c)}`);
  const [ahead, behind] = c.stdout.trim().split(/\s+/).map(Number);
  const state = ahead > 0 && behind > 0 ? 'diverged' : ahead > 0 ? 'ahead' : behind > 0 ? 'behind' : 'same';
  if (state === 'diverged') blockers.push(`로컬과 원격이 갈라졌다 (로컬에만 커밋 ${ahead}개, 원격에만 ${behind}개) — 직접 합친 뒤 다시 저장한다`);
  else if (state === 'ahead') blockers.push(`push 안 된 커밋이 ${ahead}개 있다 — 먼저 push 하거나 정리한다`);
  else if (state === 'behind') blockers.push(`원격보다 커밋 ${behind}개 뒤처졌다 — 받아오기 하면 된다`);
  return { branch, dirty, ahead, behind, state, head, remote, fetchError, blockers };
}

export interface GitResult { ok: boolean; message: string }

// 깨끗한 main 이 원격보다 뒤처지기만 했을 때만 fast-forward 로 받는다
export async function pullFastForward(repo: string): Promise<GitResult> {
  const st = await remoteStatus(repo);
  if (st.fetchError) return { ok: false, message: `원격을 확인하지 못했다: ${st.fetchError}` };
  if (st.branch !== 'main') return { ok: false, message: `현재 브랜치가 main이 아니다 (${st.branch})` };
  if (st.dirty.length) return { ok: false, message: '작업 트리에 커밋 안 된 변경이 있어서 받아오지 않는다' };
  if (st.state === 'diverged') return { ok: false, message: '로컬과 원격이 갈라져서 자동으로 받아오지 않는다 — 직접 합친다' };
  if (st.state === 'ahead') return { ok: false, message: 'push 안 된 로컬 커밋이 있어서 받아오지 않는다' };
  if (st.state === 'no-remote') return { ok: false, message: '원격 main이 없다' };
  if (st.behind === 0) return { ok: false, message: '받아올 커밋이 없다 (원격과 같다)' };
  const r = await kitGit(repo, ['pull', '--ff-only', 'origin', 'main'], NET_MS);
  if (r.code !== 0) return { ok: false, message: `git pull --ff-only 실패: ${lastLine(r)}` };
  return { ok: true, message: `커밋 ${st.behind}개를 받아왔다` };
}

// HEAD 가 우리 커밋(sha)이고 그 부모가 저장 전 HEAD(baseSha)일 때만 저장 전으로 되돌린다
export async function undoOwnCommit(repo: string, sha: string, baseSha: string): Promise<GitResult> {
  const head = await headSha(repo);
  if (head !== sha) return { ok: false, message: `HEAD(${head.slice(0, 7)})가 방금 만든 커밋(${sha.slice(0, 7)})이 아니어서 되돌리지 않는다` };
  const p = await kitGit(repo, ['rev-parse', '--verify', '-q', `${sha}^`]);
  if (p.code !== 0 || p.stdout.trim() !== baseSha) return { ok: false, message: `방금 만든 커밋의 부모가 저장 전 HEAD(${baseSha.slice(0, 7)})가 아니어서 되돌리지 않는다` };
  const r = await kitGit(repo, ['reset', '--hard', '-q', baseSha]);
  if (r.code !== 0) return { ok: false, message: `git reset 실패: ${lastLine(r)}` };
  return { ok: true, message: `커밋 ${sha.slice(0, 7)}을 되돌렸다` };
}
