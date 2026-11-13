// 다크 화면 스크린샷 (V12). 임시 설정으로 서버를 띄우고 장면마다 찍는다.
// 쓰는 법: npm run screens -- <kit 레포 경로> [출력 폴더]   (CLAUDE_CONFIG_DIR 로 설치본 위치를 바꿀 수 있다)
// kit 레포 경로가 없으면(기본 ../../jh-kit) makeKitRepo 로 만든 레포를 쓴다.
// 워커 저장 장면(6~)은 인자 kit 레포가 아니라 언제나 makeKitRepo 로 만든 레포·가짜 claude·임시 CLAUDE_CONFIG_DIR 로 찍는다
// (진짜 레포에 commit·push 하지 않는다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createHandler, listen } from '../server/app.ts';
import { prepareSaveKit } from './savekit.ts';
import { makeFakeStreamClaude } from '../test/fakeclaudeStream.ts';
import { copyHistory, limitScript, REC, unknownScript } from './chatfix.ts';

const sk = prepareSaveKit();
const argKit = path.resolve(process.argv[2] || path.join(process.cwd(), '..', '..', 'jh-kit'));
const kitRepo = fs.existsSync(path.join(argKit, 'kit', 'kit.yaml')) ? argKit : sk.kr.repo;
if (kitRepo !== argKit) console.log(`kit 레포가 없어서(${argKit}) makeKitRepo 레포로 찍는다`);
const outDir = path.resolve(process.argv[3] || path.join(process.cwd(), 'screens'));
fs.mkdirSync(outDir, { recursive: true });

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plenum-screens-'));
const notGit = path.join(root, '홍길동 테스트', '영상 편집');
fs.mkdirSync(notGit, { recursive: true });
const empty = path.join(root, '빈 레포');
fs.mkdirSync(empty);
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: empty });

const cfgDir = path.join(root, 'cfg');
const handler = createHandler({ cfgDir, launcher: sk.launcher });
const { server, port } = await listen(handler, 0);
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
const builder = page.getByRole('button', { name: 'su-builder', exact: true });
await (await builder.count() ? builder : page.getByTestId('worker-row').first().getByRole('button')).click();
await page.getByTestId('editor-name').waitFor();
await page.getByTestId('remote-line').filter({ hasNotText: '확인 중' }).waitFor({ timeout: 60000 });
await shot('3-settings-workers.png', true);

await page.goto(`${base}/#/project/${encodeURIComponent(kitP.id)}`);
await page.getByRole('button', { name: '새 세션' }).waitFor();
await shot('4-project.png');

await page.goto(`${base}/#/`);
await page.getByRole('button', { name: '프로젝트 추가' }).first().click();
await page.getByRole('tab', { name: '로컬 폴더에서' }).click();
await page.getByLabel('폴더 경로').fill(notGit);
await page.getByRole('button', { name: '확인' }).click();
await page.getByRole('region', { name: '감지 결과' }).waitFor();
await shot('5-add-korean-path.png');

// ── 워커 저장 장면: makeKitRepo 레포 + 가짜 claude ──
const T = { timeout: 60000 };
await post('/api/settings', { kitRepoPath: sk.kr.repo, editorCommand: process.execPath }, 'PUT');
sk.useFakeClaude();
sk.installAsSource();
const row = (name: string) => page.getByTestId('worker-row').filter({ has: page.getByRole('button', { name, exact: true }) });
const model = page.getByLabel('AI', { exact: true });
const effort = page.getByLabel('노력도', { exact: true });
const run = page.getByTestId('save-run');
const jobId = () => page.evaluate(() => document.querySelector('[data-testid=save-run]')?.getAttribute('data-job-id') ?? null);
// 이전 결과 패널이 남아 있어도 넘어가지 않게: job id 가 바뀐 새 저장이 끝날 때까지
const settled = (prev: string | null) => page.waitForFunction((prev) => {
      const el = document.querySelector('[data-testid=save-run]');
      const s = el?.getAttribute('data-status');
      return !!el && el.getAttribute('data-job-id') !== prev && !!s && s !== 'running';
    }, prev, T);
const remoteSame = () => page.getByTestId('remote-line').filter({ hasText: '원격 main과 같음' }).waitFor(T);

await page.goto(`${base}/#/settings/workers`);
await page.reload();
await page.getByTestId('version').filter({ hasText: '같음' }).waitFor(T);
await remoteSame();
await row('rev').click();
await effort.selectOption('high');
await row('impl').click();
await model.selectOption('opus');
await shot('6-worker-editing.png', true);

await model.selectOption('fable');
await page.getByTestId('fable-warn').waitFor();
await shot('6b-worker-fable-warning.png', true);
await model.selectOption('opus');
await row('rev').click();
await page.getByRole('button', { name: '되돌리기' }).click();
await row('impl').click();

await page.getByRole('button', { name: '저장…' }).click();
await page.getByTestId('save-dialog').waitFor(T);
await shot('7-save-confirm.png');

let prev = await jobId();
await page.getByRole('button', { name: 'commit · push' }).click();
await run.waitFor(T);
if (await run.getAttribute('data-status') === 'running') await shot('8-save-running.png', true);
else console.log('8-save-running.png: 저장이 너무 빨리 끝나 진행 중 장면을 못 찍었다');
await settled(prev);
sk.setInstallVersion('0.0.2');
await page.getByRole('button', { name: '설치본에 반영' }).click();
await page.waitForFunction(() => /ok|fail/.test(document.querySelector('[data-testid=install-result]')?.getAttribute('data-status') || ''), null, T);
await page.getByTestId('version').filter({ hasText: '같음' }).waitFor(T);
await page.getByTestId('install-result').locator('details').first().evaluate((d) => { (d as HTMLDetailsElement).open = true; });
await shot('9-save-done-installed.png', true);
await page.getByRole('button', { name: '닫기' }).click();

await remoteSame();
await row('impl').click();
await model.selectOption('sonnet');
await effort.selectOption('high');
await page.getByRole('button', { name: '저장…' }).click();
prev = await jobId();
await page.getByRole('button', { name: 'commit · push' }).click();
await settled(prev);
await page.getByTestId('save-failed').waitFor(T);
await shot('10-build-error.png', true);
await page.getByRole('button', { name: '되돌리기' }).click();
await page.getByRole('button', { name: '닫기' }).click();

// push 거부: origin 의 push 주소만 원격과 갈라진 bare 레포로 돌려 둔다 (서버 코드는 그대로)
sk.pushTo(sk.divergedRemote());
await row('rev').click();
await effort.selectOption('medium');
await page.getByRole('button', { name: '저장…' }).click();
prev = await jobId();
await page.getByRole('button', { name: 'commit · push' }).click();
await settled(prev);
await page.getByTestId('push-failed').waitFor(T);
await shot('11-push-failed.png', true);
await page.getByRole('button', { name: '커밋 취소' }).click();
await page.getByTestId('save-cancelled').waitFor(T);
sk.pushTo(null);

// 설정 › kit: 소스와 설치본 버전이 다를 때 반영 버튼
// 설치본을 옛 버전으로 돌린다 (installed_plugins.json 버전만)
const ip = path.join(sk.claudeHome, 'plugins', 'installed_plugins.json');
const data = JSON.parse(fs.readFileSync(ip, 'utf8'));
data.plugins['demo-kit@kjh-code'][0].version = '0.0.1';
fs.writeFileSync(ip, JSON.stringify(data));
await page.goto(`${base}/#/settings/kit`);
await page.reload();
await page.getByTestId('install-panel').waitFor(T);
await shot('12-kit-version-differs.png', true);

// ── 채팅 장면 (13~17): 가짜 claude stream 모드로 녹화 재생. 지난 세션은 진짜 기록 fixture 를 이 프로젝트로 복사 ──
const stream = makeFakeStreamClaude(path.join(root, '가짜 stream'));
process.env.PATH = `${stream.binDir}${path.delimiter}${process.env.PATH}`; // 설치용 가짜 claude 보다 앞에
for (const sid of ['279fe3c2-3715-4f89-ac82-284e5c2f6842', '9b9b276d-f1e7-4c81-82c9-d87128a70e31', '4b6b568b-6d83-4d93-ba05-7c608b2d16f6']) {
  copyHistory(process.env.CLAUDE_CONFIG_DIR!, notGit, '-tmp-plenum-rec-----AbCdEf', sid);
}
const useScript = (f: string) => { process.env.FAKE_STREAM_SCRIPT = f; };
const sendChat = async (t: string) => {
  await page.getByLabel('메시지', { exact: true }).fill(t);
  await page.locator('.composer').getByRole('button', { name: '보내기' }).click();
};
const newSession = () => page.getByRole('button', { name: '새 세션' }).click();
const perm = (cmd: string) => page.getByTestId('permission-card').filter({ hasText: cmd });
await page.goto(`${base}/#/project/${encodeURIComponent(ngP.id)}`);
await page.getByRole('button', { name: '새 세션' }).waitFor(T);

useScript(REC('01-cards.jsonl'));
await newSession();
await sendChat('a.txt 와 c.txt 를 만들고 a.txt 를 지워줘');
await page.getByTestId('question-card').getByRole('button', { name: /^a\.txt/ }).waitFor(T);
await shot('13-chat-question.png');

await page.getByTestId('question-card').getByRole('button', { name: /^a\.txt/ }).click();
await perm('touch a.txt').getByRole('button', { name: '허용', exact: true }).click(T);
await perm('touch c.txt').getByRole('button', { name: /이 세션 동안/ }).waitFor(T);
await perm('touch c.txt').getByRole('button', { name: '거부…' }).click();
await page.getByLabel('거부 이유').fill('테스트는 내가 돌릴게');
await page.getByLabel('거부 이유').evaluate((el) => el.scrollIntoView({ block: 'center' }));
await shot('14-chat-permission-deny.png');
await perm('touch c.txt').getByRole('button', { name: /이 세션 동안/ }).click();
await perm('rm a.txt').getByRole('button', { name: '거부…' }).click(T);
await page.getByLabel('거부 이유').fill('삭제는 내가 직접 할게');
await perm('rm a.txt').getByRole('button', { name: '거부 보내기' }).click();
await page.getByTestId('assistant-text').filter({ hasText: 'Not done' }).waitFor(T);

useScript(REC('04-agents.jsonl'));
await newSession();
await sendChat('워커 두 개를 띄워서 파일 수를 세고 인사해줘');
await page.waitForFunction(() => {
  const rows = [...document.querySelectorAll('[data-testid=worker-run]')];
  return rows.length === 2 && rows.every((e) => e.getAttribute('data-state') === 'done');
}, null, T);
await page.getByTestId('assistant-text').filter({ hasText: 'ALL DONE' }).waitFor(T);
await shot('15-chat-done-workers.png');

const unk = path.join(root, 'unknown.jsonl');
unknownScript(unk);
useScript(unk);
await newSession();
await sendChat('새 형식 요청');
await page.getByTestId('unknown-card').waitFor(T);
await shot('16-chat-unknown.png');

// 한도 장면은 마지막에 (limits.json 에 남아 이후 보내기를 막는다)
const lim = path.join(root, 'limit.jsonl');
limitScript(lim, Math.floor(Date.now() / 1000) + 3600);
useScript(lim);
await newSession();
await sendChat('한도 확인');
await page.getByTestId('limit-rejected').waitFor(T);
await shot('17-chat-limit.png');

await (handler as any).chats.shutdownAll().catch(() => {});
await browser.close();
server.close();
console.log(`ids: kit=${kitP.id} notGit=${ngP.id}`);
