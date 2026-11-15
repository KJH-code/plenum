// Windows·macOS 파일 시스템은 대소문자를 가리지 않는다. 이름이 대소문자만 다른 파일이 있으면
// import './Markdown' 이 Markdown.tsx 대신 markdown.ts 로 풀려 Windows 에서만 빌드가 깨진다(0.3.0 CI 에서 실제로 남).
// 확장자를 뺀 이름이 대소문자만 다른 파일이 레포(앱 소스·테스트·서버)에 없는지 본다.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { APP } from './helpers.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'fixtures') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

test('확장자를 뺀 이름이 대소문자만 다른 파일이 같은 폴더에 없다', () => {
  const byKey = new Map<string, Set<string>>();
  let n = 0;
  for (const top of ['web', 'server', 'test', 'e2e']) for (const f of walk(path.join(APP, top))) {
    n++;
    const dir = path.dirname(f), stem = path.basename(f).replace(/\.[^.]+$/, '');
    const key = path.join(dir, stem.toLowerCase());
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key)!.add(path.relative(APP, path.join(dir, stem)));
  }
  expect(n).toBeGreaterThan(30);
  expect([...byKey.values()].filter((s) => s.size > 1).map((s) => [...s].sort().join(' ↔ '))).toEqual([]);
});
