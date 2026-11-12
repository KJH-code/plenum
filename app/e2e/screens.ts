// 다크 화면 스크린샷 (V12). 임시 설정으로 서버를 띄우고 장면마다 찍는다.
// 쓰는 법: npm run screens -- <kit 레포 경로> [출력 폴더]   (CLAUDE_CONFIG_DIR 로 설치본 위치를 바꿀 수 있다)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createHandler, listen } from '../server/app.ts';

const kitRepo = path.resolve(process.argv[2] || path.join(process.cwd(), '..', '..', 'jh-kit'));
const outDir = path.resolve(process.argv[3] || path.join(process.cwd(), 'screens'));
fs.mkdirSync(outDir, { recursive: true });

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plenum-screens-'));
const notGit = path.join(root, '홍길동 테스트', '영상 편집');
fs.mkdirSync(notGit, { recursive: true });
const empty = path.join(root, '빈 레포');
fs.mkdirSync(empty);
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: empty });

const cfgDir = path.join(root, 'cfg');
const { server, port } = await listen(createHandler({ cfgDir }), 0);
const base = `http://127.0.0.1:${port}`;
const H = { 'Content-Type': 'application/json', 'X-Plenum': '1' };
const post = (url: string, body: unknown, method = 'POST') => fetch(base + url, { method, headers: H, body: JSON.stringify(body) }).then((r) => r.json());
await post('/api/settings', { kitRepoPath: kitRepo, cloneDir: path.join(root, 'Documents', 'GitHub') }, 'PUT');
const kitP = await post('/api/projects', { kind: 'local', path: kitRepo });
const ngP = await post('/api/projects', { kind: 'local', path: notGit });
await post('/api/projects', { kind: 'local', path: empty });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const shot = async (name: string, fullPage = false) => {
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(outDir, name), fullPage });
  console.log(path.join(outDir, name));
};

await page.goto(`${base}/#/`);
await page.getByTestId('version').waitFor();
await page.getByTestId('tile').first().waitFor();
await shot('1-home.png');

await page.getByTestId('tile').filter({ hasText: '영상 편집' }).click();
await page.getByText('git이 아니라서 절약~극한 모드는 끝까지 못 간다').first().waitFor();
await shot('2-home-not-git.png');

await page.goto(`${base}/#/settings/workers`);
await page.getByTestId('worker-row').first().waitFor();
await page.getByRole('button', { name: '펼치기: su-builder', exact: true }).click();
await page.getByTestId('worker-detail').waitFor();
await shot('3-settings-workers.png', true);

await page.goto(`${base}/#/project/${encodeURIComponent(kitP.id)}`);
await page.getByText('[오케스트레이터 채팅]').waitFor();
await shot('4-project.png');

await page.goto(`${base}/#/`);
await page.getByRole('button', { name: '프로젝트 추가' }).first().click();
await page.getByRole('tab', { name: '로컬 폴더에서' }).click();
await page.getByLabel('폴더 경로').fill(notGit);
await page.getByRole('button', { name: '확인' }).click();
await page.getByRole('region', { name: '감지 결과' }).waitFor();
await shot('5-add-korean-path.png');

await browser.close();
server.close();
console.log(`ids: kit=${kitP.id} notGit=${ngP.id}`);
