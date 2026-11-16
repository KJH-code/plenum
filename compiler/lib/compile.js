'use strict';
// compileKit(kitDir) → { files: Map<상대경로, Buffer>, warnings } (쓰기 없음)
// compileVariant(kitDir, {variant, variantFile}) → { files, modes, warnings, variant: <판 이름|null> } (쓰기 없음)
// writeOut(outDir, result) → out 폴더를 지우고 새로 쓴다
const fs = require('fs');
const path = require('path');
const { KitError, loadKit } = require('./kit');
const { LEFTOVER_RE } = require('./render');
const claudeCode = require('./claude-code');
const { loadVariant, applyVariant } = require('./variant');

const TARGETS = [claudeCode];
// 이름만 정해 두고 아직 만들지 않은 하네스
const PLANNED_HARNESSES = ['agents-md'];

function checkLeftovers(files) {
  for (const [rel, buf] of files) {
    if (buf.includes(0)) continue;
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = LEFTOVER_RE.exec(lines[i]);
      if (m) throw new KitError(`생성물에 남은 자리표시자: ${rel}:${i + 1} ${m[0]}`);
    }
  }
}

function compileKit(kitDir, targetId = 'claude-code') {
  const target = TARGETS.find((t) => t.id === targetId);
  if (!target) throw new KitError(`모르는 대상: ${targetId}`);
  const kit = loadKit(kitDir);
  target.validate(kit);
  const result = target.compile(kit);
  checkLeftovers(result.files);
  return result;
}

function pickVariant(kit, { variant, variantFile }) {
  if (variant !== undefined && variantFile !== undefined) throw new KitError('--variant와 --variant-file은 같이 쓸 수 없음 (하나만)');
  const names = () => (kit.variants && kit.variants.size ? [...kit.variants.keys()].join(', ') : '없음');
  if (variantFile !== undefined) {
    const file = path.resolve(variantFile);
    if (!file.endsWith('.yaml')) throw new KitError(`판 파일은 .yaml로 끝나야 함: ${variantFile}`);
    return { name: path.basename(file).slice(0, -'.yaml'.length), file, where: variantFile };
  }
  if (variant !== undefined) {
    if (kit.variants === null) throw new KitError(`판 ${variant}: kit에 variants/ 폴더가 없음`);
    if (!kit.variants.has(variant)) throw new KitError(`없는 판: ${variant} (있는 것: ${names()})`);
    return kit.variants.get(variant);
  }
  if (kit.variants === null) return null;
  const def = kit.meta.name;
  if (typeof def !== 'string' || !def) throw new KitError('kit.yaml에 name이 없음 (기본 판을 정할 수 없음)');
  if (!kit.variants.has(def)) throw new KitError(`기본 판 없음: variants/${def}.yaml (있는 것: ${names()})`);
  return kit.variants.get(def);
}

function compileVariant(kitDir, opts = {}) {
  const kit = loadKit(kitDir);
  const picked = pickVariant(kit, opts);
  const variant = picked ? loadVariant(picked.file, picked.where) : null;
  const harness = variant ? variant.harness : 'claude-code';
  const target = TARGETS.find((t) => t.id === harness);
  if (!target) {
    if (PLANNED_HARNESSES.includes(harness)) throw new KitError(`하네스 ${harness}는 아직 없음 (지금은 ${TARGETS.map((t) => t.id).join(', ')}만)`);
    throw new KitError(`모르는 하네스 ${harness} (있는 것: ${TARGETS.map((t) => t.id).join(', ')})`);
  }
  target.validate(kit);
  let result = target.compile(kit);
  checkLeftovers(result.files);
  if (variant) {
    result = applyVariant(kit, result, variant);
    checkLeftovers(result.files);
  }
  return { files: result.files, modes: result.modes, warnings: result.warnings, variant: picked ? picked.name : null };
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

module.exports = { compileKit, compileVariant, writeOut, KitError, TARGETS, PLANNED_HARNESSES };
