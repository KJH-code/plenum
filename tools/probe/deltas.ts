// 스트리밍 조각(stream_event 의 content_block_delta) 이어 붙이기. redact·scan·CI(test/fixtures-privacy.test.ts)가 같이 쓴다.
// 이름·홈 경로가 조각 경계에서 끊기면 줄 단위 검사로는 못 잡는다 → 같은 메시지·같은 content block 의 조각을 이어 붙인 문자열에서 치환·검사한다.
// 묶는 키(2.1.323 녹화로 확인): session_id + parent_tool_use_id + 메시지 id(api_message_id, 없으면 그 앞 message_start 의 message.id) + event.index.
// 조각 종류: text_delta.text · input_json_delta.partial_json · thinking_delta.thinking. signature_delta 는 건드리지 않는다.
// 의존성 없음, Node 내장만.

export const DELTA_FIELDS: Record<string, string> = { text_delta: 'text', input_json_delta: 'partial_json', thinking_delta: 'thinking' };

export interface DeltaPiece { line: number; field: string; text: string }        // line: lines 배열의 번호(0부터)
export interface DeltaGroup { key: string; kind: string; pieces: DeltaPiece[] }
export interface DeltaProblem { line: number; why: string }

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

// strict: 모든 줄이 녹화 줄 모양({dir, …} JSON)이어야 한다(fixture·CI). 아니면 JSON 아닌 줄은 건너뛴다(redact 원본의 raw 줄 등)
export function collectDeltas(lines: string[], o: { strict?: boolean } = {}): { groups: DeltaGroup[]; problems: DeltaProblem[] } {
  const groups = new Map<string, DeltaGroup>();
  const problems: DeltaProblem[] = [];
  const lastMsg = new Map<string, string>();                     // session|parent → 지금 메시지 id(message_start)
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    let o2: any;
    try { o2 = JSON.parse(l); } catch { if (o.strict) problems.push({ line: i, why: 'JSON 이 아닌 줄' }); return; }
    if (!isObj(o2) || typeof o2.dir !== 'string') { if (o.strict) problems.push({ line: i, why: '녹화 줄 모양({dir, …})이 아님' }); return; }
    const m = o2.msg;
    if (!isObj(m) || m.type !== 'stream_event' || !isObj(m.event)) return;
    const e = m.event;
    const sp = JSON.stringify([m.session_id ?? null, m.parent_tool_use_id ?? null]);
    if (e.type === 'message_start' && isObj(e.message) && typeof e.message.id === 'string') { lastMsg.set(sp, e.message.id); return; }
    if (e.type !== 'content_block_delta' || !isObj(e.delta)) return;
    const kind = e.delta.type;
    const field = typeof kind === 'string' ? DELTA_FIELDS[kind] : undefined;
    if (!field) return;                                            // signature_delta 등은 묶지 않는다(줄 단위 검사만)
    const text = e.delta[field];
    if (typeof text !== 'string') { problems.push({ line: i, why: `${kind} 의 ${field} 가 문자열이 아님` }); return; }
    const msgId = typeof m.api_message_id === 'string' ? m.api_message_id : lastMsg.get(sp);
    if (msgId === undefined || !Number.isInteger(e.index)) { problems.push({ line: i, why: 'delta 묶음 키(메시지 id·index)가 없음' }); return; }
    const key = JSON.stringify([m.session_id ?? null, m.parent_tool_use_id ?? null, msgId, e.index]);
    let g = groups.get(key);
    if (!g) { g = { key, kind, pieces: [] }; groups.set(key, g); }
    else if (g.kind !== kind) { problems.push({ line: i, why: `같은 블록에 delta 종류가 섞임(${g.kind}·${kind})` }); return; }
    g.pieces.push({ line: i, field, text });
  });
  return { groups: [...groups.values()], problems };
}

// 이어 붙인 문자열(조각이 2개 이상인 묶음만 — 1개면 줄 단위 검사와 같다). line: 묶음의 첫 줄(0부터)
export function joinedDeltaTexts(lines: string[], o: { strict?: boolean } = {}): { texts: { line: number; text: string }[]; problems: DeltaProblem[] } {
  const { groups, problems } = collectDeltas(lines, o);
  return { texts: groups.filter((g) => g.pieces.length > 1).map((g) => ({ line: g.pieces[0].line, text: g.pieces.map((p) => p.text).join('') })), problems };
}

// ── 문자 단위 diff(Myers) → 구간 목록. 결정적
export type Seg = { eq: true; len: number } | { eq: false; del: number; ins: number };

function myers(a: string, b: string): Seg[] {
  const n = a.length; const m = b.length; const max = n + m;
  if (max === 0) return [];
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a.charCodeAt(x) === b.charCodeAt(y)) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  // 되짚어 연산 목록(앞에서부터): 'e' 같음, 'd' 지움, 'i' 넣음
  const ops: string[] = [];
  let x = n; let y = m;
  for (let d = found; d > 0; d--) {
    const pv = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && pv[off + k - 1] < pv[off + k + 1]) ? k + 1 : k - 1;
    const px = pv[off + prevK]; const py = px - prevK;
    while (x > px && y > py) { ops.push('e'); x--; y--; }
    if (x === px) { ops.push('i'); y--; } else { ops.push('d'); x--; }
  }
  while (x > 0 && y > 0) { ops.push('e'); x--; y--; }
  ops.reverse();
  const segs: Seg[] = [];
  for (const op of ops) {
    const last = segs[segs.length - 1];
    if (op === 'e') { if (last && last.eq) last.len++; else segs.push({ eq: true, len: 1 }); }
    else if (last && !last.eq) { if (op === 'd') last.del++; else last.ins++; }
    else segs.push({ eq: false, del: op === 'd' ? 1 : 0, ins: op === 'i' ? 1 : 0 });
  }
  return segs;
}

// S → S' 구간 목록. 앞뒤 공통 부분은 먼저 떼고, 바뀐 구간 사이의 짧은 같은 구간(2글자 이하)은 바뀐 구간에 합친다
// (치환 값과 원래 이름이 우연히 한 글자 같아 경계가 이름 가운데 남지 않게)
export function diffSegments(a: string, b: string): Seg[] {
  let p = 0;
  while (p < a.length && p < b.length && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  const mid = myers(a.slice(p, a.length - s), b.slice(p, b.length - s));
  const raw: Seg[] = [...(p ? [{ eq: true as const, len: p }] : []), ...mid, ...(s ? [{ eq: true as const, len: s }] : [])];
  const out: Seg[] = [];
  for (let i = 0; i < raw.length; i++) {
    const g = raw[i];
    const prev = out[out.length - 1];
    if (g.eq) {
      const next = raw[i + 1];
      if (g.len <= 2 && prev && !prev.eq && next && !next.eq) { prev.del += g.len; prev.ins += g.len; continue; }
      if (prev && prev.eq) prev.len += g.len; else out.push({ ...g });
    } else if (prev && !prev.eq) { prev.del += g.del; prev.ins += g.ins; }
    else out.push({ ...g });
  }
  return out;
}

// 낱말을 끊는 글자(공백·따옴표·괄호 등). 경로 글자(\\ / : . - _)는 끊지 않는다
const BREAK = /[\s"'`,;(){}\[\]<>|=]/;
const GLUE_MAX = 256;

// S 의 경계 오프셋(오름차순) → S' 오프셋. 같은 구간 안은 그대로, 바뀐 구간 안(시작 제외)은 그 구간의 끝으로.
// a(=S)를 주면: 같은 구간 안의 경계라도 바로 뒤 바뀐 구간까지 끊는 글자 없이 이어지면(같은 낱말·경로 조각 — 예: `C:\\Users\\|갑돌`)
// 그 바뀐 구간의 끝으로 옮긴다. 조각이 `Users\\` 로 끝나 줄 단위 홈 검사에 걸리거나 이름 앞부분과 치환 값이 갈리지 않게
export function mapBoundaries(segs: Seg[], bounds: number[], a?: string): number[] {
  const out: number[] = [];
  let i = 0; let pa = 0; let pb = 0;
  const glue = (b: number, segEndA: number, segEndB: number, next: Seg | undefined): number | null => {
    if (a === undefined || !next || next.eq) return null;
    const rest = a.slice(b, segEndA);
    if (rest.length > GLUE_MAX || BREAK.test(rest)) return null;
    if (b === 0 || BREAK.test(a[b - 1])) return null;      // 경계 앞이 끊는 글자면 뒤 조각이 낱말의 시작 — 그대로
    return segEndB + next.ins;
  };
  for (const b of bounds) {
    for (;;) {
      const g = segs[i];
      if (!g) { out.push(pb); break; }
      const la = g.eq ? g.len : g.del; const lb = g.eq ? g.len : g.ins;
      const last = i === segs.length - 1;
      if (b < pa + la || (b === pa + la && last)) {
        if (g.eq) out.push(glue(b, pa + la, pb + lb, segs[i + 1]) ?? pb + (b - pa));
        else out.push(pb + lb);
        break;
      }
      if (b === pa + la) { out.push(g.eq ? (glue(b, pa + la, pb + lb, segs[i + 1]) ?? pb + lb) : pb + lb); break; }
      pa += la; pb += lb; i++;
    }
  }
  return out;
}

// 조각들을 이어 붙여 f 로 바꾼 뒤 원래 경계로 다시 나눈다. 조각 수는 그대로(빈 조각 가능)
export function splitLike(pieces: string[], replaced: string, original = pieces.join('')): string[] {
  const bounds: number[] = [];
  let acc = 0;
  for (let i = 0; i < pieces.length - 1; i++) { acc += pieces[i].length; bounds.push(acc); }
  const nb = mapBoundaries(diffSegments(original, replaced), bounds, original);
  const cuts = [0, ...nb, replaced.length];
  return pieces.map((_, i) => replaced.slice(cuts[i], cuts[i + 1]));
}
