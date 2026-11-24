// 낱말의 "깨진 형태"(mojibake) 생성기 + fixture 개인 정보 검사(test/fixtures-privacy.test.ts)와 redact.ts 가 같이 쓰는 규칙(맨 아래). 의존성 없음, Node 내장만.
// 비공개 낱말이 인코딩이 어긋난 채 녹화에 남는 경우(UTF-8 바이트를 Latin-1 로 읽기 등)를 잡으려고 쓴다.
// 5종, 이 순서: UTF-8→Latin-1, UTF-8→CP1252, CP949→Latin-1, CP949→CP1252, CP949→UTF-8(U+FFFD 아닌 글자가 2개 이상일 때만). 같은 것은 하나로.

// CP1252 의 0x80~0x9F. 정의 안 된 0x81 0x8D 0x8F 0x90 0x9D 는 Windows 동작대로 같은 코드포인트로 둔다.
const CP1252_HIGH = [
  '\u20AC', '\u0081', '\u201A', '\u0192', '\u201E', '\u2026', '\u2020', '\u2021',
  '\u02C6', '\u2030', '\u0160', '\u2039', '\u0152', '\u008D', '\u017D', '\u008F',
  '\u0090', '\u2018', '\u2019', '\u201C', '\u201D', '\u2022', '\u2013', '\u2014',
  '\u02DC', '\u2122', '\u0161', '\u203A', '\u0153', '\u009D', '\u017E', '\u0178',
];

function readAsLatin1(bytes: number[]): string {
  return Buffer.from(bytes).toString('latin1');
}
function readAsCp1252(bytes: number[]): string {
  return bytes.map((b) => (b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b))).join('');
}

let cp949Table: Map<string, number[]> | null | undefined; // undefined=아직, null=만들 수 없음
function cp949Reverse(): Map<string, number[]> | null {
  if (cp949Table !== undefined) return cp949Table;
  try {
    const dec = new TextDecoder('euc-kr');
    const table = new Map<string, number[]>();
    for (let lead = 0x81; lead <= 0xfe; lead++) {
      for (let trail = 0x41; trail <= 0xfe; trail++) {
        if (!((trail >= 0x41 && trail <= 0x5a) || (trail >= 0x61 && trail <= 0x7a) || trail >= 0x81)) continue;
        const s = dec.decode(Uint8Array.from([lead, trail]));
        if (s.length === 0 || [...s].length !== 1 || s === '\uFFFD') continue;
        if (!table.has(s)) table.set(s, [lead, trail]);
      }
    }
    cp949Table = table.size > 0 ? table : null;
  } catch {
    cp949Table = null;
  }
  return cp949Table;
}

export function cp949Bytes(word: string): number[] | null {
  const table = cp949Reverse();
  if (!table) return null;
  const out: number[] = [];
  for (const ch of word) {
    if (ch.charCodeAt(0) < 0x80) out.push(ch.charCodeAt(0));
    else {
      const b = table.get(ch);
      if (!b) return null;
      out.push(...b);
    }
  }
  return out;
}

export function mojibakeVariants(word: string): { variants: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const found: string[] = [];
  const utf8 = [...Buffer.from(word, 'utf8')];
  found.push(readAsLatin1(utf8), readAsCp1252(utf8));
  const cp949 = cp949Bytes(word);
  // 5번째: CP949 바이트를 UTF-8 로 읽은 것(U+FFFD 와 정상 글자가 섞인다). U+FFFD 만 남으면 정보가 없어 뺀다(오탐) — 홈 자리는 redact 가 U+FFFD 규칙으로 맡는다
  if (cp949) {
    found.push(readAsLatin1(cp949), readAsCp1252(cp949));
    // U+FFFD 가 아닌 글자가 2개 이상일 때만(1개 이하는 흔한 글자 하나라 오탐)
    const u = new TextDecoder('utf-8').decode(Uint8Array.from(cp949));
    if ([...u].filter((c) => c !== '\uFFFD').length >= 2) found.push(u);
  }
  else if (!cp949Reverse()) warnings.push("CP949 깨진 형태 2종 생략: TextDecoder('euc-kr') 를 쓸 수 없다(small-icu?)");
  else warnings.push('CP949 깨진 형태 2종 생략: 낱말에 CP949 로 표현되지 않는 글자가 있다');
  return { variants: [...new Set(found)].filter((v) => v !== word && !/^\uFFFD*$/.test(v)), warnings };
}

export function privateWordsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PLENUM_PRIVATE_WORDS || '').split(',').map((w) => w.trim()).filter(Boolean);
}

// ── fixture 개인 정보 검사와 redact 가 같이 쓰는 규칙 ─────────────
// 치환 값 `홍길동`·`hong` 만 예외. 이름 끝: 글자·숫자·_·-·비ASCII 글자가 이어지거나 '.'+글자·숫자가 이어지면 다른 이름(홍길동2·홍길동x·홍길동.txt·홍길동�).
// 뒤에 공백·'·)·문장 끝 '.' 는 끝으로 본다
export const HONG = '홍길동';
// 비ASCII 글자(U+FFFD·결합 문자 U+0333·´ 등 포함)가 바로 이어지면 모두 이름의 일부로 보고 막는다
export const NAME_END = '(?![\\p{L}\\p{N}_\\-]|[^\\x00-\\x7F]|\\.[\\p{L}\\p{N}])';
const OK_NAME = `${HONG}${NAME_END}`;
// [이름, 정규식] — 하나라도 맞으면 홍길동 아닌 Windows 사용자 폴더가 남은 것.
// 구분자 묶음은 (?=(…))\1 로 통째로 먹는다(되짚기로 \\ 중 하나만 먹고 뒤를 통과시키지 않게)
export const WIN_HOME_CHECKS: [string, RegExp][] = [
  ['Windows 사용자 폴더', new RegExp(`[A-Za-z]:[\\\\/]+Users(?=([\\\\/]+))\\1(?!${OK_NAME})`, 'iu')],
  ['드라이브 경로 /c/Users·//c/Users', new RegExp(`(?<![A-Za-z0-9])/+[A-Za-z]/Users/(?!${OK_NAME})`, 'iu')],
  ['WSL /mnt/<x>/Users', new RegExp(`/mnt/[A-Za-z]/Users/(?!${OK_NAME})`, 'iu')],
  // Claude 가 경로를 폴더 이름으로 바꾼 꼴: 글자·숫자 밖은 모두 '-'. 홍길동은 '---'(한 글자에 하나)로 바뀐다
  ['평탄화 C--Users-', new RegExp(`(?<![A-Za-z0-9])[A-Za-z]--Users-(?!(?:${HONG}|---)(?![\\p{L}\\p{N}_]))`, 'iu')],
];
// RateLimitResetCredit_<id>: 치환 값 _0 만 허용
export const RATE_CREDIT_LEFT = /RateLimitResetCredit_(?!0(?![A-Za-z0-9-]))[A-Za-z0-9-]+/i;

export const isAscii = (w: string) => /^[\x00-\x7F]*$/.test(w);
// 낱말이 글에 있는지. ASCII 낱말은 대소문자 무시, 그 밖(한글·깨진 형태)은 글자 그대로
export function hasWord(text: string, word: string): boolean {
  if (!word) return false;
  return isAscii(word) ? text.toLowerCase().includes(word.toLowerCase()) : text.includes(word);
}

export const EMPTY_WORDS =
  'PLENUM_PRIVATE_WORDS 가 비어 있다. 이메일 아이디·실명·Windows 사용자 이름 등을 쉼표로 넣고 다시 돌린다' +
  ' (PowerShell: $env:PLENUM_PRIVATE_WORDS="낱말1,낱말2"). 낱말 없이 하려면 --allow-empty-words';
// 녹화·치환 전에: 낱말이 비었으면 거부. --allow-empty-words 면 경고만, --dry-run 은 경고만
export function wordsGate(words: string[], o: { allowEmpty?: boolean; dryRun?: boolean } = {}): { ok: boolean; message: string | null } {
  if (words.length > 0) return { ok: true, message: null };
  if (o.allowEmpty) return { ok: true, message: 'PLENUM_PRIVATE_WORDS 가 비어 있다 — --allow-empty-words 로 낱말 치환·검사 없이 진행' };
  if (o.dryRun) return { ok: true, message: `경고: ${EMPTY_WORDS}` };
  return { ok: false, message: EMPTY_WORDS };
}

// JSON \uXXXX 이스케이프 꼴(ASCII 밖 글자만 이스케이프). 소문자 hex·대문자 hex 두 가지. ASCII 낱말은 없음
export function escapeForms(word: string): string[] {
  if (isAscii(word)) return [];
  const esc = (up: boolean) => [...word].map((ch) => (ch.charCodeAt(0) < 0x80 && ch.length === 1 ? ch
    : [...Array(ch.length).keys()].map((i) => { const h = ch.charCodeAt(i).toString(16).padStart(4, '0'); return `\\u${up ? h.toUpperCase() : h}`; }).join(''))).join('');
  return [...new Set([esc(false), esc(true)])];
}

// JSON 글이 문자열 안에 또 들어가면 이스케이프가 \\uac11 처럼 백슬래시가 여럿이 된다 → 하나로 접은 사본에서도 찾는다
export const foldEscapes = (s: string) => (s.includes('\\') ? s.replace(/\\+u/g, '\\u') : s);
// 이스케이프 꼴 낱말 검사(백슬래시 개수 무관)
export function hasEscapeForm(text: string, word: string): boolean {
  const forms = escapeForms(word);
  if (forms.length === 0 || !text.includes('\\')) return false;
  const f = foldEscapes(text);
  return forms.some((v) => f.includes(v));
}

// fail-closed: 녹화 fixture(app/test/fixtures/providers/**)는 올바른 UTF-8·BOM 없음·NUL 없음이어야 한다.
// 그 밖이면 내용과 상관없이 실패(깨진 바이트 속 낱말을 쫓아가지 않고 막는다). 문제 없으면 null
export function fixtureBytesProblem(buf: Uint8Array): string | null {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'BOM 있음';
  if (buf.includes(0)) return 'NUL 바이트 있음';
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return '올바른 UTF-8 이 아님'; }
  return null;
}
export const FIXTURE_STRICT_DIR = 'app/test/fixtures/providers/';
