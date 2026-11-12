'use strict';
// ERROR(종료 1)와 WARN(종료 0) 장면. 망가뜨린 fixture 사본마다 따로 빌드한다
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { copyFixture, compile, edit } = require('./lib/run');
const { makeTmp, rmTmp } = require('./lib/tree');

let tmp;
before(() => { tmp = makeTmp('plenum-errors-'); });
after(() => rmTmp(tmp));

let n = 0;
function broken(change) {
  const dir = path.join(tmp, `case-${n++}`);
  fs.mkdirSync(dir);
  const kit = copyFixture(dir);
  change(kit);
  return compile(['--kit', kit, '--out', path.join(dir, 'out'), '--json']);
}
const W = (kit, name) => path.join(kit, 'workers', `${name}.md`);

const ERRORS = [
  ['stage 없음', (k) => edit(W(k, 'impl'), /^stage: .*\n/m, ''), /workers\/impl\.md: stage가 없음/],
  ['stage 오타', (k) => edit(W(k, 'impl'), 'stage: 구현', 'stage: 구현함'), /stage "구현함"가 kit\.yaml stages에 없음/],
  ['summary 없음', (k) => edit(W(k, 'rev'), /^summary: .*\n/m, ''), /workers\/rev\.md: summary가 없음/],
  ['stages 목록 없음', (k) => edit(path.join(k, 'kit.yaml'), /^stages: .*\n/m, ''), /kit\.yaml stages는 비어 있지 않은 문자열 목록/],
  ['처음 쓰는 계층', (k) => edit(W(k, 'impl'), 'effort: medium', 'effort: high'), /계층 행 없음: Sonnet high/],
  ['모르는 머리말 칸', (k) => edit(W(k, 'impl'), 'stage: 구현', 'stage: 구현\nowner: me'), /모르는 머리말 칸 "owner"/],
  ['모드에 없는 워커', (k) => edit(path.join(k, 'modes', 'demo.yaml'), 'worker: rev', 'worker: nobody'), /없는 워커 nobody/],
  ['fallback에 없는 워커', (k) => fs.appendFileSync(path.join(k, 'modes', 'demo.yaml'), 'fallback: [nobody]\n'), /fallback: 없는 워커 nobody/],
  ['fallback이 slots와 겹침', (k) => fs.appendFileSync(path.join(k, 'modes', 'demo.yaml'), 'fallback: [rev]\n'), /fallback: rev는 이미 slots에 있음/],
  ['없는 표 토큰', (k) => edit(path.join(k, 'skills', 'demo', 'SKILL.md'), '{{workers_table:demo}}', '{{workers_table:nope}}'), /nope/],
];

for (const [label, change, re] of ERRORS) {
  test(`ERROR: ${label}`, () => {
    const r = broken(change);
    assert.strictEqual(r.status, 1, `${label}: 성공하면 안 된다\n${r.stdout}`);
    assert.match(r.stderr, /^ERROR /m);
    assert.match(r.stderr, re, r.stderr);
  });
}

test('ERROR 장면 개수 확인 (표가 비면 위 반복이 0번 돈다)', () => {
  assert.strictEqual(ERRORS.length, 10);
});

test('WARN: 산문에 옛 모델이 남으면 경고하고 빌드는 성공', () => {
  const r = broken((k) => {
    edit(W(k, 'impl'), 'model: sonnet', 'model: opus');
    edit(W(k, 'impl'), 'effort: medium', 'effort: xhigh');
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.json.warnings.some((w) => w.file === 'skills/demo/SKILL.md'), JSON.stringify(r.json.warnings));
  assert.match(r.stderr, /^WARN skills\/demo\/SKILL\.md:\d+ /m);
});
