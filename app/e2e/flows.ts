// 브라우저 흐름 확인 (실패하면 종료 코드 1). 버그 3·4: 틀린 kit 경로는 저장 전에 거부되고 상단도 그대로,
// 올바른 경로를 저장하면 새로고침 없이 상단 버전 표시가 바뀐다.
// 쓰는 법: npm run e2e -- <kit 레포 경로>   (build/claude-code 가 있는 kit 레포. 없으면 가짜 kit을 만들어 쓴다)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createHandler, listen } from '../server/app.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plenum-flows-'));
let kitRepo = process.argv[2] ? path.resolve(process.argv[2]) : '';
if (!kitRepo) {
  kitRepo = path.join(root, '홍길동 kit');
  for (const d of ['kit/workers', 'build/claude-code/.claude-plugin']) fs.mkdirSync(path.join(kitRepo, d), { recursive: true });
  fs.writeFileSync(path.join(kitRepo, 'kit', 'kit.yaml'), 'name: demo-kit\nversion: "0.0.1"\ndescription: d\ntargets: [claude-code]\nstages: [구현]\ntiers:\n  - {tier: Sonnet medium, label: x, role: y}\n');
  fs.writeFileSync(path.join(kitRepo, 'kit', 'providers.yaml'), 'providers:\n  - id: claude\n');
  fs.writeFileSync(path.join(kitRepo, 'kit', 'workers', 'w.md'), '---\nname: w\ndescription: d\ntools: Read\nmodel: sonnet\neffort: medium\nmaxTurns: 5\nprovider: claude\nlabel: x\nstage: 구현\nsummary: "s"\n---\n본문\n');
  fs.writeFileSync(path.join(kitRepo, 'build', 'claude-code', '.claude-plugin', 'plugin.json'), '{"name":"demo-kit","version":"0.0.1"}\n');
}
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'no-claude'); // 설치본 없음
const { server, port } = await listen(createHandler({ cfgDir: path.join(root, 'cfg') }), 0);
const browser = await chromium.launch();
const page = await browser.newPage();
try {
  await page.goto(`http://127.0.0.1:${port}/#/settings/kit`);
  const version = page.getByTestId('version');
  await version.waitFor();
  assert.match(await version.innerText(), /지정 안 됨/);

  await page.getByLabel('kit 레포 경로').fill('KJH-code/jh-kit');
  await page.getByRole('button', { name: '저장' }).click();
  const status = page.getByRole('status');
  await status.waitFor();
  assert.match(await status.innerText(), /owner\/repo 꼴이다/, '틀린 경로가 거부되지 않았다');
  assert.match(await version.innerText(), /지정 안 됨/);

  await page.getByLabel('kit 레포 경로').fill(kitRepo);
  await page.getByRole('button', { name: '저장' }).click();
  await page.waitForFunction(() => /소스/.test(document.querySelector('[data-testid=version]')?.textContent || ''), null, { timeout: 5000 });
  const text = await version.innerText();
  assert.match(text, /소스\s*\d/, `새로고침 없이 바뀌지 않았다: ${text}`);
  assert.match(text, /설치본 못 찾음/);
  console.log('flows 통과:', text.replace(/\s+/g, ' '));
} finally {
  await browser.close();
  server.close();
}
