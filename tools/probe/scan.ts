// 병합 전 마지막 검사: 진짜 비공개 낱말(PLENUM_PRIVATE_WORDS)과 그 깨진 형태가 커밋 기록·HEAD 트리에 있는지 찾는다.
// 사용(app/ 에서): npm run probe:scan -- [--range <범위>] [--repo <폴더>]   (기본 범위 1b8402f..HEAD, 기본 레포 = 지금 폴더의 git 최상위)
// 찾는 곳: (a) git log -p --text --format=fuller <범위> (커밋 메시지·작성자 이름·이메일·diff), (b) HEAD 트리의 블롭 전부(디스크가 아니라 HEAD).
// 찾는 것: 문자열 형태(원래·깨진 형태·JSON \uXXXX 이스케이프, ASCII 는 대소문자 무시) + 원래 낱말의 바이트열(UTF-16LE·CP949, 텍스트가 아닌 버퍼는 UTF-8 도).
// fail-closed: app/test/fixtures/providers/** 블롭은 올바른 UTF-8·BOM 없음·NUL 없음이 아니면 내용과 상관없이 실패.
// 출력에 낱말·찾은 문자열은 절대 찍지 않는다 — "낱말 #n 형태 k: <파일>:<줄>" / "낱말 #n 형태 k: 커밋 <해시> <diff 파일>" 만.
// 경로 이름에 낱말이 있으면 경로도 가린다. 종료 코드: 0 = 0건, 1 = 있음, 2 = git 실패, 4 = 낱말 없음
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURE_STRICT_DIR, cp949Bytes, escapeForms, fixtureBytesProblem, hasWord, isAscii, mojibakeVariants, privateWordsFromEnv } from './variants.ts';

export const DEFAULT_RANGE = '1b8402f..HEAD';
export interface Form { word: number; form: number; text: string; lower: string | null }
export interface ByteForm { word: number; kind: 'utf8' | 'utf16le' | 'cp949'; bytes: Buffer }

// 낱말마다 형태 1 = 원래, 2.. = 깨진 형태, 그 뒤 JSON 이스케이프(소문자·대문자 hex)
export function formsOf(words: string[]): Form[] {
  const out: Form[] = [];
  words.forEach((w, i) => {
    [...new Set([w, ...mojibakeVariants(w).variants, ...escapeForms(w)])]
      .forEach((t, k) => out.push({ word: i + 1, form: k + 1, text: t, lower: isAscii(t) ? t.toLowerCase() : null }));
  });
  return out;
}

// 원래 낱말의 바이트열. CP949 를 못 만들면 그 하나는 빼고 경고. 같은 바이트열은 하나로(ASCII 는 UTF-8 = CP949)
export function byteFormsOf(words: string[]): { forms: ByteForm[]; warnings: string[] } {
  const forms: ByteForm[] = [];
  const warnings: string[] = [];
  words.forEach((w, i) => {
    const seen = new Set<string>();
    const add = (kind: ByteForm['kind'], bytes: Buffer) => { const k = bytes.toString('hex'); if (bytes.length && !seen.has(k)) { seen.add(k); forms.push({ word: i + 1, kind, bytes }); } };
    add('utf8', Buffer.from(w, 'utf8'));
    add('utf16le', Buffer.from(w, 'utf16le'));
    const c = cp949Bytes(w);
    if (c) add('cp949', Buffer.from(c)); else warnings.push(`낱말 #${i + 1}: CP949 바이트열을 만들 수 없어 그 검색은 건너뛴다`);
  });
  return { forms, warnings };
}

// 낱말 모양 요약(낱말 자체는 찍지 않는다): 한글·ASCII·그 밖 글자 수
export function wordShape(w: string): string {
  const chars = [...w];
  const ko = chars.filter((c) => /[가-힣ᄀ-ᇿ㄰-㆏]/.test(c)).length;
  const ascii = chars.filter((c) => c.charCodeAt(0) < 0x80).length;
  return `한글 ${ko}자 / ASCII ${ascii}자 / 그 밖 ${chars.length - ko - ascii}자`;
}

function hitsIn(line: string, forms: Form[]): Form[] {
  let low: string | null = null;
  const out: Form[] = [];
  for (const f of forms) {
    if (!f.text) continue;
    if (f.lower !== null) { low ??= line.toLowerCase(); if (low.includes(f.lower)) out.push(f); } else if (line.includes(f.text)) out.push(f);
  }
  return out;
}
const label = (f: Form) => `낱말 #${f.word} 형태 ${f.form}`;
const blabel = (f: ByteForm) => `낱말 #${f.word} 바이트 ${f.kind}`;
const isText = (b: Buffer) => !b.includes(0) && fixtureBytesProblem(b) === null;
// 올바른 UTF-8 텍스트 버퍼에서는 UTF-8 바이트 검색이 문자열 검색과 같고, CP949 바이트열(0x80 이상)은 UTF-8 글자 안에 우연히 맞을 뿐이라
// (진짜 CP949 글자가 있으면 UTF-8 이 깨진다) UTF-16LE 만 찾는다. 텍스트가 아니면 세 가지 다
const byteHits = (b: Buffer, bforms: ByteForm[], text: boolean) => bforms.filter((f) => !(text && f.kind !== 'utf16le') && b.includes(f.bytes));

// 경로를 찍어도 되는지: 낱말이 들어 있으면 가린다
export function safePath(p: string, forms: Form[]): string {
  return forms.some((f) => hasWord(p, f.text)) ? '(경로에 낱말이 있어 가림)' : p;
}

// (a) git log -p 출력(버퍼) → 찾은 곳(커밋·diff 파일마다 한 번)
export function scanLog(buf: Buffer | string, forms: Form[], bforms: ByteForm[] = []): string[] {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  const out = new Set<string>();
  let commit = '?';
  let file = '(커밋 머리·메시지)';
  let start = 0;
  while (start <= b.length) {
    let end = b.indexOf(0x0a, start);
    if (end < 0) end = b.length;
    const lb = b.subarray(start, end);
    start = end + 1;
    const line = lb.toString('utf8');
    const c = /^commit ([0-9a-f]{7,64})\b/.exec(line);
    if (c) { commit = c[1].slice(0, 12); file = '(커밋 머리·메시지)'; }
    else {
      const d = /^diff --git a\/.* b\/(.*)$/.exec(line);
      if (d) file = safePath(d[1], forms);
    }
    for (const f of hitsIn(line, forms)) out.add(`${label(f)}: 커밋 ${commit} ${file}`);
    for (const f of byteHits(lb, bforms, isText(lb))) out.add(`${blabel(f)}: 커밋 ${commit} ${file}`);
    if (end === b.length) break;
  }
  return [...out];
}

// (b) 블롭 하나 → 찾은 곳. 텍스트면 줄마다 문자열 검색, 모든 블롭에 바이트 검색, providers/** 는 fail-closed
export function scanFile(rel: string, buf: Buffer, forms: Form[], bforms: ByteForm[] = []): string[] {
  const shown = safePath(rel, forms);
  const out: string[] = [];
  if (shown !== rel) for (const f of hitsIn(rel, forms)) out.push(`${label(f)}: (파일 이름) ${shown}`);
  if (rel.startsWith(FIXTURE_STRICT_DIR)) { const p = fixtureBytesProblem(buf); if (p) out.push(`fail-closed: ${shown} — ${p}`); }
  const text = !buf.subarray(0, 8000).includes(0);
  if (text) buf.toString('utf8').split('\n').forEach((line, i) => { for (const f of hitsIn(line, forms)) out.push(`${label(f)}: ${shown}:${i + 1}`); });
  for (const f of byteHits(buf, bforms, text && fixtureBytesProblem(buf) === null)) out.push(`${blabel(f)}: ${shown}`);
  return out;
}

const GIT_C = ['-c', 'core.quotepath=false', '-c', 'i18n.logOutputEncoding=UTF-8'];
function git(repo: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', [...GIT_C, ...args], { cwd: repo, encoding: 'buffer', maxBuffer: 1 << 30, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(new Error(`git ${args[0]} 실패: ${Buffer.from(stderr ?? '').toString('utf8').trim() || err.message}`)) : resolve(stdout)));
  });
}

// HEAD 트리의 블롭: [경로, 해시] (ls-tree -r -z, 정렬)
export function parseLsTree(buf: Buffer): [string, string][] {
  const out: [string, string][] = [];
  for (const e of buf.toString('utf8').split('\0')) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.*)$/s.exec(e);
    if (m) out.push([m[2], m[1]]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// git cat-file --batch 로 블롭 내용을 한 번에(셸 없이, 인자 배열)
function catBlobs(repo: string, hashes: string[]): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...GIT_C, 'cat-file', '--batch'], { cwd: repo, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    child.once('error', (e) => reject(new Error(`git cat-file 실패: ${e.message}`)));
    child.once('close', (code) => {
      if (code !== 0) { reject(new Error(`git cat-file 실패: ${err.trim() || code}`)); return; }
      const all = Buffer.concat(chunks);
      const map = new Map<string, Buffer>();
      let pos = 0;
      for (const h of hashes) {
        const nl = all.indexOf(0x0a, pos);
        if (nl < 0) break;
        const head = all.subarray(pos, nl).toString('utf8').split(' ');
        if (head[1] === 'missing') { pos = nl + 1; continue; }
        const size = Number(head[2]);
        map.set(h, all.subarray(nl + 1, nl + 1 + size));
        pos = nl + 1 + size + 1;
      }
      resolve(map);
    });
    child.stdin.on('error', () => { /* 무시: close 에서 처리 */ });
    child.stdin.end(hashes.map((h) => `${h}\n`).join(''));
  });
}

export function parseArgs(argv: string[]): { range: string; repo: string | null } {
  let range = DEFAULT_RANGE; let repo: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--range') { range = argv[++i] ?? ''; if (!range) throw new Error('--range 뒤에 범위가 없다'); }
    else if (a === '--repo') { repo = argv[++i] ?? ''; if (!repo) throw new Error('--repo 뒤에 폴더가 없다'); }
    else throw new Error(`모르는 인자: ${a} (사용: npm run probe:scan -- [--range <범위>] [--repo <폴더>])`);
  }
  if (range.startsWith('-')) throw new Error(`범위가 옵션처럼 보인다: ${range}`);
  return { range, repo };
}

async function main(argv: string[]): Promise<number> {
  const o = parseArgs(argv);
  const words = privateWordsFromEnv();
  if (words.length === 0) {
    console.error("PLENUM_PRIVATE_WORDS 가 비어 있다. 찾을 낱말(이메일 아이디·실명·사용자 이름 등)을 쉼표로 넣고 다시 돌린다 (PowerShell 창에서: $env:PLENUM_PRIVATE_WORDS = '낱말1,낱말2')");
    return 4;
  }
  words.forEach((w, i) => console.log(`낱말 #${i + 1}: ${wordShape(w)}`));
  const forms = formsOf(words);
  const { forms: bforms, warnings } = byteFormsOf(words);
  for (const w of warnings) console.warn(w);
  let repo: string;
  try {
    repo = o.repo ? path.resolve(o.repo) : (await git(process.cwd(), ['rev-parse', '--show-toplevel'])).toString('utf8').trim();
  } catch (e: any) { console.error(e.message); return 2; }
  let logHits: string[]; const treeHits: string[] = [];
  try {
    if ((await git(repo, ['status', '--porcelain'])).length > 0) console.warn('경고: 작업 트리가 HEAD 와 다르다 — 검사는 HEAD 기준');
    logHits = scanLog(await git(repo, ['log', '-p', '--text', '--format=fuller', o.range, '--']), forms, bforms);
    const entries = parseLsTree(await git(repo, ['ls-tree', '-r', '-z', 'HEAD']));
    const blobs = await catBlobs(repo, entries.map(([, h]) => h));
    for (const [rel, h] of entries) {
      const b = blobs.get(h);
      if (!b) { treeHits.push(`블롭을 읽지 못했다: ${safePath(rel, forms)}`); continue; }
      treeHits.push(...scanFile(rel, b, forms, bforms));
    }
  } catch (e: any) { console.error(e.message); return 2; }
  for (const h of logHits) console.log(h);
  for (const h of treeHits) console.log(h);
  console.log(`합계: 커밋 기록(${o.range}) ${logHits.length}건, HEAD 트리 ${treeHits.length}건 — 낱말 ${words.length}개, 문자열 형태 ${forms.length}개, 바이트 형태 ${bforms.length}개`);
  return logHits.length + treeHits.length > 0 ? 1 : 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e?.message ?? e); process.exitCode = 2; });
}
