'use strict';
// 손으로 두는 산문에 적힌 모델 표기가 워커 파일 값과 다르면 경고(에러 아님).
//
// 표기 = "Model effort"(예: Sonnet medium) 또는 "Model"만(예: (Sonnet), Opus).
//   effort까지 있으면 계층 전체를, 모델만 있으면 모델만 워커 파일과 비교한다.
// 이름 = 백틱 안 kit 워커 이름(`w-implement`). `a`·`b` 처럼 가운뎃점으로 붙은 이름은 한 묶음.
//
// 이름(묶음)과 표기를 짝짓는 규칙:
//   앞) 표기 바로 뒤에 이름: "Sonnet medium `w-implement`" (사이에 공백만)
//   뒤) 이름 뒤 같은 구간 안의 첫 표기. 구간은 이름 끝에서 시작해 아래 중 먼저 오는 곳에서 끊긴다.
//       - 다른 워커 이름 (그 이름의 표기다)
//       - 표 칸 경계 |, 줄 끝
//       - 문장 끝 (. 뒤 공백·줄 끝, 또는 **. 처럼 강조 뒤)
//       - 괄호 밖 쉼표·세미콜론 (목록의 다음 항목). 이름 뒤 괄호 안의 쉼표는 끊지 않는다: (`su-verifier`, Opus high)
//       - MAX_GAP(20)자를 넘는 거리. 기준본에서 이름과 표기 사이에 낀 말은 최대 11자
//         ("가벼운 review")라 여유를 두되, 다른 절의 모델 이야기까지 닿지 않게 짧게 둔다.
//   칸) 표 칸 하나에 워커 이름 1개와 표기 1개만 있으면 거리와 상관없이 짝.
//
// 빼는 곳: "변경 기록" 절, ``` 코드 블록, kit/prose-ignore.yaml 항목에 맞는 줄. .md 파일만 본다.
const { displayModel, tierOf } = require('./kit');

const MAX_GAP = 20;
const MODEL = '(Opus|Sonnet|Haiku|Fable)';
const EFFORT = '(low|medium|high|xhigh|max)';
const PHRASE_SRC = `(?<![\\w-])${MODEL}(?: ${EFFORT})?(?![\\w-])`;
const RE_PHRASE = new RegExp(PHRASE_SRC, 'g');
const RE_NAME = /`([a-z0-9-]+)`/g;
const HISTORY_HEADING = /^(#{1,6})\s+변경 기록\s*$/;

function phrasesIn(text, offset = 0) {
  return [...text.matchAll(RE_PHRASE)].map((m) => ({
    start: offset + m.index, end: offset + m.index + m[0].length, model: m[1], effort: m[2] || null, text: m[0],
  }));
}

// 이름 묶음 목록: [{names:[...], start, end}]
function nameGroups(line, isWorker) {
  const hits = [...line.matchAll(RE_NAME)].filter((m) => isWorker(m[1]))
    .map((m) => ({ name: m[1], start: m.index, end: m.index + m[0].length }));
  const groups = [];
  for (const h of hits) {
    const g = groups[groups.length - 1];
    if (g && line.slice(g.end, h.start) === '·') { g.names.push(h.name); g.end = h.end; continue; }
    groups.push({ names: [h.name], start: h.start, end: h.end });
  }
  return groups;
}

// 이름 끝(from)에서 시작하는 구간의 끝 위치
function segmentEnd(line, from, nextNameStart, inParen) {
  let limit = Math.min(nextNameStart, line.length, from + MAX_GAP + 40);
  let depth = 0;
  for (let i = from; i < limit; i++) {
    const c = line[i];
    if (c === '(') depth++;
    else if (c === ')') { if (depth > 0) depth--; else return i; }
    else if (c === '|') return i;
    else if ((c === ',' || c === ';') && depth === 0 && !inParen) return i;
    else if (c === '.' && (i + 1 >= line.length || /[\s*)]/.test(line[i + 1]))) return i;
  }
  return limit;
}

// 위치 앞에서 닫히지 않은 ( 개수
function parenDepth(line, pos) {
  let d = 0;
  for (let i = 0; i < pos; i++) {
    if (line[i] === '(') d++;
    else if (line[i] === ')' && d > 0) d--;
  }
  return d;
}

function loadIgnore(kit) {
  return (kit.proseIgnore || []).map((e) => ({
    ...e,
    re: e.pattern !== undefined ? new RegExp(e.pattern) : null,
  }));
}

function ignored(rules, rel, text) {
  return rules.some((r) => r.file === rel && (r.re ? r.re.test(text) : text.includes(r.line_contains)));
}

function proseWarnings(kit, rel, text) {
  if (!rel.endsWith('.md')) return [];
  const rules = loadIgnore(kit);
  const isWorker = (n) => kit.workers.has(n);
  const warnings = [];
  const lines = text.split('\n');
  let skipLevel = 0;
  let fence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = /^(#{1,6})\s/.exec(line);
    if (h) {
      if (skipLevel && h[1].length <= skipLevel) skipLevel = 0;
      const hist = HISTORY_HEADING.exec(line);
      if (hist && !skipLevel) skipLevel = hist[1].length;
    }
    if (skipLevel) continue;
    if (ignored(rules, rel, line)) continue;

    const pairs = []; // {name, phrase}
    const groups = nameGroups(line, isWorker);
    const phrases = phrasesIn(line);
    groups.forEach((g, gi) => {
      // 앞) 바로 앞 표기
      const before = phrases.find((p) => p.end <= g.start && /^ +$/.test(line.slice(p.end, g.start)));
      if (before) for (const n of g.names) pairs.push({ name: n, p: before, rule: '앞' });
      // 뒤) 구간 안 첫 표기
      const next = gi + 1 < groups.length ? groups[gi + 1].start : line.length;
      const end = segmentEnd(line, g.end, next, parenDepth(line, g.start) > 0);
      const after = phrases.find((p) => p.start >= g.end && p.end <= end && p.start - g.end <= MAX_GAP);
      if (after) for (const n of g.names) pairs.push({ name: n, p: after, rule: '뒤' });
    });
    // 목록) "Opus 짝(`a`, `b`)" — 이름만 든 괄호 목록 바로 앞(같은 구 안)의 표기
    for (const m of line.matchAll(/\(((?:`[a-z0-9-]+`(?:, |·))*`[a-z0-9-]+`)\)/g)) {
      const names = [...m[1].matchAll(RE_NAME)].map((x) => x[1]);
      if (!names.every(isWorker)) continue;
      const p = phrases.filter((x) => x.end <= m.index).pop();
      if (!p) continue;
      const gap = line.slice(p.end, m.index);
      if (gap.length > MAX_GAP || /[.,;|()`]/.test(gap)) continue;
      for (const n of names) pairs.push({ name: n, p, rule: '목록' });
    }
    // 칸) 표 칸에 이름 1개 + 표기 1개
    if (line.startsWith('|')) {
      let pos = 0;
      for (const cell of line.split('|')) {
        const names = [...cell.matchAll(RE_NAME)].map((m) => m[1]).filter(isWorker);
        const ps = phrasesIn(cell, pos);
        if (names.length === 1 && ps.length === 1) pairs.push({ name: names[0], p: ps[0], rule: '칸' });
        pos += cell.length + 1;
      }
    }

    const seen = new Set();
    for (const { name, p, rule } of pairs) {
      const key = `${name}\0${p.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const w = kit.workers.get(name);
      const actual = p.effort ? tierOf(w) : displayModel(w.model);
      if (kit.proseTrace) kit.proseTrace({ file: rel, line: lineNo, name, said: p.text, actual, rule });
      if (p.text !== actual) {
        warnings.push({ file: rel, line: lineNo, message: `\`${name}\` 산문 표기 "${p.text}"가 워커 파일 값 "${actual}"과 다름` });
      }
    }
  }
  return warnings;
}

module.exports = { proseWarnings, MAX_GAP };
