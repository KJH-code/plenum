// 가짜 claude stream 모드 (채팅 테스트). 인자에 -p 가 있으면 stream 모드, 없으면 종료 64.
// 진짜와 같은 방식으로 PATH 이름("claude")으로 찾게 만든다(fakeclaude.ts 와 같은 posix·cmd 형태).
// FAKE_STREAM_SCRIPT: 녹화 jsonl({dir:"in"|"out"|"exit", msg}) 경로. out 은 순서대로 내고, in 자리에서는 stdin 에서
//   같은 종류(control_response 는 같은 request_id, control_request 는 같은 subtype, user 는 아무 user)가 올 때까지 기다린다.
//   exit 자리에서는 stdin 이 닫힐 때까지 기다렸다가(진짜는 다음 입력을 기다린다) 그 종료 코드로 끝난다.
// stdin 이 닫히면 남은 in 은 건너뛰고 out 을 다 낸 뒤 종료 코드 0 (녹화 06).
// 기다리지 않던 interrupt 를 받으면 control_response {still_queued:[]} + result/error_during_execution 을 내고 종료 1.
// FAKE_STREAM_LOG: 받은 stdin 줄 기록. FAKE_STREAM_ARGS: {args, cwd, sessionEnv, notify(받은 PLENUM_NOTIFY, 없으면 null)} 한 줄. FAKE_STREAM_DELAY_MS: out 줄 간격. 합성 대본 out 줄의 delayMs: 그 줄만 늦게 낸다.
// --version → FAKE_CLAUDE_VERSION(기본 2.1.323), --help → FAKE_CLAUDE_HELP_EFFORT=0 이면 --effort 줄 없는 도움말.
// FAKE_STREAM_HANG=1: 시작하자마자 손자 프로세스 하나를 띄우고(FAKE_STREAM_PIDS 에 "자기 손자" pid 기록) 무엇을 받아도 안 끝난다.
import fs from 'node:fs';
import path from 'node:path';
import { defaultForm, fakeEnv, type FakeForm } from './fakeclaude.ts';

const SCRIPT = String.raw`'use strict';
const fs = require('fs');
const { spawn } = require('child_process');
const readline = require('readline');
const env = process.env;
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log((env.FAKE_CLAUDE_VERSION || '2.1.323') + ' (Claude Code)'); process.exit(0); }
if (args[0] === '--help') {
  const lines = ['Usage: claude [options] [command] [prompt]', '', 'Options:',
    '  -p, --print                       Print response and exit',
    '  --model <model>                   Model for the current session'];
  if (env.FAKE_CLAUDE_HELP_EFFORT !== '0') lines.push('  --effort <level>                  Effort level for the current session (low, medium, high, xhigh, max)');
  lines.push('  --resume [value]                  Resume a conversation');
  console.log(lines.join('\n'));
  process.exit(0);
}
if (!args.includes('-p')) { console.error('fake claude stream: -p 가 없다'); process.exit(64); }
if (env.FAKE_STREAM_ARGS) fs.appendFileSync(env.FAKE_STREAM_ARGS, JSON.stringify({ args, cwd: process.cwd(), sessionEnv: [env.CLAUDE_CODE_SESSION_ID || null, env.CLAUDE_CODE_REMOTE_SESSION_ID || null], notify: env.PLENUM_NOTIFY === undefined ? null : env.PLENUM_NOTIFY }) + '\n');
const hang = env.FAKE_STREAM_HANG === '1';
if (hang) {
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  if (env.FAKE_STREAM_PIDS) fs.appendFileSync(env.FAKE_STREAM_PIDS, process.pid + ' ' + g.pid + '\n');
  setInterval(() => {}, 1000);
}
const delay = Number(env.FAKE_STREAM_DELAY_MS || 0);
let script = [];
if (env.FAKE_STREAM_SCRIPT) script = fs.readFileSync(env.FAKE_STREAM_SCRIPT, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((x) => x.dir === 'in' || x.dir === 'out' || x.dir === 'exit');
let sessionId = null;
for (const x of script) if (x.dir === 'out' && x.msg && x.msg.session_id) { sessionId = x.msg.session_id; break; }

const queue = [];
let closed = false;
let wake = null;
let waitingFor = null;
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const finish = (code) => { if (hang) return; process.stdout.write('', () => process.exit(code)); };
const isInterrupt = (m) => m && m.type === 'control_request' && m.request && m.request.subtype === 'interrupt';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (l) => {
  if (env.FAKE_STREAM_LOG) fs.appendFileSync(env.FAKE_STREAM_LOG, l + '\n');
  let m; try { m = JSON.parse(l); } catch { return; }
  if (!hang && isInterrupt(m) && !(waitingFor && isInterrupt(waitingFor))) {
    out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { still_queued: [] } } });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, permission_denials: [] });
    finish(1);
    return;
  }
  queue.push(m);
  if (wake) wake();
});
rl.on('close', () => { closed = true; if (wake) wake(); });
const matches = (want) => (m) => {
  if (want.type === 'control_response') return m.type === 'control_response' && m.response && want.response && m.response.request_id === want.response.request_id;
  if (want.type === 'control_request') return m.type === 'control_request' && m.request && want.request && m.request.subtype === want.request.subtype;
  return m.type === want.type;
};
async function waitFor(pred) {
  for (;;) {
    const i = queue.findIndex(pred);
    if (i >= 0) return queue.splice(i, 1)[0];
    if (closed) return null;
    await new Promise((r) => { wake = r; });
    wake = null;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let code = 0;
  for (const x of script) {
    if (x.dir === 'out') { if (delay) await sleep(delay); if (x.delayMs) await sleep(x.delayMs); out(x.msg); }
    else if (x.dir === 'in') { waitingFor = x.msg; await waitFor(matches(x.msg)); waitingFor = null; }
    else { code = x.code == null ? 0 : x.code; break; }
  }
  await waitFor(() => false);
  finish(code);
})();
`;

export interface FakeStreamClaude {
  binDir: string;
  logFile: string;     // 받은 stdin 줄
  argsFile: string;    // 받은 인자
  pidsFile: string;    // HANG: "자기 손자"
  env(o?: { script?: string; hang?: boolean; delayMs?: number; version?: string; helpEffort?: boolean; extra?: Record<string, string> }): NodeJS.ProcessEnv;
  stdin(): any[];
  argsCalls(): { args: string[]; cwd: string; sessionEnv: (string | null)[]; notify: string | null }[];
  hangPids(): number[][];
}

export function makeFakeStreamClaude(dir: string, form: FakeForm = defaultForm()): FakeStreamClaude {
  const win = process.platform === 'win32';
  fs.mkdirSync(dir, { recursive: true });
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const script = path.join(dir, 'fake-claude-stream.js');
  fs.writeFileSync(script, SCRIPT);
  if (form === 'posix') {
    if (win) throw new Error('posix 가짜는 Windows에서 못 쓴다');
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    fs.writeFileSync(path.join(binDir, 'claude'), `#!/bin/sh\nexec ${q(process.execPath)} ${q(script)} "$@"\n`, { mode: 0o755 });
  } else if (form === 'cmd') {
    if (!win) throw new Error('cmd 가짜는 Windows 전용');
    fs.writeFileSync(path.join(dir, 'real-claude.cmd'), `@"${process.execPath}" "%~dp0fake-claude-stream.js" %*\r\n@exit /b %errorlevel%\r\n`);
    fs.writeFileSync(path.join(binDir, 'claude.cmd'), '@"%~dp0..\\real-claude.cmd" %*\r\n');
  } else throw new Error('stream 가짜는 posix·cmd 형태만');
  const logFile = path.join(dir, 'stdin.log');
  const argsFile = path.join(dir, 'args.log');
  const pidsFile = path.join(dir, 'pids.log');
  const lines = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
  return {
    binDir, logFile, argsFile, pidsFile,
    env: (o = {}) => fakeEnv(win ? [binDir, path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : [binDir], {
      FAKE_STREAM_LOG: logFile, FAKE_STREAM_ARGS: argsFile, FAKE_STREAM_PIDS: pidsFile,
      ...(o.script ? { FAKE_STREAM_SCRIPT: o.script } : {}),
      ...(o.hang ? { FAKE_STREAM_HANG: '1' } : {}),
      ...(o.delayMs !== undefined ? { FAKE_STREAM_DELAY_MS: String(o.delayMs) } : {}),
      ...(o.version ? { FAKE_CLAUDE_VERSION: o.version } : {}),
      ...(o.helpEffort === false ? { FAKE_CLAUDE_HELP_EFFORT: '0' } : {}),
      ...o.extra,
    }),
    stdin: () => lines(logFile).map((l) => JSON.parse(l)),
    argsCalls: () => lines(argsFile).map((l) => JSON.parse(l)),
    hangPids: () => lines(pidsFile).map((l) => l.split(' ').map(Number)),
  };
}

// 합성 대본: 녹화와 같은 한 줄 모양으로 쓴다
export function writeScript(file: string, items: ({ dir: 'in' | 'out'; msg: unknown; delayMs?: number } | { dir: 'exit'; code: number })[]) {
  fs.writeFileSync(file, items.map((x) => JSON.stringify(x)).join('\n') + '\n');
}
