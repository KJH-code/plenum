// 계약 테스트 재생: 녹화 한 장면을 가짜 claude(fakeclaudeStream.ts)로 돌려 지금 채팅 매니저(server/chat.ts)가 내는
// ChatEvent 열과 stdin 줄을 모은다. 가짜가 녹화의 in 자리에서 기다리면(FAKE_STREAM_WAITS) 녹화된 in 을 매니저 API 로 바꿔 넣는다:
//   control_response + updatedPermissions → respond allow-session, updatedInput.answers → respond answer,
//   behavior allow → allow, deny → deny + 이유(message 의 "이유: " 뒤, 없으면 빈 값), user → send,
//   control_request interrupt → interrupt, exit(가짜가 stdin 닫힘을 기다림) → close.
// 매니저가 스스로 쓰는 in(첫 initialize, 첫 user)은 넣지 않는다.
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

type Item = { dir: 'in' | 'out' | 'exit'; msg?: any; code?: number };
// 가짜와 같은 규칙으로 대본을 읽는다(인덱스가 맞아야 한다)
function readScript(file: string): Item[] {
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
const QUIET_MS = 60;
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
  let lastAt = Date.now();
  let chatId: string | null = null;
  const early: { id: string; ev: ChatEvent }[] = [];
  const off = m.onEvent((c, ev) => {
    lastAt = Date.now();
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
    // 가짜가 기다리기 시작한 뒤 앞서 낸 줄이 매니저에 다 닿을 때까지(이벤트가 QUIET_MS 동안 없음 + 조건)
    const settle = async (cond: () => boolean = () => true) => {
      const end = Date.now() + SCENE_TIMEOUT_MS;
      while (!(Date.now() - lastAt >= QUIET_MS && cond())) {
        if (Date.now() > end) throw new Error(`${scene}: 매니저 이벤트가 가라앉지 않는다`);
        await sleep(10);
      }
    };
    const deadline = Date.now() + SCENE_TIMEOUT_MS;
    let handled = 0;
    for (;;) {
      const marks = fs.existsSync(waitsFile) ? fs.readFileSync(waitsFile, 'utf8').split('\n').filter(Boolean) : [];
      if (handled < marks.length) {
        const [idxS, kind] = marks[handled++].split(' ');
        const idx = Number(idxS);
        if (idx === firstInit || idx === firstUser) continue;
        const x = script[idx];
        if (!x) throw new Error(`${scene}: 대본에 없는 인덱스 ${idxS}`);
        if (kind === 'exit') {
          await settle();
          await m.close(id);
          continue;
        }
        const msg = x.msg;
        if (msg?.type === 'control_response') {
          const r = msg.response ?? {};
          const rid: string = r.request_id;
          const b = r.response ?? {};
          await settle(() => hasCard(rid));
          if (b.behavior === 'allow' && Array.isArray(b.updatedPermissions)) m.respond(id, { requestId: rid, action: 'allow-session' });
          else if (b.behavior === 'allow' && b.updatedInput && typeof b.updatedInput === 'object' && b.updatedInput.answers) m.respond(id, { requestId: rid, action: 'answer', answers: b.updatedInput.answers });
          else if (b.behavior === 'allow') m.respond(id, { requestId: rid, action: 'allow' });
          else if (b.behavior === 'deny') {
            const message = typeof b.message === 'string' ? b.message : '';
            const at = message.indexOf('이유: ');
            m.respond(id, { requestId: rid, action: 'deny', reason: at >= 0 ? message.slice(at + '이유: '.length) : '' });
          } else throw new Error(`${scene}: ${idx} 모르는 control_response: ${JSON.stringify(msg).slice(0, 200)}`);
        } else if (msg?.type === 'user') {
          const t = msg.message?.content;
          if (typeof t !== 'string') throw new Error(`${scene}: ${idx} user in 이 글자가 아니다`);
          await settle();
          m.send(id, t);
        } else if (msg?.type === 'control_request' && msg.request?.subtype === 'interrupt') {
          await settle();
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
    fs.rmSync(root, { recursive: true, force: true });
  }
}
