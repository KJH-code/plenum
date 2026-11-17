// 계약 테스트: 녹화(fixtures/providers/<제공자>/<버전>/)를 지금 채팅 매니저로 재생한 결과가 커밋된 기준(<장면>.golden.json)과
// 바이트 단위로 같은지 본다. 기준은 손으로 쓰지 않는다 — UPDATE_GOLDEN=1 npx vitest run test/contract.test.ts 로 지금 코드 출력을 쓴다.
// 장면 목록·비교 함수는 test/contract/replay.ts 에 있다(decode 단위 검사도 같은 것을 쓴다).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_DIR, PROVIDERS_DIR, SCENES, goldenPath, replay, sameDump, scenePath, serialize, type Dump } from './contract/replay.ts';

const UPDATE = process.env.UPDATE_GOLDEN === '1';
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
