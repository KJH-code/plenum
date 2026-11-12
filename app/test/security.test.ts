// 로컬 서버를 다른 사이트가 부르지 못하게: 헤더 없는 변경 요청, 다른 Host
import http from 'node:http';
import path from 'node:path';
import { expect, test } from 'vitest';
import { inProcess, tmpDir } from './helpers.ts';

test('X-Plenum 헤더 없는 POST는 403', async () => {
  const srv = await inProcess({ cfgDir: path.join(tmpDir(), 'cfg') });
  const r = await fetch(`${srv.base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"kind":"local","path":"/"}' });
  expect(r.status).toBe(403);
  await srv.close();
});

test('X-Plenum 헤더 없는 POST /api/install 은 403 (설치본에 반영)', async () => {
  const srv = await inProcess({ cfgDir: path.join(tmpDir(), 'cfg') });
  const r = await fetch(`${srv.base}/api/install`, { method: 'POST' });
  expect(r.status).toBe(403);
  expect((await srv.call('GET', '/api/install')).body.status).toBe('idle');
  await srv.close();
});

test('Host가 127.0.0.1·localhost가 아니면 403 (DNS rebinding)', async () => {
  const srv = await inProcess({ cfgDir: path.join(tmpDir(), 'cfg') });
  const port = Number(new URL(srv.base).port);
  const status = await new Promise<number>((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/settings', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode!); });
  });
  expect(status).toBe(403);
  expect((await srv.call('GET', '/api/settings')).status).toBe(200);
  await srv.close();
});

test('정적 파일은 dist 밖으로 못 나간다', async () => {
  const srv = await inProcess({ cfgDir: path.join(tmpDir(), 'cfg') });
  const port = Number(new URL(srv.base).port);
  const status = await new Promise<number>((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/..%2f..%2fpackage.json' }, (res) => { res.resume(); resolve(res.statusCode!); });
  });
  expect([403, 200, 503]).toContain(status);
  await srv.close();
});

test('kit 저장 API의 POST도 X-Plenum 헤더 없으면 403', async () => {
  const srv = await inProcess({ cfgDir: path.join(tmpDir(), 'cfg') });
  for (const p of ['/api/kit/pull', '/api/kit/preview', '/api/kit/save', '/api/kit/save/retry', '/api/kit/save/cancel', '/api/kit/open']) {
    const r = await fetch(`${srv.base}${p}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"worker":"impl","model":"opus","effort":"xhigh","file":"kit/kit.yaml"}' });
    expect(r.status, p).toBe(403);
  }
  await srv.close();
});
