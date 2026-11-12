// 사용자가 넣은 경로 검사. 상대 경로는 서버가 뜬 위치(cwd) 기준이 돼서 엉뚱한 곳을 가리키므로 받지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserError } from './errors.ts';

const OWNER_REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

// ~ 는 홈으로 펼친다. 절대 경로가 아니면 이유를 붙여 거부한다.
export function absolutePath(input: unknown, what: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new UserError(400, `${what}가 비어 있다`);
  let s = input.trim().replace(/^["']|["']$/g, '');
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(1));
  if (OWNER_REPO.test(s) && !fs.existsSync(path.resolve(s))) {
    throw new UserError(400, `"${s}"는 GitHub의 owner/repo 꼴이다. ${what}에는 그 레포를 clone한 내 컴퓨터 폴더의 전체 경로를 넣는다 (예: ${example()}). 아직 clone하지 않았으면 홈의 "프로젝트 추가 › GitHub에서"로 받으면 된다`);
  }
  if (/^https?:\/\//.test(s) || s.startsWith('git@')) throw new UserError(400, `주소가 아니라 내 컴퓨터 폴더의 전체 경로를 넣는다 (예: ${example()})`);
  if (!path.isAbsolute(s)) throw new UserError(400, `상대 경로는 받지 않는다 — 서버가 뜬 폴더 기준이 되기 때문이다. 전체 경로를 넣는다 (예: ${example()})`);
  return path.resolve(s);
}

function example(): string {
  return path.join(os.homedir(), 'Documents', 'GitHub', 'jh-kit');
}

export function checkKitRepo(input: unknown): string {
  const dir = absolutePath(input, 'kit 레포 경로');
  if (!fs.existsSync(dir)) throw new UserError(400, `폴더가 없다: ${dir}`);
  if (!fs.statSync(dir).isDirectory()) throw new UserError(400, `폴더가 아니다: ${dir}`);
  if (!fs.existsSync(path.join(dir, 'kit', 'kit.yaml'))) throw new UserError(400, `kit/kit.yaml이 없다 — kit 레포(예: jh-kit 클론)의 맨 위 폴더인지 확인: ${dir}`);
  if (!fs.existsSync(path.join(dir, 'build', 'claude-code'))) throw new UserError(400, `build/claude-code가 없다 — 그 레포에서 npm ci 후 npm run build: ${dir}`);
  return dir;
}

export function checkCloneDir(input: unknown): string {
  const dir = absolutePath(input, 'clone 폴더');
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) throw new UserError(400, `폴더가 아니다: ${dir}`);
  return dir;
}
