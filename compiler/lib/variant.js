'use strict';
// 판(variant): 한 하네스의 출력에서 빼고 바꾼 것. kit/variants/<이름>.yaml
// loadVariant(file, where) → 검사한 판 설정
// applyVariant(kit, result, variant) → 새 { files, modes, warnings } (입력 Map은 고치지 않는다)
const fs = require('fs');
const { KitError, readYaml, byCode } = require('./kit');
const { HISTORY_HEADING } = require('./prose');

const TOP_KEYS = ['harness', 'include', 'exclude', 'replace', 'manifest'];
const UNITS = ['skills', 'agents', 'hooks'];
const EXCLUDE_KEYS = [...UNITS, 'files'];
const REPLACE_KEYS = ['from', 'to', 'files', 'optional'];
const MANIFEST_KEYS = ['name', 'version', 'author', 'description'];
const UNIT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const PLUGIN_JSON = '.claude-plugin/plugin.json';
const HOOKS_JSON = 'hooks/hooks.json';
const UNIT_LABEL = { skills: '스킬', agents: '에이전트', hooks: '훅' };

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isBinary = (buf) => buf.includes(0);

// ---- 읽기·형식 검사 ----

function checkPath(err, label, p) {
  if (typeof p !== 'string' || p === '') err(`${label}: 비어 있지 않은 문자열이어야 함`);
  if (p.startsWith('/')) err(`${label}: /로 시작하면 안 됨 (출력 기준 상대경로): ${p}`);
  if (p.includes('\\')) err(`${label}: \\ 대신 /로 나눈다: ${p}`);
  if (p.split('/').includes('..')) err(`${label}: .. 조각은 쓸 수 없음: ${p}`);
}

function stringList(err, label, v, check) {
  if (!Array.isArray(v) || v.length === 0) err(`${label}: 비어 있지 않은 문자열 목록이어야 함`);
  const seen = new Set();
  v.forEach((x, i) => {
    if (typeof x !== 'string' || x === '') err(`${label}[${i}]: 비어 있지 않은 문자열이어야 함`);
    if (seen.has(x)) err(`${label}: 같은 값이 두 번: ${x}`);
    seen.add(x);
    check(`${label}[${i}]`, x);
  });
  return v.slice();
}

function loadSection(err, data, key, allowed) {
  if (!has(data, key)) return {};
  const sec = data[key];
  if (!isMap(sec)) err(`${key}: 맵이어야 함 (허용 칸: ${allowed.join(', ')})`);
  const out = {};
  for (const k of Object.keys(sec)) {
    if (key === 'include' && k === 'files') err('include.files: files는 exclude만 받는다');
    if (!allowed.includes(k)) err(`${key}: 모르는 칸 "${k}" (허용: ${allowed.join(', ')})`);
    const label = `${key}.${k}`;
    out[k] = stringList(err, label, sec[k], k === 'files'
      ? (l, x) => checkPath(err, l, x)
      : (l, x) => { if (!UNIT_NAME_RE.test(x)) err(`${l}: 이름은 ${UNIT_NAME_RE} 꼴이어야 함: ${x}`); });
  }
  return out;
}

function loadReplace(err, data) {
  if (!has(data, 'replace')) return [];
  if (!Array.isArray(data.replace)) err('replace: 목록이어야 함');
  return data.replace.map((r, i) => {
    const label = `replace[${i}]`;
    if (!isMap(r)) err(`${label}: 맵이어야 함 (허용 칸: ${REPLACE_KEYS.join(', ')})`);
    for (const k of Object.keys(r)) {
      if (!REPLACE_KEYS.includes(k)) err(`${label}: 모르는 칸 "${k}" (허용: ${REPLACE_KEYS.join(', ')})`);
    }
    if (typeof r.from !== 'string' || r.from === '') err(`${label}.from: 비어 있지 않은 문자열이어야 함`);
    if (typeof r.to !== 'string') err(`${label}.to: 문자열이어야 함 (빈 문자열은 "")`);
    const rule = { from: r.from, to: r.to, files: null, optional: false };
    if (has(r, 'files')) rule.files = stringList(err, `${label}.files`, r.files, (l, x) => checkPath(err, l, x));
    if (has(r, 'optional')) {
      if (typeof r.optional !== 'boolean') err(`${label}.optional: true 또는 false`);
      rule.optional = r.optional;
    }
    return rule;
  });
}

function loadManifest(err, data) {
  if (!has(data, 'manifest')) return {};
  const m = data.manifest;
  if (!isMap(m)) err(`manifest: 맵이어야 함 (허용 칸: ${MANIFEST_KEYS.join(', ')})`);
  for (const k of Object.keys(m)) {
    if (!MANIFEST_KEYS.includes(k)) err(`manifest: 모르는 칸 "${k}" (허용: ${MANIFEST_KEYS.join(', ')})`);
  }
  if (has(m, 'name') && (typeof m.name !== 'string' || !PLUGIN_NAME_RE.test(m.name))) {
    err(`manifest.name: ${PLUGIN_NAME_RE} 꼴의 문자열이어야 함: ${m.name}`);
  }
  if (has(m, 'version')) {
    if (typeof m.version === 'number') err(`manifest.version: 숫자로 읽힘 (${m.version}) — "1.0.0"처럼 따옴표로 감싸라`);
    if (typeof m.version !== 'string' || m.version === '') err('manifest.version: 비어 있지 않은 문자열이어야 함');
  }
  if (has(m, 'description') && (typeof m.description !== 'string' || m.description === '')) {
    err('manifest.description: 비어 있지 않은 문자열이어야 함');
  }
  if (has(m, 'author') && typeof m.author !== 'string' && !isMap(m.author)) err('manifest.author: 문자열이나 맵이어야 함');
  return { ...m };
}

// file: 절대 경로, where: 메시지 앞머리 (variants/<이름>.yaml 또는 --variant-file로 받은 경로)
function loadVariant(file, where) {
  const err = (msg) => { throw new KitError(`${where}: ${msg}`); };
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) err('판 파일이 없음');
  let data;
  try {
    data = readYaml(file);
  } catch (e) {
    if (!(e instanceof KitError)) throw e;
    err(e.message.startsWith(`${file}: `) ? e.message.slice(file.length + 2) : e.message);
  }
  if (!isMap(data)) err(`맵이 아님 (허용 칸: ${TOP_KEYS.join(', ')})`);
  for (const k of Object.keys(data)) {
    if (!TOP_KEYS.includes(k)) err(`모르는 칸 "${k}" (허용: ${TOP_KEYS.join(', ')})`);
  }
  if (typeof data.harness !== 'string' || data.harness === '') err('harness가 없음 (문자열, 예: claude-code)');
  const include = loadSection(err, data, 'include', UNITS);
  const exclude = loadSection(err, data, 'exclude', EXCLUDE_KEYS);
  for (const u of UNITS) {
    if (include[u] && exclude[u]) err(`${u}가 include와 exclude에 둘 다 있음 (하나만)`);
  }
  return {
    where,
    harness: data.harness,
    include,
    exclude,
    replace: loadReplace(err, data),
    manifest: loadManifest(err, data),
  };
}

// ---- 적용 ----

const matchesPath = (rel, p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p);

// 하네스 출력에서 단위별 전체 집합
function unitSets(names) {
  const sets = { skills: new Set(), agents: new Set(), hooks: new Set() };
  for (const rel of names) {
    let m;
    if ((m = /^skills\/([^/]+)\//.exec(rel))) sets.skills.add(m[1]);
    else if ((m = /^agents\/([^/]+)\.md$/.exec(rel))) sets.agents.add(m[1]);
    else if ((m = /^hooks\/([^/]+)\.js$/.exec(rel))) sets.hooks.add(m[1]);
  }
  return sets;
}

const unitOwns = {
  skills: (rel, n) => rel.startsWith(`skills/${n}/`),
  agents: (rel, n) => rel === `agents/${n}.md`,
  hooks: (rel, n) => rel === `hooks/${n}.js`,
};

// command 안의 hooks/<이름>.js (앞: 시작·/·\·"·공백, 뒤: [\w.-]가 아님)
const HOOK_REF_SRC = (name) => `(?:^|[/\\\\"\\s])hooks/${name}\\.js(?![\\w.-])`;
const ANY_HOOK_RE = new RegExp(HOOK_REF_SRC('([A-Za-z0-9][A-Za-z0-9._-]*)'), 'g');

function parseHooksJson(err, buf) {
  let obj;
  try {
    obj = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    err(`${HOOKS_JSON}를 JSON으로 읽을 수 없음 — ${e.message}`);
  }
  if (!isMap(obj) || (has(obj, 'hooks') && !isMap(obj.hooks))) err(`${HOOKS_JSON}: {"hooks": {<이벤트>: [...]}} 모양이 아님`);
  const events = obj.hooks || {};
  for (const [ev, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) err(`${HOOKS_JSON}: hooks.${ev}가 목록이 아님`);
    groups.forEach((g, i) => {
      if (!isMap(g) || !Array.isArray(g.hooks)) err(`${HOOKS_JSON}: hooks.${ev}[${i}].hooks가 목록이 아님`);
    });
  }
  return obj;
}

function* handlers(obj) {
  for (const groups of Object.values(obj.hooks || {})) {
    for (const g of groups) for (const h of g.hooks) yield h;
  }
}

function cleanHooksJson(err, buf, removedHooks) {
  const obj = parseHooksJson(err, buf);
  const res = removedHooks.map((n) => new RegExp(HOOK_REF_SRC(escapeRe(n))));
  const calls = (h) => isMap(h) && typeof h.command === 'string' && res.some((re) => re.test(h.command));
  let removed = 0;
  const events = obj.hooks || {};
  for (const ev of Object.keys(events)) {
    const groups = [];
    for (const g of events[ev]) {
      const kept = g.hooks.filter((h) => !calls(h));
      if (kept.length === g.hooks.length) { groups.push(g); continue; }
      removed += g.hooks.length - kept.length;
      if (kept.length > 0) groups.push({ ...g, hooks: kept });
    }
    if (groups.length === events[ev].length && groups.every((g, i) => g === events[ev][i])) continue;
    if (groups.length === 0) delete events[ev];
    else events[ev] = groups;
  }
  if (removed === 0) return buf;
  return Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// 남은 언급 검사용 정규식
function mentionRes(unit, name, pluginNames) {
  const n = escapeRe(name);
  if (unit !== 'skills') return [new RegExp(`(?<![\\w-])${n}(?![\\w-])`)];
  return [
    new RegExp(`(?<![\\w/.-])/${n}(?![\\w-])`),
    new RegExp(`\`${n}\``),
    ...pluginNames.map((p) => new RegExp(`(?<![\\w-])${escapeRe(p)}:${n}(?![\\w-])`)),
    new RegExp(`(?<![\\w-])skills/${n}/`),
  ];
}

// .md의 "변경 기록" 절 줄 표시 (prose.js와 같은 규칙. 제목 판정에만 코드 블록 상태를 쓴다)
function historyLines(lines) {
  const skip = new Array(lines.length).fill(false);
  let skipLevel = 0;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) fence = !fence;
    else if (!fence) {
      const h = /^(#{1,6})\s/.exec(line);
      if (h) {
        if (skipLevel && h[1].length <= skipLevel) skipLevel = 0;
        const hist = HISTORY_HEADING.exec(line);
        if (hist && !skipLevel) skipLevel = hist[1].length;
      }
    }
    skip[i] = skipLevel > 0;
  }
  return skip;
}

function applyVariant(kit, result, variant) {
  const err = (msg) => { throw new KitError(`${variant.where}: ${msg}`); };
  const names = [...result.files.keys()];
  const files = new Map(result.files);

  // 1. 넣기·빼기
  const sets = unitSets(names);
  const removedUnits = { skills: [], agents: [], hooks: [] };
  for (const u of UNITS) {
    const all = [...sets[u]].sort(byCode);
    for (const key of ['include', 'exclude']) {
      for (const n of variant[key][u] || []) {
        if (!sets[u].has(n)) err(`${key}.${u}: 출력에 없는 ${UNIT_LABEL[u]} ${n} (있는 것: ${all.join(', ') || '없음'})`);
      }
    }
    if (variant.exclude[u]) removedUnits[u] = variant.exclude[u].slice();
    else if (variant.include[u]) removedUnits[u] = all.filter((n) => !variant.include[u].includes(n));
  }
  for (const u of UNITS) {
    for (const n of removedUnits[u]) for (const rel of names) if (unitOwns[u](rel, n)) files.delete(rel);
  }
  for (const p of variant.exclude.files || []) {
    if (matchesPath(PLUGIN_JSON, p)) err(`exclude.files: ${PLUGIN_JSON}는 뺄 수 없음 (${p})`);
    const hit = names.filter((rel) => matchesPath(rel, p));
    if (hit.length === 0) err(`exclude.files: 출력에 없는 ${p.endsWith('/') ? '폴더' : '경로'} ${p}`);
    for (const rel of hit) files.delete(rel);
  }
  const removedAny = files.size !== names.length;

  // 2. hooks.json 정리
  if (removedUnits.hooks.length > 0 && files.has(HOOKS_JSON)) {
    files.set(HOOKS_JSON, cleanHooksJson(err, files.get(HOOKS_JSON), removedUnits.hooks));
  }

  // 3. 없는 스크립트 호출 검사
  if (removedAny && files.has(HOOKS_JSON)) {
    const obj = parseHooksJson(err, files.get(HOOKS_JSON));
    for (const h of handlers(obj)) {
      if (!isMap(h) || typeof h.command !== 'string') continue;
      for (const m of h.command.matchAll(ANY_HOOK_RE)) {
        const script = `hooks/${m[1]}.js`;
        if (!files.has(script)) {
          err(`${HOOKS_JSON}이 출력에 없는 스크립트를 부름: ${script} — exclude.hooks: [${m[1]}] 로 빼면 호출 항목도 같이 빠진다`);
        }
      }
    }
  }

  // 4. 치환
  variant.replace.forEach((r, i) => {
    let targets = [...files.keys()];
    if (r.files) {
      for (const p of r.files) {
        if (!targets.some((rel) => matchesPath(rel, p))) err(`replace[${i}].files: 남은 파일에 없는 경로 ${p}`);
      }
      targets = targets.filter((rel) => r.files.some((p) => matchesPath(rel, p)));
    }
    let count = 0;
    for (const rel of targets) {
      const buf = files.get(rel);
      if (isBinary(buf)) continue;
      const parts = buf.toString('utf8').split(r.from);
      if (parts.length === 1) continue;
      count += parts.length - 1;
      files.set(rel, Buffer.from(parts.join(r.to), 'utf8'));
    }
    if (count === 0 && !r.optional) err(`replace[${i}]: "${r.from}"이 한 번도 안 맞음 (0번 맞아도 되면 optional: true)`);
  });

  // 5. 매니페스트
  const mkeys = Object.keys(variant.manifest);
  if (mkeys.length > 0) {
    let obj;
    try {
      obj = JSON.parse(files.get(PLUGIN_JSON).toString('utf8'));
    } catch (e) {
      err(`${PLUGIN_JSON}를 JSON으로 읽을 수 없음 — ${e.message}`);
    }
    if (!isMap(obj)) err(`${PLUGIN_JSON}가 JSON 객체가 아님`);
    for (const k of mkeys) obj[k] = variant.manifest[k];
    files.set(PLUGIN_JSON, Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8'));
  }

  // 6. 남은 언급 WARN
  const warnings = result.warnings.filter((w) => files.has(w.file));
  const pluginNames = [kit.meta.name, variant.manifest.name].filter((p, i, a) => typeof p === 'string' && p && a.indexOf(p) === i);
  const checks = [];
  for (const u of UNITS) {
    for (const n of removedUnits[u]) {
      checks.push({ res: mentionRes(u, n, pluginNames), message: `뺀 ${UNIT_LABEL[u]} ${n} 언급이 남아 있음` });
    }
  }
  if (checks.length > 0) {
    for (const [rel, buf] of files) {
      if (isBinary(buf)) continue;
      const lines = buf.toString('utf8').split('\n');
      const skip = rel.endsWith('.md') ? historyLines(lines) : null;
      for (let i = 0; i < lines.length; i++) {
        if (skip && skip[i]) continue;
        for (const c of checks) {
          if (c.res.some((re) => re.test(lines[i]))) warnings.push({ file: rel, line: i + 1, message: c.message });
        }
      }
    }
  }

  // 7. 정렬
  warnings.sort((a, b) => byCode(a.file, b.file) || a.line - b.line || byCode(a.message, b.message));
  const sortedNames = [...files.keys()].sort(byCode);
  return {
    files: new Map(sortedNames.map((rel) => [rel, files.get(rel)])),
    modes: new Map(sortedNames.filter((rel) => result.modes.has(rel)).map((rel) => [rel, result.modes.get(rel)])),
    warnings,
  };
}

module.exports = { loadVariant, applyVariant };
