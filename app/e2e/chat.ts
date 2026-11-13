// 프로젝트 창 채팅 흐름 (실패하면 종료 코드 1, 스크린샷을 남긴다).
// 가짜 claude(stream 모드)로 진짜 녹화(test/fixtures/stream)를 재생한다. 진짜 claude·~/.claude 는 건드리지 않는다.
// 쓰는 법: npm run e2e  (vite build 뒤 flows.ts 다음에 돈다)  ·  따로: npx tsx e2e/chat.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { chromium, type Page } from 'playwright';
import { createHandler, listen } from '../server/app.ts';
import type { Command } from '../server/open.ts';
import { makeFakeStreamClaude } from '../test/fakeclaudeStream.ts';
import { copyHistory, limitScript, REC, replyScript, twoTurnScript } from './chatfix.ts';

const SERVER_DOWN = 'Plenum 서버가 꺼져 있음 — 터미널에서 다시 켜기';
const root = fs.mkdtempSync(path.join(os.tmpdir(), '홍길동 채팅-'));
const projDir = path.join(root, '내 프로젝트');
fs.mkdirSync(projDir);
const claudeHome = path.join(root, 'claude home');
fs.mkdirSync(claudeHome);
const fake = makeFakeStreamClaude(path.join(root, '가짜'));
const env = fake.env({ script: REC('01-cards.jsonl'), extra: { CLAUDE_CONFIG_DIR: claudeHome } });
const launched: Command[] = [];
const PAST = '279fe3c2-3715-4f89-ac82-284e5c2f6842';
copyHistory(claudeHome, projDir, '-tmp-plenum-rec-----AbCdEf', PAST);
// 질문 a.txt 답 + rm a.txt 거부가 있는 진짜 기록(b5b49096). 01 녹화 채팅과 세션 ID 가 같아 다른 ID 로 복사한다
const S01 = 'e01e01e0-5604-499f-a80b-49f35d8d09bb';
copyHistory(claudeHome, projDir, '-tmp-plenum-rec-----AbCdEg', 'b5b49096-5604-499f-a80b-49f35d8d09bb', S01);

const handler = createHandler({ cfgDir: path.join(root, '설정'), env, claudeHome, launcher: async (c) => { launched.push(c); return { ok: true } as const; } });
let { server, port } = await listen(handler, 0);
const base = `http://127.0.0.1:${port}`;
const H = { 'Content-Type': 'application/json', 'X-Plenum': '1' };
const proj = await (await fetch(`${base}/api/projects`, { method: 'POST', headers: H, body: JSON.stringify({ kind: 'local', path: projDir }) })).json();
const projUrl = `${base}/#/project/${encodeURIComponent(proj.id)}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 860 }, colorScheme: 'dark' });
const T = { timeout: 20000 };
const ok: string[] = [];
const pass = (s: string) => { ok.push(s); console.log(`  ✓ ${s}`); };

const composer = () => page.locator('.composer');
async function sendText(t: string) {
  await page.getByLabel('메시지', { exact: true }).fill(t);
  await composer().getByRole('button', { name: '보내기' }).click();
}
async function noHScroll(where: string) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert.ok(r.sw <= r.iw, `${where}: 가로 스크롤 생김 (scrollWidth ${r.sw} > ${r.iw})`);
}
const status = () => page.getByTestId('chat-status');
const responses = () => fake.stdin().filter((x) => x.type === 'control_response').map((x) => x.response);
function closeServer(s: http.Server) { return new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }); }

try {
  // ── 노력도 드롭다운: --effort 가 있으면 보인다 ──
  await page.goto(projUrl);
  await page.getByRole('button', { name: '새 세션' }).waitFor(T);
  await page.getByLabel('노력도', { exact: true }).waitFor(T);
  await page.locator('.new-opts[data-caps=effort]').waitFor(T);
  assert.equal(await page.getByLabel('모델', { exact: true }).inputValue(), '');
  assert.equal(await page.getByLabel('모델', { exact: true }).locator('option').first().innerText(), '기본값');
  assert.equal(await page.getByLabel('노력도', { exact: true }).locator('option').first().innerText(), '기본값');
  pass('(c) 노력도 드롭다운 보임(--effort 있음), 모델·노력도 기본 글자 "기본값"');

  // ── (1) 01 녹화: 질문 → 허용 → 이 세션 동안 허용 → 거부+이유 ──
  await sendText('시작');
  const q = page.getByTestId('question-card').last();
  await q.getByRole('button', { name: /^a\.txt/ }).waitFor(T);
  await status().filter({ hasText: '답을 기다림' }).waitFor(T);
  await noHScroll('질문 카드');

  // (7) 응답 중 새로고침 → 대기 카드가 다시 보인다
  await page.reload();
  await page.getByTestId('question-card').last().getByRole('button', { name: /^a\.txt/ }).waitFor(T);
  assert.equal(await page.getByTestId('question-card').last().getByTestId('card-result').count(), 0, '새로고침 뒤 카드가 답한 것으로 보인다');
  await status().filter({ hasText: '답을 기다림' }).waitFor(T);
  pass('(7) 응답 중 새로고침 → 대기 질문 카드 복원·상태 "답을 기다림"');

  await page.getByTestId('question-card').last().getByRole('button', { name: /^a\.txt/ }).click();
  await page.getByTestId('question-card').last().getByTestId('card-result').filter({ hasText: '→ a.txt (Recommended)' }).waitFor(T);
  const perm = (cmd: string) => page.getByTestId('permission-card').filter({ hasText: cmd });
  await perm('touch a.txt').getByRole('button', { name: '허용', exact: true }).click(T);
  await perm('touch a.txt').getByTestId('card-result').filter({ hasText: /^허용$/ }).waitFor(T);
  await status().filter({ hasText: '승인을 기다림' }).waitFor(T);
  const sess = perm('touch c.txt').getByRole('button', { name: /이 세션 동안/ });
  await sess.waitFor(T);
  assert.equal((await sess.innerText()).replace(/\s+/g, ' '), '이 세션 동안 touch c.txt 허용');
  await sess.click();
  await perm('touch c.txt').getByTestId('card-result').filter({ hasText: '허용 · 이 세션 동안 다시 묻지 않음' }).waitFor(T);
  await perm('rm a.txt').getByRole('button', { name: '거부…' }).click(T);
  await page.getByLabel('거부 이유').fill('삭제는 내가 직접 할게');
  await noHScroll('승인 카드(거부 이유)');
  await perm('rm a.txt').getByRole('button', { name: '거부 보내기' }).click();
  await perm('rm a.txt').getByTestId('card-result').filter({ hasText: '거부함 · "삭제는 내가 직접 할게"를 Claude에게 전달' }).waitFor(T);
  await page.getByTestId('assistant-text').filter({ hasText: 'Not done: step 5 failed' }).waitFor(T);
  await status().filter({ hasText: '끝남' }).waitFor(T);
  const r = responses();
  assert.equal(r.length, 4, JSON.stringify(r));
  assert.deepEqual(r[0].response.updatedInput.answers, { 'Which file name?': 'a.txt (Recommended)' });
  assert.equal(r[0].response.behavior, 'allow');
  assert.deepEqual(r[1].response, { behavior: 'allow', updatedInput: { command: 'touch a.txt', description: 'Create a.txt' } });
  assert.deepEqual(r[2].response.updatedPermissions, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch c.txt' }], behavior: 'allow', destination: 'session' }]);
  assert.deepEqual(r[3].response, { behavior: 'deny', message: '삭제는 내가 직접 할게' });
  const tools = page.getByTestId('tools');
  assert.ok(await tools.count() >= 1);
  assert.match(await tools.first().locator('summary').innerText(), /^도구 \d+번 · /);
  assert.equal(await tools.first().evaluate((d) => (d as HTMLDetailsElement).open), false, '도구 줄은 기본 접힘');
  // 끝 메시지의 마크다운: 굵게·인라인 코드가 요소로
  const last = page.getByTestId('assistant-text').filter({ hasText: 'Not done' });
  assert.ok(await last.locator('strong').count() > 0 && await last.locator('code').count() > 0, '마크다운이 그려지지 않았다');
  assert.match(await page.getByTestId('limit-5시간').innerText(), /\d+%/);
  await noHScroll('끝남');
  pass('(1) 01 녹화: 질문 a.txt → 허용 → 이 세션 동안 `touch c.txt` 허용 → 거부+이유 → 끝 메시지, stdin 응답 4개 모양 맞음, 도구 접힘, 한도 표시');

  // ── (2) 03 녹화: 모드 질문 → 모드 없음 → 헤더 ──
  env.FAKE_STREAM_SCRIPT = REC('03-mode.jsonl');
  await page.getByRole('button', { name: '새 세션' }).click();
  await sendText('README.md 첫 줄을 "# fake project" 로 바꿔줘');
  const mq = page.getByTestId('question-card').last();
  await mq.locator('.tag', { hasText: '모드' }).waitFor(T);
  await mq.getByRole('button', { name: /^모드 없음/ }).click();
  await page.getByTestId('mode-badge').filter({ hasText: '모드: 모드 없음' }).waitFor(T);
  const edit = page.getByTestId('permission-card').last();
  await edit.getByText('파일을 고쳐도 될까?').waitFor(T);
  assert.equal(await edit.locator('details').count(), 1, 'Edit 승인 카드에 접힌 diff 가 없다');
  assert.equal(await edit.getByRole('button', { name: /이 세션 동안/ }).count(), 0, 'addRules 가 없는데 이 세션 동안 허용이 보인다');
  await edit.getByRole('button', { name: '허용', exact: true }).click();
  await page.getByTestId('assistant-text').filter({ hasText: '바꿨습니다' }).waitFor(T);
  pass('(2) 03 녹화: 모드 질문 → "모드 없음" → 헤더 "모드: 모드 없음", Edit 카드(diff 접힘, 이 세션 동안 없음)');

  // ── (3) 04 녹화: 워커 표 2줄 → 끝남 ──
  env.FAKE_STREAM_SCRIPT = REC('04-agents.jsonl');
  await page.getByRole('button', { name: '새 세션' }).click();
  await sendText('워커 두 개');
  const runs = page.getByTestId('worker-run');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=worker-run]').length === 2, null, T);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=worker-run]')].every((e) => e.getAttribute('data-state') === 'done'), null, T);
  for (let i = 0; i < 2; i++) assert.match(await runs.nth(i).innerText(), /끝남/);
  assert.equal(await page.getByTestId('worker-table').count(), 1, '턴 하나에 워커 표 하나');
  await page.getByTestId('assistant-text').filter({ hasText: 'ALL DONE' }).waitFor(T);
  await noHScroll('워커 표');
  pass('(3) 04 녹화: 워커 표 2줄(count files·say hi) → 둘 다 끝남');

  // ── (4) 지난 세션 → 이어하기 → 지난 기록 ──
  const transcript = await (await fetch(`${base}/api/projects/${proj.id}/sessions/${PAST}/transcript`)).json();
  const firstUser = transcript.find((x: any) => x.type === 'user').text as string;
  const row = page.locator(`[data-testid=session-row][data-sid="${PAST}"]`);
  await row.waitFor(T);
  await row.getByRole('button').first().click();
  await row.getByRole('button', { name: '이어하기' }).click();
  const pastBox = page.getByTestId('past-transcript');
  await pastBox.waitFor(T);
  assert.ok((await pastBox.innerText()).includes(firstUser.slice(0, 20)), `지난 기록에 첫 질문이 없다: ${firstUser.slice(0, 20)}`);
  pass(`(4) 지난 세션 목록 → 이어하기 → 지난 기록(${transcript.length}줄) 그려짐`);

  // ── (a) 지난 기록의 카드 줄: 접두어가 한 번씩만 ──
  const row01 = page.locator(`[data-testid=session-row][data-sid="${S01}"]`);
  await row01.getByRole('button').first().click();
  await row01.getByRole('button', { name: '이어하기' }).click();
  await page.getByTestId('past-answered').first().waitFor(T);
  assert.deepEqual(await page.getByTestId('past-answered').allInnerTexts(), ['답함: a.txt', '거부함: Bash rm a.txt']);
  pass('(a) 지난 기록 카드 줄 "답함: a.txt"·"거부함: Bash rm a.txt" (접두어 한 번씩)');
  await row.getByRole('button').first().click();
  await row.getByRole('button', { name: '이어하기' }).click();
  await pastBox.waitFor(T);

  // ── (5) 터미널로 열기 ──
  await page.locator('.bar-top').getByRole('button', { name: '터미널로 열기' }).click();
  const dlg = page.getByRole('dialog', { name: '터미널로 열기' });
  await dlg.waitFor(T);
  await dlg.getByRole('button', { name: '터미널로', exact: true }).click();
  const lines = (await dlg.getByTestId('terminal-lines').innerText({ timeout: T.timeout })).split('\n');
  assert.equal(lines.length, 2, lines.join(' / '));
  assert.equal(lines[1], `claude --resume ${PAST}`);
  if (process.platform === 'win32') {
    assert.equal(launched.length, 1, '가짜 launcher 가 불리지 않았다');
    assert.ok(launched[0].args.join(' ').includes(PAST));
  } else {
    assert.match(await dlg.innerText(), /이 두 줄을 터미널에 붙여 넣는다/);
    assert.equal(launched.length, 0, 'mac·Linux 는 자동으로 열지 않는다');
  }
  await page.keyboard.press('Escape');
  assert.equal(await dlg.count(), 0, 'Esc 로 닫히지 않았다');
  pass(`(5) 터미널로 열기 → ${process.platform === 'win32' ? '가짜 launcher 호출' : '수동(붙여 넣기) 안내'}, 확인창에 두 줄, Esc 닫기`);

  // ── (d) 끝난 채팅 → 터미널로 열기(채팅 닫힘) → 훅 SessionStart → 이어 보내기 409 → "이미 닫았다" → 다시 시작 ──
  const D = 'dddddddd-1111-4222-8333-444444444444';
  const dScript = path.join(root, 'reply-d.jsonl');
  replyScript(dScript, D, '첫 답이다');
  env.FAKE_STREAM_SCRIPT = dScript;
  await page.getByRole('button', { name: '새 세션' }).click();
  await sendText('터미널 전');
  await page.getByTestId('assistant-text').filter({ hasText: '첫 답이다' }).waitFor(T);
  await status().filter({ hasText: '끝남' }).waitFor(T);
  await page.locator('.bar-top').getByRole('button', { name: '터미널로 열기' }).click();
  const dlg2 = page.getByRole('dialog', { name: '터미널로 열기' });
  await dlg2.getByRole('button', { name: '채팅 끝내고 터미널로' }).click(T);
  await dlg2.getByTestId('terminal-lines').waitFor(T);
  await page.keyboard.press('Escape');
  await page.locator('[data-testid=chat-status][data-state=ended]').waitFor(T);
  const hook = await fetch(`${base}/api/hook`, { method: 'POST', headers: H, body: JSON.stringify({ event: 'SessionStart', session_id: D, cwd: projDir }) });
  assert.deepEqual(await hook.json(), { ok: true });
  replyScript(dScript, D, '다시 시작했다');
  await sendText('터미널 뒤');
  const forget = composer().locator('..').getByRole('button', { name: '이미 닫았다' });
  await forget.waitFor(T);
  assert.equal(await page.getByLabel('메시지', { exact: true }).inputValue(), '터미널 뒤', '409 뒤 입력창 글이 지워졌다');
  await forget.click();
  await page.getByTestId('assistant-text').filter({ hasText: '다시 시작했다' }).waitFor(T);
  assert.equal(await forget.count(), 0);
  const act = await (await fetch(`${base}/api/projects/${proj.id}/activity`)).json();
  assert.equal(act.sessions.some((x: any) => x.sessionId === D && x.source === 'terminal'), false, '이미 닫았다 뒤에도 터미널 세션이 남았다');
  const args = fake.argsCalls();
  assert.deepEqual(args[args.length - 1].args.slice(-2), ['--resume', D]);
  pass('(d) 끝난 채팅에서 터미널(훅)로 열린 세션 이어 보내기 → 409 → "이미 닫았다" → forget-terminal 뒤 --resume 으로 다시 시작');

  // ── (e) 살아 있는 채팅(다른 탭에서 시작) 세션을 목록에서 이어하기 → 서버가 글을 그 채팅에 전달 → 그 채팅 화면 ──
  const eScript = path.join(root, 'two-turn.jsonl');
  twoTurnScript(eScript, PAST);
  env.FAKE_STREAM_SCRIPT = eScript;
  await row.getByRole('button').first().click();
  await row.getByRole('button', { name: '이어하기' }).click();
  await page.getByTestId('past-transcript').waitFor(T);
  const other = await (await fetch(`${base}/api/projects/${proj.id}/chats`, { method: 'POST', headers: H, body: JSON.stringify({ text: '다른 탭', resume: PAST }) })).json();
  for (let i = 0; i < 100; i++) {
    const cs = await (await fetch(`${base}/api/projects/${proj.id}/chats`)).json();
    if (cs.some((c: any) => c.chatId === other.chat.chatId && c.sessionId === PAST && c.state === 'idle')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const argsBefore = fake.argsCalls().length;
  await sendText('이 탭에서 이어');
  await page.getByTestId('assistant-text').filter({ hasText: '둘째 턴 답' }).waitFor(T);
  assert.equal(await page.getByTestId('past-transcript').count(), 0, '그 채팅 화면으로 바뀌지 않았다');
  assert.deepEqual(await page.locator('.bubble').allInnerTexts(), ['다른 탭', '이 탭에서 이어']);
  assert.equal(fake.argsCalls().length, argsBefore, '살아 있는 채팅이 있는데 claude 를 새로 띄웠다');
  pass('(e) 살아 있는 채팅 세션을 목록에서 이어하기 → forwarded → 같은 채팅 화면에 글이 감(새 claude 없음)');

  // ── 노력도: --effort 없는 claude → 드롭다운 없음 ──
  env.FAKE_CLAUDE_HELP_EFFORT = '0';
  env.FAKE_CLAUDE_VERSION = '2.1.248'; // 기능 캐시는 버전별
  await page.reload();
  await page.locator('.new-opts[data-caps=no-effort]').waitFor(T); // 기능을 다 읽은 뒤에 본다(읽기 전에도 드롭다운은 없다)
  assert.equal(await page.getByLabel('노력도', { exact: true }).count(), 0, '--effort 가 없는데 노력도 드롭다운이 보인다');
  delete env.FAKE_CLAUDE_HELP_EFFORT;
  delete env.FAKE_CLAUDE_VERSION;
  pass('FAKE_CLAUDE_HELP_EFFORT=0 → 노력도 드롭다운 없음');

  // ── (b) 리셋 시각 없는 rejected → 보내기 켜짐 + 경고 한 줄 ──
  const lim0 = path.join(root, 'limit-unknown.jsonl');
  limitScript(lim0, null);
  env.FAKE_STREAM_SCRIPT = lim0;
  await page.getByRole('button', { name: '새 세션' }).click();
  await sendText('한도 모름');
  const lw = page.getByTestId('limit-warn');
  await lw.waitFor(T);
  assert.equal(await lw.innerText(), '사용 한도에 걸렸다는 신호가 왔지만 리셋 시각을 모른다');
  assert.equal(await page.getByTestId('limit-rejected').count(), 0, '리셋 시각을 모르는데 막힘 안내가 보인다');
  await page.getByLabel('메시지', { exact: true }).fill('또');
  assert.equal(await composer().getByRole('button', { name: '보내기' }).isDisabled(), false, '리셋 시각을 모르는데 보내기가 꺼졌다');
  await composer().getByRole('button', { name: '보내기' }).click();
  await page.locator('.bubble', { hasText: /^또$/ }).waitFor(T);
  assert.equal(await page.locator('.composer-wrap .warn-line', { hasText: '리셋 시각을 모른다' }).count(), 1, '경고 줄이 겹친다');
  assert.equal(await status().filter({ hasText: '한도 초과' }).count(), 0);
  pass('(b) resetsAt 없는 rejected → 보내기 켜짐·보내짐, 입력창 위 경고 한 줄, 막힘 안내 없음');

  // ── (6) 한도 rejected → 보내기 비활성 + 리셋 시각 ──
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const lim = path.join(root, 'limit.jsonl');
  limitScript(lim, reset);
  env.FAKE_STREAM_SCRIPT = lim;
  await page.getByRole('button', { name: '새 세션' }).click();
  await sendText('한도');
  const alert = page.getByTestId('limit-rejected');
  await alert.waitFor(T);
  const hhmm = await page.evaluate((s) => { const d = new Date(s * 1000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }, reset);
  assert.equal(await alert.innerText(), `5시간 한도를 다 썼다. ${hhmm}에 다시 열린다. 채팅·터미널 둘 다 같은 한도라 기다려야 한다.`);
  await page.getByLabel('메시지', { exact: true }).fill('또');
  assert.equal(await composer().getByRole('button', { name: '보내기' }).isDisabled(), true, '한도 초과인데 보내기가 켜져 있다');
  await status().filter({ hasText: '한도 초과' }).waitFor(T);
  assert.equal(await page.getByTestId('limit-5시간').locator('b').innerText(), '100%');
  pass(`(6) 한도 rejected → 보내기 비활성, "${hhmm}에 다시 열린다", 상태 "한도 초과"`);

  // ── 서버 꺼짐: 채팅 화면 → 같은 문구 한 줄, 다시 켜면 사라짐 ──
  await closeServer(server);
  await page.getByTestId('server-down').filter({ hasText: SERVER_DOWN }).waitFor(T);
  ({ server } = await listen(handler, port));
  await page.waitForFunction(() => !document.querySelector('[data-testid=server-down]'), null, T);
  pass('채팅 화면에서 서버 끔 → "Plenum 서버가 꺼져 있음 — 터미널에서 다시 켜기", 다시 켜면 사라짐');

  // ── 서버 꺼짐: 홈에서 프로젝트 추가 ──
  await page.goto(`${base}/#/`);
  await page.getByTestId('tile').first().waitFor(T);
  await closeServer(server);
  await page.getByRole('button', { name: '프로젝트 추가' }).first().click();
  await page.getByRole('tab', { name: '로컬 폴더에서' }).click();
  await page.getByLabel('폴더 경로').fill(projDir);
  await page.getByRole('button', { name: '확인' }).click();
  const err = page.getByRole('dialog').getByRole('alert');
  await err.waitFor(T);
  assert.equal(await err.innerText(), SERVER_DOWN);
  assert.equal(await page.getByText('Failed to fetch').count(), 0);
  pass('홈에서 서버 끄고 프로젝트 추가 → 서버 꺼짐 문구("Failed to fetch" 없음)');

  console.log(`chat 통과 (${ok.length})`);
} catch (e) {
  const shot = path.join(os.tmpdir(), `plenum-chat-fail-${Date.now()}.png`);
  try { await page.screenshot({ path: shot, fullPage: true }); console.error(`실패 스크린샷: ${shot}`); } catch { /* 무시 */ }
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  await (handler as any).chats.shutdownAll().catch(() => {});
  if (server.listening) await closeServer(server);
}
