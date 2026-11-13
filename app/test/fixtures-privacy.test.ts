// 공개 레포: 진짜 claude 녹화·세션 기록 fixture 에 개인 정보가 들어가지 않았는지 검사한다.
// 실명은 여기에 적을 수 없어서(이 파일도 공개) 두 가지로 막는다:
//   1) 홈 경로 자체를 막는다 — Windows `X:\Users\…`, macOS `/Users/…`, `/root/`, `/home/<hong 아님>`. 실명은 보통 홈 경로로 새어 든다
//   2) PLENUM_PRIVATE_WORDS(쉼표로 구분, 노트북·CI 비밀 변수)에 적은 낱말이 있으면 실패
// 이메일은 example.invalid·GitHub noreply·noreply@anthropic.com 만 허용한다.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { APP } from './helpers.ts';

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
  ['Windows 사용자 폴더', /[A-Za-z]:(?:\\\\|\\|\/)+Users(?:\\\\|\\|\/)/i],
  ['macOS 사용자 폴더', /(?<![A-Za-z])\/Users\//],
  ['/root 홈', /(?<![A-Za-z0-9_-])\/root\//],
  ['hong 아닌 /home', /\/home\/(?!hong\/)[^/"\\\s]+\//],
];

test('검사할 fixture 가 있다 (0개면 아래 검사가 공짜로 통과한다)', () => {
  expect(all.filter((f) => f.endsWith('.jsonl')).length).toBeGreaterThanOrEqual(10);
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

test('PLENUM_PRIVATE_WORDS 에 적은 낱말(실명 등)이 없다', () => {
  const words = (process.env.PLENUM_PRIVATE_WORDS || '').split(',').map((w) => w.trim()).filter(Boolean);
  const bad: string[] = [];
  for (const f of all) { const t = fs.readFileSync(f, 'utf8'); for (const w of words) if (t.includes(w)) bad.push(`${rel(f)}: 비공개 낱말 #${words.indexOf(w) + 1}`); }
  expect(bad).toEqual([]);
});

test('검사 규칙이 실제로 잡는다 (규칙이 아무것도 못 잡으면 위 통과가 거짓말)', () => {
  expect('mail me at someone@gmail.com'.match(EMAIL)?.[0]).toBe('someone@gmail.com');
  expect(ALLOWED_EMAIL.test('someone@gmail.com')).toBe(false);
  expect(ALLOWED_EMAIL.test('hong@example.invalid')).toBe(true);
  expect(HOME_PATHS[0][1].test('"cwd":"C:\\\\Users\\\\누군가\\\\proj"')).toBe(true);
  expect(HOME_PATHS[0][1].test('C:\\Users\\누군가')).toBe(true);
  expect(HOME_PATHS[1][1].test('/Users/someone/x')).toBe(true);
  expect(HOME_PATHS[3][1].test('/home/someone/x')).toBe(true);
  expect(HOME_PATHS[3][1].test('/home/hong/.claude')).toBe(false);
});
