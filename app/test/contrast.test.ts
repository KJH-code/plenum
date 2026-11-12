// V7: theme.css 토큰의 모든 쌍 — 글자(--fg-*) 4.5:1, 테두리(--line-*) 3:1, 배경(--bg-*) 위에서.
// 계산식은 DevVault Knowledge/Frontend/명도 대비와 색조 의 lum·cr 그대로.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { APP } from './helpers.ts';

const css = fs.readFileSync(path.join(APP, 'web', 'src', 'theme.css'), 'utf8');
const root = /:root\s*\{([\s\S]*?)\}/.exec(css)![1];
const tokens: Record<string, string> = {};
for (const m of root.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)) tokens[m[1]] = m[2];

const hex = (h: string) => [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16) / 255);
const lum = (c: string) => { const [r, g, b] = hex(c).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const cr = (a: string, b: string) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
const pick = (p: string) => Object.keys(tokens).filter((k) => k.startsWith(p));

test('토큰을 읽었다 (0개면 아래 검사가 공짜로 통과한다)', () => {
  expect(pick('bg-').length).toBeGreaterThanOrEqual(4);
  expect(pick('fg-').length).toBeGreaterThanOrEqual(8);
  expect(pick('line-').length).toBeGreaterThanOrEqual(2);
});

test('모든 글자 토큰 × 모든 배경 토큰 ≥ 4.5:1', () => {
  const bad: string[] = [];
  for (const f of pick('fg-')) for (const b of pick('bg-')) {
    const r = cr(tokens[f], tokens[b]);
    if (r < 4.5) bad.push(`${f} on ${b} = ${r.toFixed(2)}`);
  }
  expect(bad).toEqual([]);
});

test('모든 테두리 토큰 × 모든 배경 토큰 ≥ 3:1', () => {
  const bad: string[] = [];
  for (const l of pick('line-')) for (const b of pick('bg-')) {
    const r = cr(tokens[l], tokens[b]);
    if (r < 3) bad.push(`${l} on ${b} = ${r.toFixed(2)}`);
  }
  expect(bad).toEqual([]);
});

test('주 버튼: 글자 4.5:1, 테두리는 배경 대비 3:1', () => {
  expect(cr(tokens['on-accent'], tokens['accent'])).toBeGreaterThanOrEqual(4.5);
  for (const b of pick('bg-')) expect(cr(tokens['line-accent'], tokens[b]), b).toBeGreaterThanOrEqual(3);
});

test('프로젝트 아이콘 배경 위 흰 글자 ≥ 4.5:1', () => {
  const icons = pick('icon-');
  expect(icons.length).toBe(5);
  for (const i of icons) expect(cr('#FFFFFF', tokens[i]), i).toBeGreaterThanOrEqual(4.5);
});

test('theme.css 밖 규칙에서 색을 직접 쓰지 않는다 (흰 글자 #FFFFFF 와 backdrop 제외)', () => {
  const body = css.slice(css.indexOf('}', css.indexOf(':root')) + 1);
  const raw = [...body.matchAll(/#[0-9A-Fa-f]{3,6}\b/g)].map((m) => m[0].toUpperCase()).filter((c) => c !== '#FFFFFF');
  expect(raw).toEqual([]);
});
