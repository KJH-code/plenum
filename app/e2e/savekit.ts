// e2e·스크린샷용 저장 장면 준비: makeKitRepo(bare 원격 + 컴파일러 든 kit 레포) + 가짜 claude + 임시 CLAUDE_CONFIG_DIR.
// 진짜 kit 레포·진짜 ~/.claude·진짜 claude 는 건드리지 않는다. 이 프로세스의 env 를 바꾼다(서버가 같은 프로세스).
import fs from 'node:fs';
import path from 'node:path';
import { copyDir, git, tmpDir } from '../test/helpers.ts';
import { makeKitRepo, setGitIdentity, type KitRepo } from '../test/kitrepo.ts';
import { makeFakeClaude, type FakeClaude } from '../test/fakeclaude.ts';
import type { Command, LaunchResult } from '../server/open.ts';

export interface SaveKit {
  kr: KitRepo;
  fake: FakeClaude;
  claudeHome: string;
  opened: Command[];                                   // 외부 에디터로 연 명령 (가짜 launcher 가 모은다)
  launcher: (c: Command, kind: 'folder' | 'editor') => Promise<LaunchResult>;
  useFakeClaude(): void;                               // PATH 앞에 가짜 claude, CLAUDE_CONFIG_DIR 은 임시
  setInstallVersion(v: string): void;                  // 가짜 plugin update 가 설치할 버전
  installAsSource(): void;                             // 설치본 = 지금 build/claude-code (같음 상태)
  pushTo(url: string | null): void;                    // origin 의 push 주소만 바꾼다 (null 이면 원래대로)
  divergedRemote(): string;                            // 원격과 갈라진 bare 레포 (push 거부 장면용)
}

export function prepareSaveKit(): SaveKit {
  setGitIdentity();
  // 계층 표: Opus medium 을 더해 sonnet → opus 저장이 통과하게, Sonnet high 는 일부러 없다(ERROR 장면).
  // 모드 표: orchestrate(기본)를 더해 "쓰는 모드" 안내가 비지 않게
  const kr = makeKitRepo({
    setup(repo) {
      const y = path.join(repo, 'kit', 'kit.yaml');
      fs.writeFileSync(y, fs.readFileSync(y, 'utf8').replace('worker_order:', '  - tier: Opus medium\n    label: "Opus medium"\n    role: "구현"\nworker_order:'));
      fs.copyFileSync(path.join(repo, 'kit', 'modes', 'demo.yaml'), path.join(repo, 'kit', 'modes', 'orchestrate.yaml'));
    },
  });
  git(kr.repo, 'config', 'user.email', 'e2e@example.com');
  const root = tmpDir('plenum-e2e-claude-');
  const claudeHome = path.join(root, 'claude home');
  fs.mkdirSync(claudeHome, { recursive: true });
  const fake = makeFakeClaude(path.join(root, 'fake'));
  const opened: Command[] = [];
  const launcher = async (c: Command) => { opened.push(c); return { ok: true } as const; };
  return {
    kr, fake, claudeHome, opened, launcher,
    useFakeClaude() {
      const env = fake.env({ mode: 'ok', configDir: claudeHome });
      process.env.PATH = `${fake.binDir}${path.delimiter}${process.env.PATH}`;
      for (const k of ['CLAUDE_CONFIG_DIR', 'FAKE_CLAUDE_MODE', 'FAKE_CLAUDE_LOG']) process.env[k] = env[k];
    },
    setInstallVersion(v) { process.env.FAKE_CLAUDE_VERSION = v; },
    installAsSource() {
      const version = /^version:\s*"?([\d.]+)"?/m.exec(fs.readFileSync(path.join(kr.repo, 'kit', 'kit.yaml'), 'utf8'))![1];
      const installPath = path.join(claudeHome, 'plugins', 'cache', 'kjh-code', 'demo-kit', version);
      copyDir(path.join(kr.repo, 'build', 'claude-code'), installPath);
      fs.writeFileSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
        version: 2,
        plugins: { 'demo-kit@kjh-code': [{ scope: 'user', installPath, version, installedAt: 'x', lastUpdated: 'x', gitCommitSha: 'x' }] },
      }));
    },
    pushTo(url) {
      if (url) git(kr.repo, 'remote', 'set-url', '--push', 'origin', url);
      else git(kr.repo, 'config', '--unset', 'remote.origin.pushurl');
    },
    divergedRemote() {
      const other = kr.other();
      const bare = path.join(kr.root, `갈라진 원격 ${Date.now()}.git`);
      git(kr.root, 'clone', '-q', '--bare', kr.remote, bare);
      kr.commitFile(other, 'README.md', '다른 세션\n', '다른 세션 커밋');
      git(other, 'push', '-q', bare, 'HEAD:main');
      return bare;
    },
  };
}
