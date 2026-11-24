// tools/probe 녹화 도구의 순수 함수: redact 치환·남은 위험 검사, record 의 답 고르기. 진짜 claude 는 띄우지 않는다
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { APP } from './helpers.ts';
import { buildContext, findRisks, mergeMeta, redactLine, redactLines, redactString } from '../../tools/probe/redact.ts';
import { commandOf, fillPrompt, outcomeOf, parseArgs, parseScene, pickPermission, pickQuestion, psQuoteInner, randToken, workdirOf, writeIn } from '../../tools/probe/record.ts';
import { EMPTY_WORDS, mojibakeVariants, wordsGate } from '../../tools/probe/variants.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { byteFormsOf, formsOf, parseArgs as scanParseArgs, parseLsTree, scanFile, scanLog, wordShape } from '../../tools/probe/scan.ts';
import os from 'node:os';

const WIN = { env: { USERPROFILE: 'C:\\Users\\갑돌' }, homedir: 'C:\\Users\\갑돌', tmpdir: 'C:\\Users\\갑돌\\AppData\\Local\\Temp' };

describe('redact', () => {
  test('Windows 홈 세 형태(\\, JSON 의 \\\\, /), 드라이브·대소문자 무관 → C:\\Users\\홍길동', () => {
    const ctx = buildContext(WIN);
    expect(redactString('C:\\Users\\갑돌\\proj', ctx)).toBe('C:\\Users\\홍길동\\proj');
    expect(redactString('d:/users/갑돌/x', ctx)).toBe('C:/Users/홍길동/x');
    expect(redactString('C:\\\\Users\\\\갑돌\\\\x', ctx)).toBe('C:\\\\Users\\\\홍길동\\\\x');
    expect(redactString('Read(//c/Users/갑돌/.claude/plugins/cache/**)', ctx)).toBe('Read(//c/Users/홍길동/.claude/plugins/cache/**)');
    // 줄 단위: JSON 이스케이프 그대로
    const line = JSON.stringify({ dir: 'out', t: 1, msg: { type: 'system', subtype: 'init', cwd: 'E:\\USERS\\갑돌\\AppData\\Local\\Temp\\plenum-rec-홍길동-x1Y2z3\\proj' } });
    const r = redactLine(line, buildContext({ ...WIN, workdir: 'C:\\Users\\갑돌\\AppData\\Local\\Temp\\plenum-rec-홍길동-x1Y2z3\\proj' }))!;
    expect(r).toContain('"cwd":"C:\\\\Users\\\\홍길동\\\\AppData\\\\Local\\\\Temp\\\\plenum-rec-홍길동-AbCdEf\\\\proj"');
    expect(findRisks(r, buildContext(WIN))).toEqual([]);
  });

  test('이름 뒤가 이어지면 홈으로 보지 않고(갑돌2 → 맨 이름만 바뀌어 홍길동2 → 검사가 막음), 남은 다른 X:\\Users\\누군가 는 검사가 잡는다', () => {
    const ctx = buildContext(WIN);
    const r2 = redactString('C:\\Users\\갑돌2\\x', ctx);
    expect(r2).toBe('C:\\Users\\홍길동2\\x');
    expect(findRisks(r2, ctx).length).toBeGreaterThan(0);
    for (const s of ['C:\\Users\\누군가\\x', 'C:\\\\Users\\\\누군가', 'e:/users/someone/x', '//c/Users/someone/x', 'C:\\Users\\홍길동x\\y']) {
      expect(findRisks(JSON.stringify({ a: s }), ctx).length, s).toBeGreaterThan(0);
    }
    for (const s of ['C:\\Users\\홍길동\\x', 'c:/users/홍길동/x', '//c/Users/홍길동/x']) expect(findRisks(JSON.stringify({ a: s }), ctx), s).toEqual([]);
    const { out, risks } = redactLines([JSON.stringify({ dir: 'out', msg: { p: 'C:\\Users\\누군가\\a' } })], ctx);
    expect(out.length).toBe(1);
    expect(risks).toEqual([{ line: 1, what: '홍길동 아닌 Windows 사용자 폴더(Windows 사용자 폴더)' }]);
  });

  test('짧은 이름(8.3) TEMP·git bash HOME 에서도 이름을 얻는다, POSIX 홈 → /home/hong', () => {
    const ctx = buildContext({ env: { TEMP: 'C:\\Users\\GAPDOL~1\\AppData\\Local\\Temp', HOME: '/c/Users/gapdol' }, homedir: 'C:\\Users\\gapdol', tmpdir: 'C:\\x' });
    expect(redactString('C:\\Users\\GAPDOL~1\\AppData', ctx)).toBe('C:\\Users\\홍길동\\AppData');
    expect(redactString('/c/Users/gapdol/.claude', ctx)).toBe('/c/Users/홍길동/.claude');
    expect(redactString('C--Users-gapdol-proj', ctx)).toBe('C--Users-홍길동-proj');
    const px = buildContext({ env: {}, homedir: '/home/gapdol', tmpdir: '/tmp' });
    expect(redactString('/home/gapdol/.claude and -home-gapdol-x and /home/gapdolX', px)).toBe('/home/hong/.claude and -home-hong-x and /home/gapdolX');
  });

  test('이메일: 허용 목록 밖만 hong@example.invalid', () => {
    const ctx = buildContext({ env: {}, homedir: '/home/hong', tmpdir: '/tmp' });
    expect(redactString('a someone@gmail.com b 1+x@users.noreply.github.com noreply@anthropic.com z@example.invalid', ctx))
      .toBe('a hong@example.invalid b 1+x@users.noreply.github.com noreply@anthropic.com z@example.invalid');
  });

  test('계정·조직 UUID 칸 → 0 UUID(값마다 1,2,… 결정적), synced/<uuid>_<uuid>, RateLimitResetCredit', () => {
    const A = '12345678-9abc-4def-8123-456789abcdef';
    const B = 'abcdef01-2345-4678-89ab-cdef01234567';
    const line = JSON.stringify({ dir: 'out', msg: { account: { accountUuid: A, organization_uuid: B, userUuid: A, other: A }, text: `{"orgUuid":"${B}"} synced/${A}_${B}/jh-kit synced\\\\${A}_${B} RateLimitResetCredit_1a2b3c` } });
    const r = JSON.parse(redactLine(line, buildContext({ env: {}, homedir: '/home/hong' }))!);
    expect(r.msg.account).toEqual({ accountUuid: '00000000-0000-4000-8000-000000000001', organization_uuid: '00000000-0000-4000-8000-000000000002', userUuid: '00000000-0000-4000-8000-000000000001', other: A });
    expect(r.msg.text).toBe(`{"orgUuid":"00000000-0000-4000-8000-000000000002"} synced/ORG_ACCOUNT/jh-kit synced\\\\ORG_ACCOUNT RateLimitResetCredit_0`);
    // 결정적
    expect(redactLine(line, buildContext({ env: {}, homedir: '/home/hong' }))).toBe(redactLine(line, buildContext({ env: {}, homedir: '/home/hong' })));
  });

  test('PLENUM_PRIVATE_WORDS 낱말·깨진 형태 → 홍길동/hong, 남으면 검사가 잡는다', () => {
    const ctx = buildContext({ env: { PLENUM_PRIVATE_WORDS: '갑돌, gapdol' }, homedir: '/home/hong' });
    const mv = mojibakeVariants('갑돌').variants;
    expect(mv.length).toBeGreaterThan(0);
    const text = `x 갑돌 gapdol ${mv.join(' ')} y`;
    const r = redactString(text, ctx);
    expect(r).toBe(`x 홍길동 hong ${mv.map(() => '홍길동').join(' ')} y`);
    expect(findRisks(r, ctx)).toEqual([]);
    for (const v of ['갑돌', 'gapdol', ...mv]) expect(findRisks(`a${v}b`, ctx).length, v).toBeGreaterThan(0);
  });

  test('작업 폴더 랜덤 → AbCdEf (그대로 쓴 꼴·Claude 가 폴더 이름으로 바꾼 꼴)', () => {
    const ctx = buildContext({ env: {}, homedir: '/home/hong', workdir: '/tmp/plenum-rec-홍길동-Q9w8E7/proj' });
    expect(redactString('/tmp/plenum-rec-홍길동-Q9w8E7/proj -tmp-plenum-rec-----Q9w8E7-proj', ctx)).toBe('/tmp/plenum-rec-홍길동-AbCdEf/proj -tmp-plenum-rec-----AbCdEf-proj');
    expect(redactString('/tmp/plenum-rec-홍길동-zzzzzz', buildContext({ env: {}, homedir: '/home/hong' }))).toBe('/tmp/plenum-rec-홍길동-AbCdEf');
  });

  test('지우기: 계정 맥락 첨부 줄·칸, init 의 명령·에이전트 설명. U+FFFD 는 줄 번호로 알린다', () => {
    const ctx = buildContext({ env: {}, homedir: '/home/hong' });
    expect(redactLine(JSON.stringify({ dir: 'out', msg: { type: 'attachment', attachment: { type: 'prompt_snapshot', text: 'secret' } } }), ctx)).toBeNull();
    const user = JSON.parse(redactLine(JSON.stringify({ dir: 'out', msg: { type: 'user', message: { content: [{ type: 'session_context', x: 1 }, { type: 'text', text: 'hi' }] }, credential_org: 'o' } }), ctx)!);
    expect(user.msg).toEqual({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } });
    const init = JSON.parse(redactLine(JSON.stringify({ dir: 'out', msg: { type: 'control_response', response: { response: { commands: [{ name: 'a', description: 'long' }], agents: [{ name: 'b', description: 'd' }] } } } }), ctx)!);
    expect(init.msg.response.response).toEqual({ commands: [{ name: 'a', description: '' }], agents: [{ name: 'b', description: '' }] });
    const { out, fffd, fffdLeft } = redactLines(['', JSON.stringify({ dir: 'out', msg: { t: 'a\uFFFDb' } }), 'not json'], ctx);
    expect(fffd).toEqual([2]);
    expect(fffdLeft).toEqual([2]);
    expect(out).toEqual([JSON.stringify({ dir: 'out', msg: { t: 'a\uFFFDb' } }), 'not json']);
    expect(redactLines([], ctx)).toEqual({ out: [], fffd: [], fffdLeft: [], risks: [] });
  });

  test('meta.json 합치기: 장면 추가·정렬·중복 없음, 다른 값은 경고', () => {
    const rec = { provider: 'claude', version: '2.1.248', os: 'windows', recordedAt: '2026-11-23', command: ['claude', '-p'], workdir: 'x', scene: '07' };
    expect(mergeMeta(null, rec, '07-a').meta).toEqual({ provider: 'claude', version: '2.1.248', os: 'windows', recordedAt: '2026-11-23', command: ['claude', '-p'], scenes: ['07-a'] });
    const m = mergeMeta({ ...rec, recordedAt: '2026-11-01', scenes: ['09-z', '07-a'] }, rec, '07-a');
    expect(m.meta.scenes).toEqual(['07-a', '09-z']);
    expect(m.meta.recordedAt).toBe('2026-11-01');
    expect(m.warnings.length).toBe(1);
  });
});

describe('record 답 고르기', () => {
  const scene = parseScene(fs.readFileSync(path.join(APP, '..', 'tools', 'probe', 'scenes', '07-powershell-session.json'), 'utf8'));
  const ALL = ['allow_once', 'allow_session', 'reject_once'];

  test('장면 07: 1·4·6 → 세션 허용, 3 → 한 번, 같은 명령 두 번째 요청 → 한 번, 모르는 명령 → 기본(거부)', () => {
    const a = 'New-Item -ItemType File -Force .\\ps-a.txt';
    const b = 'New-Item -ItemType File -Force .\\ps-b.txt';
    const x = 'New-Item -ItemType File -Force $env:TEMP\\plenum-ps-x.txt';
    const y = 'New-Item -ItemType File -Force C:\\Users\\갑돌\\AppData\\Local\\Temp\\plenum-ps-y.txt';
    const seq = [a, a, b, x, x, y, y, 'Remove-Item foo'];
    const got: string[] = [];
    seq.forEach((c, i) => got.push(pickPermission(scene, seq.slice(0, i), c, ALL).optionId));
    expect(got).toEqual(['allow_session', 'allow_once', 'allow_once', 'allow_session', 'allow_once', 'allow_session', 'allow_once', 'reject_once']);
    // 세 번째 요청도 계속 진행
    expect(pickPermission(scene, [a, a], a, ALL).optionId).toBe('allow_once');
  });

  test('nth·default, 카드에 없는 답은 allow_once(거부는 그대로)', () => {
    const s = { answers: [{ match: 'q', nth: 2, optionId: 'allow_session' as const }], defaultAnswer: 'allow_once' as const };
    expect(pickPermission(s, [], 'q', ALL)).toEqual({ optionId: 'allow_once', rule: null, note: null });
    expect(pickPermission(s, ['q'], 'q', ALL)).toEqual({ optionId: 'allow_session', rule: 0, note: null });
    expect(pickPermission(s, ['q'], 'q', ['allow_once', 'reject_once']).optionId).toBe('allow_once');
    expect(pickPermission({ answers: [], defaultAnswer: 'reject_once' }, [], 'z', ['allow_once', 'reject_once']).optionId).toBe('reject_once');
    expect(pickPermission({ answers: [], defaultAnswer: 'reject_once' }, [], '', [])).toMatchObject({ optionId: 'reject_once' });
  });

  test('모드 질문: label "모드 없음"(추천 표시 무시)을 고르고, 없으면 거부', () => {
    expect(pickQuestion([{ question: '모드?', options: [{ label: '일반 (추천)' }, { label: '모드 없음 (Recommended)' }] }]))
      .toEqual({ action: 'accept', answers: { '모드?': '모드 없음 (Recommended)' } });
    expect(pickQuestion([{ question: 'File?', options: [{ label: 'a.txt' }] }])).toEqual({ action: 'decline' });
    expect(pickQuestion([])).toEqual({ action: 'decline' });
  });

  test('장면·인자·작업 폴더·프롬프트 채우기', () => {
    expect(scene.turns[0].prompt.split('\n')[0]).toBe('No mode questions, do not use Skill.');
    const p = fillPrompt(scene.turns[0].prompt, 'C:\\T');
    expect(p).toContain("New-Item -ItemType File -Force 'C:\\T\\plenum-ps-y.txt'");
    // L7: 작은따옴표 안에 넣으므로 값 안의 ' 는 ''
    expect(fillPrompt(scene.turns[0].prompt, "C:\\Users\\O'Neil\\T")).toContain("-Force 'C:\\Users\\O''Neil\\T\\plenum-ps-y.txt'");
    expect(psQuoteInner("a'b''c")).toBe("a''b''''c");
    expect(pickPermission(scene, [], "New-Item -ItemType File -Force 'C:\\T\\plenum-ps-y.txt'", ALL).optionId).toBe('allow_session');
    expect(p).not.toContain('{TMP}');
    expect(p).toContain('$env:TEMP\\plenum-ps-x.txt');
    const r = randToken();
    expect(r).toMatch(/^[A-Za-z0-9]{6}$/);
    expect(workdirOf(scene, '/tmp', 'Ab12Cd')).toBe(path.join('/tmp', 'plenum-rec-홍길동-Ab12Cd', 'proj'));
    expect(commandOf({ command: 'ls' })).toBe('ls');
    expect(commandOf({ file_path: '/a' })).toBe('/a');
    expect(commandOf(undefined)).toBe('');
    expect(parseArgs(['s.json', '--dry-run'])).toEqual({ scene: 's.json', out: null, dryRun: true, allowEmptyWords: false });
    expect(parseArgs(['s.json', '--allow-empty-words']).allowEmptyWords).toBe(true);
    expect(() => parseArgs([])).toThrow();
    expect(() => parseArgs(['s.json', '--out'])).toThrow();
    expect(() => parseScene('{"scene":"x"}')).toThrow(/장면 JSON/);
  });
});

describe('review 반례', () => {
  const PX = { homedir: '/home/hong', tmpdir: '/tmp' };

  test('H1: ASCII 낱말은 대소문자 무시로 치환·검사, 한글은 그대로', () => {
    const ctx = buildContext({ ...PX, env: { PLENUM_PRIVATE_WORDS: 'gapdol,갑돌' } });
    expect(redactString('GapDol GAPDOL gapdol 갑돌', ctx)).toBe('hong hong hong 홍길동');
    expect(findRisks('mail GAPDOL', ctx)).toEqual(['낱말 #1']);
    expect(findRisks('hong 홍길동', ctx)).toEqual([]);
  });

  test('H2: 홈 이름 자리가 U+FFFD·깨진 형태로만 되어 있으면 같은 구분자 모양의 홍길동으로, 그 밖은 계속 막음', () => {
    const ctx = buildContext({ ...PX, env: { PLENUM_PRIVATE_WORDS: '갑돌' } });
    const mv = mojibakeVariants('갑돌').variants;
    const F = '\uFFFD';
    const cases: [string, string][] = [
      [`C:\\Users\\${F}${F}${F}\\AppData`, 'C:\\Users\\홍길동\\AppData'],
      [`d:\\\\Users\\\\${F}${F}\\\\x`, 'C:\\\\Users\\\\홍길동\\\\x'],
      [`E:/Users/${F}/x`, 'C:/Users/홍길동/x'],
      [`C:\\Users\\${mv[0]}\\x`, 'C:\\Users\\홍길동\\x'],
      [`C:\\Users\\${F}${mv[mv.length - 1]}${F}\\x`, 'C:\\Users\\홍길동\\x'],
      [`/c/Users/${F}${F}/x`, '/c/Users/홍길동/x'],
    ];
    for (const [i, o] of cases) {
      const r = redactString(i, ctx);
      expect(r, i).toBe(o);
      expect(findRisks(r, ctx), i).toEqual([]);
    }
    // 이름에 진짜 글자가 섞이면 홈으로 치환하지 않고 검사가 막는다(U+FFFD 는 남아도 실패 아님 — 막는 것은 홈)
    const left = redactString(`C:\\Users\\Ab${F}\\x`, ctx);
    expect(left).toBe(`C:\\Users\\Ab${F}\\x`);
    expect(findRisks(left, ctx)).toEqual(['홍길동 아닌 Windows 사용자 폴더(Windows 사용자 폴더)']);
    // 홈 밖에 남은 U+FFFD 는 실패가 아니다(보고만)
    const { fffd, fffdLeft, risks } = redactLines([JSON.stringify({ dir: 'out', msg: { a: `x${F}y`, cwd: `C:\\Users\\${F}${F}\\p` } })], ctx);
    expect([fffd, fffdLeft, risks]).toEqual([[1], [1], []]);
  });

  test('M1: //c/Users·/c/Users·/mnt/c/Users·평탄화 C--Users- 를 치환하고, 남은 것은 검사가 잡는다', () => {
    const ctx = buildContext({ ...PX, env: { USERPROFILE: 'C:\\Users\\gapdol' } });
    expect(redactString('Read(//c/Users/gapdol/x) /d/Users/gapdol/y /mnt/c/Users/gapdol/z C--Users-gapdol-proj', ctx))
      .toBe('Read(//c/Users/홍길동/x) /c/Users/홍길동/y /mnt/c/Users/홍길동/z C--Users-홍길동-proj');
    for (const bad of ['//c/Users/someone/x', '/c/Users/someone/x', '/mnt/c/Users/someone/x', 'C--Users-someone-proj', 'C--Users---gd-x']) {
      expect(findRisks(bad, ctx).length, bad).toBeGreaterThan(0);
    }
    for (const ok of ['//c/Users/홍길동/x', '/c/Users/홍길동/x', '/mnt/c/Users/홍길동/x', 'C--Users-----proj', 'C--Users-홍길동-proj', '-tmp-plenum-rec-----AbCdEf']) {
      expect(findRisks(ok, ctx), ok).toEqual([]);
    }
  });

  test('M2: env 의 Windows 사용자 이름은 경로 밖 맨 이름도 치환·검사(ASCII 는 앞뒤 경계·대소문자 무시), 흔한 이름은 맨 이름 제외', () => {
    const ctx = buildContext({ ...PX, env: { USERPROFILE: 'C:\\Users\\gapdol' } });
    expect(redactString('user gapdol, GAPDOL-PC\\gapdol, gapdolx', ctx)).toBe('user hong, hong-PC\\hong, gapdolx');
    expect(findRisks('login Gapdol', ctx).length).toBeGreaterThan(0);
    expect(findRisks('gapdolx', ctx)).toEqual([]);
    const ko = buildContext({ ...PX, env: { USERPROFILE: 'C:\\Users\\갑돌' } });
    const mv = mojibakeVariants('갑돌').variants;
    expect(redactString(`user 갑돌 ${mv[0]}`, ko)).toBe('user 홍길동 홍길동');
    expect(findRisks(`a ${mv[0]}`, ko).length).toBeGreaterThan(0);
    const generic = buildContext({ ...PX, env: { USERPROFILE: 'C:\\Users\\User' } });
    expect(redactString('C:\\Users\\User\\x "type":"user"', generic)).toBe('C:\\Users\\홍길동\\x "type":"user"');
    expect(generic.warnings.some((w) => w.includes('흔한'))).toBe(true);
  });

  test("M2': 빈 PLENUM_PRIVATE_WORDS 는 거부, --allow-empty-words 면 진행, dry-run 은 경고만", () => {
    expect(wordsGate([], {})).toEqual({ ok: false, message: EMPTY_WORDS });
    expect(wordsGate([], { allowEmpty: true }).ok).toBe(true);
    expect(wordsGate([], { dryRun: true })).toMatchObject({ ok: true });
    expect(wordsGate([], { dryRun: true }).message).toMatch(/^경고/);
    expect(wordsGate(['a'], {})).toEqual({ ok: true, message: null });
    // CLI: 낱말 없이 redact·record 는 0 아닌 코드, record --dry-run 은 0
    const env = { ...process.env, PLENUM_PRIVATE_WORDS: '' };
    const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', ...args], { cwd: APP, env, encoding: 'utf8', timeout: 60000 });
    const red = run(['../tools/probe/redact.ts', path.join(os.tmpdir(), 'nothing-raw.jsonl')]);
    expect(red.status).toBe(4);
    expect(red.stderr).toContain('PLENUM_PRIVATE_WORDS');
    const scenePath = '../tools/probe/scenes/07-powershell-session.json';
    expect(run(['../tools/probe/record.ts', scenePath]).status).toBe(4);
    const dry = run(['../tools/probe/record.ts', scenePath, '--dry-run']);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('--dry-run: claude 를 띄우지 않았다');
    const allow = run(['../tools/probe/redact.ts', path.join(os.tmpdir(), 'nothing-raw.jsonl'), '--allow-empty-words']);
    expect(allow.status).toBe(1);                  // 낱말 검문은 지나고, 메타 파일이 없어서 실패
    expect(allow.stderr).toContain('메타 파일이 없다');
  });

  test('M3: spawn 실패·version 없음·턴 끝 0회·종료 코드 ≠0·시간 초과면 0 아닌 코드', () => {
    const okRun = { spawnFailed: false, version: '2.1.248', turnsDone: 1, turns: 1, code: 0, timedOut: false };
    expect(outcomeOf(okRun)).toEqual({ exitCode: 0, reasons: [] });
    expect(outcomeOf({ ...okRun, spawnFailed: true, code: null, version: null, turnsDone: 0 }).exitCode).toBe(1);
    expect(outcomeOf({ ...okRun, version: null }).reasons).toEqual(['init 에서 claude_code_version 을 못 읽었다']);
    expect(outcomeOf({ ...okRun, turnsDone: 0 }).reasons).toEqual(['턴 끝(result)이 한 번도 안 왔다']);
    expect(outcomeOf({ ...okRun, turns: 2 }).exitCode).toBe(1);
    expect(outcomeOf({ ...okRun, code: 1 }).reasons).toEqual(['claude 종료 코드 1']);
    expect(outcomeOf({ ...okRun, code: null, timedOut: true }).reasons).toEqual(['시간 초과', 'claude 종료 코드 null']);
  });

  test('L1: stdin 에 실제로 쓴 것만 in 으로 기록, 못 쓰면 dropped', () => {
    const recs: unknown[] = []; const logs: string[] = []; const wrote: string[] = [];
    const ok = { writable: true, write: (s: string) => wrote.push(s) };
    expect(writeIn(ok, { a: 1 }, (x) => recs.push(x), (s) => logs.push(s))).toBe(true);
    expect(wrote).toEqual(['{"a":1}\n']);
    for (const st of [null, { writable: false, write: () => wrote.push('x') }, { writable: true, writableEnded: true, write: () => wrote.push('x') }, { writable: true, destroyed: true, write: () => wrote.push('x') }]) {
      expect(writeIn(st, { b: 2 }, (x) => recs.push(x), (s) => logs.push(s))).toBe(false);
    }
    expect(recs).toEqual([{ dir: 'in', msg: { a: 1 } }]);
    expect(wrote.length).toBe(1);
    expect(logs.length).toBe(4);
    expect(logs.every((l) => l.startsWith('dropped'))).toBe(true);
  });

  test('L2: 이름 끝 — 공백·\'·)·문장 끝 . 는 끝, 홍길동2·홍길동x 는 막힘. 원래 이름도 같은 끝 규칙으로 치환', () => {
    const ctx = buildContext({ ...PX, env: { USERPROFILE: 'C:\\Users\\gapdol' } });
    for (const s of ['C:\\Users\\홍길동 이다', "'C:\\Users\\홍길동'", '(C:\\Users\\홍길동)', 'C:\\Users\\홍길동.']) expect(findRisks(s, ctx), s).toEqual([]);
    for (const s of ['C:\\Users\\홍길동2', 'C:\\Users\\홍길동x', 'C:\\Users\\홍길동.txt']) expect(findRisks(s, ctx).length, s).toBeGreaterThan(0);
    expect(redactString('home is C:\\Users\\gapdol.', ctx)).toBe('home is C:\\Users\\홍길동.');
    expect(redactString("'C:\\Users\\gapdol' (C:\\Users\\gapdol)", ctx)).toBe("'C:\\Users\\홍길동' (C:\\Users\\홍길동)");
  });

  test('L3: RateLimitResetCredit_<영숫자·-> 전체 → _0 (대소문자 무시)', () => {
    const ctx = buildContext({ ...PX, env: {} });
    expect(redactString('RateLimitResetCredit_AbZ9-x1 ratelimitresetcredit_q', ctx)).toBe('RateLimitResetCredit_0 RateLimitResetCredit_0');
    expect(findRisks('RateLimitResetCredit_Zz-1', ctx)).toEqual(['RateLimitResetCredit 실제 값']);
    expect(findRisks('"RateLimitResetCredit_0"', ctx)).toEqual([]);
  });
});

describe('review 2차 반례', () => {
  const PX = { homedir: '/home/hong', tmpdir: '/tmp' };

  test("M1(a): 앞이 ':' 인 /c/Users(git bash PATH)도 치환·검사, 드라이브 꼴은 이 규칙에 이중으로 걸리지 않음", () => {
    const ctx = buildContext({ ...PX, env: { USERPROFILE: 'C:\\Users\\gapdol' } });
    expect(redactString('PATH=/usr/bin:/c/Users/gapdol/bin', ctx)).toBe('PATH=/usr/bin:/c/Users/홍길동/bin');
    expect(findRisks('PATH=/usr/bin:/c/Users/someone/bin', ctx)).toEqual(['홍길동 아닌 Windows 사용자 폴더(드라이브 경로 /c/Users·//c/Users)']);
    expect(findRisks('PATH=/usr/bin:/c/Users/홍길동/bin', ctx)).toEqual([]);
    expect(redactString('C:/Users/gapdol/x', ctx)).toBe('C:/Users/홍길동/x');
    expect(findRisks('C:/Users/someone/x', ctx)).toEqual(['홍길동 아닌 Windows 사용자 폴더(Windows 사용자 폴더)']);
  });

  test('M1(b): 한글 N글자 이름의 평탄화 꼴(- N개)은 홍길동 꼴(--- 3개)로', () => {
    for (const name of ['갑', '갑돌', '갑돌이네']) {
      const ctx = buildContext({ ...PX, env: { USERPROFILE: `C:\\Users\\${name}` } });
      const flat = `C--Users-${'-'.repeat(name.length)}`;
      expect(redactString(`${flat}-proj and ${flat}`, ctx), name).toBe('C--Users-----proj and C--Users----');
      expect(findRisks(redactString(`x ${flat}-proj`, ctx), ctx), name).toEqual([]);
    }
    // 고치지 않은 2글자 꼴은 CI 규칙이 막는다(규칙은 그대로)
    expect(findRisks('C--Users----proj', buildContext({ ...PX, env: {} })).length).toBeGreaterThan(0);
  });

  test('H2: 5번째 깨진 형태(CP949→UTF-8, U+FFFD 섞임)를 치환·검사, 홈 자리에 오면 홍길동', () => {
    // 갑돌: CP949 바이트를 UTF-8 로 읽으면 U+FFFD 뿐 → 낱말 형태에서 빠진다(정보 없음). 갑돌이네: 섞인 꼴이라 남는다
    expect(mojibakeVariants('갑돌').variants.some((v) => v.includes('\uFFFD'))).toBe(false);
    // 갑돌이네: CP949→UTF-8 은 U+FFFD 아닌 글자가 1개뿐 → 뺀다(형태 5 는 그런 글자가 2개 이상일 때만). 홍길동: 2개라 남는다
    expect(mojibakeVariants('갑돌이네').variants.some((v) => v.includes('\uFFFD'))).toBe(false);
    expect(mojibakeVariants('홍길동').variants.some((v) => v.includes('\uFFFD') && [...v].filter((c) => c !== '\uFFFD').length >= 2)).toBe(true);
    const hong = mojibakeVariants('홍길동').variants;
    const mixed = hong[hong.length - 1];
    expect(mixed).toContain('\uFFFD');
    expect(mixed).not.toMatch(/^\uFFFD*$/);
    // 사용자 이름이 홍길동 꼴 깨진 형태인 경우: 가짜 이름 갑돌(사용자) + 낱말 홍길동은 치환 값이라 쓸 수 없으니, 깨진 형태를 junk 로 쓰는 낱말로 시험
    const ctx = buildContext({ ...PX, env: { PLENUM_PRIVATE_WORDS: '갑돌' } });
    const g = mojibakeVariants('갑돌').variants;
    expect(redactString(`C:\\Users\\${g[g.length - 1]}\\x`, ctx)).toBe('C:\\Users\\홍길동\\x');
    // 홍길동 자체의 CP949→UTF-8 꼴이 홈 자리에 오면(USERPROFILE 이 그 꼴로 깨진 경우) U+FFFD 섞인 이름도 홍길동으로
    const ctx2 = buildContext({ ...PX, env: { USERPROFILE: `C:\\Users\\${mixed}` } });
    const r = redactString(`cwd C:\\\\Users\\\\${mixed}\\\\proj and ${mixed}`, ctx2);
    expect(r).toBe('cwd C:\\\\Users\\\\홍길동\\\\proj and 홍길동');
    expect(findRisks(r, ctx2)).toEqual([]);
  });

  test('M2: win32 에서 USERNAME(폴더 이름과 다름)도 맨 이름·경로로 치환, 흔한 이름은 맨 이름 제외', () => {
    const env = { USERPROFILE: 'C:\\Users\\gapdol', USERNAME: 'someone' };
    const ctx = buildContext({ ...PX, env, platform: 'win32' });
    expect(redactString('C:\\Users\\gapdol\\x someone-PC\\someone C:\\Users\\someone\\y', ctx)).toBe('C:\\Users\\홍길동\\x hong-PC\\hong C:\\Users\\홍길동\\y');
    expect(findRisks('login SOMEONE', ctx).length).toBeGreaterThan(0);
    expect(redactString('someone', buildContext({ ...PX, env, platform: 'linux' }))).toBe('someone');
    const gen = buildContext({ ...PX, env: { USERNAME: 'Admin' }, platform: 'win32' });
    expect(redactString('"role":"admin" C:\\Users\\Admin\\x', gen)).toBe('"role":"admin" C:\\Users\\홍길동\\x');
  });
});

describe('review 3차 반례', () => {
  const PX = { homedir: '/home/hong', tmpdir: '/tmp' };
  test('긴 사용자 이름부터: USERNAME=Kim + 폴더 Kim Gapdol 등이 통째로 홍길동, 검사 0건', () => {
    const cases: [string, string][] = [['Kim', 'Kim Gapdol'], ['Gapdol', 'Gapdol Kim'], ['gapdol', 'gapdol (old)']];
    for (const [user, folder] of cases) {
      const ctx = buildContext({ ...PX, env: { USERNAME: user, USERPROFILE: `C:\\Users\\${folder}` }, platform: 'win32' });
      expect(ctx.winNames[0], folder).toBe(folder);
      for (const sep of ['\\', '\\\\', '/']) {
        const r = redactString(`cwd C:${sep}Users${sep}${folder}${sep}proj`, ctx);
        expect(r, `${folder} ${sep}`).toBe(`cwd C:${sep}Users${sep}홍길동${sep}proj`);
        expect(findRisks(r, ctx), `${folder} ${sep}`).toEqual([]);
      }
      const bare = redactString(`login ${user}, folder ${folder}.`, ctx);
      expect(findRisks(bare, ctx), bare).toEqual([]);
    }
  });

  test('이름 끝에 U+FFFD 가 이어지면 이름의 일부: U+FFFD·깨진 형태로만 된 이름만 치환, 섞이면 막힘', () => {
    const ctx = buildContext({ ...PX, env: { USERPROFILE: 'C:\\Users\\Ab' } });
    const F = '\uFFFD';
    const mixed = redactString(`C:\\Users\\${F}${F}ab\\x`, ctx);
    expect(mixed).toBe(`C:\\Users\\${F}${F}ab\\x`);
    expect(findRisks(mixed, ctx)).toEqual(['홍길동 아닌 Windows 사용자 폴더(Windows 사용자 폴더)']);
    const tail = redactString(`C:\\Users\\Ab${F}\\x`, ctx);
    expect(tail).toBe(`C:\\Users\\Ab${F}\\x`);                 // Ab 만 바꾸고 U+FFFD 를 남기지 않는다
    expect(findRisks(tail, ctx).length).toBeGreaterThan(0);
    expect(findRisks(`C:\\Users\\홍길동${F}\\x`, ctx).length).toBeGreaterThan(0);
    expect(redactString(`C:\\Users\\${F}${F}\\x`, ctx)).toBe('C:\\Users\\홍길동\\x');
  });
});

describe('scan', () => {
  const words = ['zorblax', '갑돌'];
  const forms = formsOf(words);
  const { forms: bforms } = byteFormsOf(words);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plenum-scan-홍길동-'));
  const repo = path.join(tmp, '레포');
  const g = (...a: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(tmp, 'nohooks')}`, ...a], {
    cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.invalid', GIT_COMMITTER_NAME: 'C', GIT_COMMITTER_EMAIL: 'c@example.invalid' },
  }).toString('utf8');
  const put = (rel: string, data: string | Buffer) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), data); };
  fs.mkdirSync(repo);
  g('init', '-q');
  put('clean.txt', 'nothing here\n');
  put('app/test/fixtures/providers/claude/9.9.9/ok.jsonl', '{"a":"홍길동"}\n');
  g('add', '.'); g('commit', '-q', '-m', 'first');
  const base = g('rev-parse', 'HEAD').trim();
  put('a.txt', 'line1\nhello ZorBlax\n');
  put('gone.txt', 'x\n갑돌\n');                                         // HEAD 에만 남기고 디스크에서 지운다
  put('u16.txt', Buffer.from('xx 갑돌 yy', 'utf16le'));                     // UTF-16LE
  put('cp949.txt', Buffer.concat([Buffer.from('name='), Buffer.from([0xb0, 0xa9, 0xb5, 0xb9]), Buffer.from('\n')]));   // CP949 원본 두 글자
  put('esc.json', '{"n":"\\uAC11\\uB3CC"}\n');                                // JSON 이스케이프(대문자 hex)
  put('app/test/fixtures/providers/claude/9.9.9/bom.jsonl', '\uFEFF{"a":1}\n');    // fail-closed
  g('add', '.'); g('commit', '-q', '-m', 'second 갑돌');
  const second = g('rev-parse', 'HEAD').trim().slice(0, 12);
  fs.rmSync(path.join(repo, 'gone.txt'));
  const run = (args: string[], w: string) => spawnSync(process.execPath, ['--import', 'tsx', '../tools/probe/scan.ts', ...args],
    { cwd: APP, env: { ...process.env, PLENUM_PRIVATE_WORDS: w }, encoding: 'utf8', timeout: 60000 });

  test('순수 함수: log 의 커밋·diff 파일, 블롭의 파일:줄, 경로 이름 가림, 바이트 형태, 모양 요약', () => {
    expect(forms.filter((f) => f.word === 1).length).toBe(1);
    expect(forms.filter((f) => f.word === 2).map((f) => f.text)).toContain('\\uac11\\ub3cc');
    expect(bforms.map((f) => `${f.word}/${f.kind}`)).toEqual(['1/utf8', '1/utf16le', '2/utf8', '2/utf16le', '2/cp949']);
    const log = `commit ${'a'.repeat(40)}\nAuthor: x zorblax\n\n    msg\ndiff --git a/p.txt b/p.txt\n+갑돌\ndiff --git a/zorblax.txt b/zorblax.txt\n+ok\n`;
    expect(scanLog(log, forms)).toEqual([`낱말 #1 형태 1: 커밋 ${'a'.repeat(12)} (커밋 머리·메시지)`, `낱말 #2 형태 1: 커밋 ${'a'.repeat(12)} p.txt`, `낱말 #1 형태 1: 커밋 ${'a'.repeat(12)} (경로에 낱말이 있어 가림)`]);
    const u16log = Buffer.concat([Buffer.from(`commit ${'b'.repeat(40)}\ndiff --git a/u.txt b/u.txt\n+`), Buffer.from('갑돌', 'utf16le'), Buffer.from('\n')]);
    expect(scanLog(u16log, forms, bforms)).toEqual([`낱말 #2 바이트 utf16le: 커밋 ${'b'.repeat(12)} u.txt`]);
    expect(scanFile('d/f.txt', Buffer.from('a\nb ZORBLAX\n'), forms)).toEqual(['낱말 #1 형태 1: d/f.txt:2']);
    expect(scanFile('zorblax/f.txt', Buffer.from('ok'), forms)).toEqual(['낱말 #1 형태 1: (파일 이름) (경로에 낱말이 있어 가림)']);
    expect(scanFile('b.bin', Buffer.from([0, 0x7a, 0x6f, 0x72, 0x62, 0x6c, 0x61, 0x78]), forms, bforms)).toEqual(['낱말 #1 바이트 utf8: b.bin']);
    expect(scanFile('app/test/fixtures/providers/x.jsonl', Buffer.from([0x7b, 0xb0, 0x7d]), forms)).toEqual(['fail-closed: app/test/fixtures/providers/x.jsonl — 올바른 UTF-8 이 아님']);
    expect(scanFile('other/x.jsonl', Buffer.from([0x7b, 0xb0, 0x7d]), forms)).toEqual([]);
    expect(scanLog('', forms)).toEqual([]);
    expect(wordShape('갑돌 Kim·')).toBe('한글 2자 / ASCII 4자 / 그 밖 1자');
    expect(parseLsTree(Buffer.from('100644 blob abc123\tb 한.txt\u0000100644 blob def456\ta.txt\u0000160000 commit 999\tsub\u0000'))).toEqual([['a.txt', 'def456'], ['b 한.txt', 'abc123']]);
    expect(() => scanParseArgs(['--range'])).toThrow();
    expect(scanParseArgs([])).toEqual({ range: '1b8402f..HEAD', repo: null });
  });

  test('CLI: HEAD 블롭(디스크에서 지운 것 포함)·UTF-16LE·CP949 원본·JSON 이스케이프·fail-closed 를 잡고, 출력에 낱말을 찍지 않는다', () => {
    const r = run(['--repo', repo, '--range', `${base}..HEAD`], words.join(','));
    expect(r.status, r.stderr).toBe(1);
    const out = r.stdout + r.stderr;
    expect(out).toContain('낱말 #1: 한글 0자 / ASCII 7자 / 그 밖 0자');
    expect(out).toContain('낱말 #2: 한글 2자 / ASCII 0자 / 그 밖 0자');
    expect(out).toContain('경고: 작업 트리가 HEAD 와 다르다 — 검사는 HEAD 기준');
    expect(out).toContain(`낱말 #1 형태 1: 커밋 ${second} a.txt`);
    expect(out).toContain(`낱말 #2 형태 1: 커밋 ${second} (커밋 머리·메시지)`);
    expect(out).toContain(`낱말 #2 바이트 utf16le: 커밋 ${second} u16.txt`);
    expect(out).toContain(`낱말 #2 바이트 cp949: 커밋 ${second} cp949.txt`);
    expect(out).toContain('낱말 #1 형태 1: a.txt:2');
    expect(out).toContain('낱말 #2 형태 1: gone.txt:2');
    expect(out).toContain('낱말 #2 바이트 utf16le: u16.txt');
    expect(out).toContain('낱말 #2 바이트 cp949: cp949.txt');
    expect(out).toMatch(/낱말 #2 형태 \d+: esc\.json:1/);
    expect(out).toContain('fail-closed: app/test/fixtures/providers/claude/9.9.9/bom.jsonl — BOM 있음');
    expect(out).not.toContain('ok.jsonl');
    for (const f of forms) expect(out.toLowerCase().includes(f.text.toLowerCase()), `형태 ${f.word}/${f.form}`).toBe(false);
    for (const f of bforms) expect(Buffer.from(out, 'utf8').includes(f.bytes), `바이트 ${f.word}/${f.kind}`).toBe(false);
    expect(out).toMatch(/합계: 커밋 기록\(.*\) \d+건, HEAD 트리 \d+건/);
  });

  test('CLI: 낱말이 없어도 fail-closed 블롭이 있으면 1, 낱말이 비면 4, 없는 범위면 2', () => {
    expect(run(['--repo', repo, '--range', `${base}..HEAD`], 'qqqnotthere').status).toBe(1);   // bom.jsonl 은 낱말과 상관없이 실패
    const clean = run(['--repo', repo, '--range', `${base}..${base}`], 'qqqnotthere');
    expect(clean.stdout).toMatch(/fail-closed/);
    const e = run(['--repo', repo], '');
    expect(e.status).toBe(4);
    expect(e.stderr).toContain('PLENUM_PRIVATE_WORDS');
    expect(run(['--repo', repo, '--range', 'nope..HEAD'], 'x').status).toBe(2);
  });

  test('CLI: fail-closed 블롭이 없는 깨끗한 레포는 0', () => {
    const r2 = path.join(tmp, '깨끗');
    fs.mkdirSync(r2);
    const g2 = (...a: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(tmp, 'nohooks')}`, ...a], {
      cwd: r2, env: { ...process.env, GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@example.invalid', GIT_COMMITTER_NAME: 'C', GIT_COMMITTER_EMAIL: 'c@example.invalid' },
    });
    fs.writeFileSync(path.join(r2, 'a.txt'), 'ok\n');
    g2('init', '-q'); g2('add', '.'); g2('commit', '-q', '-m', 'x');
    const r = run(['--repo', r2, '--range', 'HEAD'], 'qqqnotthere');
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/합계: 커밋 기록\(HEAD\) 0건, HEAD 트리 0건/);
  });
});
