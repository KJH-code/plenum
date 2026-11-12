'use strict';
// pack: zip 내용·결정성·이름·실행 비트·CRLF 정규화
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { copyFixture, compile, pack } = require('./lib/run');
const { listFiles, makeTmp, rmTmp, copyDir } = require('./lib/tree');
const { readZip } = require('./lib/zip');

let tmp, build;
before(() => {
  tmp = makeTmp('plenum-pack-');
  copyFixture(tmp);
  const r = compile([], { cwd: tmp });
  assert.strictEqual(r.status, 0, r.stderr);
  build = path.join(tmp, 'build', 'claude-code');
});
after(() => rmTmp(tmp));

function packTo(out, from = build) {
  const r = pack(['--build', from, '--out', out]);
  assert.strictEqual(r.status, 0, r.stderr);
  return readZip(fs.readFileSync(out));
}
const countCR = (files) => [...files.values()].reduce((s, b) => s + b.filter((x) => x === 0x0d).length, 0);
const EXEC = ['hooks/h.js', 'scripts/s.js'];

test('인자 없이 부르면 <cwd>/dist/<plugin name>-<version>.zip', () => {
  const r = pack([], { cwd: tmp });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^dist\/demo-kit-0\.0\.1\.zip \(9 files\)\s*$/);
  assert.ok(fs.existsSync(path.join(tmp, 'dist', 'demo-kit-0.0.1.zip')));
});

test('zip의 파일 목록·내용이 build와 같다', () => {
  const { files, order } = packTo(path.join(tmp, 'a.zip'));
  assert.deepStrictEqual(order, listFiles(build));
  for (const n of order) assert.ok(files.get(n).equals(fs.readFileSync(path.join(build, n))), n);
});

test('두 번 pack하면 바이트가 같다', () => {
  packTo(path.join(tmp, 'x1.zip')); packTo(path.join(tmp, 'x2.zip'));
  assert.ok(fs.readFileSync(path.join(tmp, 'x1.zip')).equals(fs.readFileSync(path.join(tmp, 'x2.zip'))));
});

test('훅·스크립트 .js 는 755, 나머지 644', () => {
  const { modes } = packTo(path.join(tmp, 'm.zip'));
  for (const n of EXEC) assert.strictEqual(modes.get(n), 0o755, n);
  assert.strictEqual(modes.get('hooks/hooks.json'), 0o644);
  assert.strictEqual(modes.get('README.md'), 0o644);
});

test('Windows 체크아웃 흉내(CRLF + 실행 비트 없음)로 묶어도 같은 zip, CR 0개', () => {
  const win = path.join(tmp, 'win-build');
  copyDir(build, win);
  let converted = 0;
  for (const n of listFiles(win)) {
    const p = path.join(win, n);
    const s = fs.readFileSync(p, 'utf8');
    if (s.includes('\n')) { fs.writeFileSync(p, s.replace(/\n/g, '\r\n')); converted++; }
    fs.chmodSync(p, 0o644);
  }
  assert.ok(converted > 0);
  const a = path.join(tmp, 'lf.zip'); const b = path.join(tmp, 'crlf.zip');
  packTo(a);
  const zb = packTo(b, win);
  assert.strictEqual(countCR(zb.files), 0);
  for (const n of EXEC) assert.strictEqual(zb.modes.get(n), 0o755, n);
  assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)));
});

test('없는 build 폴더는 ERROR(종료 1)', () => {
  const r = pack(['--build', path.join(tmp, '없는폴더')]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /^ERROR build 폴더가 없다/m);
});

const hasUnzip = spawnSync('unzip', ['-v']).status === 0;
test('unzip -t 통과', { skip: hasUnzip ? false : 'unzip이 없다' }, () => {
  const z = path.join(tmp, 'u.zip');
  packTo(z);
  const r = spawnSync('unzip', ['-t', z], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});
