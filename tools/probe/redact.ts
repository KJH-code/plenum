// 녹화 원본(record.ts 결과) → 개인 정보를 치환한 fixture. 같은 입력·같은 env 면 같은 출력.
// 사용(app/ 에서): npm run probe:redact -- <scene>-raw.jsonl [--dest <dir>] [--allow-empty-words] [--explain]
//   → <dest>/<scene>.jsonl, <dest>/meta.json(scenes 에 추가·정렬, 있으면 합침). dest 기본 app/test/fixtures/providers/claude/<version>/
// 치환 규칙은 2.1.323 README 를 따른다: 홈 → C:\Users\홍길동 · /home/hong, PLENUM_PRIVATE_WORDS·Windows 사용자 이름과 깨진 형태 → 홍길동/hong,
// 허용 밖 이메일 → hong@example.invalid, 계정·조직 UUID → 0 UUID, synced/<uuid>_<uuid> → synced/ORG_ACCOUNT,
// RateLimitResetCredit_<id> → _0, 작업 폴더 랜덤 → AbCdEf. 시스템 프롬프트·계정 맥락 첨부·init 의 스킬·명령 설명은 지운다.
// 치환 뒤에도 낱말·깨진 형태·다른 Windows 홈이 남으면 파일을 쓰지 않고 0 아닌 코드로 끝난다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cp949Bytes, HONG, NAME_END, RATE_CREDIT_LEFT, WIN_HOME_CHECKS, isAscii, mojibakeVariants, privateWordsFromEnv, wordsGate } from './variants.ts';

export const WIN_HOME = HONG;
export const POSIX_HOME = '/home/hong';
export const RAND = 'AbCdEf';
export const FAKE_EMAIL = 'hong@example.invalid';

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const HANGUL = /[\uAC00-\uD7A3]/;

// 낱말 하나의 치환·검사 규칙. ci: 대소문자 무시(ASCII 낱말), bounded: 앞뒤가 영숫자면 안 맞음(env 에서 얻은 ASCII 사용자 이름)
export interface WordRule { from: string; to: string; ci: boolean; bounded: boolean; label: string; re: RegExp }
function wordRule(from: string, to: string, label: string, bounded: boolean): WordRule {
  const ci = isAscii(from);
  const b = bounded && ci;
  const src = b ? `(?<![A-Za-z0-9])${esc(from)}(?![A-Za-z0-9])` : esc(from);
  return { from, to, ci, bounded: b, label, re: new RegExp(src, ci ? 'gi' : 'g') };
}

// JSON \uXXXX 이스케이프 꼴 규칙. 백슬래시 개수(\u·\\u·…)는 맞은 그대로 두고 홍길동의 같은 꼴로 바꾼다
export interface EscRule { label: string; re: RegExp }
function escRule(word: string, label: string): EscRule | null {
  if (isAscii(word) || HONG.includes(word)) return null;   // 치환 값과 겹치는 낱말은 add 와 같이 뺀다
  let first = true;
  const src = [...word].map((ch) => {
    if (ch.length === 1 && ch.charCodeAt(0) < 0x80) return esc(ch);
    return [...Array(ch.length).keys()].map((i) => {
      const h = ch.charCodeAt(i).toString(16).padStart(4, '0');
      const part = `${first ? '(\\\\+)' : '\\1'}u${h}`;
      first = false;
      return part;
    }).join('');
  }).join('');
  return { label, re: new RegExp(src, 'gi') };
}
const hongEscape = (bs: string, upper: boolean) => [...HONG].map((c) => {
  const h = c.charCodeAt(0).toString(16).padStart(4, '0');
  return `${bs}u${upper ? h.toUpperCase() : h}`;
}).join('');

export interface Ctx {
  winNames: string[];                         // Windows 사용자 이름(홍길동 제외)
  posixHomes: string[];                       // POSIX 홈 경로(/home/x, /Users/x, /root)
  words: WordRule[];                          // 낱말·깨진 형태·사용자 이름 규칙, 긴 것부터
  escapes: EscRule[];                         // 낱말·사용자 이름의 JSON \uXXXX 이스케이프 꼴(백슬래시 개수 무관)
  privateWords: number;                       // PLENUM_PRIVATE_WORDS 낱말 수
  junk: string;                               // 홈 폴더 이름 자리가 이것만으로 되어 있으면 홍길동으로(U+FFFD·깨진 형태)
  rand: string | null;                        // 작업 폴더 랜덤(모르면 6자 아무거나)
  uuids: Map<string, string>;                 // 계정·조직 UUID → 0 UUID (처음 나온 순서)
  warnings: string[];
}

export interface CtxInput {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  tmpdir?: string;
  workdir?: string | null;
  platform?: NodeJS.Platform;                 // win32 이면 env.USERNAME 도 사용자 이름으로 본다
}

// 맨 이름으로 치환하면 녹화가 망가지는 흔한 이름(그 자체로 사람을 가리키지 않는다)
const GENERIC_NAMES = new Set(['user', 'users', 'admin', 'administrator', 'owner', 'guest', 'default', 'public', 'home', 'test', 'pc', 'me', 'hong']);
const WIN_USER = /^[A-Za-z]:[\\/]+Users[\\/]+([^\\/]+)/i;
export function buildContext(o: CtxInput = {}): Ctx {
  const env = o.env ?? process.env;
  const homedir = o.homedir ?? os.homedir();
  const tmpdir = o.tmpdir ?? os.tmpdir();
  const srcs = [homedir, env.USERPROFILE, env.HOME, env.TEMP, env.TMP, tmpdir, o.workdir ?? undefined]
    .filter((x): x is string => typeof x === 'string' && x.length > 0);
  const winNames = new Set<string>();
  const posixHomes = new Set<string>();
  for (const s of srcs) {
    const m = WIN_USER.exec(s);
    if (m && m[1] !== WIN_HOME) winNames.add(m[1]);
    // git bash 의 HOME=/c/Users/<이름>, WSL 의 /mnt/c/Users/<이름>
    const g = /^(?:\/+|\/mnt\/)[A-Za-z]\/Users\/([^/]+)/i.exec(s);
    if (g && g[1] !== WIN_HOME) winNames.add(g[1]);
  }
  // Windows 로그인 이름(폴더 이름과 다를 수 있다)
  if ((o.platform ?? process.platform) === 'win32' && env.USERNAME && env.USERNAME !== WIN_HOME && !/[\\/]/.test(env.USERNAME)) winNames.add(env.USERNAME);
  for (const s of [homedir, env.HOME]) {
    if (typeof s !== 'string' || !s.startsWith('/') || /^(?:\/+|\/mnt\/)[A-Za-z]\/Users\//i.test(s)) continue;
    const h = s.replace(/\/+$/, '');
    if (h && h !== POSIX_HOME) posixHomes.add(h);
  }
  const warnings: string[] = [];
  const rules = new Map<string, WordRule>();
  const junkParts = new Set<string>(['\uFFFD']);
  const add = (from: string, to: string, label: string, bounded: boolean) => {
    if (!from) return;
    if (from.toLowerCase() === to.toLowerCase() || (isAscii(from) && to.toLowerCase().includes(from.toLowerCase())) || HONG.includes(from)) {
      warnings.push(`${label}: 치환 값(${to})과 겹쳐서 치환·검사하지 않는다`);
      return;
    }
    const key = isAscii(from) ? from.toLowerCase() : from;
    if (!rules.has(key)) rules.set(key, wordRule(from, to, label, bounded));
  };
  const words = privateWordsFromEnv(env);
  words.forEach((w, i) => {
    add(w, HANGUL.test(w) ? HONG : 'hong', `낱말 #${i + 1}`, false);
    const mv = mojibakeVariants(w);
    warnings.push(...mv.warnings.map((x) => `낱말 #${i + 1}: ${x}`));
    mv.variants.forEach((v, k) => { add(v, HONG, `낱말 #${i + 1} 깨진 형태 ${k + 1}`, false); junkParts.add(v); });
  });
  // 긴 이름부터(Kim 이 Kim Gapdol 의 앞부분만 바꾸고 나머지를 남기지 않게). 같으면 문자순
  const names = [...winNames].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  // 홈 자리 전용: CP949 바이트를 UTF-8 로 읽은 꼴 전체(U+FFFD 아닌 글자 수와 상관없이). 낱말 규칙·CI 검사에서는 2글자 미만이면 뺀다(mojibakeVariants)
  const f5 = (w: string) => {
    const c = cp949Bytes(w);
    if (!c) return;
    const u = new TextDecoder('utf-8').decode(Uint8Array.from(c));
    if (u !== w) junkParts.add(u);                     // ASCII 이름은 그대로라 빼야 한다(깨진 형태가 아님)
  };
  words.forEach(f5);
  names.forEach(f5);
  const escapes: EscRule[] = [];
  words.forEach((w, i) => { const r = escRule(w, `낱말 #${i + 1} JSON 이스케이프`); if (r) escapes.push(r); });
  names.forEach((n, i) => { const r = escRule(n, `사용자 이름 #${i + 1} JSON 이스케이프`); if (r) escapes.push(r); });
  names.forEach((n, i) => {
    const mv = mojibakeVariants(n);
    mv.variants.forEach((v, k) => { add(v, HONG, `사용자 이름 #${i + 1} 깨진 형태 ${k + 1}`, false); junkParts.add(v); });
    if (isAscii(n) && (GENERIC_NAMES.has(n.toLowerCase()) || n.length < 3)) {
      warnings.push(`사용자 이름 #${i + 1}: 흔한·짧은 이름이라 경로 밖 맨 이름은 치환하지 않는다(경로 안은 치환)`);
      return;
    }
    add(n, isAscii(n) ? 'hong' : HONG, `사용자 이름 #${i + 1}`, true);
  });
  const sorted = [...rules.values()].sort((a, b) => b.from.length - a.from.length || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const junk = [...junkParts].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map(esc).join('|');
  const r = o.workdir ? /plenum-rec-[^\\/]*-([A-Za-z0-9]{6})(?=[\\/]|$)/.exec(o.workdir) : null;
  return {
    winNames: names, posixHomes: [...posixHomes].sort((a, b) => b.length - a.length), words: sorted, escapes,
    privateWords: words.length, junk, rand: r ? r[1] : null, uuids: new Map(), warnings,
  };
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_KEY = /^(organization|account|user|org)_?uuid$/i;
const UUID_TEXT = new RegExp(`((?:organization|account|user|org)_?[Uu]uid\\\\*"\\s*:\\s*\\\\*")(${UUID})`, 'gi');
const SYNCED = new RegExp(`(synced(?:\\\\+|/+))${UUID}_${UUID}`, 'g');
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL = /(@example\.invalid|@users\.noreply\.github\.com|^noreply@anthropic\.com)$/i;
const isZeroUuid = (u: string) => /^00000000-0000-4000-8000-0{11}[0-9]$/.test(u);

function zeroUuid(ctx: Ctx, u: string): string {
  if (isZeroUuid(u)) return u;
  const k = u.toLowerCase();
  let z = ctx.uuids.get(k);
  if (!z) { z = `00000000-0000-4000-8000-${String(ctx.uuids.size + 1).padStart(12, '0')}`; ctx.uuids.set(k, z); }
  return z;
}

// 홈 폴더 자리(이름 패턴 n) → 홍길동. 구분자 모양은 그대로: X:\Users\ · JSON 의 \\ · / · //c/Users/ · /c/Users/ · /mnt/c/Users/
function replaceHome(t: string, n: string): string {
  t = t.replace(new RegExp(`[A-Za-z]:([\\\\/]+)Users([\\\\/]+)(?:${n})${NAME_END}`, 'giu'), (_m, a, b) => `C:${a}Users${b}${WIN_HOME}`);
  t = t.replace(new RegExp(`(?<![A-Za-z0-9])(/+)[A-Za-z]/Users/(?:${n})${NAME_END}`, 'giu'), (_m, a) => `${a}c/Users/${WIN_HOME}`);
  t = t.replace(new RegExp(`/mnt/([A-Za-z])/Users/(?:${n})${NAME_END}`, 'giu'), (_m, d) => `/mnt/${d}/Users/${WIN_HOME}`);
  return t;
}

// 문자열 하나 치환 (JSON 안의 \\ 이스케이프 형태도 같이 — 문자열 속에 JSON 글이 든 경우)
export function redactString(s: string, ctx: Ctx): string {
  let t = s;
  for (const name of ctx.winNames) {
    t = replaceHome(t, esc(name));
    // Claude 가 경로를 폴더 이름으로 바꾼 꼴(C--Users-<이름>-…). 이름이 전부 - 가 되면(한글) 새는 것이 없다
    const flat = name.replace(/[^A-Za-z0-9]/g, '-');
    if (/[A-Za-z0-9]/.test(flat)) t = t.replace(new RegExp(`(?<![A-Za-z0-9])[A-Za-z]--Users-${esc(flat)}(?![A-Za-z0-9])`, 'gi'), `C--Users-${WIN_HOME}`);
    // 전부 - 가 되는 이름(한글 N글자 → - N개)은 홍길동의 평탄화 꼴(--- 3개)로 맞춘다(N≠3 이면 검사가 막는다)
    else t = t.replace(new RegExp(`(?<![A-Za-z0-9])[A-Za-z]--Users-${flat}(?=-(?!-)|[^A-Za-z0-9-]|$)`, 'g'), 'C--Users----');
  }
  // 이름 자리가 U+FFFD·깨진 형태로만 된 홈(원래 바이트를 잃은 경로)
  t = replaceHome(t, `(?:${ctx.junk})+`);
  for (const h of ctx.posixHomes) {
    t = t.replace(new RegExp(`${esc(h)}${NAME_END}`, 'gu'), POSIX_HOME);
    const flat = h.replace(/[^A-Za-z0-9]/g, '-');
    if (h.split('/').filter(Boolean).length >= 2) t = t.replace(new RegExp(`${esc(flat)}(?![A-Za-z0-9])`, 'g'), '-home-hong');
  }
  for (const w of ctx.words) t = t.replace(w.re, w.to);
  for (const e of ctx.escapes) t = t.replace(e.re, (m, bs: string) => hongEscape(bs, /u[0-9a-f]{0,3}[A-F]/.test(m)));
  t = t.replace(EMAIL, (m) => (ALLOWED_EMAIL.test(m) ? m : FAKE_EMAIL));
  t = t.replace(UUID_TEXT, (_m, a, u) => `${a}${zeroUuid(ctx, u)}`);
  t = t.replace(SYNCED, (_m, a) => `${a}ORG_ACCOUNT`);
  t = t.replace(/RateLimitResetCredit_[A-Za-z0-9-]+/gi, 'RateLimitResetCredit_0');
  const rand = ctx.rand ? esc(ctx.rand) : '[A-Za-z0-9]{6}';
  t = t.replace(new RegExp(`(plenum-rec-(?:${WIN_HOME}|---)-)${rand}(?![A-Za-z0-9])`, 'g'), `$1${RAND}`);
  return t;
}

// 지우는 것: 시스템 프롬프트·계정 맥락 첨부(2.1.323 README)
const DROP_TYPES = new Set(['prompt_snapshot', 'session_context', 'skill_listing', 'credential_org']);
const DROP_KEYS = /^(prompt_snapshot|session_context|skill_listing|credential_org|system_?prompt|systemPrompt)$/i;
const isDropObj = (v: unknown) => isObj(v) && ((typeof v.type === 'string' && DROP_TYPES.has(v.type))
  || (isObj(v.attachment) && typeof v.attachment.type === 'string' && DROP_TYPES.has(v.attachment.type)));
const DESC_LISTS = ['commands', 'agents', 'skills', 'slash_commands'];

function blankDescriptions(o: unknown) {
  if (!isObj(o)) return;
  for (const k of DESC_LISTS) {
    if (!Array.isArray(o[k])) continue;
    for (const e of o[k]) if (isObj(e) && typeof e.description === 'string') e.description = '';
  }
}

// 값 전체를 돌며 지우고 치환한다. undefined = 이 값을 지운다
export function redactValue(v: unknown, ctx: Ctx): unknown {
  if (typeof v === 'string') return redactString(v, ctx);
  if (Array.isArray(v)) return v.filter((x) => !isDropObj(x)).map((x) => redactValue(x, ctx));
  if (isObj(v)) {
    if (isDropObj(v)) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (DROP_KEYS.test(k) || isDropObj(x)) continue;
      const key = redactString(k, ctx);
      out[key] = UUID_KEY.test(k) && typeof x === 'string' && new RegExp(`^${UUID}$`).test(x) ? zeroUuid(ctx, x) : redactValue(x, ctx);
    }
    return out;
  }
  return v;
}

// 녹화 한 줄 → 치환한 줄. null = 줄째 지운다
export function redactLine(line: string, ctx: Ctx): string | null {
  let o: any;
  try { o = JSON.parse(line); } catch { return redactString(line, ctx); }
  if (isObj(o) && isObj(o.msg)) {
    const m = o.msg;
    if (isDropObj(m)) return null;
    if (m.type === 'control_response' && isObj(m.response)) blankDescriptions(m.response.response);
    if (m.type === 'system' && m.subtype === 'init') blankDescriptions(m);
  }
  return JSON.stringify(redactValue(o, ctx));
}

// 치환 뒤 남은 위험. 비어 있지 않으면 파일을 쓰지 않는다
export function findRisks(text: string, ctx: Ctx): string[] {
  const out: string[] = [];
  for (const w of ctx.words) { w.re.lastIndex = 0; if (w.re.test(text)) out.push(w.label); w.re.lastIndex = 0; }
  for (const e of ctx.escapes) { e.re.lastIndex = 0; if (e.re.test(text)) out.push(e.label); e.re.lastIndex = 0; }
  for (const [name, re] of WIN_HOME_CHECKS) if (re.test(text)) out.push(`홍길동 아닌 Windows 사용자 폴더(${name})`);
  if (RATE_CREDIT_LEFT.test(text)) out.push('RateLimitResetCredit 실제 값');
  return out;
}

// --explain: 걸린 자리를 이름 글자만 가려 찍는다(원본을 보낼 수 없을 때 진단용).
// 한글→가, ASCII 글자→a, 숫자→9, U+FFFD→?, 그 밖 비ASCII(깨진 형태 등)→*, 기호·백슬래시·공백은 그대로.
// 개인 정보가 아닌 고정 경로 조각(Users·AppData 등)과 치환 값(홍길동·hong)은 그대로 둔다
const DIAG_KEEP = ['Users', 'USERS', 'users', 'AppData', 'Local', 'LocalLow', 'Roaming', 'Temp', 'TEMP', 'temp', 'plenum', 'rec', 'proj', 'probe', 'Desktop', 'Documents', HONG, 'hong', 'AbCdEf', 'mnt', 'u'];
export function maskForDiag(s: string): string {
  let out = '';
  const keep = [...DIAG_KEEP].sort((a, b) => b.length - a.length);
  for (let i = 0; i < s.length;) {
    const k = keep.find((w) => w.length > 1 && s.startsWith(w, i) && !/[A-Za-z0-9]/.test(s[i - 1] ?? '') && !/[A-Za-z0-9]/.test(s[i + w.length] ?? ''));
    if (k) { out += k; i += k.length; continue; }
    const cp = s.codePointAt(i)!; const ch = String.fromCodePoint(cp); i += ch.length;
    if (cp >= 0xac00 && cp <= 0xd7a3) out += '가';
    else if (/[A-Za-z]/.test(ch)) out += 'a';
    else if (/[0-9]/.test(ch)) out += '9';
    else if (cp === 0xfffd) out += '?';
    else if (cp > 0x7f) out += '*';
    else out += ch;
  }
  return out;
}
export function explainLine(raw: string, redacted: string, pad = 20): string[] {
  const out: string[] = [];
  const near = (t: string, at: number, len: number) => maskForDiag(t.slice(Math.max(0, at - pad), at + len + pad));
  for (const [name, re] of WIN_HOME_CHECKS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of redacted.matchAll(g)) out.push(`  치환 뒤 [${name}] @${m.index}: ${near(redacted, m.index!, m[0].length)}`);
  }
  for (const m of raw.matchAll(/Users/gi)) out.push(`  원본 Users @${m.index}: ${near(raw, m.index!, 5)}`);
  return out;
}

// fffd: 원본에 U+FFFD 가 있던 줄, fffdLeft: 치환 뒤에도 남은 줄(실패 아님 — 보고에 적기)
export function redactLines(lines: string[], ctx: Ctx):
  { out: string[]; fffd: number[]; fffdLeft: number[]; risks: { line: number; what: string }[] } {
  const out: string[] = [];
  const fffd: number[] = [];
  const fffdLeft: number[] = [];
  const risks: { line: number; what: string }[] = [];
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    if (/\uFFFD|\\u[fF][fF][fF][dD]/.test(l)) fffd.push(i + 1);   // 문자 그대로 또는 JSON 이스케이프 \uFFFD
    const r = redactLine(l, ctx);
    if (r === null) return;
    if (r.includes('\uFFFD')) fffdLeft.push(i + 1);
    for (const what of findRisks(r, ctx)) risks.push({ line: i + 1, what });
    out.push(r);
  });
  return { out, fffd, fffdLeft, risks };
}

// fixture meta.json: 있으면 합친다(장면만 더함·정렬). 다른 값이 다르면 경고
export function mergeMeta(existing: Record<string, any> | null, rec: Record<string, any>, scene: string): { meta: Record<string, any>; warnings: string[] } {
  const fresh = { provider: rec.provider, version: rec.version, os: rec.os, recordedAt: rec.recordedAt, command: rec.command };
  const warnings: string[] = [];
  const base: Record<string, any> = existing ? { ...existing } : { ...fresh };
  if (existing) for (const k of Object.keys(fresh) as (keyof typeof fresh)[]) {
    if (JSON.stringify(existing[k]) !== JSON.stringify(fresh[k])) warnings.push(`meta.json 의 ${k} 가 이번 녹화와 다르다(기존 값 유지): ${JSON.stringify(existing[k])} / ${JSON.stringify(fresh[k])}`);
  }
  const scenes = new Set<string>(Array.isArray(base.scenes) ? base.scenes : []);
  scenes.add(scene);
  base.scenes = [...scenes].sort();
  return { meta: base, warnings };
}

function main(argv: string[]): number {
  let raw: string | null = null; let dest: string | null = null; let allowEmpty = false; let explain = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--allow-empty-words') allowEmpty = true;
    else if (argv[i] === '--explain') explain = true;
    else if (argv[i] === '--dest') { dest = argv[++i] ?? null; if (!dest) { console.error('--dest 뒤에 폴더가 없다'); return 1; } }
    else if (argv[i].startsWith('--')) { console.error(`모르는 옵션: ${argv[i]}`); return 1; }
    else if (!raw) raw = argv[i];
    else { console.error(`인자가 너무 많다: ${argv[i]}`); return 1; }
  }
  if (!raw) { console.error('사용: npm run probe:redact -- <scene>-raw.jsonl [--dest <dir>] [--allow-empty-words] [--explain]'); return 1; }
  const gate = wordsGate(privateWordsFromEnv(), { allowEmpty });
  if (gate.message) console.error(gate.message);
  if (!gate.ok) return 4;
  const rawPath = path.resolve(raw);
  if (!rawPath.endsWith('-raw.jsonl')) { console.error('원본 파일 이름은 <scene>-raw.jsonl 이어야 한다'); return 1; }
  const metaPath = rawPath.replace(/-raw\.jsonl$/, '-meta.json');
  if (!fs.existsSync(metaPath)) { console.error(`메타 파일이 없다: ${metaPath}`); return 1; }
  const recMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const scene: string = typeof recMeta.scene === 'string' ? recMeta.scene : path.basename(rawPath).replace(/-raw\.jsonl$/, '');
  if (typeof recMeta.version !== 'string' || !/^[0-9A-Za-z.+-]+$/.test(recMeta.version)) { console.error(`메타에 version 이 없다(init 을 못 받음?): ${recMeta.version}`); return 1; }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const destDir = path.resolve(dest ?? path.join(here, '..', '..', 'app', 'test', 'fixtures', 'providers', 'claude', recMeta.version));

  const ctx = buildContext({ workdir: typeof recMeta.workdir === 'string' ? recMeta.workdir : null });
  for (const w of ctx.warnings) console.warn(w);
  const rawLines = fs.readFileSync(rawPath, 'utf8').split(/\r?\n/);
  const { out, fffd, fffdLeft, risks } = redactLines(rawLines, ctx);
  const red = redactValue(recMeta, ctx) as Record<string, any>;
  const metaRisks = findRisks(JSON.stringify(red), ctx);
  for (const n of fffd) console.log(`U+FFFD 있음(원래 바이트를 되살릴 수 없음 — 보고에 적기): ${n}번째 줄${fffdLeft.includes(n) ? ' (치환 뒤에도 남음, 실패 아님)' : ' (치환·삭제 뒤 남지 않음)'}`);
  if (risks.length || metaRisks.length) {
    for (const r of risks) console.error(`치환 뒤 남음: ${r.line}번째 줄 — ${r.what}`);
    if (explain) for (const n of [...new Set(risks.map((r) => r.line))]) {
      const l = rawLines[n - 1]; const r = redactLine(l, ctx) ?? '';
      console.error(`${n}번째 줄 (가림: 한글→가 ASCII→a 숫자→9 U+FFFD→? 그 밖 비ASCII→*)`);
      for (const e of explainLine(l, r)) console.error(e);
    }
    for (const r of metaRisks) console.error(`치환 뒤 남음: 메타 — ${r}`);
    console.error('파일을 쓰지 않았다');
    return 3;
  }
  const destMeta = path.join(destDir, 'meta.json');
  const existing = fs.existsSync(destMeta) ? JSON.parse(fs.readFileSync(destMeta, 'utf8')) : null;
  const { meta, warnings } = mergeMeta(existing, red, scene);
  for (const w of warnings) console.warn(w);
  fs.mkdirSync(destDir, { recursive: true });
  const outPath = path.join(destDir, `${scene}.jsonl`);
  fs.writeFileSync(outPath, out.join('\n') + '\n');
  fs.writeFileSync(destMeta, JSON.stringify(meta, null, 2) + '\n');
  console.log(`썼다: ${outPath} (${out.length}줄)`);
  console.log(`썼다: ${destMeta}`);
  console.log('다음: 눈으로 훑고 app/ 에서 npm test (개인 정보 검사 test/fixtures-privacy.test.ts)');
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) process.exitCode = main(process.argv.slice(2));
