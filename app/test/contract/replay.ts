// 계약 테스트 재생: 녹화 한 장면을 가짜 claude(fakeclaudeStream.ts)로 돌려 지금 채팅 매니저(server/chat.ts)가 내는
// ChatEvent 열과 stdin 줄을 모은다. 가짜가 녹화의 in 자리에서 기다리면(FAKE_STREAM_WAITS) 녹화된 in 을 매니저 API 로 바꿔 넣는다:
//   control_response + updatedPermissions → respond allow-session, updatedInput.answers → respond answer,
//   behavior allow → allow, deny → deny + 이유(message 의 "이유: " 뒤, 없으면 message 전체), user → send,
//   control_request interrupt → interrupt, exit(가짜가 stdin 닫힘을 기다림) → close.
// 매니저가 스스로 쓰는 in(첫 initialize, 첫 user)은 넣지 않는다.
// 동기화는 시간이 아니라 조건으로 한다(가짜의 기다림 신호 + 매니저 이벤트):
//   control_response X → card(requestId X) 이벤트가 왔다, user → 그 앞 녹화 result 수만큼 result 가 왔고 state idle,
//   interrupt → 신호만(interrupt() 는 이벤트를 내지 않는다), exit → state idle 또는 ended.
// 정규화: at=0, chatId→"CHAT", limits.receivedAt=0, worker.startedAt·endedAt 숫자면 0. 그 밖의 값은 그대로.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatManager } from '../../server/chat.ts';
import type { ChatEvent } from '../../server/chatTypes.ts';
import { makeFakeStreamClaude } from '../fakeclaudeStream.ts';
import { APP } from '../helpers.ts';

export const PROVIDERS_DIR = path.join(APP, 'test', 'fixtures', 'providers');
export const CLAUDE_DIR = path.join(PROVIDERS_DIR, 'claude', '2.1.323');

export interface Meta { provider: string; version: string; os: string; recordedAt: string | null; command: string[]; scenes: string[] }
export const readMeta = (dir = CLAUDE_DIR): Meta => JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
export const SCENES: string[] = readMeta().scenes;
export const scenePath = (scene: string, dir = CLAUDE_DIR) => path.join(dir, `${scene}.jsonl`);
export const goldenPath = (scene: string, dir = CLAUDE_DIR) => path.join(dir, `${scene}.golden.json`);
export const expectPath = (scene: string, dir = CLAUDE_DIR) => path.join(dir, `${scene}.expect.json`);

export interface Replay { events: unknown[]; stdin: string[] }
export interface Dump extends Replay { scene: string }

// 기준 파일과 같은 모양의 문자열 (2칸 들여쓰기, 끝 줄바꿈)
export const serialize = (d: Dump) => `${JSON.stringify(d, null, 2)}\n`;
// 비교 함수: 바이트 단위로 같아야 같음. 자가검사(g)와 장면 비교(d)가 같이 쓴다
export function sameDump(actual: string, golden: string): boolean {
  if (typeof actual !== 'string' || typeof golden !== 'string') throw new Error('비교할 값이 문자열이 아니다');
  if (!golden.length) throw new Error('기준이 비어 있다');
  return actual === golden;
}

export type Item = { dir: 'in' | 'out' | 'exit'; msg?: any; code?: number };
// 가짜와 같은 규칙으로 대본을 읽는다(인덱스가 맞아야 한다). decode 단위 검사도 쓴다
export function readScript(file: string): Item[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
    .filter((x: Item) => x.dir === 'in' || x.dir === 'out' || x.dir === 'exit');
}

function normalize(ev: ChatEvent, chatId: string): unknown {
  const e: any = JSON.parse(JSON.stringify(ev, (_k, v) => (v === chatId ? 'CHAT' : v)));
  e.at = 0;
  if (e.type === 'limits' && e.limits && typeof e.limits === 'object') e.limits.receivedAt = 0;
  if (e.type === 'worker' && e.worker && typeof e.worker === 'object') {
    if (typeof e.worker.startedAt === 'number') e.worker.startedAt = 0;
    if (typeof e.worker.endedAt === 'number') e.worker.endedAt = 0;
  }
  return e;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SCENE_TIMEOUT_MS = 20000;

export async function replay(scene: string, dir = CLAUDE_DIR): Promise<Replay> {
  const script = readScript(scenePath(scene, dir));
  const firstInit = script.findIndex((x) => x.dir === 'in' && x.msg?.type === 'control_request' && x.msg?.request?.subtype === 'initialize');
  const firstUser = script.findIndex((x) => x.dir === 'in' && x.msg?.type === 'user');
  if (firstUser < 0 || typeof script[firstUser].msg?.message?.content !== 'string') throw new Error(`${scene}: 첫 user in(글자)이 없다`);
  const text: string = script[firstUser].msg.message.content;
  // 이어하기 장면: 녹화의 session_id 를 --resume 대상으로
  const resume = /resume/.test(scene) ? script.find((x) => x.dir === 'out' && typeof x.msg?.session_id === 'string')?.msg.session_id as string | undefined : undefined;
  if (/resume/.test(scene) && !resume) throw new Error(`${scene}: 녹화에 session_id 가 없다`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plenum-contract-'));
  const projDir = path.join(root, 'project');
  const cfgDir = path.join(root, 'cfg');
  const claudeDir = path.join(root, 'claude-config');
  fs.mkdirSync(projDir);
  fs.mkdirSync(claudeDir);
  const waitsFile = path.join(root, 'waits.log');
  const fake = makeFakeStreamClaude(path.join(root, 'fake'));
  const env = fake.env({ script: scenePath(scene, dir), extra: { FAKE_STREAM_WAITS: waitsFile, CLAUDE_CONFIG_DIR: claudeDir, PLENUM_CONFIG_DIR: cfgDir } });
  const m = createChatManager({ cfgDir, env, closeWaitMs: 3000 });

  const raw: ChatEvent[] = [];
  let chatId: string | null = null;
  const early: { id: string; ev: ChatEvent }[] = [];
  const off = m.onEvent((c, ev) => {
    if (chatId === null) early.push({ id: c.chatId, ev });
    else if (c.chatId === chatId) raw.push(ev);
  });
  try {
    const { chat } = await m.start({ id: 'p1', path: projDir }, { text, ...(resume ? { resume } : {}) });
    chatId = chat.chatId;
    for (const x of early) if (x.id === chatId) raw.push(x.ev);
    const id = chatId;
    const ended = () => raw.some((e) => e.type === 'state' && e.state === 'ended');
    const hasCard = (rid: string) => raw.some((e) => e.type === 'card' && e.card.requestId === rid);
    const state = () => { for (let i = raw.length - 1; i >= 0; i--) { const e = raw[i]; if (e.type === 'state') return e.state; } return null; };
    const results = () => raw.filter((e) => e.type === 'result').length;
    const deadline = Date.now() + SCENE_TIMEOUT_MS;
    // 매니저가 그 in 을 받을 준비가 될 때까지(조건). 시간 대기는 전체 상한뿐
    const ready = async (what: string, cond: () => boolean) => {
      while (!cond()) {
        if (Date.now() > deadline) throw new Error(`${scene}: ${what} 조건이 ${SCENE_TIMEOUT_MS}ms 안에 안 됐다 (state ${state()}, 이벤트 ${raw.length})`);
        await sleep(5);
      }
    };
    let handled = 0;
    for (;;) {
      // 가짜가 쓰는 중인 줄을 반만 읽지 않게: 줄바꿈으로 끝난 줄만 쓴다(마지막 줄바꿈 뒤 조각은 버린다)
      const marks = fs.existsSync(waitsFile) ? fs.readFileSync(waitsFile, 'utf8').split('\n').slice(0, -1).filter(Boolean) : [];
      if (handled < marks.length) {
        const [idxS, kind] = marks[handled++].split(' ');
        const idx = Number(idxS);
        if (idx === firstInit || idx === firstUser) continue;
        const x = script[idx];
        if (!x) throw new Error(`${scene}: 대본에 없는 인덱스 ${idxS}`);
        if (kind === 'exit') {
          await ready(`${idx} exit`, () => state() === 'idle' || state() === 'ended');
          await m.close(id);
          continue;
        }
        const msg = x.msg;
        if (msg?.type === 'control_response') {
          const r = msg.response ?? {};
          const rid: string = r.request_id;
          const b = r.response ?? {};
          await ready(`${idx} control_response`, () => hasCard(rid));
          if (b.behavior === 'allow' && Array.isArray(b.updatedPermissions)) m.respond(id, { requestId: rid, action: 'allow-session' });
          else if (b.behavior === 'allow' && b.updatedInput && typeof b.updatedInput === 'object' && b.updatedInput.answers) m.respond(id, { requestId: rid, action: 'answer', answers: b.updatedInput.answers });
          else if (b.behavior === 'allow') m.respond(id, { requestId: rid, action: 'allow' });
          else if (b.behavior === 'deny') {
            const message = typeof b.message === 'string' ? b.message : '';
            const at = message.indexOf('이유: ');
            m.respond(id, { requestId: rid, action: 'deny', reason: at >= 0 ? message.slice(at + '이유: '.length) : message });
          } else throw new Error(`${scene}: ${idx} 모르는 control_response: ${JSON.stringify(msg).slice(0, 200)}`);
        } else if (msg?.type === 'user') {
          const t = msg.message?.content;
          if (typeof t !== 'string') throw new Error(`${scene}: ${idx} user in 이 글자가 아니다`);
          const before = script.slice(0, idx).filter((y) => y.dir === 'out' && y.msg?.type === 'result').length;
          await ready(`${idx} user`, () => results() >= before && state() === 'idle');
          m.send(id, t);
        } else if (msg?.type === 'control_request' && msg.request?.subtype === 'interrupt') {
          m.interrupt(id);
        } else throw new Error(`${scene}: ${idx} 재생할 수 없는 in: ${JSON.stringify(msg).slice(0, 200)}`);
        continue;
      }
      if (ended()) break;
      if (Date.now() > deadline) throw new Error(`${scene}: ${SCENE_TIMEOUT_MS}ms 안에 끝나지 않았다. 기다림 표시: ${JSON.stringify(marks)}`);
      await sleep(10);
    }
    const stdin = fs.existsSync(fake.logFile) ? fs.readFileSync(fake.logFile, 'utf8').split('\n').filter(Boolean) : [];
    return { events: raw.map((e) => normalize(e, id)), stdin };
  } finally {
    off();
    await m.shutdownAll();
    // Windows 에서 막 끝난 프로세스가 파일을 잡고 있으면 EBUSY·EPERM → Node 내장 재시도. 그래도 못 지우면 경고만(앞선 오류를 가리지 않게)
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (e: any) { console.warn(`[contract] 임시 폴더를 못 지웠다: ${root} (${e?.code ?? e})`); }
  }
}
