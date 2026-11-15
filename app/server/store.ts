// 설정 폴더의 작은 JSON 파일들: sessions.json(세션 ID → 모드·버전·Plenum 시작 여부), limits.json(마지막 한도 값).
// config.json 과 같이 임시 파일에 쓰고 rename 한다. 읽다가 깨졌으면 빈 값으로 본다(앱이 멈추지 않게).
import fs from 'node:fs';
import path from 'node:path';
import type { Limits, ModeName } from './chatTypes.ts';

export interface SessionMeta { mode?: ModeName | null; version?: string | null; plenum?: boolean; projectId?: string; updatedAt?: number }

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}
function writeJson(dir: string, name: string, value: unknown) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const tmp = path.join(dir, `${name}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

export function readSessions(dir: string): Record<string, SessionMeta> {
  const v = readJson<Record<string, SessionMeta>>(path.join(dir, 'sessions.json'), {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
export function updateSession(dir: string, sessionId: string, patch: SessionMeta): SessionMeta {
  const all = readSessions(dir);
  const next = { ...all[sessionId], ...patch, updatedAt: Date.now() };
  all[sessionId] = next;
  writeJson(dir, 'sessions.json', all);
  return next;
}

export function readLimits(dir: string): Limits | null {
  const v = readJson<Limits | null>(path.join(dir, 'limits.json'), null);
  return v && typeof v === 'object' && typeof v.receivedAt === 'number' ? v : null;
}
export function saveLimits(dir: string, limits: Limits) { writeJson(dir, 'limits.json', limits); }
