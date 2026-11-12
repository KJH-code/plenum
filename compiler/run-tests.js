#!/usr/bin/env node
// tests/*.test.js 를 찾아 node --test 로 돌린다.
// Node 22는 `node --test tests/` 의 디렉터리 인자를 모듈로 읽어서 죽고, glob 인자는 Node 18에서 안 먹는다.
// 그래서 파일 목록을 여기서 직접 만든다. 하나도 못 찾으면 "통과"가 아니라 실패로 끝낸다.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, 'test');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));
if (files.length === 0) {
  process.stderr.write(`run-tests: ${dir} 에서 *.test.js 를 하나도 못 찾았다\n`);
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
