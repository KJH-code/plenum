'use strict';
// TargetCompiler: Claude Code 플러그인 형식 (build/claude-code/)
const fs = require('fs');
const { KitError, EFFORTS, KIT_ONLY_KEYS, tierOf, byCode } = require('./kit');
const { renderText, COMPUTED } = require('./render');
const { proseWarnings } = require('./prose');

const GENERATED_TEXT = [
  '# 생성된 폴더',
  '',
  '이 폴더는 `kit/`에서 `node tools/compile.js`로 만든 Claude Code 플러그인이다.',
  '여기를 직접 고치지 않는다. `kit/`을 고친 뒤 다시 빌드한다. 빌드할 때마다 이 폴더는 지워지고 새로 써진다.',
  '',
].join('\n');

function validate(kit) {
  const targets = kit.meta.targets || [];
  if (!targets.includes('claude-code')) throw new KitError('kit.yaml targets에 claude-code가 없음');
  for (const k of ['name', 'version', 'description']) {
    if (!kit.meta[k]) throw new KitError(`kit.yaml에 ${k}가 없음`);
  }

  const tierRows = new Set();
  for (const row of kit.meta.tiers || []) {
    if (!row || !row.tier || row.label === undefined || row.role === undefined) {
      throw new KitError('kit.yaml tiers 행에는 tier·label·role이 있어야 함');
    }
    if (tierRows.has(row.tier)) throw new KitError(`kit.yaml tiers에 같은 계층이 두 번: ${row.tier}`);
    tierRows.add(row.tier);
  }
  const order = (kit.meta.worker_order || []).map(String);
  for (const n of order) if (!kit.workers.has(n)) throw new KitError(`kit.yaml worker_order에 없는 워커: ${n}`);
  if (new Set(order).size !== order.length) throw new KitError('kit.yaml worker_order에 같은 워커가 두 번');

  const stages = kit.meta.stages;
  if (!Array.isArray(stages) || stages.length === 0 || stages.some((x) => typeof x !== 'string' || !x)) {
    throw new KitError('kit.yaml stages는 비어 있지 않은 문자열 목록');
  }
  if (new Set(stages).size !== stages.length) throw new KitError('kit.yaml stages에 같은 단계가 두 번');

  for (const w of kit.workers.values()) {
    if (!w.name) throw new KitError(`${w.where}: name이 없음`);
    const stage = w.fields.stage === undefined || w.fields.stage === null ? '' : String(w.fields.stage);
    if (!stage) throw new KitError(`${w.where}: stage가 없음 (kit.yaml stages 중 하나: ${stages.join('·')})`);
    if (!stages.includes(stage)) throw new KitError(`${w.where}: stage "${stage}"가 kit.yaml stages에 없음 (있는 것: ${stages.join('·')})`);
    if (typeof w.fields.summary !== 'string' || !w.fields.summary.trim()) throw new KitError(`${w.where}: summary가 없음`);
    if (`${w.name}.md` !== w.file) throw new KitError(`${w.where}: name(${w.name})이 파일 이름과 다름`);
    if (!w.model) throw new KitError(`${w.where}: model이 없음`);
    if (!w.effort) throw new KitError(`${w.where}: effort가 없음`);
    if (!/^[a-z][a-z0-9-]*$/.test(w.model)) throw new KitError(`${w.where}: model 값이 이상함: ${w.model}`);
    if (!EFFORTS.includes(w.effort)) throw new KitError(`${w.where}: effort는 ${EFFORTS.join('·')} 중 하나: ${w.effort}`);
    if (!w.provider) throw new KitError(`${w.where}: provider가 없음`);
    if (!kit.providers.includes(w.provider)) {
      throw new KitError(`${w.where}: provider "${w.provider}"가 providers.yaml에 없음 (있는 것: ${kit.providers.join(', ') || '없음'})`);
    }
    if (!tierRows.has(tierOf(w))) {
      throw new KitError(`계층 행 없음: ${tierOf(w)} — kit.yaml tiers에 추가 (${w.where})`);
    }
  }

  for (const t of [...kit.modes.values(), ...kit.tables.values()]) {
    if (kit.modes.has(t.id) && kit.tables.has(t.id)) throw new KitError(`표 이름이 modes/와 tables/에 둘 다 있음: ${t.id}`);
    if (t.columns !== null) {
      if (!Array.isArray(t.columns) || t.columns.length === 0) throw new KitError(`${t.where}: columns는 비어 있지 않은 목록`);
      for (const c of t.columns) {
        if (!c || typeof c.header !== 'string' || typeof c.field !== 'string') throw new KitError(`${t.where}: columns 항목은 {header, field}`);
      }
    }
    for (const f of t.fallback) {
      if (!kit.workers.has(f)) throw new KitError(`${t.where} fallback: 없는 워커 ${f}`);
      if (t.slots.some((s) => String(s.worker) === f)) throw new KitError(`${t.where} fallback: ${f}는 이미 slots에 있음`);
    }
    const slots = new Set();
    for (const s of t.slots) {
      if (!s || !s.slot) throw new KitError(`${t.where}: slot 이름이 없는 항목`);
      if (slots.has(s.slot)) throw new KitError(`${t.where}: 같은 slot 이름이 두 번: ${s.slot}`);
      slots.add(s.slot);
      if (!s.worker) throw new KitError(`${t.where} slot ${s.slot}: worker가 없음`);
      if (!kit.workers.has(String(s.worker))) throw new KitError(`${t.where} slot ${s.slot}: 없는 워커 ${s.worker}`);
      for (const c of t.columns || []) {
        if (COMPUTED.has(c.field)) continue;
        if (c.field === 'label' && (s.label === undefined || s.label === null) && kit.workers.get(String(s.worker)).label !== null) continue;
        if (s[c.field] === undefined) throw new KitError(`${t.where} slot ${s.slot}: "${c.header}" 칸 값(${c.field})이 없음`);
      }
      if (!t.columns && (s.label === undefined || s.label === null) && kit.workers.get(String(s.worker)).label === null) {
        throw new KitError(`${t.where} slot ${s.slot}: label이 없음`);
      }
    }
  }
}

function agentText(kit, w, rel, warn) {
  // kit 전용 칸 줄(들여쓴 이어지는 줄 포함)만 빼고 원문 그대로
  const kept = w.fmLines.filter((_, i) => !KIT_ONLY_KEYS.includes(w.lineKeys[i]));
  const text = ['---', ...kept, ...w.rest].join('\n');
  return renderText(kit, text, w, rel, warn);
}

function pluginJson(meta) {
  const obj = { name: meta.name, version: String(meta.version), description: meta.description };
  if (meta.author !== undefined) obj.author = meta.author;
  return JSON.stringify(obj, null, 2) + '\n';
}

function isBinary(buf) {
  return buf.includes(0);
}

function compile(kit) {
  const files = new Map();
  const modes = new Map();
  const warnings = [];
  const add = (rel, content, exec) => {
    if (files.has(rel)) throw new KitError(`출력 경로가 겹침: ${rel}`);
    files.set(rel, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
    modes.set(rel, exec ? 0o755 : 0o644);
  };
  const warnFor = (rel) => (line, message) => warnings.push({ file: rel, line, message });

  for (const w of kit.workers.values()) {
    const rel = `agents/${w.file}`;
    add(rel, agentText(kit, w, rel, warnFor(rel)), w.exec);
  }
  for (const f of kit.files) {
    const buf = fs.readFileSync(f.abs);
    if (isBinary(buf)) { add(f.rel, buf, f.exec); continue; }
    add(f.rel, renderText(kit, buf.toString('utf8'), null, f.rel, warnFor(f.rel)), f.exec);
  }
  if (!files.has('.claude-plugin/plugin.json')) add('.claude-plugin/plugin.json', pluginJson(kit.meta), false);
  add('GENERATED.md', GENERATED_TEXT, false);

  // 정렬된 Map으로 (결정적 순서)
  const sorted = new Map([...files.entries()].sort((a, b) => byCode(a[0], b[0])));
  for (const [rel, buf] of sorted) {
    if (isBinary(buf)) continue;
    warnings.push(...proseWarnings(kit, rel, buf.toString('utf8')));
  }
  warnings.sort((a, b) => byCode(a.file, b.file) || a.line - b.line || byCode(a.message, b.message));
  return { files: sorted, modes, warnings };
}

module.exports = { id: 'claude-code', compile, validate, GENERATED_TEXT };
