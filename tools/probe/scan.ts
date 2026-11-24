// 병합 전 마지막 검사: 진짜 비공개 낱말(PLENUM_PRIVATE_WORDS)과 그 깨진 형태가 커밋 기록·작업 트리에 있는지 찾는다.
// 사용(app/ 에서): npm run probe:scan -- [--range <범위>] [--repo <폴더>]   (기본 범위 1b8402f..HEAD, 기본 레포 = 지금 폴더의 git 최상위)
// 찾는 곳: (a) git log -p --format=fuller <범위> (커밋 메시지·작성자 이름·이메일·diff), (b) git ls-files 의 텍스트 파일(바이너리 건너뜀).
// 출력에 낱말·찾은 문자열은 절대 찍지 않는다 — "낱말 #n 형태 k: <파일>:<줄>" / "낱말 #n 형태 k: 커밋 <해시> <diff 파일>" 만.
// 경로 이름에 낱말이 있으면 경로도 가린다. 종료 코드: 0 = 0건, 1 = 있음, 2 = git 실패, 4 = 낱말 없음
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hasWord, isAscii, mojibakeVariants, privateWordsFromEnv } from './variants.ts';

export const DEFAULT_RANGE = '1b8402f..HEAD';
export interface Form { word: number; form: number; text: string; lower: string | null }

// 낱말마다 형태 1 = 원래, 2.. = 깨진 형태
export function formsOf(words: string[]): Form[] {
  const out: Form[] = [];
  words.forEach((w, i) => {
    [w, ...mojibakeVariants(w).variants].forEach((t, k) => out.push({ word: i + 1, form: k + 1, text: t, lower: isAscii(t) ? t.toLowerCase() : null }));
  });
  return out;
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
// 경로를 찍어도 되는지: 낱말이 들어 있으면 가린다
export function safePath(p: string, forms: Form[]): string {
  return forms.some((f) => hasWord(p, f.text)) ? '(경로에 낱말이 있어 가림)' : p;
}

// (a) git log -p 출력 → 찾은 곳(커밋·diff 파일마다 한 번)
export function scanLog(text: string, forms: Form[]): string[] {
  const out = new Set<string>();
  let commit = '?';
  let file = '(커밋 머리·메시지)';
  for (const line of text.split('\n')) {
    const c = /^commit ([0-9a-f]{7,64})\b/.exec(line);
    if (c) { commit = c[1].slice(0, 12); file = '(커밋 머리·메시지)'; }
    else {
      const d = /^diff --git a\/.* b\/(.*)$/.exec(line);
      if (d) file = safePath(d[1], forms);
    }
    for (const f of hitsIn(line, forms)) out.add(`${label(f)}: 커밋 ${commit} ${file}`);
  }
  return [...out];
}

// (b) 파일 하나(이미 읽은 내용) → 찾은 곳(줄마다)
export function scanFile(rel: string, buf: Buffer, forms: Form[]): string[] {
  if (buf.subarray(0, 8000).includes(0)) return [];   // 바이너리
  const shown = safePath(rel, forms);
  const out: string[] = [];
  if (shown !== rel) for (const f of hitsIn(rel, forms)) out.push(`${label(f)}: (파일 이름) ${shown}`);
  buf.toString('utf8').split('\n').forEach((line, i) => { for (const f of hitsIn(line, forms)) out.push(`${label(f)}: ${shown}:${i + 1}`); });
  return out;
}

function git(repo: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', '-c', 'i18n.logOutputEncoding=UTF-8', ...args],
      { cwd: repo, encoding: 'buffer', maxBuffer: 1 << 30, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(new Error(`git ${args[0]} 실패: ${Buffer.from(stderr ?? '').toString('utf8').trim() || err.message}`)) : resolve(stdout)));
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
    console.error('PLENUM_PRIVATE_WORDS 가 비어 있다. 찾을 낱말(이메일 아이디·실명·사용자 이름 등)을 쉼표로 넣고 다시 돌린다 (PowerShell: $env:PLENUM_PRIVATE_WORDS="낱말1,낱말2")');
    return 4;
  }
  const forms = formsOf(words);
  let repo: string;
  try {
    repo = o.repo ? path.resolve(o.repo) : (await git(process.cwd(), ['rev-parse', '--show-toplevel'])).toString('utf8').trim();
  } catch (e: any) { console.error(e.message); return 2; }
  let logHits: string[]; let treeHits: string[] = [];
  try {
    logHits = scanLog((await git(repo, ['log', '-p', '--format=fuller', o.range, '--'])).toString('utf8'), forms);
    const files = (await git(repo, ['ls-files', '-z'])).toString('utf8').split('\0').filter(Boolean).sort();
    for (const rel of files) {
      let buf: Buffer;
      try { buf = fs.readFileSync(path.join(repo, rel)); } catch { continue; }   // 지워졌거나 하위 모듈
      treeHits.push(...scanFile(rel, buf, forms));
    }
  } catch (e: any) { console.error(e.message); return 2; }
  for (const h of logHits) console.log(h);
  for (const h of treeHits) console.log(h);
  console.log(`합계: 커밋 기록(${o.range}) ${logHits.length}건, 작업 트리 ${treeHits.length}건 — 낱말 ${words.length}개, 형태 ${forms.length}개`);
  return logHits.length + treeHits.length > 0 ? 1 : 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e?.message ?? e); process.exitCode = 2; });
}
