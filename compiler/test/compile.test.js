'use strict';
// 컴파일러: 기본 경로(cwd), 결정성, kit 전용 칸 제거, 토큰 렌더링, 실행 비트
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { copyFixture, compile } = require('./lib/run');
const { listFiles, compareTrees, makeTmp, rmTmp } = require('./lib/tree');

let tmp, kit;
before(() => { tmp = makeTmp('plenum-compile-'); kit = copyFixture(tmp); });
after(() => rmTmp(tmp));

test('인자 없이 부르면 <cwd>/kit → <cwd>/build/claude-code', () => {
  const r = compile([], { cwd: tmp });
  assert.strictEqual(r.status, 0, r.stderr);
  const files = listFiles(path.join(tmp, 'build', 'claude-code'));
  assert.deepStrictEqual(files, ['.claude-plugin/plugin.json', 'GENERATED.md', 'README.md', 'agents/impl.md', 'agents/rev.md',
    'hooks/h.js', 'hooks/hooks.json', 'scripts/s.js', 'skills/demo/SKILL.md']);
});

test('같은 kit을 두 번 빌드하면 바이트가 같다', () => {
  const a = path.join(tmp, 'a'); const b = path.join(tmp, 'b');
  assert.strictEqual(compile(['--kit', kit, '--out', a]).status, 0);
  assert.strictEqual(compile(['--kit', kit, '--out', b]).status, 0);
  const d = compareTrees(a, b, { allowExtra: [] });
  assert.deepStrictEqual([d.different, d.missing, d.extra], [[], [], []]);
  assert.strictEqual(d.compared, 9);
});

test('kit 전용 칸(provider·label·memo·stage·summary)은 빠지고 나머지 머리말 줄은 원문 그대로', () => {
  const out = path.join(tmp, 'k');
  assert.strictEqual(compile(['--kit', kit, '--out', out]).status, 0);
  const rev = fs.readFileSync(path.join(out, 'agents', 'rev.md'), 'utf8');
  assert.ok(!/^(provider|label|memo|stage|summary):/m.test(rev), rev);
  assert.match(rev, /^isolation: worktree$/m);
  assert.match(rev, /^description: 리뷰 워커 \(Opus xhigh\)\. 테스트용\.$/m);
  const impl = fs.readFileSync(path.join(out, 'agents', 'impl.md'), 'utf8');
  assert.ok(!/^memo:/m.test(impl));
});

test('표·계층 표·워커 값 토큰이 채워진다', () => {
  const out = path.join(tmp, 't');
  assert.strictEqual(compile(['--kit', kit, '--out', out]).status, 0);
  const skill = fs.readFileSync(path.join(out, 'skills', 'demo', 'SKILL.md'), 'utf8');
  assert.match(skill, /^\| 구현 \(Sonnet\) \| `impl` \| sonnet \| medium \|$/m);
  assert.match(skill, /^\| 리뷰 \| `rev` \| opus \| xhigh \|$/m);
  const hook = fs.readFileSync(path.join(out, 'hooks', 'h.js'), 'utf8');
  assert.match(hook, /impl: 'sonnet'/);
  const readme = fs.readFileSync(path.join(out, 'README.md'), 'utf8');
  assert.match(readme, /Sonnet medium/);
  for (const f of listFiles(out)) assert.ok(!fs.readFileSync(path.join(out, f), 'utf8').includes('{{'), `${f}에 토큰이 남았다`);
  const plugin = JSON.parse(fs.readFileSync(path.join(out, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.deepStrictEqual([plugin.name, plugin.version], ['demo-kit', '0.0.1']);
});

test('실행 비트는 kit 파일 그대로 (훅 755, 나머지 644)', { skip: process.platform === 'win32' ? 'Windows에는 실행 비트가 없다' : false }, () => {
  const out = path.join(tmp, 'm');
  assert.strictEqual(compile(['--kit', kit, '--out', out]).status, 0);
  assert.strictEqual(fs.statSync(path.join(out, 'hooks', 'h.js')).mode & 0o777, 0o755);
  assert.strictEqual(fs.statSync(path.join(out, 'README.md')).mode & 0o777, 0o644);
});

test('--json은 파일 수와 경고를 한 줄로', () => {
  const r = compile(['--kit', kit, '--out', path.join(tmp, 'j'), '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(r.json, { files: 9, warnings: [] });
});
