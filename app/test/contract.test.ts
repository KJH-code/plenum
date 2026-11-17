// 계약 테스트: 녹화(fixtures/providers/<제공자>/<버전>/)를 지금 채팅 매니저로 재생한 결과가 커밋된 기준(<장면>.golden.json)과
// 바이트 단위로 같은지 본다. 기준은 손으로 쓰지 않는다 — UPDATE_GOLDEN=1 npx vitest run test/contract.test.ts 로 지금 코드 출력을 쓴다.
// 장면 목록·비교 함수는 test/contract/replay.ts 에 있다(decode 단위 검사도 같은 것을 쓴다).
// decode 단위 검사((b)(c)(e)(f)(h))는 드라이버(server/provider/claude.ts)만 돌린다. (c) 기준은
// UPDATE_EXPECT=1 npx vitest run test/contract.test.ts 로 지금 드라이버 출력을 쓴다(golden 은 건드리지 않는다).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRANCHES, DENIED, branchHits, createClaudeDriver } from '../server/provider/claude.ts';
import type { ProviderEvent } from '../server/provider/events.ts';
import {
  CLAUDE_DIR, PROVIDERS_DIR, SCENES, expectPath, goldenPath, readScript, replay, sameDump, scenePath, serialize, type Dump,
} from './contract/replay.ts';

const UPDATE = process.env.UPDATE_GOLDEN === '1';
const UPDATE_EXPECT = process.env.UPDATE_EXPECT === '1';
const subdirs = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)) : []);

describe('계약: fixture', () => {
  it('(a) 제공자/버전 폴더 ≥1, 녹화 jsonl ≥1, 장면마다 녹화와 기준이 있다', () => {
    const versions = subdirs(PROVIDERS_DIR).flatMap(subdirs);
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions).toContain(CLAUDE_DIR);
    const jsonl = fs.readdirSync(CLAUDE_DIR).filter((f) => f.endsWith('.jsonl'));
    expect(jsonl.length).toBeGreaterThanOrEqual(1);
    expect(SCENES.length).toBeGreaterThan(0);
    expect(jsonl.sort()).toEqual(SCENES.map((s) => `${s}.jsonl`).sort());
    for (const s of SCENES) expect(fs.existsSync(scenePath(s)), s).toBe(true);
    if (UPDATE) return;
    const golden = fs.readdirSync(CLAUDE_DIR).filter((f) => f.endsWith('.golden.json'));
    expect(golden.length).toBe(SCENES.length);
    expect(golden.sort()).toEqual(SCENES.map((s) => `${s}.golden.json`).sort());
  });
});

describe('계약: 재생 = 기준', () => {
  // 표가 비면 아래 it.each 가 0개가 되므로 (a)가 장면 수를 단언한다
  it.each(SCENES)('(d) %s', async (scene) => {
    const r = await replay(scene);
    const actual = serialize({ scene, ...r });
    if (UPDATE) {
      // 결정적인지 한 번 더 돌려 보고 쓴다
      const again = serialize({ scene, ...(await replay(scene)) });
      expect(again).toBe(actual);
      fs.writeFileSync(goldenPath(scene), actual);
      return;
    }
    const golden = fs.readFileSync(goldenPath(scene), 'utf8');
    if (!sameDump(actual, golden)) expect(actual).toBe(golden); // 다르면 차이를 보여 준다
    expect(sameDump(actual, golden)).toBe(true);
  }, 60000);
});

describe('계약: 비교기 자가검사', () => {
  it('(g) 이벤트 하나를 빼거나 문자열 칸 한 글자를 바꾼 사본은 다르다고 판정한다', () => {
    let checked = 0;
    for (const scene of SCENES) {
      if (!fs.existsSync(goldenPath(scene))) continue;
      const golden = fs.readFileSync(goldenPath(scene), 'utf8');
      const d = JSON.parse(golden) as Dump;
      expect(d.scene).toBe(scene);
      expect(d.events.length).toBeGreaterThan(0);
      expect(d.stdin.length).toBeGreaterThan(0);
      // 그대로 다시 직렬화하면 같다(직렬화 모양이 기준 파일과 맞는다)
      expect(sameDump(serialize(d), golden)).toBe(true);

      // 이벤트 하나 빼기(가운데)
      const dropped: Dump = { ...d, events: d.events.filter((_e, i) => i !== Math.floor(d.events.length / 2)) };
      expect(sameDump(serialize(dropped), golden)).toBe(false);

      // 문자열 칸 한 글자 바꾸기: 처음 만나는 길이 ≥1 문자열 값의 첫 글자
      const mutated = JSON.parse(golden) as Dump;
      let done = false;
      const flip = (o: any): void => {
        if (done || !o || typeof o !== 'object') return;
        for (const k of Object.keys(o)) {
          if (done) return;
          if (typeof o[k] === 'string' && o[k].length > 0) {
            o[k] = (o[k][0] === 'X' ? 'Y' : 'X') + o[k].slice(1);
            done = true;
          } else flip(o[k]);
        }
      };
      flip(mutated.events);
      expect(done).toBe(true);
      expect(sameDump(serialize(mutated), golden)).toBe(false);

      // stdin 줄 한 글자 바꾸기
      const s0 = d.stdin[0];
      const stdinMut: Dump = { ...d, stdin: [(s0[0] === 'X' ? 'Y' : 'X') + s0.slice(1), ...d.stdin.slice(1)] };
      expect(sameDump(serialize(stdinMut), golden)).toBe(false);
      checked++;
    }
    if (!UPDATE) expect(checked).toBe(SCENES.length);
    // 빈 기준과의 비교는 같음이 아니라 오류
    expect(() => sameDump('', '')).toThrow();
  });
});

// ── decode 단위 검사 ─────────────────────────────────────
const rawOf = (text: string) => ({ provider: 'claude', version: '2.1.323', channel: 'stdout' as const, text });
// 녹화 한 장면의 out 줄을 새 드라이버 하나에 순서대로 넣는다. 가짜 claude 가 쓰는 줄과 같은 글자(JSON.stringify)
function decodeScene(scene: string): { events: ProviderEvent[]; throws: number } {
  const d = createClaudeDriver();
  const events: ProviderEvent[] = [];
  let throws = 0;
  for (const x of readScript(scenePath(scene))) {
    if (x.dir !== 'out') continue;
    try { events.push(...d.decode(rawOf(JSON.stringify(x.msg)))); } catch { throws++; }
  }
  return { events, throws };
}

interface Expect { types: string[]; permissionCards: number; questionCards: number; sessionScopeOption: boolean; stopReasons: string[]; windows: string[]; unknown: number }
function summarize(events: ProviderEvent[]): Expect {
  const windows: string[] = [];
  for (const e of events) if (e.type === 'usage') for (const w of e.windows ?? []) if (!windows.includes(w.id)) windows.push(w.id);
  return {
    types: events.map((e) => e.type),
    permissionCards: events.filter((e) => e.type === 'requestPermission').length,
    questionCards: events.filter((e) => e.type === 'elicitation').length,
    sessionScopeOption: events.some((e) => e.type === 'requestPermission' && e.options.some((o) => o.scope === 'session')),
    stopReasons: events.flatMap((e) => (e.type === 'turnEnd' ? [e.stopReason] : [])),
    windows,
    unknown: events.filter((e) => e.type === 'unknown').length,
  };
}

// 키 집합(중첩 포함)과 값 타입. 배열은 원소마다
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shape);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as any)[k])]));
  return v === null ? 'null' : typeof v;
}

describe('계약: decode', () => {
  it.each(SCENES)('(b) %s: out 줄 전부 decode 해도 throw 0', (scene) => {
    const { events, throws } = decodeScene(scene);
    expect(throws).toBe(0);
    expect(events.length).toBeGreaterThan(0);
  });

  it.each(SCENES)('(c) %s: 이벤트 요약이 기준(<장면>.expect.json)과 같다', (scene) => {
    const actual = summarize(decodeScene(scene).events);
    if (UPDATE_EXPECT) { fs.writeFileSync(expectPath(scene), `${JSON.stringify(actual, null, 2)}\n`); return; }
    expect(actual).toEqual(JSON.parse(fs.readFileSync(expectPath(scene), 'utf8')));
  });

  it('(e) 녹화 in 의 control_response 마다 드라이버가 만든 답의 키 집합·값 타입이 같다', () => {
    let checked = 0;
    for (const scene of SCENES) {
      const d = createClaudeDriver();
      for (const x of readScript(scenePath(scene))) {
        if (x.dir === 'out') { d.decode(rawOf(JSON.stringify(x.msg))); continue; }
        if (x.dir !== 'in' || x.msg?.type !== 'control_response') continue;
        const rid: string = x.msg.response.request_id;
        const b = x.msg.response.response ?? {};
        let mine: unknown;
        if (b.behavior === 'allow' && Array.isArray(b.updatedPermissions)) mine = d.answerPermission(rid, { outcome: 'selected', optionId: 'allow_session' });
        else if (b.behavior === 'allow' && b.updatedInput?.answers) mine = d.answerQuestion(rid, { action: 'accept', answers: b.updatedInput.answers });
        else if (b.behavior === 'allow') mine = d.answerPermission(rid, { outcome: 'selected', optionId: 'allow_once' });
        else if (b.behavior === 'deny') mine = d.answerPermission(rid, { outcome: 'selected', optionId: 'reject_once', message: String(b.message ?? '') });
        else throw new Error(`${scene}: 모르는 control_response ${JSON.stringify(x.msg).slice(0, 200)}`);
        expect(shape(mine), `${scene} ${rid}`).toEqual(shape(x.msg));
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it('(f) 합성 줄: 모르는 것은 unknown 으로, 모르는 요청은 거절 답과 함께', () => {
    const d = createClaudeDriver();
    const one = (text: string) => { const evs = d.decode(rawOf(text)); expect(evs).toHaveLength(1); return evs[0]; };
    for (const t of ['{bad json', '"str"', '[]', 'null', '']) {
      const e = one(t);
      expect(e.type === 'unknown' && e.reason, t).toBe('parse');
      expect(e.type === 'unknown' && e.raw.text).toBe(t);
    }
    const weird = one('{"type":"weird"}');
    expect(weird).toMatchObject({ type: 'unknown', reason: 'event', hint: 'weird', answeredWithDefault: false });
    const mystery = one('{"type":"control_request","request_id":"x","request":{"subtype":"mystery"}}');
    expect(mystery).toMatchObject({ type: 'unknown', reason: 'event', hint: 'mystery', answeredWithDefault: true, requestId: 'x' });
    expect(mystery.type === 'unknown' && JSON.stringify(mystery.reply))
      .toBe('{"type":"control_response","response":{"subtype":"error","request_id":"x","error":"Plenum 채팅이 처리하지 못하는 요청"}}');
    expect(one('{"type":"control_request","request":{"subtype":"can_use_tool"}}')).toMatchObject({ type: 'unknown', reason: 'field' });

    // 값 몇 개를 직접: 조각 번호, 세션 규칙의 ruleContent, 거부 문구
    d.decode(rawOf('{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}'));
    expect(one('{"type":"stream_event","event":{"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"hi"}}}'))
      .toMatchObject({ type: 'message', phase: 'chunk', messageId: 'm1', index: 3, text: 'hi' });
    const perm = one(JSON.stringify({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch c.txt' },
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch c.txt' }], behavior: 'allow', destination: 'session' }, { type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } }));
    expect(perm.type === 'requestPermission' && perm.options.map((o) => o.optionId)).toEqual(['allow_once', 'allow_session', 'reject_once']);
    expect(JSON.stringify(d.answerPermission('p1', { outcome: 'selected', optionId: 'allow_session' })))
      .toBe('{"type":"control_response","response":{"subtype":"success","request_id":"p1","response":{"behavior":"allow","updatedInput":{"command":"touch c.txt"},"updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"touch c.txt"}],"behavior":"allow","destination":"session"}]}}}');
    expect(JSON.stringify(d.answerPermission('p1', { outcome: 'selected', optionId: 'reject_once', message: '싫다' })))
      .toBe(`{"type":"control_response","response":{"subtype":"success","request_id":"p1","response":{"behavior":"deny","message":"${DENIED}. 이유: 싫다"}}}`);
    expect(DENIED).toBe('사용자가 직접 거부했다(훅 아님)');
    expect(JSON.stringify(d.interrupt())).toBe('{"type":"control_request","request_id":"int-1","request":{"subtype":"interrupt"}}');
    expect(JSON.stringify(d.interrupt())).toBe('{"type":"control_request","request_id":"int-2","request":{"subtype":"interrupt"}}');
  });

  it('(h) 매핑 분기 도달: fixture 전체를 돈 뒤 안 닿은 분기를 출력한다(실패 아님)', () => {
    branchHits.clear();
    for (const scene of SCENES) decodeScene(scene);
    const missed = BRANCHES.filter((b) => !branchHits.has(b));
    console.log(`[contract (h)] 안 닿은 분기 ${missed.length}/${BRANCHES.length}: ${missed.join(', ') || '없음'}`);
    expect(branchHits.size).toBeGreaterThan(0);
  });
});
