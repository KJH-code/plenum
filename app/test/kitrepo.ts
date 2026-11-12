// 저장 파이프라인 테스트용 kit 레포: 로컬 bare 원격 + clone (네트워크 없이 진짜 git fetch·push).
// 경로에 한글·공백을 일부러 넣는다. 다른 테스트·e2e 에서도 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP, copyDir, git, tmpDir } from './helpers.ts';

export const PLENUM_ROOT = path.join(APP, '..');
export const FIXTURE_KIT = path.join(PLENUM_ROOT, 'compiler', 'test', 'fixtures', 'kit');

const IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

// 서버 쪽 git commit 이 작성자 정보 없이 실패하지 않게 테스트 프로세스 env 에 넣는다. 돌려놓는 함수를 돌려준다
export function setGitIdentity(): () => void {
  const saved = Object.fromEntries(Object.keys(IDENTITY).map((k) => [k, process.env[k]]));
  Object.assign(process.env, IDENTITY);
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

const PACKAGE_JSON = '{\n  "name": "demo-kit",\n  "version": "0.0.1",\n  "private": true\n}\n';
const PACKAGE_LOCK = `{
  "name": "demo-kit",
  "version": "0.0.1",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "demo-kit",
      "version": "0.0.1"
    }
  }
}
`;

// kit 레포 안 node_modules/plenum (이 레포의 컴파일러) + js-yaml·argparse
export function installCompiler(repo: string) {
  const nm = path.join(repo, 'node_modules');
  const plenum = path.join(nm, 'plenum');
  copyDir(path.join(PLENUM_ROOT, 'bin'), path.join(plenum, 'bin'));
  fs.mkdirSync(path.join(plenum, 'compiler'), { recursive: true });
  for (const e of fs.readdirSync(path.join(PLENUM_ROOT, 'compiler'), { withFileTypes: true })) {
    const s = path.join(PLENUM_ROOT, 'compiler', e.name);
    if (e.isFile()) fs.copyFileSync(s, path.join(plenum, 'compiler', e.name));
    else if (e.isDirectory() && e.name !== 'test') copyDir(s, path.join(plenum, 'compiler', e.name));
  }
  fs.copyFileSync(path.join(PLENUM_ROOT, 'package.json'), path.join(plenum, 'package.json'));
  for (const dep of ['js-yaml', 'argparse']) {
    const src = path.join(PLENUM_ROOT, 'node_modules', dep);
    if (fs.existsSync(src)) copyDir(src, path.join(nm, dep));
  }
}

// kit 레포 루트에서 컴파일 (npm run build 와 같음)
export function compile(repo: string) {
  execFileSync(process.execPath, [path.join(repo, 'node_modules', 'plenum', 'bin', 'plenum-compile')], { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
}

export interface KitRepo {
  root: string;      // <tmp>/홍길동 홈/jh kit
  repo: string;      // 앱이 쓰는 clone
  remote: string;    // bare 원격 (main)
  other(): string;   // 두 번째 clone (부를 때마다 새로)
  git(...args: string[]): string;   // repo 에서
  head(dir?: string): string;
  remoteHead(): string;
  porcelain(dir?: string): string;
  // dir(clone)에서 파일을 쓰고 커밋 (push 는 하지 않음)
  commitFile(dir: string, rel: string, content: string, message: string): string;
}

export function makeKitRepo(opts: { setup?: (repo: string) => void } = {}): KitRepo {
  const root = path.join(tmpDir('plenum-kit-'), '홍길동 홈', 'jh kit');
  fs.mkdirSync(root, { recursive: true });
  const remote = path.join(root, 'remote.git');
  const repo = path.join(root, 'jh-kit 클론');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);

  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  copyDir(FIXTURE_KIT, path.join(repo, 'kit'));
  fs.writeFileSync(path.join(repo, 'package.json'), PACKAGE_JSON);
  fs.writeFileSync(path.join(repo, 'package-lock.json'), PACKAGE_LOCK);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  installCompiler(repo);
  if (opts.setup) opts.setup(repo);
  compile(repo);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', '처음');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '-u', 'origin', 'main');

  let n = 0;
  const kr: KitRepo = {
    root, repo, remote,
    other() {
      const dir = path.join(root, `다른 클론 ${++n}`);
      git(root, 'clone', '-q', remote, dir);
      return dir;
    },
    git: (...args) => git(repo, ...args),
    head: (dir = repo) => git(dir, 'rev-parse', 'HEAD').trim(),
    remoteHead: () => git(remote, 'rev-parse', 'refs/heads/main').trim(),
    porcelain: (dir = repo) => git(dir, 'status', '--porcelain'),
    commitFile(dir, rel, content, message) {
      const f = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
      git(dir, 'add', '--', rel);
      git(dir, 'commit', '-q', '-m', message);
      return git(dir, 'rev-parse', 'HEAD').trim();
    },
  };
  return kr;
}
