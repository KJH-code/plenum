'use strict';
// kit/ 읽기와 검증용 모델. 쓰기는 하지 않는다.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

class KitError extends Error {}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// 머리말 칸: 빌드로 그대로 나가는 칸과 kit에만 있는 칸
const PASS_KEYS = ['name', 'description', 'tools', 'model', 'effort', 'maxTurns', 'isolation'];
const KIT_ONLY_KEYS = ['provider', 'label', 'memo', 'stage', 'summary'];
// 그대로 복사하지 않는 kit 최상위 항목
const RESERVED = new Set(['kit.yaml', 'providers.yaml', 'rules.md', 'prose-ignore.yaml', 'workers', 'modes', 'tables']);

const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const displayModel = (m) => m.charAt(0).toUpperCase() + m.slice(1);
const tierOf = (w) => `${displayModel(w.model)} ${w.effort}`;

function readYaml(file) {
  let data;
  try {
    data = yaml.load(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new KitError(`${file}: YAML을 읽을 수 없음 — ${e.message.split('\n')[0]}`);
  }
  return data;
}

// 정렬된 상대경로 목록 (디렉터리 재귀)
function walk(root, rel = '') {
  const out = [];
  const dir = path.join(root, rel);
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => byCode(a.name, b.name))) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...walk(root, r));
    else if (ent.isFile()) out.push(r);
  }
  return out;
}

const isExec = (file) => (fs.statSync(file).mode & 0o111) !== 0;

// 머리말을 원문 줄 그대로 나눈다. 다시 직렬화하지 않는다.
function splitFrontmatter(text, where) {
  const lines = text.split('\n');
  if (lines[0] !== '---') throw new KitError(`${where}: 머리말(---)이 없음`);
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new KitError(`${where}: 머리말 끝(---)이 없음`);
  return { fmLines: lines.slice(1, end), rest: lines.slice(end) }; // rest[0] === '---'
}

function loadWorker(kitDir, file) {
  const abs = path.join(kitDir, 'workers', file);
  const where = `workers/${file}`;
  const text = fs.readFileSync(abs, 'utf8');
  const { fmLines, rest } = splitFrontmatter(text, where);
  let fields;
  try {
    fields = yaml.load(fmLines.join('\n')) || {};
  } catch (e) {
    throw new KitError(`${where}: 머리말 YAML 오류 — ${e.message.split('\n')[0]}`);
  }
  if (typeof fields !== 'object' || Array.isArray(fields)) throw new KitError(`${where}: 머리말이 키-값 목록이 아님`);
  // 줄 단위 키 목록 (들여쓴 줄은 앞 키에 붙는다)
  const lineKeys = [];
  let cur = null;
  for (const l of fmLines) {
    const m = /^([A-Za-z][\w-]*):/.exec(l);
    if (m) cur = m[1];
    else if (!/^\s/.test(l) && l.trim() !== '') throw new KitError(`${where}: 머리말 줄을 읽을 수 없음: ${l}`);
    lineKeys.push(cur);
  }
  for (const k of Object.keys(fields)) {
    if (!PASS_KEYS.includes(k) && !KIT_ONLY_KEYS.includes(k)) {
      throw new KitError(`${where}: 모르는 머리말 칸 "${k}" (허용: ${[...PASS_KEYS, ...KIT_ONLY_KEYS].join(', ')})`);
    }
  }
  const str = (k) => (fields[k] === undefined || fields[k] === null ? '' : String(fields[k]));
  return {
    file,
    where,
    exec: isExec(abs),
    name: str('name'),
    model: str('model'),
    effort: str('effort'),
    provider: str('provider'),
    label: fields.label === undefined ? null : str('label'),
    fields,
    fmLines,
    lineKeys,
    rest,
  };
}

function loadTableFile(file, kind, id) {
  const data = readYaml(file);
  const where = `${kind}/${id}.yaml`;
  if (!data || typeof data !== 'object' || !Array.isArray(data.slots)) throw new KitError(`${where}: slots 목록이 없음`);
  if (data.fallback !== undefined && !Array.isArray(data.fallback)) throw new KitError(`${where}: fallback은 워커 이름 목록`);
  return { id, kind, where, columns: data.columns || null, slots: data.slots, fallback: (data.fallback || []).map(String) };
}

function loadDir(kitDir, kind) {
  const map = new Map();
  const dir = path.join(kitDir, kind);
  if (!fs.existsSync(dir)) return map;
  for (const f of fs.readdirSync(dir).sort(byCode)) {
    if (!f.endsWith('.yaml')) continue;
    const id = f.slice(0, -'.yaml'.length);
    map.set(id, loadTableFile(path.join(dir, f), kind, id));
  }
  return map;
}

// kit/prose-ignore.yaml: 산문 경고 예외. ignore: [{file, line_contains | pattern, reason}]
function loadProseIgnore(dir) {
  const file = path.join(dir, 'prose-ignore.yaml');
  if (!fs.existsSync(file)) return [];
  const data = readYaml(file) || {};
  const list = data.ignore === undefined || data.ignore === null ? [] : data.ignore;
  if (!Array.isArray(list)) throw new KitError('prose-ignore.yaml: ignore는 목록');
  list.forEach((e, i) => {
    const where = `prose-ignore.yaml ignore[${i}]`;
    if (!e || typeof e.file !== 'string' || !e.file) throw new KitError(`${where}: file이 없음`);
    const hasC = typeof e.line_contains === 'string' && e.line_contains !== '';
    const hasP = typeof e.pattern === 'string' && e.pattern !== '';
    if (hasC === hasP) throw new KitError(`${where}: line_contains와 pattern 중 하나만`);
    if (hasP) {
      try { new RegExp(e.pattern); } catch (err) { throw new KitError(`${where}: pattern 정규식 오류 — ${err.message}`); }
    }
    if (typeof e.reason !== 'string' || !e.reason.trim()) throw new KitError(`${where}: reason이 없음`);
  });
  return list;
}

function loadKit(kitDir) {
  const dir = path.resolve(kitDir);
  if (!fs.existsSync(path.join(dir, 'kit.yaml'))) throw new KitError(`kit.yaml이 없음: ${dir}`);
  const meta = readYaml(path.join(dir, 'kit.yaml')) || {};
  const prov = fs.existsSync(path.join(dir, 'providers.yaml')) ? readYaml(path.join(dir, 'providers.yaml')) : null;
  const providers = (prov && Array.isArray(prov.providers) ? prov.providers : []).map((p) => String(p && p.id));

  const workers = new Map();
  const wdir = path.join(dir, 'workers');
  if (fs.existsSync(wdir)) {
    for (const f of fs.readdirSync(wdir).sort(byCode)) {
      if (!f.endsWith('.md')) continue;
      const w = loadWorker(dir, f);
      workers.set(w.name || f.slice(0, -3), w);
    }
  }

  const files = [];
  for (const rel of walk(dir)) {
    if (RESERVED.has(rel.split('/')[0])) continue;
    const abs = path.join(dir, rel);
    files.push({ rel, abs, exec: isExec(abs) });
  }

  return {
    dir, meta, providers, workers, modes: loadDir(dir, 'modes'), tables: loadDir(dir, 'tables'), files,
    proseIgnore: loadProseIgnore(dir),
  };
}

module.exports = { KitError, loadKit, splitFrontmatter, EFFORTS, PASS_KEYS, KIT_ONLY_KEYS, byCode, displayModel, tierOf };
