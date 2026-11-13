// PATH 의 claude 가 무엇을 지원하는지. 노트북 2.1.248 에 --effort 가 없을 수 있다 → 없으면 화면이 노력도 칸을 숨긴다.
// --version·--help 를 셸 없이 돌린다(각 15초). 결과는 (찾은 경로 + 버전) 키로 캐시한다 — 업데이트하면 버전이 바뀌어 다시 본다.
import { commandFor, resolveCommand, runCommand } from './open.ts';

export interface ClaudeCaps { found: boolean; version: string | null; effort: boolean }

const cache = new Map<string, ClaudeCaps>();
const TIMEOUT_MS = 15000;

export async function claudeCaps(env: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<ClaudeCaps> {
  const resolved = resolveCommand('claude', env, platform);
  if (!resolved) return { found: false, version: null, effort: false };
  let v, h;
  try {
    v = await runCommand(commandFor(resolved, ['--version'], platform), { env, timeoutMs: TIMEOUT_MS });
  } catch { return { found: true, version: null, effort: false }; }
  const version = /(\d+\.\d+\.\d+)/.exec(v.output)?.[1] ?? null;
  const key = `${resolved}\0${version ?? ''}`;
  const hit = cache.get(key);
  if (hit) return { ...hit };
  try {
    h = await runCommand(commandFor(resolved, ['--help'], platform), { env, timeoutMs: TIMEOUT_MS });
  } catch { return { found: true, version, effort: false }; }
  const caps: ClaudeCaps = { found: true, version, effort: /(^|\s)--effort\b/m.test(h.output) };
  // 실패(시간 초과·오류)는 캐시하지 않는다 — 다음에 다시 본다
  if (version && h.code === 0 && !h.timedOut) cache.set(key, caps);
  return { ...caps };
}
