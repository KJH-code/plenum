// V6: API가 내는 워커 27개를 kit/workers/*.md 머리말과 직접 대조한다 (API와 다른 방법으로 읽는다: 줄 단위 + js-yaml)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { APP, inProcess, tmpDir } from './helpers.ts';

const require = createRequire(import.meta.url);
const yaml = require(path.join(APP, '..', 'node_modules', 'js-yaml'));

// jh-kit 레포 위치: PLENUM_TEST_KIT_REPO, 없으면 plenum 옆 폴더 jh-kit
const KIT_REPO = process.env.PLENUM_TEST_KIT_REPO || path.join(APP, '..', '..', 'jh-kit');
const HAS_KIT = fs.existsSync(path.join(KIT_REPO, 'kit', 'kit.yaml'));

function frontmatter(file: string): any {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  return yaml.load(lines.slice(1, end).join('\n'));
}

describe.skipIf(!HAS_KIT)(`워커 대조 (${KIT_REPO})`, () => {
  let srv: Awaited<ReturnType<typeof inProcess>>;
  let data: any;
  beforeAll(async () => {
    srv = await inProcess({ cfgDir: path.join(tmpDir(), 'cfg') });
    expect((await srv.call('PUT', '/api/settings', { kitRepoPath: KIT_REPO })).status).toBe(200);
    data = (await srv.call('GET', '/api/kit/workers')).body;
  });
  afterAll(() => srv.close());

  test('워커는 27개이고 kit/workers/*.md 파일 수와 같다', () => {
    expect(data.ok, data.message).toBe(true);
    const files = fs.readdirSync(path.join(KIT_REPO, 'kit', 'workers')).filter((f) => f.endsWith('.md'));
    expect(files.length).toBe(27);
    expect(data.workers.length).toBe(27);
  });

  test('단계 순서는 kit.yaml stages, 워커는 그 순서로 묶여 있다', () => {
    const meta = yaml.load(fs.readFileSync(path.join(KIT_REPO, 'kit', 'kit.yaml'), 'utf8'));
    expect(data.stages).toEqual(meta.stages);
    expect(data.stages).toEqual(['구현', '설계', '테스트', '리뷰', '반박 검증', '증명', '보조']);
    const idx = data.workers.map((w: any) => data.stages.indexOf(w.stage));
    expect(idx).toEqual([...idx].sort((a: number, b: number) => a - b));
    expect(idx.every((i: number) => i >= 0)).toBe(true);
  });

  test('워커마다 stage·summary·model·effort·tools·maxTurns·isolation·원본 파일이 머리말과 같다', () => {
    let checked = 0;
    for (const w of data.workers) {
      const fm = frontmatter(path.join(KIT_REPO, w.file));
      expect(w.file).toBe(`kit/workers/${fm.name}.md`);
      expect(w.name).toBe(fm.name);
      expect(w.stage).toBe(fm.stage);
      expect(w.summary).toBe(fm.summary);
      expect(w.model).toBe(fm.model);
      expect(w.effort).toBe(fm.effort);
      expect(w.tools).toBe(String(fm.tools));
      expect(w.maxTurns).toBe(fm.maxTurns);
      expect(w.isolation).toBe(fm.isolation ?? null);
      expect(w.description).not.toContain('{{');
      checked++;
    }
    expect(checked).toBe(27);
  });

  test('쓰는 모드: modes/*.yaml 슬롯과 fallback, tables/check.yaml에서 거꾸로 계산', () => {
    const by = Object.fromEntries(data.workers.map((w: any) => [w.name, w.modes.map((m: any) => (m.fallback ? `${m.mode}(대체)` : m.mode))]));
    expect(by['su-builder']).toEqual(['최대', '극한(대체)']);
    expect(by['su-builder-fable']).toEqual(['극한']);
    expect(by['checker-test']).toContain('/check');
    // 손으로 센 기대값이 아니라 yaml에서 다시 센다
    const fable = yaml.load(fs.readFileSync(path.join(KIT_REPO, 'kit', 'modes', 'fable.yaml'), 'utf8'));
    for (const s of fable.slots) expect(by[s.worker]).toContain('극한');
    for (const f of fable.fallback) expect(by[f]).toContain('극한(대체)');
  });

  test('isolation 칸이 있는 워커는 su-builder·su-builder-fable 둘뿐', () => {
    expect(data.workers.filter((w: any) => w.isolation).map((w: any) => w.name).sort()).toEqual(['su-builder', 'su-builder-fable']);
  });
});

test('kit 레포가 없으면 워커 대신 이유를 돌려준다', async () => {
  const srv = await inProcess({ cfgDir: path.join(tmpDir(), 'cfg') });
  const r = (await srv.call('GET', '/api/kit/workers')).body;
  expect(r).toMatchObject({ ok: false, message: 'kit 레포 경로가 지정되지 않았다' });
  const bad = await srv.call('PUT', '/api/settings', { kitRepoPath: tmpDir() });
  expect(bad.status).toBe(400);
  expect(bad.body.error).toMatch(/kit\/kit\.yaml이 없다/);
  expect((await srv.call('GET', '/api/settings')).body.kitRepoPath).toBeNull();
  await srv.close();
});
