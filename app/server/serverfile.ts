// 포트 파일: <설정 폴더>/server.json = { port, pid, startedAt }. 훅 스크립트가 이 파일에서 지금 뜬 서버의 포트를 읽는다(포트를 고정하지 않는다).
// 임시 파일에 쓰고 rename 한다. 지울 때는 파일의 pid 가 내 pid 일 때만 — 나중에 뜬 다른 서버의 파일을 지우지 않는다.
import fs from 'node:fs';
import path from 'node:path';

export interface ServerFile { port: number; pid: number; startedAt: number }

export function serverFilePath(cfgDir: string): string { return path.join(cfgDir, 'server.json'); }

export function writeServerFile(cfgDir: string, port: number): ServerFile {
  const value: ServerFile = { port, pid: process.pid, startedAt: Date.now() };
  fs.mkdirSync(cfgDir, { recursive: true });
  const tmp = path.join(cfgDir, `server.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, serverFilePath(cfgDir));
  return value;
}

export function readServerFile(cfgDir: string): ServerFile | null {
  try {
    const v = JSON.parse(fs.readFileSync(serverFilePath(cfgDir), 'utf8'));
    return v && typeof v.port === 'number' && typeof v.pid === 'number' ? v : null;
  } catch { return null; }
}

// 내가 쓴 파일이면 지우고 true. 없거나 남의 것이면 그대로 두고 false. exit 처리 안에서 불리므로 던지지 않는다.
export function removeServerFile(cfgDir: string): boolean {
  const v = readServerFile(cfgDir);
  if (!v || v.pid !== process.pid) return false;
  try { fs.rmSync(serverFilePath(cfgDir), { force: true }); return true; } catch { return false; }
}
