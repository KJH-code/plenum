// 작업 폴더 비교 키. 세션 기록의 cwd·훅의 cwd·프로젝트 경로를 같은 규칙으로 맞춰 비교한다.
// 폴더 이름(~/.claude/projects/<인코딩>)으로 대조하지 않는다 — 한글이 글자 수만큼 '-'가 돼서 다른 폴더끼리 겹친다(노트북 2.1.248 확인).
import path from 'node:path';

export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const lib = platform === 'win32' ? path.win32 : path.posix;
  let k = lib.normalize(p.normalize('NFC'));
  if (k.length > 1 && (k.endsWith('/') || k.endsWith('\\'))) k = k.replace(/[\\/]+$/, '');
  if (platform === 'win32') k = k.replace(/\//g, '\\').toLowerCase();
  if (platform === 'win32' && /^[a-z]:$/.test(k)) k += '\\';
  return k;
}

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}
