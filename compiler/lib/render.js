'use strict';
// 자리표시자 치환과 표 생성
//   워커 맥락 안: {{tier}} {{Model}} {{model}} {{effort}}
//   어디서나:     {{tier:<워커>}} {{Model:<워커>}} {{model:<워커>}} {{effort:<워커>}}
//                 {{workers_table:<id>}}  (kit/modes/<id>.yaml 또는 kit/tables/<id>.yaml)
//                 {{tier_table}}          (README "모델 계층" 표, kit.yaml tiers)
const { KitError, displayModel, tierOf, byCode } = require('./kit');

const TOKEN_RE = /\{\{([A-Za-z_]+)(?::([^{}\s]+))?\}\}/g;
const LEFTOVER_RE = /\{\{[^\n]*?\}\}/;

const VALUE = {
  tier: (w) => tierOf(w),
  Model: (w) => displayModel(w.model),
  model: (w) => w.model,
  effort: (w) => w.effort,
};

const DEFAULT_COLUMNS = [
  { header: '단계', field: 'label' },
  { header: '에이전트', field: 'agent' },
  { header: 'model', field: 'model' },
  { header: 'effort', field: 'effort' },
];
const COMPUTED = new Set(['agent', 'file', 'model', 'effort']);

function tableFor(kit, id) {
  const m = kit.modes.get(id);
  const t = kit.tables.get(id);
  if (m && t) throw new KitError(`표 이름이 modes/와 tables/에 둘 다 있음: ${id}`);
  return m || t || null;
}

const tableLine = (cells) => `| ${cells.join(' | ')} |`;
const sepLine = (n) => `|${'---|'.repeat(n)}`;

function checkCell(v, where) {
  if (/[|\n]/.test(v)) throw new KitError(`${where}: 표 칸에 | 나 줄바꿈이 있음: ${v}`);
  return v;
}

function renderWorkersTable(kit, id, where) {
  const t = tableFor(kit, id);
  if (!t) throw new KitError(`${where}: 표 정의 없음: modes/${id}.yaml 또는 tables/${id}.yaml`);
  const cols = t.columns || DEFAULT_COLUMNS;
  const lines = [tableLine(cols.map((c) => c.header)), sepLine(cols.length)];
  for (const s of t.slots) {
    const w = kit.workers.get(s.worker);
    const cellWhere = `${t.where} slot ${s.slot}`;
    const cells = cols.map((c) => {
      let v;
      if (c.field === 'agent') v = `\`${w.name}\``;
      else if (c.field === 'file') v = `\`agents/${w.name}.md\``;
      else if (c.field === 'model') v = w.model;
      else if (c.field === 'effort') v = w.effort;
      else if (c.field === 'label' && (s.label === undefined || s.label === null)) v = w.label;
      else v = s[c.field] === undefined || s[c.field] === null ? '' : String(s[c.field]);
      return checkCell(renderInline(kit, v, w, cellWhere), cellWhere);
    });
    lines.push(tableLine(cells));
  }
  return lines.join('\n');
}

// README 계층 표: 워커를 (model, effort)로 묶어 kit.yaml tiers 행에 넣는다
function renderTierTable(kit, where, warn) {
  const meta = kit.meta;
  const headers = meta.tier_columns || ['계층', '맡는 일', '에이전트'];
  const order = workerOrder(kit);
  const lines = [tableLine(headers), sepLine(headers.length)];
  for (const row of meta.tiers || []) {
    const names = order.filter((n) => tierOf(kit.workers.get(n)) === row.tier);
    if (names.length === 0) {
      warn(`계층 행에 워커가 없어 뺐다: ${row.tier} (kit.yaml tiers)`);
      continue;
    }
    lines.push(tableLine([row.label, row.role, names.map((n) => `\`${n}\``).join(' ')].map((v) => checkCell(String(v), where))));
  }
  return lines.join('\n');
}

function workerOrder(kit) {
  const listed = (kit.meta.worker_order || []).map(String);
  const rest = [...kit.workers.keys()].filter((n) => !listed.includes(n)).sort(byCode);
  return [...listed, ...rest];
}

function valueToken(kit, name, arg, ctxWorker, where) {
  if (!VALUE[name]) return null;
  let w = ctxWorker;
  if (arg !== undefined) {
    w = kit.workers.get(arg);
    if (!w) throw new KitError(`${where}: {{${name}:${arg}}} — 없는 워커 ${arg}`);
  } else if (!w) {
    throw new KitError(`${where}: {{${name}}}는 워커 파일 안에서만 쓸 수 있음 (밖에서는 {{${name}:<워커>}})`);
  }
  return VALUE[name](w);
}

// 한 줄 안 값 토큰만 (표 칸, 라벨 등)
function renderInline(kit, text, ctxWorker, where) {
  return text.replace(TOKEN_RE, (all, name, arg) => {
    const v = valueToken(kit, name, arg, ctxWorker, where);
    if (v === null) throw new KitError(`${where}: 여기서 쓸 수 없는 자리표시자 ${all}`);
    return v;
  });
}

// 파일 전체. 줄 단위로 처리해 경고 줄번호(출력 기준)를 맞춘다.
// warn(lineNo, message)
function renderText(kit, text, ctxWorker, rel, warn) {
  const inLines = text.split('\n');
  const out = [];
  let outLine = 1;
  for (let i = 0; i < inLines.length; i++) {
    const where = `${rel}:${i + 1}`;
    const lineAtStart = outLine;
    const line = inLines[i].replace(TOKEN_RE, (all, name, arg) => {
      if (name === 'workers_table') {
        if (!arg) throw new KitError(`${where}: {{workers_table:<id>}}에 id가 없음`);
        return renderWorkersTable(kit, arg, where);
      }
      if (name === 'tier_table' && arg === undefined) {
        return renderTierTable(kit, where, (msg) => warn(lineAtStart, msg));
      }
      const v = valueToken(kit, name, arg, ctxWorker, where);
      if (v === null) throw new KitError(`${where}: 모르는 자리표시자 ${all}`);
      return v;
    });
    out.push(line);
    outLine += line.split('\n').length;
  }
  return out.join('\n');
}

module.exports = { renderText, renderInline, tableFor, workerOrder, LEFTOVER_RE, DEFAULT_COLUMNS, COMPUTED };
