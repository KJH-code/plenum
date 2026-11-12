import fs from 'node:fs';
import path from 'node:path';
import { run } from './run.ts';

export type GitState = 'none' | 'empty' | 'ok';

export interface GitHubRef { owner: string; repo: string; url: string }

export interface Detection {
  exists: boolean;
  git: GitState;            // none = .git 없음, empty = 커밋 0개, ok = 커밋 있음
  branch: string | null;
  github: GitHubRef | null;
  hasClaudeMd: boolean;
  hasClaudeDir: boolean;
}

// https://github.com/<o>/<r>(.git)(/) 또는 git@github.com:<o>/<r>(.git) 만 받는다
export function parseGitHubUrl(input: string): GitHubRef | null {
  const s = input.trim();
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(s)
    || /^git@github\.com:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(s);
  if (!m) return null;
  const [, owner, repo] = m;
  if (repo === '.' || repo === '..') return null;
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

export async function detect(dir: string): Promise<Detection> {
  const exists = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  const base: Detection = { exists, git: 'none', branch: null, github: null, hasClaudeMd: false, hasClaudeDir: false };
  if (!exists) return base;
  base.hasClaudeMd = fs.existsSync(path.join(dir, 'CLAUDE.md'));
  base.hasClaudeDir = fs.existsSync(path.join(dir, '.claude'));
  // .git 은 폴더(일반 클론)거나 파일(worktree·submodule)이다
  if (!fs.existsSync(path.join(dir, '.git'))) return base;
  const head = await run('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: dir });
  base.git = head.code === 0 ? 'ok' : 'empty';
  const br = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: dir });
  base.branch = br.code === 0 ? br.stdout.trim() || null : null;
  const origin = await run('git', ['remote', 'get-url', 'origin'], { cwd: dir });
  if (origin.code === 0) base.github = parseGitHubUrl(origin.stdout.trim());
  return base;
}

export async function clone(url: string, dest: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await run('git', ['clone', '--', url, dest], { timeoutMs: 10 * 60 * 1000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.code === 0) return { ok: true };
  return { ok: false, message: (r.stderr || r.stdout).trim() || `git clone 실패 (종료 ${r.code})` };
}
