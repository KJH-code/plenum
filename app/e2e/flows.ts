// 브라우저 흐름 확인 (실패하면 종료 코드 1).
// 1) 버그 3·4: 틀린 kit 경로는 저장 전에 거부되고 상단도 그대로, 올바른 경로를 저장하면 새로고침 없이 상단 버전 표시가 바뀐다.
// 2) 설정 › 워커 저장 흐름: 행 선택 → 수정란 → 저장 확인창 → 검사·빌드·commit·push → 끝/실패 패널 → 설치본에 반영.
//    makeKitRepo(로컬 bare 원격) + 가짜 claude + 임시 CLAUDE_CONFIG_DIR 로만 돈다.
// 쓰는 법: npm run e2e [-- <kit 레포 경로>]
//   인자를 주면 1)만 그 레포로 확인한다(진짜 레포에 commit·push 하지 않게 2)는 건너뛴다).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { createHandler, listen } from '../server/app.ts';
import { git } from '../test/helpers.ts';
import { prepareSaveKit } from './savekit.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plenum-flows-'));
const argKit = process.argv[2] ? path.resolve(process.argv[2]) : '';
const sk = argKit ? null : prepareSaveKit();
const kitRepo = argKit || sk!.kr.repo;

process.env.CLAUDE_CONFIG_DIR = path.join(root, 'no-claude'); // 설치본 없음
const { server, port } = await listen(createHandler({ cfgDir: path.join(root, 'cfg'), ...(sk ? { launcher: sk.launcher } : {}) }), 0);
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const T = { timeout: 30000 };

const ok: string[] = [];
const pass = (s: string) => { ok.push(s); console.log(`  ✓ ${s}`); };

try {
  // ── 1) kit 경로 ──
  await page.goto(`${base}/#/settings/kit`);
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
  pass(`kit 경로 거부·반영: ${text.replace(/\s+/g, ' ')}`);

  if (!sk) {
    console.log('kit 레포 인자를 받아서 워커 저장 흐름은 건너뛴다 (진짜 레포에 commit·push 하지 않는다)');
  } else {
    await saveFlows(page, sk);
  }
  console.log(`flows 통과 (${ok.length})`);
} finally {
  await browser.close();
  server.close();
}

async function saveFlows(page: Page, sk: ReturnType<typeof prepareSaveKit>) {
  const { kr } = sk;
  const post = (url: string, body: unknown) => fetch(base + url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Plenum': '1' }, body: JSON.stringify(body) });
  // 외부 에디터 명령은 PATH 에 있는 것이어야 한다(실제로 띄우지는 않는다 — launcher 가 가짜)
  assert.equal((await post('/api/settings', { editorCommand: process.execPath })).status, 200);
  sk.useFakeClaude();
  sk.installAsSource();
  const version = page.getByTestId('version');
  const editor = page.getByTestId('worker-editor');
  const row = (name: string) => page.getByTestId('worker-row').filter({ has: page.getByRole('button', { name, exact: true }) });
  const model = page.getByLabel('AI', { exact: true });
  const effort = page.getByLabel('노력도', { exact: true });
  const saveBtn = page.getByRole('button', { name: '저장…' });
  const remoteLine = page.getByTestId('remote-line');
  const run = page.getByTestId('save-run');
  const waitRemoteSame = () => remoteLine.filter({ hasText: '원격 main과 같음' }).waitFor(T);
  const steps = async () => Object.fromEntries(await Promise.all(['check', 'build', 'commit', 'push'].map(async (k) => [k, await page.getByTestId(`step-${k}`).getAttribute('data-state')])));
  const jobId = () => page.evaluate(() => document.querySelector('[data-testid=save-run]')?.getAttribute('data-job-id') ?? null);
  // 이전 저장의 결과 패널(취소·실패)이 남아 있어도 넘어가지 않게: job id 가 바뀐 새 저장이 끝날 때까지 기다린다
  const settledAfter = (prev: string | null) => page.waitForFunction((prev) => {
      const el = document.querySelector('[data-testid=save-run]');
      const s = el?.getAttribute('data-status');
      return !!el && el.getAttribute('data-job-id') !== prev && !!s && s !== 'running';
    }, prev, T);
  const confirmSave = async () => {
    await saveBtn.click();
    await page.getByTestId('save-dialog').waitFor(T);
    const prev = await jobId();
    await page.getByRole('button', { name: 'commit · push' }).click();
    await settledAfter(prev);
  };

  await page.goto(`${base}/#/settings/workers`);
  await page.reload(); // 설치본 위치를 바꾼 뒤 상단 버전을 다시 읽는다 (초안 없음)
  await version.filter({ hasText: '같음' }).waitFor(T);
  await waitRemoteSame();

  // 1. 행 클릭 → 수정란, 펼치기·동작 버튼 줄 없음
  await row('impl').click();
  assert.equal(await editor.getByTestId('editor-name').innerText(), 'impl');
  assert.equal(await editor.getByTestId('editor-file').innerText(), 'kit/workers/impl.md');
  assert.equal(await page.getByRole('button', { name: /펼치기|접기/ }).count(), 0, '펼치기 버튼이 남아 있다');
  assert.equal(await page.getByTestId('worker-detail').count(), 0);
  assert.equal(await page.getByRole('complementary', { name: '워커 동작' }).count(), 0, '오른쪽 동작 버튼 줄이 남아 있다');
  for (const name of ['빌드', '워커 추가', '복제', '삭제']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0, `동작 버튼 "${name}"이 남아 있다`);
  assert.match(await editor.innerText(), /Read, Edit, Write, Grep, Glob, Bash · 80/);
  await page.getByRole('button', { name: '외부 에디터로 열기' }).click();
  await waitFor(() => sk.opened.some((c) => c.args.some((a) => a.endsWith(path.join('kit', 'workers', 'impl.md')))), '외부 에디터로 열기가 워커 파일을 열지 않았다');
  pass('행 클릭 → 수정란(이름·파일), 펼치기·동작 버튼 줄 없음, 외부 에디터로 열기');

  // 2. AI opus → 강조·수정 중·쓰는 모드 안내, fable → 경고
  assert.equal(await saveBtn.isDisabled(), true, '바뀐 게 없는데 저장… 이 켜져 있다');
  await model.selectOption('opus');
  assert.equal(await model.getAttribute('data-changed'), 'true');
  assert.match(await editor.innerText(), /원래: sonnet/);
  await row('impl').getByTestId('dirty-mark').waitFor();
  assert.match(await page.getByTestId('mode-note').innerText(), /이 워커를 쓰는 모드: 기본\. 저장하면 이 모드들의 품질과 한도 사용량이 함께 바뀐다/);
  assert.match(await page.getByTestId('unsaved-count').innerText(), /저장 안 한 변경 1개/);
  assert.equal(await page.getByTestId('fable-warn').count(), 0);
  await model.selectOption('fable');
  const fw = await page.getByTestId('fable-warn').innerText();
  assert.match(fw, /Fable은 훅이 ORCHESTRATE_FABLE=1일 때만 허용한다\. 극한 모드가 아닌 모드에서 이 워커를 부르면 막힌다\./);
  assert.match(fw, /막혔을 때 Opus 짝 안내도 없다\(훅 OPUS_PAIR는 3단계에서 워커 칸으로 옮긴다\)/);
  await model.selectOption('sonnet');
  assert.equal(await row('impl').getByTestId('dirty-mark').count(), 0, '원래 값으로 돌리면 수정 중이 꺼져야 한다');
  await model.selectOption('opus');
  pass('AI 바꾸기: 칸 강조·원래 값·● 수정 중·쓰는 모드 안내·Fable 경고(짝 안내 없음)');

  // 7. 초안이 있으면 beforeunload 가 막는다 / 없으면 안 막는다
  const before = () => page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return { prevented: e.defaultPrevented, rv: String((e as any).returnValue) };
  });
  const b1 = await before();
  assert.equal(b1.prevented, true, `초안이 있는데 beforeunload 가 안 막았다: ${JSON.stringify(b1)}`);
  pass(`초안 있음 → beforeunload 막음 (${JSON.stringify(b1)})`);

  // 3. 저장 확인창 → commit · push → 4칸 ✓ → 저장 끝 → 상단 버전 다름
  const base0 = kr.head();
  await saveBtn.click();
  const dlg = page.getByTestId('save-dialog');
  await dlg.waitFor(T);
  const dt = await dlg.innerText();
  for (const s of ['kit/workers/impl.md', '- model: sonnet', '+ model: opus', 'kit/kit.yaml', '- version: "0.0.1"', '+ version: "0.0.2"', '버전은 저장마다 patch가 하나씩 오른다 (0.0.1 → 0.0.2)']) assert.ok(dt.includes(s), `확인창에 "${s}"가 없다:\n${dt}`);
  assert.equal(await dlg.getByTestId('commit-message').innerText(), 'impl: model sonnet → opus (0.0.2)');
  assert.equal(await dlg.getByTestId('author-email').innerText(), '작성자 e2e@example.com');
  await dlg.getByRole('button', { name: '취소' }).click();
  assert.equal(await dlg.count(), 0);
  assert.equal(kr.head(), base0, '취소했는데 커밋이 생겼다');
  await confirmSave();
  assert.equal(await run.getAttribute('data-status'), 'done', await run.innerText());
  const st = await steps();
  assert.deepEqual({ ...st, check: st.check === 'warn' ? 'ok' : st.check }, { check: 'ok', build: 'ok', commit: 'ok', push: 'ok' }, JSON.stringify(st));
  let warnNote = '';
  if (st.check === 'warn') {
    // 컴파일러 WARN 은 막지 않는다: 패널에 파일:줄 — 메시지, 그 줄 열기
    const wt = await page.getByTestId('save-warnings').innerText();
    assert.match(wt, /WARN \d+개 \(막지 않음\)/);
    assert.match(wt, /\S+:\d+ — /);
    const n = sk.opened.length;
    await page.getByRole('button', { name: /^외부 에디터로 그 줄 열기/ }).first().click();
    await waitFor(() => sk.opened.length > n, 'WARN 줄 열기가 에디터를 부르지 않았다');
    warnNote = ` · ${wt.split('\n')[0]}`;
  }
  const short = kr.head().slice(0, 7);
  assert.notEqual(kr.head(), base0);
  assert.equal(kr.remoteHead(), kr.head(), 'push 되지 않았다');
  assert.match(await page.getByTestId('save-done').innerText(), new RegExp(`저장 끝 · 커밋 ${short} push됨\\.`));
  await version.filter({ hasText: '버전 다름' }).waitFor(T);
  await page.waitForFunction(() => !document.querySelector('[data-testid=dirty-mark]'), null, T);
  assert.match(await row('impl').innerText(), /opus/);
  assert.equal(await page.getByTestId('unsaved-count').count(), 0);
  assert.equal((await before()).prevented, false, '초안이 없는데 beforeunload 가 막는다');
  pass(`저장: 확인창(diff·버전·메시지·작성자) → 4칸 ✓ → 저장 끝 ${short} → 상단 "버전 다름", 초안 지워짐, beforeunload 풀림${warnNote}`);

  // 4. 설치본에 반영 → ok → 상단 같음
  sk.setInstallVersion('0.0.2');
  await page.getByRole('button', { name: '설치본에 반영' }).click();
  const ir = page.getByTestId('install-result');
  await page.waitForFunction(() => {
    const s = document.querySelector('[data-testid=install-result]')?.getAttribute('data-status');
    return s === 'ok' || s === 'fail';
  }, null, T);
  assert.equal(await ir.getAttribute('data-status'), 'ok', await ir.innerText());
  const it = await ir.innerText();
  assert.match(it, /claude plugin marketplace update kjh-code/);
  assert.match(it, /claude plugin update demo-kit@kjh-code/);
  assert.match(it, /종료 코드 0/);
  assert.match(it, /설치본도 0\.0\.2로 맞췄다\./);
  await version.filter({ hasText: '같음' }).waitFor(T);
  pass('설치본에 반영 → 명령·종료 코드·결과 ok → 상단 "같음"');
  await page.getByRole('button', { name: '닫기' }).click();
  assert.equal(await run.count(), 0);

  // 5. tiers 에 없는 조합 (sonnet high) → 빌드 ERROR, kit.yaml 열기, 아무것도 안 바뀜
  await waitRemoteSame();
  const base1 = kr.head();
  await row('impl').click();
  await model.selectOption('sonnet');
  await effort.selectOption('high');
  await confirmSave();
  assert.equal(await run.getAttribute('data-status'), 'failed', await run.innerText());
  const ft = await page.getByTestId('save-failed').innerText();
  assert.match(ft, /빌드 ERROR · 계층 Sonnet high가 kit\.yaml의 tiers에 없다\. 처음 쓰는 조합이면 tiers에 행을 하나 추가해야 한다\./);
  assert.match(ft, /아무것도 바뀌지 않았다\. 워커 파일은 원래대로다\./);
  assert.equal((await steps()).check, 'fail');
  assert.equal(await page.getByTestId('step-check').locator('.hint').innerText(), 'ERROR · 계층 없음');
  assert.equal(kr.head(), base1);
  assert.equal(kr.porcelain(), '');
  const n0 = sk.opened.length;
  await page.getByRole('button', { name: 'kit.yaml 열기' }).click();
  await waitFor(() => sk.opened.slice(n0).some((c) => c.args.some((a) => a.endsWith(path.join('kit', 'kit.yaml')))), 'kit.yaml 열기가 kit.yaml을 열지 않았다');
  await row('impl').getByTestId('dirty-mark').waitFor(); // 초안은 남는다
  await page.getByRole('button', { name: '되돌리기' }).click();
  assert.equal(await row('impl').getByTestId('dirty-mark').count(), 0);
  await page.getByRole('button', { name: '닫기' }).click();
  pass('tiers 없는 조합 → 빌드 ERROR 패널·kit.yaml 열기·"아무것도 바뀌지 않았다", HEAD·작업 트리 그대로');

  // 5b. push 거부 → push 실패 패널 → 커밋 취소 → 다시 → 받아와서 다시 push
  sk.pushTo(sk.divergedRemote());
  const base2 = kr.head();
  await row('rev').click();
  await effort.selectOption('medium');
  await confirmSave();
  assert.equal(await run.getAttribute('data-status'), 'push-failed', await run.innerText());
  const pushShort = kr.head().slice(0, 7);
  const pt = await page.getByTestId('push-failed').innerText();
  assert.match(pt, new RegExp(`push 실패 · 원격 main이 그사이 앞섰다\\. 커밋 ${pushShort}는 로컬에만 있다\\.`));
  assert.equal((await steps()).push, 'fail');
  assert.equal(await page.getByTestId('step-push').locator('.hint').innerText(), '원격이 앞섬');
  await page.getByRole('button', { name: '커밋 취소' }).click();
  await page.getByTestId('save-cancelled').waitFor(T);
  assert.equal(kr.head(), base2, '커밋 취소 뒤 HEAD 가 저장 전이 아니다');
  await row('rev').getByTestId('dirty-mark').waitFor();
  await waitRemoteSame();
  await confirmSave();
  assert.equal(await run.getAttribute('data-status'), 'push-failed');
  sk.pushTo(null);
  const prevRetry = await jobId();
  await page.getByRole('button', { name: '받아와서 다시 push' }).click();
  await settledAfter(prevRetry);
  assert.equal(await run.getAttribute('data-status'), 'done', await run.innerText());
  assert.equal(kr.remoteHead(), kr.head());
  pass(`push 거부 → push 실패 패널(${pushShort}) → 커밋 취소(초안 남음) → 받아와서 다시 push → 저장 끝`);
  await page.getByRole('button', { name: '닫기' }).click();

  // 6. 원격 뒤처짐 → 화면 다시 열면 뒤처짐·저장 비활성 → 받아오기 → 저장 가능
  const other = kr.other();
  kr.commitFile(other, 'README.md', '다른 클론\n', '다른 클론에서 push');
  git(other, 'push', '-q', 'origin', 'main');
  await page.goto(`${base}/#/settings/kit`);
  await page.getByLabel('kit 레포 경로').waitFor();
  await page.goto(`${base}/#/settings/workers`);
  await remoteLine.filter({ hasText: '원격 main이 1커밋 앞섰다 · 받아온 뒤에 저장할 수 있다' }).waitFor(T);
  await row('impl').click();
  await effort.selectOption('xhigh');
  await model.selectOption('opus');
  assert.equal(await saveBtn.isDisabled(), true, '원격이 앞섰는데 저장… 이 켜져 있다');
  await page.getByRole('button', { name: '받아오기 (git pull)' }).click();
  await waitRemoteSame();
  assert.equal(await saveBtn.isDisabled(), false, '받아온 뒤에도 저장… 이 꺼져 있다');
  assert.equal(kr.head(), kr.remoteHead());
  pass('원격 뒤처짐 → 원격 줄·저장 비활성 → 받아오기 → 원격과 같음·저장 가능');
}

async function waitFor(cond: () => boolean, msg: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(msg);
    await new Promise((r) => setTimeout(r, 50));
  }
}
