'use strict';
// compileKit(kitDir) → { files: Map<상대경로, Buffer>, warnings } (쓰기 없음)
// writeOut(outDir, result) → out 폴더를 지우고 새로 쓴다
const fs = require('fs');
const path = require('path');
const { KitError, loadKit } = require('./kit');
const { LEFTOVER_RE } = require('./render');
const claudeCode = require('./claude-code');

const TARGETS = [claudeCode];

function compileKit(kitDir, targetId = 'claude-code') {
  const target = TARGETS.find((t) => t.id === targetId);
  if (!target) throw new KitError(`모르는 대상: ${targetId}`);
  const kit = loadKit(kitDir);
  target.validate(kit);
  const result = target.compile(kit);
  for (const [rel, buf] of result.files) {
    if (buf.includes(0)) continue;
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = LEFTOVER_RE.exec(lines[i]);
      if (m) throw new KitError(`생성물에 남은 자리표시자: ${rel}:${i + 1} ${m[0]}`);
    }
  }
  return result;
}

function isInside(child, parent) {
  const r = path.relative(parent, child);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

function writeOut(outDir, result, kitDir) {
  const out = path.resolve(outDir);
  if (kitDir && (isInside(path.resolve(kitDir), out) || isInside(out, path.resolve(kitDir)))) {
    throw new KitError(`out 폴더가 kit 폴더와 겹침: ${out}`);
  }
  if (fs.existsSync(out)) {
    if (!fs.statSync(out).isDirectory()) throw new KitError(`out이 폴더가 아님: ${out}`);
    if (!fs.existsSync(path.join(out, 'GENERATED.md'))) {
      throw new KitError(`out 폴더에 GENERATED.md가 없어 지우지 않음 (생성 폴더가 아닐 수 있다): ${out}`);
    }
    fs.rmSync(out, { recursive: true, force: true });
  }
  for (const [rel, buf] of result.files) {
    const file = path.join(out, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    const mode = result.modes && result.modes.get(rel);
    if (mode) fs.chmodSync(file, mode);
  }
}

module.exports = { compileKit, writeOut, KitError, TARGETS };
