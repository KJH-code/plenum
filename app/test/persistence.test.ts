// V5: 프로젝트를 추가하고 서버 프로세스를 껐다 켜도 같은 목록이 나온다
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { spawnServer, tmpDir } from './helpers.ts';

const H = { 'Content-Type': 'application/json', 'X-Plenum': '1' };

describe('다시 켜도 유지', () => {
  test('추가 → 종료 → 재시작 → 같은 목록, config.json에 저장됨', async () => {
    const root = tmpDir();
    const cfgDir = path.join(root, 'cfg');
    const a = path.join(root, '홍길동 테스트', '영상 편집');
    const b = path.join(root, 'second');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b);
    const env = { PLENUM_CONFIG_DIR: cfgDir, PLENUM_PORT: '0' };

    const s1 = await spawnServer(env);
    for (const p of [a, b]) {
      const r = await fetch(`${s1.base}/api/projects`, { method: 'POST', headers: H, body: JSON.stringify({ kind: 'local', path: p }) });
      expect(r.status).toBe(201);
    }
    const before = await (await fetch(`${s1.base}/api/projects`)).json();
    await s1.stop();

    expect(fs.existsSync(path.join(cfgDir, 'config.json'))).toBe(true);
    const s2 = await spawnServer(env);
    const after = await (await fetch(`${s2.base}/api/projects`)).json();
    await s2.stop();

    expect(after.map((p: any) => [p.id, p.name, p.path])).toEqual(before.map((p: any) => [p.id, p.name, p.path]));
    expect(after.map((p: any) => p.name)).toEqual(['영상 편집', 'second']);
    expect(after[0].path).toBe(a);
  });
});
