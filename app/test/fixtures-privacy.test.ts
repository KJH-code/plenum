// 공개 레포: 진짜 claude 녹화·세션 기록 fixture 에 개인 정보가 들어가지 않았는지 검사한다.
// 실명을 작성자·크레딧으로 쓰는 것은 괜찮다(재혁 결정 2026-11-15). 막는 것은 계정에 닿는 정보다:
//   1) 홈 경로 자체를 막는다 — Windows `X:\Users\…`, macOS `/Users/…`, `/root/`, `/home/<hong 아님>`
//   1-1) 계정·조직 UUID — `organizationUuid`·`accountUuid` 같은 칸의 0 아닌 UUID, 플러그인 경로 `synced/<uuid>_<uuid>`
//   2) PLENUM_PRIVATE_WORDS(쉼표로 구분, 노트북·CI 비밀 변수)에 적은 낱말이 있으면 실패
// 이메일은 example.invalid·GitHub noreply·noreply@anthropic.com 만 허용한다.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { APP } from './helpers.ts';
import { RATE_CREDIT_LEFT, WIN_HOME_CHECKS, escapeForms, fixtureBytesProblem, hasWord, mojibakeVariants, privateWordsFromEnv } from '../../tools/probe/variants.ts';

const ROOT = path.join(APP, 'test', 'fixtures');
function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}
const all = files(ROOT);
const rel = (p: string) => path.relative(ROOT, p);

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL = /(@example\.invalid|@users\.noreply\.github\.com|^noreply@anthropic\.com)$/i;
const HOME_PATHS: [string, RegExp][] = [
  // Windows 홈 4형태(X:\Users\·/c/Users/·//c/Users/·/mnt/c/Users/·평탄화 C--Users-) — redact 와 같은 규칙(tools/probe/variants.ts).
  // 예외: 녹화에서 홈을 치환한 `홍길동` 하나만(JSON 이스케이프·슬래시·드라이브·대소문자 무관). `홍길동x`·`홍길동2` 는 막힌다
  ...WIN_HOME_CHECKS,
  ['macOS 사용자 폴더', /(?<![A-Za-z])\/Users\//],
  ['/root 홈', /(?<![A-Za-z0-9_-])\/root\//],
  ['hong 아닌 /home', /\/home\/(?!hong\/)[^/"\\\s]+\//],
];

test('검사할 fixture 가 있다 (0개면 아래 검사가 공짜로 통과한다)', () => {
  expect(all.filter((f) => f.endsWith('.jsonl')).length).toBeGreaterThanOrEqual(10);
});

// fail-closed: 녹화 fixture 는 올바른 UTF-8·BOM 없음·NUL 없음만 받는다(깨진 바이트 속 낱말을 쫓아가지 않고 막는다)
test('녹화 fixture(providers/**)는 올바른 UTF-8 이고 BOM·NUL 이 없다', () => {
  const strict = all.filter((f) => rel(f).split(path.sep)[0] === 'providers');
  expect(strict.length).toBeGreaterThan(0);
  const bad: string[] = [];
  for (const f of strict) { const p = fixtureBytesProblem(fs.readFileSync(f)); if (p) bad.push(`${rel(f)}: ${p}`); }
  expect(bad).toEqual([]);
});

test('fixture 에 허용 목록 밖 이메일이 없다', () => {
  const bad: string[] = [];
  for (const f of all) for (const m of fs.readFileSync(f, 'utf8').matchAll(EMAIL)) if (!ALLOWED_EMAIL.test(m[0])) bad.push(`${rel(f)}: ${m[0]}`);
  expect([...new Set(bad)]).toEqual([]);
});

test('fixture 에 실제 홈 경로(C:\\Users\\ 등)가 없다', () => {
  const bad: string[] = [];
  for (const f of all) {
    const t = fs.readFileSync(f, 'utf8');
    for (const [name, re] of HOME_PATHS) { const m = re.exec(t); if (m) bad.push(`${rel(f)}: ${name} "${t.slice(Math.max(0, m.index - 20), m.index + 40)}"`); }
  }
  expect(bad).toEqual([]);
});

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ACCOUNT_FIELD = new RegExp(`"(organization|account|user|org)_?[Uu]uid"\\s*:\\s*"(${UUID})"`, 'gi');
const SYNCED_PATH = new RegExp(`synced[\\\\/]+${UUID}_${UUID}`, 'i');
const isZero = (u: string) => /^[0-]+[0-9]?$/.test(u.replace(/-4000-8000-/, '-0000-0000-')); // 치환에 쓴 00000000-0000-4000-8000-00000000000x

test('fixture 에 계정·조직 UUID 가 없다 (치환한 0 UUID 만 허용)', () => {
  const bad: string[] = [];
  for (const f of all) {
    const t = fs.readFileSync(f, 'utf8');
    for (const m of t.matchAll(ACCOUNT_FIELD)) if (!isZero(m[2])) bad.push(`${rel(f)}: ${m[0].slice(0, 60)}`);
    if (SYNCED_PATH.test(t)) bad.push(`${rel(f)}: 플러그인 경로에 조직·계정 UUID`);
  }
  expect(bad).toEqual([]);
});

// 비밀이 비어 있으면(포크 PR, 비밀 없는 로컬) 이 검사만 건너뛴다 — 이메일·경로 검사는 위에서 그대로 돈다
// 낱말마다 깨진 형태(UTF-8→Latin-1 등 4종)도 같이 찾는다
const words = privateWordsFromEnv();
function wordHits(text: string, ws: string[]): string[] {
  const bad: string[] = [];
  ws.forEach((w, i) => {
    if (hasWord(text, w)) bad.push(`낱말 #${i + 1}`);    // ASCII 낱말은 대소문자 무시
    mojibakeVariants(w).variants.forEach((v, k) => { if (hasWord(text, v)) bad.push(`낱말 #${i + 1} 깨진 형태 ${k + 1}`); });
    escapeForms(w).forEach((v, k) => { if (text.includes(v)) bad.push(`낱말 #${i + 1} JSON 이스케이프 ${k + 1}`); });
  });
  return bad;
}
const RATE_CREDIT = RATE_CREDIT_LEFT;
test.skipIf(words.length === 0)('PLENUM_PRIVATE_WORDS 에 적은 낱말(이메일 아이디 등)과 그 깨진 형태가 없다', () => {
  for (const w of words) for (const warn of mojibakeVariants(w).warnings) console.warn(`낱말 #${words.indexOf(w) + 1}: ${warn}`);
  const bad: string[] = [];
  for (const f of all) for (const h of wordHits(fs.readFileSync(f, 'utf8'), words)) bad.push(`${rel(f)}: ${h}`);
  expect(bad).toEqual([]);
});

test('fixture 에 RateLimitResetCredit 실제 값이 없다 (치환 값은 RateLimitResetCredit_0)', () => {
  const bad: string[] = [];
  for (const f of all) if (RATE_CREDIT.test(fs.readFileSync(f, 'utf8'))) bad.push(rel(f));
  expect(bad).toEqual([]);
});

test('검사 규칙이 실제로 잡는다 (규칙이 아무것도 못 잡으면 위 통과가 거짓말)', () => {
  expect('mail me at someone@gmail.com'.match(EMAIL)?.[0]).toBe('someone@gmail.com');
  expect(ALLOWED_EMAIL.test('someone@gmail.com')).toBe(false);
  expect(ALLOWED_EMAIL.test('hong@example.invalid')).toBe(true);
  const rule = (name: string) => HOME_PATHS.find(([n]) => n === name)![1];
  const anyHome = (s: string) => HOME_PATHS.some(([, re]) => re.test(s));
  expect(rule('Windows 사용자 폴더').test('"cwd":"C:\\\\Users\\\\누군가\\\\proj"')).toBe(true);
  expect(rule('Windows 사용자 폴더').test('C:\\Users\\누군가')).toBe(true);
  expect(rule('macOS 사용자 폴더').test('/Users/someone/x')).toBe(true);
  expect(rule('hong 아닌 /home').test('/home/someone/x')).toBe(true);
  expect(rule('hong 아닌 /home').test('/home/hong/.claude')).toBe(false);
  const fakeOrg = '"organizationUuid":"12345678-9abc-4def-8123-456789abcdef"';
  expect([...fakeOrg.matchAll(ACCOUNT_FIELD)].map((m) => isZero(m[2]))).toEqual([false]);
  expect([...'"accountUuid":"00000000-0000-4000-8000-000000000001"'.matchAll(ACCOUNT_FIELD)].map((m) => isZero(m[2]))).toEqual([true]);
  expect(SYNCED_PATH.test('/home/hong/.claude/plugins/synced/12345678-9abc-4def-8123-456789abcdef_12345678-9abc-4def-8123-456789abcdef/jh-kit')).toBe(true);
  expect(SYNCED_PATH.test('/home/hong/.claude/plugins/synced/ORG_ACCOUNT/jh-kit')).toBe(false);
  // Windows 홈: 홍길동 치환만 예외
  const win = rule('Windows 사용자 폴더');
  for (const ok of ['"cwd":"C:\\\\Users\\\\홍길동\\\\proj"', 'C:\\Users\\홍길동\\x', 'c:/users/홍길동/x', 'D:\\USERS\\홍길동\\x']) expect(win.test(ok), ok).toBe(false);
  for (const bad of ['C:\\Users\\누군가\\x', 'C:\\\\Users\\\\홍길동2\\\\x', 'C:\\Users\\홍길동x\\y', 'E:/Users/someone/x']) expect(win.test(bad), bad).toBe(true);
  // 이름 끝(L2): 공백·'·)·문장 끝 '.' 는 끝, '.'+글자는 다른 이름
  for (const ok of ['C:\\Users\\홍길동 x', "'C:\\Users\\홍길동'", '(C:\\Users\\홍길동)', 'C:\\Users\\홍길동.', 'C:\\Users\\홍길동', 'C:\\Users\\홍길동~1']) expect(anyHome(ok), ok).toBe(false);
  for (const bad of ['C:\\Users\\홍길동.txt', 'C:\\Users\\홍길동_2', 'C:\\Users\\홍길동-x']) expect(anyHome(bad), bad).toBe(true);
  // 다른 형태(M1): //c/Users·/c/Users·/mnt/c/Users·평탄화. 홍길동(평탄화는 --- 또는 홍길동)만 예외
  // 앞이 ':' 여도 잡는다(git bash PATH=/usr/bin:/c/Users/…). 드라이브 꼴 C:/Users/홍길동 은 이 규칙에 걸리지 않는다
  expect(rule('드라이브 경로 /c/Users·//c/Users').test('PATH=/usr/bin:/c/Users/someone/bin')).toBe(true);
  expect(rule('드라이브 경로 /c/Users·//c/Users').test('PATH=/usr/bin:/c/Users/홍길동/bin')).toBe(false);
  for (const ok of ['C:/Users/홍길동/x', 'C:/Users/someone/x', 'C:\\Users\\someone']) expect(rule('드라이브 경로 /c/Users·//c/Users').test(ok), ok).toBe(false);
  for (const bad of ['Read(//c/Users/someone/.claude)', '/c/Users/someone/x', '/mnt/c/Users/someone/x', 'C--Users-someone-proj', 'C--Users---gd-proj', '/mnt/d/Users/홍길동2/x']) expect(anyHome(bad), bad).toBe(true);
  for (const ok of ['Read(//c/Users/홍길동/.claude)', '/c/Users/홍길동/x', '/mnt/c/Users/홍길동/x', 'C--Users-----proj', 'C--Users-홍길동-proj', 'C:\\T\\plenum-rec-----AbCdEf', 'abc/Users/x']) expect(anyHome(ok), ok).toBe(false);
  // 깨진 형태 생성기·검사기 (env 없이도 도는 고정 예시)
  const mv = mojibakeVariants('홍길동');
  // 홍길동의 CP949 바이트는 전부 0xA0 이상이라 Latin-1 과 CP1252 읽기가 같아 중복 제거로 하나, 그리고 CP949→UTF-8(U+FFFD 섞임) 하나 → 4개.
  // CP949 불가 환경이면 2개 + warning
  expect(mv.variants.length === 4 || (mv.variants.length === 2 && mv.warnings.length > 0)).toBe(true);
  expect(mv.variants.length === 4 ? mv.warnings : []).toEqual([]);
  if (mv.variants.length === 4) expect(mv.variants[3]).toBe(new TextDecoder('utf-8').decode(Uint8Array.from([0xc8, 0xab, 0xb1, 0xe6, 0xb5, 0xbf])));
  // U+FFFD 만 남는 형태는 빼고(정보 없음 — 오탐), 섞인 형태는 남긴다
  for (const w of ['갑돌', '갑돌이네', '홍길동']) expect(mojibakeVariants(w).variants.every((v) => !/^\uFFFD*$/.test(v)), w).toBe(true);
  expect(mv.variants[0]).toBe(Buffer.from('홍길동', 'utf8').toString('latin1'));
  expect(mv.variants).not.toContain('홍길동');
  expect(new Set(mv.variants).size).toBe(mv.variants.length);
  for (const v of mv.variants) expect(wordHits(`xx ${v} yy`, ['홍길동']).length).toBeGreaterThan(0);
  expect(wordHits('홍길동', ['홍길동'])).toEqual(['낱말 #1']);
  expect(wordHits('아무 상관 없는 글', ['홍길동'])).toEqual([]);
  // ASCII 낱말은 대소문자 무시(H1), 한글은 그대로
  expect(wordHits('Hi GapDol!', ['gapdol'])).toEqual(['낱말 #1']);
  expect(wordHits('xx', ['gapdol'])).toEqual([]);
  // JSON \uXXXX 이스케이프 꼴(소문자·대문자 hex)
  expect(wordHits('{"a":"\\uac11\\ub3cc"}', ['갑돌'])).toEqual(['낱말 #1 JSON 이스케이프 1']);
  expect(wordHits('{"a":"\\uAC11\\uB3CC"}', ['갑돌'])).toEqual(['낱말 #1 JSON 이스케이프 2']);
  // fail-closed 바이트 규칙: BOM·NUL·잘못된 UTF-8 각각 잡고, 정상 UTF-8 은 통과
  expect(fixtureBytesProblem(Buffer.from('\uFEFF{"a":1}\n', 'utf8'))).toBe('BOM 있음');
  expect(fixtureBytesProblem(Buffer.from([0x7b, 0x00, 0x7d]))).toBe('NUL 바이트 있음');
  expect(fixtureBytesProblem(Buffer.from('갑돌', 'utf16le'))).not.toBeNull();
  expect(fixtureBytesProblem(Buffer.from([0x7b, 0xb0, 0xa9, 0x7d]))).toBe('올바른 UTF-8 이 아님');
  expect(fixtureBytesProblem(Buffer.from('{"a":"홍길동 \uFFFD"}\n', 'utf8'))).toBeNull();
  expect(fixtureBytesProblem(Buffer.alloc(0))).toBeNull();
  expect(mojibakeVariants('abc').variants).toEqual([]);
  expect(privateWordsFromEnv({ PLENUM_PRIVATE_WORDS: ' a, ,b ,' })).toEqual(['a', 'b']);
  expect(RATE_CREDIT.test('RateLimitResetCredit_1a2b')).toBe(true);
  expect(RATE_CREDIT.test('RateLimitResetCredit_0')).toBe(false);
  expect(RATE_CREDIT.test('"RateLimitResetCredit_0"')).toBe(false);
  expect(RATE_CREDIT.test('RateLimitResetCredit_0a')).toBe(true);
  expect(RATE_CREDIT.test('ratelimitresetcredit_Zq-9')).toBe(true);
  expect(RATE_CREDIT.test('RateLimitResetCredit_0-x')).toBe(true);
  expect(RATE_CREDIT.test('RateLimitResetCredit_0 ')).toBe(false);
});
