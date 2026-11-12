// V10: 설치본 없음 / 같음 / 내용 다름 / 버전 다름
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { compareVersions, treeHash } from '../server/versions.ts';
import { tmpDir } from './helpers.ts';

function setup() {
  const root = tmpDir();
  const repo = path.join(root, 'kit-repo');
  const build = path.join(repo, 'build', 'claude-code');
  fs.mkdirSync(path.join(build, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(build, 'agents'));
  fs.writeFileSync(path.join(build, '.claude-plugin', 'plugin.json'), '{"name":"jh-kit","version":"2.1.1"}\n');
  fs.writeFileSync(path.join(build, 'agents', 'a.md'), '에이전트\n');
  const home = path.join(root, '.claude');
  const installPath = path.join(home, 'plugins', 'cache', 'kjh-code', 'jh-kit', '2.1.1');
  return { root, repo, build, home, installPath };
}
function install(home: string, installPath: string, from: string, version = '2.1.1') {
  fs.cpSync(from, installPath, { recursive: true });
  fs.writeFileSync(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { 'jh-kit@kjh-code': [{ scope: 'user', installPath, version, installedAt: 'x', lastUpdated: 'x', gitCommitSha: 'x' }] },
  }));
}
const kit = { name: 'jh-kit', version: '2.1.1' };

describe('버전 비교', () => {
  test('설치본 없음 → 설치본 못 찾음', () => {
    const s = setup();
    const v = compareVersions(s.repo, kit, { CLAUDE_CONFIG_DIR: s.home });
    expect(v.status).toBe('unknown');
    expect(v.installed).toBeNull();
    expect(v.installedProblem).toBe('설치본 못 찾음');
    expect(v.source).toMatchObject({ version: '2.1.1', files: 2 });
  });

  test('같은 내용을 설치 → 같음', () => {
    const s = setup();
    install(s.home, s.installPath, s.build);
    const v = compareVersions(s.repo, kit, { CLAUDE_CONFIG_DIR: s.home });
    expect(v.status).toBe('same');
    expect(v.installed!.hash).toBe(v.source!.hash);
  });

  test('파일 1바이트가 다르면 → 내용 다름', () => {
    const s = setup();
    install(s.home, s.installPath, s.build);
    fs.appendFileSync(path.join(s.installPath, 'agents', 'a.md'), 'x');
    expect(compareVersions(s.repo, kit, { CLAUDE_CONFIG_DIR: s.home }).status).toBe('content-differs');
  });

  test('파일 하나가 더 있어도 → 내용 다름, 버전이 다르면 → 버전 다름', () => {
    const s = setup();
    install(s.home, s.installPath, s.build);
    fs.writeFileSync(path.join(s.installPath, 'extra.md'), '');
    expect(compareVersions(s.repo, kit, { CLAUDE_CONFIG_DIR: s.home }).status).toBe('content-differs');
    const s2 = setup();
    install(s2.home, s2.installPath, s2.build, '2.1.0');
    expect(compareVersions(s2.repo, kit, { CLAUDE_CONFIG_DIR: s2.home }).status).toBe('version-differs');
  });

  test('트리 해시는 권한 비트를 보지 않고 경로·내용만 본다', () => {
    const s = setup();
    const h1 = treeHash(s.build)!.hash;
    fs.chmodSync(path.join(s.build, 'agents', 'a.md'), 0o755);
    expect(treeHash(s.build)!.hash).toBe(h1);
    fs.renameSync(path.join(s.build, 'agents', 'a.md'), path.join(s.build, 'agents', 'b.md'));
    expect(treeHash(s.build)!.hash).not.toBe(h1);
  });

  test('줄바꿈만 다르면 → 줄바꿈만 다름, CR이 든 쪽을 센다 (버그 5)', () => {
    const s = setup();
    install(s.home, s.installPath, s.build);
    fs.writeFileSync(path.join(s.build, 'agents', 'a.md'), '에이전트\r\n');
    const v = compareVersions(s.repo, kit, { CLAUDE_CONFIG_DIR: s.home });
    expect(v.status).toBe('eol-differs');
    expect(v.source!.crFiles).toBe(1);
    expect(v.installed!.crFiles).toBe(0);
    // 내용까지 다르면 줄바꿈만 다른 게 아니다
    fs.writeFileSync(path.join(s.build, 'agents', 'a.md'), '다른 내용\r\n');
    expect(compareVersions(s.repo, kit, { CLAUDE_CONFIG_DIR: s.home }).status).toBe('content-differs');
  });

  test('바이너리 파일(NUL 포함)은 CR이 있어도 바꾸지 않는다', () => {
    const s = setup();
    fs.writeFileSync(path.join(s.build, 'bin.dat'), Buffer.from([0, 13, 10, 1]));
    const t = treeHash(s.build)!;
    expect(t.crFiles).toBe(0);
    expect(t.lfHash).toBe(t.hash);
  });
});
