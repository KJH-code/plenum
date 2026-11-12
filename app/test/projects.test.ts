// V8·V9: git 감지, clone, 목록에서 빼기, CLAUDE.md, 열기 명령 — 한글·공백 경로로
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { editorCommand, folderCommand, type Command } from '../server/open.ts';
import { parseGitHubUrl } from '../server/git.ts';
import { git, inProcess, tmpDir } from './helpers.ts';

let root: string;
let srv: Awaited<ReturnType<typeof inProcess>>;
const launched: Command[] = [];
let bare: string;

beforeAll(async () => {
  root = path.join(tmpDir(), '홍길동 홈');
  fs.mkdirSync(root);
  // GitHub 주소를 로컬 bare 레포로 돌려 보낸다 (git url.<base>.insteadOf — 네트워크 없이 진짜 git clone)
  bare = path.join(root, 'bare', 'demo.git');
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'CLAUDE.md'), '# 데모\n한글 CLAUDE.md\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', '첫 커밋');
  git(root, 'clone', '-q', '--bare', seed, bare);
  process.env.GIT_CONFIG_COUNT = '1';
  process.env.GIT_CONFIG_KEY_0 = `url.${bare}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/test-owner/demo';

  srv = await inProcess({ cfgDir: path.join(root, 'cfg'), launcher: async (c) => { launched.push(c); return { ok: true }; } });
  await srv.call('PUT', '/api/settings', { cloneDir: path.join(root, 'Documents', 'GitHub') });
});
afterAll(async () => {
  await srv.close();
  delete process.env.GIT_CONFIG_COUNT; delete process.env.GIT_CONFIG_KEY_0; delete process.env.GIT_CONFIG_VALUE_0;
});

describe('감지', () => {
  test('.git 없는 폴더 = git 아님, 한글·공백 경로 그대로', async () => {
    const dir = path.join(root, '홍길동 테스트', '영상 편집');
    fs.mkdirSync(dir, { recursive: true });
    const r = await srv.call('POST', '/api/projects', { kind: 'local', path: dir });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: '영상 편집', path: dir, source: 'local' });
    expect(r.body.detection).toMatchObject({ exists: true, git: 'none', github: null, hasClaudeMd: false });
  });

  test('커밋 0개 레포 = 커밋 없음', async () => {
    const dir = path.join(root, '빈 레포');
    fs.mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    const r = await srv.call('POST', '/api/projects', { kind: 'local', path: dir });
    expect(r.body.detection).toMatchObject({ git: 'empty', branch: 'main' });
  });

  test('커밋 있고 GitHub 원격 있는 레포', async () => {
    const dir = path.join(root, '깃 레포');
    fs.mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'dev');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'a');
    git(dir, 'remote', 'add', 'origin', 'git@github.com:KJH-code/plenum.git');
    const r = await srv.call('POST', '/api/projects', { kind: 'local', path: dir });
    expect(r.body.detection).toMatchObject({ git: 'ok', branch: 'dev', github: { owner: 'KJH-code', repo: 'plenum', url: 'https://github.com/KJH-code/plenum' } });
  });

  test('같은 폴더를 두 번 넣으면 409, 없는 폴더는 400', async () => {
    const dir = path.join(root, '홍길동 테스트', '영상 편집');
    expect((await srv.call('POST', '/api/projects', { kind: 'local', path: dir })).status).toBe(409);
    expect((await srv.call('POST', '/api/projects', { kind: 'local', path: path.join(root, '없음') })).status).toBe(400);
  });
});

describe('GitHub clone', () => {
  test('주소 형식', () => {
    expect(parseGitHubUrl('https://github.com/KJH-code/jh-kit')).toMatchObject({ owner: 'KJH-code', repo: 'jh-kit' });
    expect(parseGitHubUrl('https://github.com/KJH-code/jh-kit.git')).toMatchObject({ repo: 'jh-kit' });
    expect(parseGitHubUrl('git@github.com:KJH-code/jh-kit.git')).toMatchObject({ repo: 'jh-kit' });
    expect(parseGitHubUrl('https://gitlab.com/a/b')).toBeNull();
    expect(parseGitHubUrl('https://github.com/a/..')).toBeNull();
    expect(parseGitHubUrl('https://github.com/a/b; rm -rf /')).toBeNull();
  });

  test('clone 위치는 <clone 폴더>/<레포>, clone 후 목록에 들어가고 CLAUDE.md를 읽는다', async () => {
    const t = await srv.call('POST', '/api/clone-target', { url: 'https://github.com/test-owner/demo' });
    expect(t.body.dest).toBe(path.join(root, 'Documents', 'GitHub', 'demo'));
    const r = await srv.call('POST', '/api/projects', { kind: 'github', url: 'https://github.com/test-owner/demo' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ name: 'demo', source: 'github', url: 'https://github.com/test-owner/demo', path: t.body.dest });
    expect(r.body.detection).toMatchObject({ git: 'ok', branch: 'main', hasClaudeMd: true });
    const doc = await srv.call('GET', `/api/projects/${r.body.id}/claude-md`);
    expect(doc.body.text).toBe('# 데모\n한글 CLAUDE.md\n');
  });

  test('clone할 폴더가 이미 있으면 409, clone 실패는 메시지', async () => {
    expect((await srv.call('POST', '/api/projects', { kind: 'github', url: 'https://github.com/test-owner/demo' })).status).toBe(409);
    const bad = await srv.call('POST', '/api/projects', { kind: 'github', url: 'https://github.com/test-owner/no-such-repo-xyz' });
    expect(bad.status).toBe(502);
    expect(bad.body.error).toMatch(/^clone 실패: /);
    expect(fs.existsSync(path.join(root, 'Documents', 'GitHub', 'no-such-repo-xyz'))).toBe(false);
    expect((await srv.call('POST', '/api/projects', { kind: 'github', url: 'https://example.com/x' })).status).toBe(400);
  });
});

describe('동작', () => {
  test('폴더 열기·에디터는 한글 경로를 인자 하나로 넘긴다', async () => {
    const list = (await srv.call('GET', '/api/projects')).body;
    const p = list.find((x: any) => x.name === '영상 편집');
    launched.length = 0;
    expect((await srv.call('POST', `/api/projects/${p.id}/open-folder`)).status).toBe(200);
    expect((await srv.call('POST', `/api/projects/${p.id}/open-editor`)).status).toBe(200);
    expect(launched[0]).toEqual(folderCommand(p.path));
    expect(launched[0].args).toEqual([p.path]);
    expect(launched[1]).toEqual(editorCommand('code', p.path));
  });

  test('Windows 명령 모양 (C:\\Users\\홍길동)', () => {
    const dir = 'C:\\Users\\홍길동\\Documents\\GitHub\\영상 편집';
    expect(folderCommand(dir, 'win32')).toEqual({ cmd: 'explorer.exe', args: [dir] });
    expect(editorCommand('code', dir, 'win32')).toEqual({ cmd: 'cmd.exe', args: ['/d', '/s', '/c', `""code" "${dir}""`], verbatim: true });
    expect(folderCommand('/a b', 'darwin')).toEqual({ cmd: 'open', args: ['/a b'] });
    expect(() => editorCommand('code', 'C:\\a"b', 'win32')).toThrow();
  });

  test('CLAUDE.md 없으면 404', async () => {
    const list = (await srv.call('GET', '/api/projects')).body;
    const p = list.find((x: any) => x.name === '영상 편집');
    expect((await srv.call('GET', `/api/projects/${p.id}/claude-md`)).status).toBe(404);
  });

  test('목록에서 빼면 목록에서만 사라지고 폴더와 안의 파일은 그대로', async () => {
    const list = (await srv.call('GET', '/api/projects')).body;
    const p = list.find((x: any) => x.name === 'demo');
    expect((await srv.call('DELETE', `/api/projects/${p.id}`)).status).toBe(200);
    const after = (await srv.call('GET', '/api/projects')).body;
    expect(after.some((x: any) => x.id === p.id)).toBe(false);
    expect(after.length).toBe(list.length - 1);
    expect(fs.existsSync(path.join(p.path, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(p.path, '.git'))).toBe(true);
    expect((await srv.call('DELETE', `/api/projects/${p.id}`)).status).toBe(404);
  });
});
