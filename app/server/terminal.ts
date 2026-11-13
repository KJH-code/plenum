// 외부 터미널에서 `claude --resume <세션>`. 명령 만들기만 한다(실행은 라우트가 launcher 로).
// Windows: Windows Terminal(wt)이 있으면 셸 없이 인자 배열로, 없으면 cmd.exe start 한 줄(verbatim).
// mac·Linux: 자동으로 열지 않는다 — 화면이 두 줄(cd, claude --resume)을 복사하게 한다.
import path from 'node:path';
import { resolveCommand, type Command } from './open.ts';

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// cmd 가 해석하는 문자 — open.ts editorCommand·commandFor 와 같은 검사
const CMD_UNSAFE = /["%\r\n]/;

export interface TerminalCommand { display: string[]; command: Command | null; via: 'wt' | 'cmd' | 'manual' }
export interface TerminalInput {
  cwd: string;
  sessionId: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isFile?: (f: string) => boolean;
}

export function terminalCommand({ cwd, sessionId, platform = process.platform, env = process.env, isFile }: TerminalInput): TerminalCommand {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new Error(`세션 ID 모양이 아니다: ${String(sessionId)}`);
  // win32: path.win32.isAbsolute('\\a') 는 true 지만 드라이브가 없다 → 드라이브 문자나 UNC 만
  const abs = typeof cwd === 'string' && (platform === 'win32' ? /^([A-Za-z]:[\\/]|\\\\[^\\])/.test(cwd) : path.posix.isAbsolute(cwd));
  if (typeof cwd !== 'string' || !cwd || !abs) throw new Error(`작업 폴더가 절대 경로가 아니다: ${String(cwd)}`);
  const resume = `claude --resume ${sessionId}`;

  if (platform === 'win32') {
    // PowerShell: 작은따옴표 안은 $·백틱을 펼치지 않는다. 작은따옴표 자체는 두 번
    const display = [`cd -LiteralPath '${cwd.replace(/'/g, "''")}'`, resume];
    // wt 는 ; 를 명령 구분자로 읽는다 → ; 가 든 폴더는 cmd 로
    const wt = cwd.includes(';') ? null : resolveCommand('wt', env, 'win32', isFile);
    if (wt) return { display, via: 'wt', command: { cmd: wt, args: ['-d', cwd, 'powershell', '-NoExit', '-Command', resume] } };
    if (CMD_UNSAFE.test(cwd)) throw new Error(`경로에 cmd가 해석하는 문자(" % 줄바꿈)가 있어서 터미널을 열 수 없다: ${cwd}`);
    // /s 는 맨 앞·맨 뒤 따옴표 한 쌍만 벗긴다. start 의 첫 따옴표 인자는 창 제목("")
    const line = `start "" /D "${cwd}" powershell -NoExit -Command "${resume}"`;
    return { display, via: 'cmd', command: { cmd: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true } };
  }
  return { display: [`cd '${cwd.replace(/'/g, `'\\''`)}'`, resume], via: 'manual', command: null };
}
