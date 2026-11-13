// 채팅 글의 마크다운 → 노드 트리 (순수 함수). HTML 은 해석하지 않는다 — 모든 글자는 text 노드로 남고 React 가 이스케이프한다.
// 지원: 단락·줄바꿈, ``` 코드 블록, `인라인 코드`, **굵게**, *기울임*, -/*/1. 목록(한 단계 중첩), [글](http·https 링크),
// # 제목, 파이프 표, > 인용. 모르는 건 글자 그대로.
export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'br' };
export interface ListItem { c: Inline[]; sub: Extract<Block, { t: 'list' }> | null }
export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'list'; ordered: boolean; items: ListItem[] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'quote'; c: Block[] };

const SAFE_URL = /^https?:\/\/[^\s]+$/i;

function pushText(out: Inline[], v: string) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === 'text') last.v += v;
  else out.push({ t: 'text', v });
}

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let buf = '';
  const flush = () => { pushText(out, buf); buf = ''; };
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\n') { flush(); out.push({ t: 'br' }); i++; continue; }
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i + 1) { flush(); out.push({ t: 'code', v: s.slice(i + 1, end) }); i = end + 1; continue; }
    }
    if (ch === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2 && !/\s/.test(s[i + 2])) { flush(); out.push({ t: 'strong', c: parseInline(s.slice(i + 2, end)) }); i = end + 2; continue; }
    }
    if (ch === '*' && s[i + 1] !== '*') {
      let end = s.indexOf('*', i + 1);
      while (end > 0 && s[end + 1] === '*') end = s.indexOf('*', end + 2);
      if (end > i + 1 && !/\s/.test(s[i + 1]) && !/\s/.test(s[end - 1])) { flush(); out.push({ t: 'em', c: parseInline(s.slice(i + 1, end)) }); i = end + 1; continue; }
    }
    if (ch === '[') {
      const mid = s.indexOf('](', i + 1);
      const end = mid > i ? s.indexOf(')', mid + 2) : -1;
      if (mid > i && end > mid && !s.slice(i + 1, mid).includes('\n')) {
        const href = s.slice(mid + 2, end).trim();
        if (SAFE_URL.test(href)) { flush(); out.push({ t: 'link', href, c: parseInline(s.slice(i + 1, mid)) }); i = end + 1; continue; }
        // http·https 가 아니면 통째로 글자
        buf += s.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

const FENCE = /^\s*```\s*([^`\s]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;

function cells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}
const isTableStart = (lines: string[], i: number) => lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-');
const startsBlock = (lines: string[], i: number) => FENCE.test(lines[i]) || HEADING.test(lines[i]) || LIST.test(lines[i]) || QUOTE.test(lines[i]) || isTableStart(lines, i);

export function parseMarkdown(src: string): Block[] {
  return parseLines(String(src ?? '').replace(/\r\n?/g, '\n').split('\n'));
}

function parseLines(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const f = FENCE.exec(line);
    if (f) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // 닫는 ``` (없으면 끝까지)
      out.push({ t: 'code', lang: f[1], v: body.join('\n') });
      continue;
    }

    const h = HEADING.exec(line);
    if (h) { out.push({ t: 'h', level: h[1].length, c: parseInline(h[2]) }); i++; continue; }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1]);
      out.push({ t: 'quote', c: parseLines(body) });
      continue;
    }

    if (isTableStart(lines, i)) {
      const head = cells(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const r = cells(lines[i]).map(parseInline);
        while (r.length < head.length) r.push([]);
        rows.push(r.slice(0, head.length));
        i++;
      }
      out.push({ t: 'table', head, rows });
      continue;
    }

    const l = LIST.exec(line);
    if (l) {
      const baseIndent = l[1].length;
      const list: Extract<Block, { t: 'list' }> = { t: 'list', ordered: /\d/.test(l[2]), items: [] };
      const texts: string[] = [];
      const subs: { ordered: boolean; texts: string[] }[] = [];
      let cur = -1;
      while (i < lines.length && lines[i].trim()) {
        const m = LIST.exec(lines[i]);
        if (m && m[1].length <= baseIndent + 1) {
          texts.push(m[3]); subs.push({ ordered: false, texts: [] }); cur = texts.length - 1;
        } else if (m && cur >= 0) {
          const sub = subs[cur];
          if (sub.texts.length === 0) sub.ordered = /\d/.test(m[2]);
          sub.texts.push(m[3]);
        } else if (cur >= 0 && /^\s+\S/.test(lines[i])) {
          // 들여 쓴 이어지는 줄
          const sub = subs[cur];
          if (sub.texts.length) sub.texts[sub.texts.length - 1] += '\n' + lines[i].trim();
          else texts[cur] += '\n' + lines[i].trim();
        } else break;
        i++;
      }
      list.items = texts.map((t, k) => ({
        c: parseInline(t),
        sub: subs[k].texts.length ? { t: 'list', ordered: subs[k].ordered, items: subs[k].texts.map((x) => ({ c: parseInline(x), sub: null })) } : null,
      }));
      out.push(list);
      continue;
    }

    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) para.push(lines[i++]);
    out.push({ t: 'p', c: parseInline(para.join('\n')) });
  }
  return out;
}
