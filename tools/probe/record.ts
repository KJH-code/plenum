// 진짜 claude 녹화기. 장면 JSON(scenes/*.json)대로 claude -p stream-json 을 띄워 stdin·stdout 을 줄 단위로 기록한다.
// 답(승인·질문)은 스스로 만들지 않고 레포 드라이버(app/server/provider/claude.ts)가 만든 원문을 보낸다 —
// 드라이버를 고치면 녹화도 고친 동작을 담는다. permission_suggestions 를 그대로 답에 넣지 않는다.
// 사용(app/ 에서): npm run probe -- ../tools/probe/scenes/07-powershell-session.json [--out <dir>] [--dry-run]
// 원본은 레포 밖(기본 os.tmpdir()/plenum-probe/)에 둔다. 개인 정보가 그대로 있다 → redact.ts 로 치환한 것만 fixture 로.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { createClaudeDriver } from '../../app/server/provider/claude.ts';
import type { QuestionOutcome } from '../../app/server/provider/events.ts';
import { chatArgs, chatEnv } from '../../app/server/chat.ts';
import { commandFor, resolveCommand, runCommand } from '../../app/server/open.ts';
import { killTree } from '../../app/server/proc.ts';
import { privateWordsFromEnv, wordsGate } from './variants.ts';

export type OptionId = 'allow_session' | 'allow_once' | 'reject_once';
export interface AnswerRule { match: string; optionId: OptionId; nth?: number }
export interface Scene {
  scene: string;
  model: string;
  workdir: { under: 'tmp'; name: string; sub?: string };
  turns: { prompt: string }[];
  answers: AnswerRule[];
  defaultAnswer: OptionId;
  timeoutMs: number;
}

const OPTION_IDS: OptionId[] = ['allow_session', 'allow_once', 'reject_once'];

// 장면 JSON 검사. 틀리면 이유를 담아 throw
export function parseScene(text: string): Scene {
  const s = JSON.parse(text);
  const bad = (m: string) => { throw new Error(`장면 JSON 이 틀렸다: ${m}`); };
  if (!s || typeof s !== 'object') bad('객체가 아님');
  if (typeof s.scene !== 'string' || !/^[A-Za-z0-9._-]+$/.test(s.scene)) bad('scene');
  if (typeof s.model !== 'string' || !s.model) bad('model');
  if (!s.workdir || s.workdir.under !== 'tmp' || typeof s.workdir.name !== 'string' || /[\\/]/.test(s.workdir.name)) bad('workdir');
  if (s.workdir.sub !== undefined && (typeof s.workdir.sub !== 'string' || /[\\/]|^\.\.?$/.test(s.workdir.sub))) bad('workdir.sub');
  if (!Array.isArray(s.turns) || s.turns.length === 0 || s.turns.some((t: any) => typeof t?.prompt !== 'string' || !t.prompt)) bad('turns');
  if (!Array.isArray(s.answers)) bad('answers');
  for (const a of s.answers) {
    if (typeof a?.match !== 'string' || !a.match || !OPTION_IDS.includes(a.optionId)) bad(`answers: ${JSON.stringify(a)}`);
    if (a.nth !== undefined && (!Number.isInteger(a.nth) || a.nth < 1)) bad(`answers.nth: ${JSON.stringify(a)}`);
  }
  if (!OPTION_IDS.includes(s.defaultAnswer)) bad('defaultAnswer');
  if (!Number.isInteger(s.timeoutMs) || s.timeoutMs <= 0) bad('timeoutMs');
  return s as Scene;
}

// 작업 폴더 이름의 {rand}: 영숫자 6자
export function randToken(bytes: Buffer = randomBytes(6)): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return [...bytes.subarray(0, 6)].map((b) => A[b % A.length]).join('');
}
export function workdirOf(scene: Scene, tmp: string, rand: string): string {
  const top = path.join(tmp, scene.workdir.name.replace(/\{rand\}/g, rand));
  return scene.workdir.sub ? path.join(top, scene.workdir.sub) : top;
}
// 프롬프트의 {TMP} → os.tmpdir() 실제 값 (변수 없는 절대 경로 명령용). 장면은 그 경로를 PowerShell 작은따옴표 문자열 안에 둔다
// ('{TMP}\x.txt') → 값 안의 ' 는 '' 로 바꿔 넣는다(공백·$·` 는 작은따옴표 안에서 그대로)
export const psQuoteInner = (s: string) => s.replace(/'/g, "''");
export const fillPrompt = (prompt: string, tmp: string) => prompt.split('{TMP}').join(psQuoteInner(tmp));

// 승인 요청의 "명령": command 칸(Bash·PowerShell), 없으면 file_path, 그것도 없으면 입력 JSON
export function commandOf(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    if (typeof o.command === 'string') return o.command;
    if (typeof o.file_path === 'string') return o.file_path;
  }
  try { return JSON.stringify(input) ?? ''; } catch { return ''; }
}

// 답 고르기. history = 이번 요청 전까지의 승인 요청 명령들(순서대로).
// 규칙을 위에서부터 보고, 명령에 match 가 들어 있고 nth(그 match 의 몇 번째 요청인지, 1부터)가 맞으면(없으면 아무 번째나) 그 답.
// 맞는 규칙이 없으면 defaultAnswer. 고른 답이 카드에 없으면(allow_session 은 드라이버가 세션 규칙이 있을 때만 낸다) allow_once
export function pickPermission(scene: Pick<Scene, 'answers' | 'defaultAnswer'>, history: string[], command: string, offered: string[]):
  { optionId: OptionId; rule: number | null; note: string | null } {
  let optionId: OptionId = scene.defaultAnswer;
  let rule: number | null = null;
  for (let i = 0; i < scene.answers.length; i++) {
    const a = scene.answers[i];
    if (!command.includes(a.match)) continue;
    const nth = history.filter((h) => h.includes(a.match)).length + 1;
    if (a.nth !== undefined && a.nth !== nth) continue;
    optionId = a.optionId; rule = i; break;
  }
  if (!offered.includes(optionId)) {
    const fallback: OptionId = offered.includes('allow_once') && optionId !== 'reject_once' ? 'allow_once' : 'reject_once';
    return { optionId: fallback, rule, note: `${optionId} 이 카드에 없어서 ${fallback}` };
  }
  return { optionId, rule, note: null };
}

// 질문(AskUserQuestion): 모드 질문이면 label 이 "모드 없음"인 선택지(끝의 (추천)/(Recommended) 무시). 모든 질문에 있어야 accept, 아니면 거부
const bareLabel = (l: string) => l.replace(/\s*\((추천|Recommended)\)\s*$/i, '').trim();
export function pickQuestion(questions: { question: string; options: { label: string }[] }[]): QuestionOutcome {
  if (questions.length === 0) return { action: 'decline' };
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const o = q.options.find((x) => bareLabel(x.label) === '모드 없음');
    if (!o) return { action: 'decline' };
    answers[q.question] = o.label;
  }
  return { action: 'accept', answers };
}

export const osName = (p: NodeJS.Platform) => (p === 'win32' ? 'windows' : p === 'darwin' ? 'macos' : p);
export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function parseArgs(argv: string[]): { scene: string; out: string | null; dryRun: boolean; allowEmptyWords: boolean } {
  let scene: string | null = null; let out: string | null = null; let dryRun = false; let allowEmptyWords = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--allow-empty-words') allowEmptyWords = true;
    else if (a === '--out') { out = argv[++i] ?? null; if (!out) throw new Error('--out 뒤에 폴더가 없다'); }
    else if (a.startsWith('--')) throw new Error(`모르는 옵션: ${a}`);
    else if (scene === null) scene = a;
    else throw new Error(`인자가 너무 많다: ${a}`);
  }
  if (!scene) throw new Error('사용: npm run probe -- <장면 JSON> [--out <폴더>] [--dry-run] [--allow-empty-words]');
  return { scene, out, dryRun, allowEmptyWords };
}

// 녹화가 쓸모 있게 끝났는지. 하나라도 걸리면 0 아닌 종료 코드
export function outcomeOf(o: { spawnFailed: boolean; version: string | null; turnsDone: number; turns: number; code: number | null; timedOut: boolean }):
  { exitCode: number; reasons: string[] } {
  const reasons: string[] = [];
  if (o.spawnFailed) reasons.push('claude 를 띄우지 못했다');
  if (o.timedOut) reasons.push('시간 초과');
  if (o.version === null) reasons.push('init 에서 claude_code_version 을 못 읽었다');
  if (o.turnsDone === 0) reasons.push('턴 끝(result)이 한 번도 안 왔다');
  else if (o.turnsDone < o.turns) reasons.push(`턴 ${o.turns}개 중 ${o.turnsDone}개만 끝났다`);
  if (o.code !== 0 && !o.spawnFailed) reasons.push(`claude 종료 코드 ${o.code}`);
  return { exitCode: reasons.length ? 1 : 0, reasons };
}

// stdin 에 실제로 쓴 것만 'in' 으로 기록한다. 못 쓰면(닫힘·끝남) 기록하지 않고 dropped 로 알린다
export interface StdinLike { writable: boolean; destroyed?: boolean; writableEnded?: boolean; write(s: string): unknown }
export function writeIn(stdin: StdinLike | null | undefined, msg: unknown, rec: (x: Record<string, unknown>) => void, log: (s: string) => void): boolean {
  if (!stdin || !stdin.writable || stdin.destroyed || stdin.writableEnded) {
    log(`dropped(stdin 이 닫혀 못 보냄, 녹화에 안 남김): ${JSON.stringify(msg).slice(0, 300)}`);
    return false;
  }
  stdin.write(JSON.stringify(msg) + '\n');
  rec({ dir: 'in', msg });
  return true;
}

async function main(argv: string[]): Promise<number> {
  const o = parseArgs(argv);
  const gate = wordsGate(privateWordsFromEnv(), { allowEmpty: o.allowEmptyWords, dryRun: o.dryRun });
  if (gate.message) console.error(gate.message);
  if (!gate.ok) return 4;
  const scene = parseScene(fs.readFileSync(path.resolve(o.scene), 'utf8'));
  const tmp = os.tmpdir();
  const out = path.resolve(o.out ?? path.join(tmp, 'plenum-probe'));
  const workdir = workdirOf(scene, tmp, randToken());
  const prompts = scene.turns.map((t) => fillPrompt(t.prompt, tmp));
  const args = chatArgs({ model: scene.model }, process.env, process.platform);
  const resolved = resolveCommand('claude', process.env, process.platform);
  console.log(`장면: ${scene.scene}`);
  console.log(`작업 폴더: ${workdir}`);
  console.log(`출력 폴더: ${out}`);
  console.log(`claude: ${resolved ?? '(PATH 에서 못 찾음)'}`);
  console.log(`인자: ${JSON.stringify(['claude', ...args])}`);
  if (o.dryRun) {
    prompts.forEach((p, i) => console.log(`프롬프트 ${i + 1}:\n${p}`));
    console.log('--dry-run: claude 를 띄우지 않았다');
    return 0;
  }
  if (!resolved) { console.error('claude 를 PATH 에서 못 찾았다'); return 1; }
  const ver = await runCommand(commandFor(resolved, ['--version'], process.platform), { timeoutMs: 30000 });
  console.log(`claude --version: ${ver.output.trim() || ver.error || `(종료 코드 ${ver.code})`}`);
  if (ver.error || ver.timedOut || ver.code !== 0) { console.error('claude --version 이 실패했다 — 녹화하지 않는다'); return 1; }

  fs.mkdirSync(workdir, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  const rawPath = path.join(out, `${scene.scene}-raw.jsonl`);
  const metaPath = path.join(out, `${scene.scene}-meta.json`);
  fs.writeFileSync(rawPath, '');
  const start = Date.now();
  const t = () => Date.now() - start;
  const rec = (x: Record<string, unknown>) => fs.appendFileSync(rawPath, JSON.stringify(x) + '\n');

  const cmd = commandFor(resolved, args, process.platform);
  const child = spawn(cmd.cmd, cmd.args, {
    cwd: workdir, env: chatEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true, windowsVerbatimArguments: !!cmd.verbatim, detached: process.platform !== 'win32',
  });
  const driver = createClaudeDriver();
  let version: string | null = null;
  let turn = 0;
  let stderr = '';
  const history: string[] = [];
  const counts = new Map<string, { n: number; answers: string[] }>();
  child.stdin!.on('error', () => { /* EPIPE: 프로세스가 먼저 끝남 */ });
  const send = (msg: unknown) => writeIn(child.stdin, msg, (x) => rec({ dir: x.dir, t: t(), msg: x.msg }), (s) => console.log(s));

  const onLine = (line: string) => {
    let msg: any;
    try { msg = JSON.parse(line); } catch { msg = undefined; }
    rec(msg === undefined ? { dir: 'raw', t: t(), text: line } : { dir: 'out', t: t(), msg });
    for (const ev of driver.decode({ provider: 'claude', version, channel: 'stdout', text: line })) {
      if (ev.type === 'sessionStarted') version = ev.version ?? version;
      else if (ev.type === 'requestPermission') {
        const command = commandOf(ev.toolCall.rawInput);
        const pick = pickPermission(scene, history, command, ev.options.map((x) => x.optionId));
        history.push(command);
        const c = counts.get(command) ?? { n: 0, answers: [] };
        c.n++; c.answers.push(pick.optionId); counts.set(command, c);
        const req = msg?.request ?? {};
        console.log(`#${history.length} ${ev.toolCall.toolName ?? ''} ${command} → ${pick.optionId}${pick.note ? ` (${pick.note})` : ''}`);
        console.log(`   permission_suggestions: ${JSON.stringify(req.permission_suggestions ?? null)}`);
        console.log(`   description: ${typeof req.description === 'string' ? req.description : '(없음)'}`);
        send(driver.answerPermission(ev.requestId, { outcome: 'selected', optionId: pick.optionId }));
      } else if (ev.type === 'elicitation') {
        const q = pickQuestion(ev.questions);
        console.log(`질문 ${ev.questions.map((x) => x.header ?? x.question).join(' / ')} → ${q.action === 'accept' ? JSON.stringify(q.answers) : '거부'}`);
        send(driver.answerQuestion(ev.requestId, q));
      } else if (ev.type === 'unknown' && ev.reply !== undefined) {
        console.log(`처리 못 하는 요청(${ev.hint ?? '?'}) → 드라이버 기본 답(거절)`);
        send(ev.reply);
      } else if (ev.type === 'turnEnd') {
        console.log(`턴 ${turn + 1} 끝: ${ev.rawSubtype} ${JSON.stringify((ev.text ?? '').slice(0, 2000))}`);
        turn++;
        if (turn < prompts.length) send(driver.prompt(prompts[turn]));
        else child.stdin!.end();
      }
    }
  };

  const dec = new StringDecoder('utf8');
  let buf = '';
  child.stdout!.on('data', (d: Buffer) => {
    buf += dec.write(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.trim()) { try { onLine(line); } catch (e: any) { console.error(`줄 처리 실패: ${e?.message ?? e}`); } }
    }
  });
  child.stderr!.on('data', (d: Buffer) => { if (stderr.length < 2000) stderr = (stderr + d.toString('utf8')).slice(0, 2000); });

  let timedOut = false;
  let spawnFailed = false;
  const exit = await new Promise<{ code: number | null; sig: string | null }>((resolve) => {
    let info: { code: number | null; sig: string | null } | null = null;
    let finished = false;
    const done = () => {
      if (!info || finished) return;
      finished = true;
      const rest = buf + dec.end();
      buf = '';
      if (rest.trim()) { try { onLine(rest.trim()); } catch { /* 무시 */ } }
      resolve(info);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      console.log('시간 초과 — 프로세스 트리를 죽인다');
      if (child.pid) void killTree(child.pid, process.platform);
      // 그래도 안 끝나면 5초 뒤 끊는다
      setTimeout(() => { info = info ?? { code: null, sig: null }; child.stdout!.destroy(); child.stderr!.destroy(); done(); }, 5000).unref();
    }, scene.timeoutMs);
    child.once('error', (e) => {
      clearTimeout(timer);
      spawnFailed = true;
      console.error(`claude 를 실행하지 못했다: ${e.message}`);
      info = info ?? { code: null, sig: null };
      done();
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      info = { code, sig: signal };
      const g = setTimeout(() => { child.stdout!.destroy(); child.stderr!.destroy(); done(); }, 2000);
      g.unref();
      child.once('close', () => { clearTimeout(g); done(); });
    });
    // spawn 이 된 뒤에만 보낸다 — spawn 이 실패하면 in 줄이 남지 않는다
    child.once('spawn', () => {
      send(driver.initialize());
      send(driver.prompt(prompts[0]));
    });
  });
  rec({ dir: 'exit', code: exit.code, sig: exit.sig, ms: t() });

  const meta = {
    provider: 'claude', version, os: osName(process.platform), recordedAt: today(),
    command: ['claude', ...args], workdir, scene: scene.scene,
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');

  if (stderr) console.log(`stderr(앞 2000자):\n${stderr}`);
  console.log(`종료: code=${exit.code} sig=${exit.sig} ${t()}ms`);
  console.log('명령별 승인 요청 횟수 (2 이상 = 세션 허용 뒤 다시 물음):');
  for (const [command, c] of counts) console.log(`  ${c.n}회  ${c.answers.join(',')}  ${command}`);
  if (counts.size === 0) console.log('  (승인 요청 없음)');
  console.log(`원본: ${rawPath}`);
  console.log(`메타: ${metaPath}`);
  const res = outcomeOf({ spawnFailed, version, turnsDone: turn, turns: prompts.length, code: exit.code, timedOut });
  for (const r of res.reasons) console.log(`실패: ${r}`);
  console.log(`원본은 레포 밖에 있다. 다음: npm run probe:redact -- ${rawPath}`);
  return res.exitCode;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  // 손자 프로세스·남은 타이머가 붙잡아도 확실히 끝낸다
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e?.message ?? e); process.exit(1); });
}
