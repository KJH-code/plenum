#!/usr/bin/env node
'use strict';
// kit/ → build/claude-code/ 컴파일러 v0
// 사용: plenum-compile [--kit <dir>] [--out <dir>] [--json]
//   기본 kit=<cwd>/kit, out=<cwd>/build/claude-code (kit 레포 루트에서 부른다. npm run build 는 레포 루트가 cwd)
//   경고: stderr "WARN <out 기준 경로>:<줄> <메시지>" (종료 코드 0)
//   에러: stderr "ERROR <메시지>" (종료 코드 1)
//   --json: stdout {"files": <개수>, "warnings": [{file, line, message}]} 한 줄
const path = require('path');
const { compileKit, writeOut, KitError } = require('./lib/compile');


function parseArgs(argv) {
  const cwd = process.cwd();
  const opts = { kit: path.join(cwd, 'kit'), out: path.join(cwd, 'build', 'claude-code'), json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--kit' || a === '--out') {
      const v = argv[++i];
      if (v === undefined || v === '' || v.startsWith('--')) throw new KitError(`${a} 뒤에 폴더가 없음`);
      opts[a.slice(2)] = path.resolve(v);
    } else throw new KitError(`모르는 인자: ${a} (사용: plenum-compile [--kit <dir>] [--out <dir>] [--json])`);
  }
  return opts;
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = compileKit(opts.kit);
    writeOut(opts.out, result, opts.kit);
    for (const w of result.warnings) process.stderr.write(`WARN ${w.file}:${w.line} ${w.message}\n`);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ files: result.files.size, warnings: result.warnings }) + '\n');
    }
    process.exitCode = 0;
  } catch (e) {
    const msg = e instanceof KitError ? e.message : (e && e.stack) || String(e);
    process.stderr.write(`ERROR ${msg.split('\n').join(' ')}\n`);
    process.exitCode = 1;
  }
}

main();
