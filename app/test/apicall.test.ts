// 웹 api.ts call(): fetch 자체가 던지면(서버 꺼짐) ServerDownError, 서버가 답한 오류는 서버 문구 그대로.
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, call, SERVER_DOWN, ServerDownError } from '../web/src/api.ts';

afterEach(() => { vi.unstubAllGlobals(); });

it('fetch 가 던지면(브라우저마다 다른 문구) ServerDownError', async () => {
  for (const msg of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(msg); }));
    const err = await call<any>('POST', '/api/projects', { kind: 'local', path: '/a' }).catch((e: any) => e);
    expect(err).toBeInstanceOf(ServerDownError);
    expect(err.message).toBe('Plenum 서버가 꺼져 있음 — 터미널에서 다시 켜기');
    expect(err.message).toBe(SERVER_DOWN);
    expect(err.message).not.toContain(msg);
  }
});

it('500 JSON 응답은 서버 문구 그대로 (ServerDownError 아님)', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '서버 오류: 뭔가 깨졌다' }), { status: 500, headers: { 'Content-Type': 'application/json' } })));
  const err = await call<any>('GET', '/api/projects').catch((e: any) => e);
  expect(err).not.toBeInstanceOf(ServerDownError);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.message).toBe('서버 오류: 뭔가 깨졌다');
  expect(err.status).toBe(500);
});

it('JSON 이 아닌 오류 응답은 상태 코드 문구, 성공은 본문', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 502 })));
  expect((await call<any>('GET', '/x').catch((e) => e)).message).toBe('응답을 읽지 못했다 (502)');
  const f = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
  vi.stubGlobal('fetch', f);
  expect(await call<any>('POST', '/y', { a: 1 })).toEqual({ ok: 1 });
  expect((f.mock.calls[0] as any)[1].headers).toEqual({ 'Content-Type': 'application/json', 'X-Plenum': '1' });
});
