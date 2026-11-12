// 버그 3: 상대 경로·owner/repo·kit 아닌 폴더는 저장 전에 거부하고, 하나라도 틀리면 아무것도 저장하지 않는다
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { inProcess, tmpDir } from './helpers.ts';

let srv: Awaited<ReturnType<typeof inProcess>>;
let kit: string;
beforeAll(async () => {
  const root = tmpDir();
  srv = await inProcess({ cfgDir: path.join(root, 'cfg') });
  kit = path.join(root, '홍길동 kit');
  fs.mkdirSync(path.join(kit, 'kit'), { recursive: true });
  fs.writeFileSync(path.join(kit, 'kit', 'kit.yaml'), 'name: x\n');
});
afterAll(() => srv.close());

const put = (body: unknown) => srv.call('PUT', '/api/settings', body);

test('owner/repo 꼴은 이유와 함께 거부, 저장 안 됨', async () => {
  const r = await put({ kitRepoPath: 'KJH-code/jh-kit' });
  expect(r.status).toBe(400);
  expect(r.body.error).toMatch(/owner\/repo 꼴이다/);
  expect(r.body.error).toContain(path.join(os.homedir(), 'Documents', 'GitHub', 'jh-kit'));
  expect((await srv.call('GET', '/api/settings')).body.kitRepoPath).toBeNull();
});

test('상대 경로·URL은 거부', async () => {
  expect((await put({ kitRepoPath: 'jh-kit' })).body.error).toMatch(/상대 경로는 받지 않는다/);
  expect((await put({ kitRepoPath: './a/b' })).body.error).toMatch(/상대 경로/);
  expect((await put({ kitRepoPath: 'https://github.com/KJH-code/jh-kit' })).body.error).toMatch(/주소가 아니라/);
  expect((await put({ cloneDir: 'GitHub' })).body.error).toMatch(/상대 경로/);
  expect((await put({ kitRepoPath: '' })).status).toBe(400);
});

test('kit.yaml은 있는데 build/claude-code가 없으면 거부, 둘 다 있으면 저장', async () => {
  const r = await put({ kitRepoPath: kit });
  expect(r.status).toBe(400);
  expect(r.body.error).toMatch(/build\/claude-code가 없다/);
  fs.mkdirSync(path.join(kit, 'build', 'claude-code'), { recursive: true });
  const ok = await put({ kitRepoPath: `"${kit}"` }); // 탐색기에서 복사한 따옴표 붙은 경로도 받는다
  expect(ok.status).toBe(200);
  expect(ok.body.kitRepoPath).toBe(kit);
});

test('여러 칸 중 하나라도 틀리면 아무것도 안 바뀐다', async () => {
  const before = (await srv.call('GET', '/api/settings')).body;
  const r = await put({ cloneDir: path.join(tmpDir(), 'new'), kitRepoPath: 'nope/nope' });
  expect(r.status).toBe(400);
  expect((await srv.call('GET', '/api/settings')).body).toEqual(before);
});

test('~ 는 홈으로 펼친다 (clone 폴더)', async () => {
  const r = await put({ cloneDir: '~/plenum-test-clone-dir' });
  expect(r.status).toBe(200);
  expect(r.body.cloneDir).toBe(path.join(os.homedir(), 'plenum-test-clone-dir'));
});

test('로컬 프로젝트 추가·감지도 상대 경로를 거부', async () => {
  expect((await srv.call('POST', '/api/projects', { kind: 'local', path: 'some/folder' })).status).toBe(400);
  expect((await srv.call('POST', '/api/inspect', { path: 'folder' })).status).toBe(400);
});
