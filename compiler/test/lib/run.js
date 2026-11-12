'use strict';
// 컴파일러·pack을 실제 프로세스로 부른다. fixture kit을 임시 폴더에 복사해서 쓴다 (레포 안에 build를 만들지 않는다).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const COMPILE = path.join(ROOT, 'bin', 'plenum-compile');
const PACK = path.join(ROOT, 'bin', 'plenum-pack');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'kit');

function copyFixture(dir) {
  const kit = path.join(dir, 'kit');
  fs.cpSync(FIXTURE, kit, { recursive: true });
  return kit;
}

function compile(args, { cwd } = {}) {
  const r = spawnSync(process.execPath, [COMPILE, ...args], { cwd: cwd || ROOT, encoding: 'utf8' });
  let json = null;
  if (args.includes('--json') && r.status === 0) json = JSON.parse(r.stdout.trim().split('\n').pop());
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function pack(args, { cwd } = {}) {
  return spawnSync(process.execPath, [PACK, ...args], { cwd: cwd || ROOT, encoding: 'utf8' });
}

function edit(file, from, to) {
  const t = fs.readFileSync(file, 'utf8');
  const t2 = typeof from === 'string' ? t.replace(from, to) : t.replace(from, to);
  if (t2 === t) throw new Error(`${file}: 바꿀 줄을 못 찾았다 (${from})`);
  fs.writeFileSync(file, t2);
}

module.exports = { ROOT, COMPILE, PACK, FIXTURE, copyFixture, compile, pack, edit };
