// 폴더 열기·외부 에디터. 명령 만들기와 실행을 나눠서 명령 모양을 테스트한다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface Command { cmd: string; args: string[]; verbatim?: boolean }
export type LaunchResult = { ok: true } | { ok: false; message: string };

export function folderCommand(dir: string, platform = process.platform): Command {
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [dir] };
  if (platform === 'darwin') return { cmd: 'open', args: [dir] };
  return { cmd: 'xdg-open', args: [dir] };
}

// 에디터 명령을 PATH(+Windows PATHEXT)에서 절대 경로로 찾는다. 이미 경로면 그대로.
// 이유: Windows cmd는 배치 파일을 따옴표 붙은 이름("code")으로 PATH에서 찾아 부르면 그 안의 %~dp0 가
// 배치 파일 폴더가 아니라 현재 폴더가 된다. code.cmd 는 "%~dp0..\Code.exe" 를 부르므로 엉뚱한 곳을 찾고 9009로 끝난다.
// 절대 경로로 부르면 %~dp0 가 맞게 잡힌다.
const isFileOnDisk = (f: string) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

export function resolveCommand(name: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform, isFile = isFileOnDisk): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (name.includes('/') || (platform === 'win32' && name.includes('\\'))) return isFile(name) ? name : null;
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32'
    ? (p.extname(name) ? [''] : (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()))
    : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const full = p.join(d.replace(/^"|"$/g, ''), name + e);
      if (isFile(full)) return full;
    }
  }
  return null;
}

// Windows: .cmd·.bat 는 셸 없이 못 부른다 → cmd.exe /d /s /c "<한 줄>". /s 는 맨 앞·맨 뒤 따옴표 한 쌍만 벗긴다.
// verbatim(windowsVerbatimArguments)이 없으면 Node가 안쪽 따옴표를 \" 로 바꿔서 cmd가 이상한 줄을 받는다.
// .exe 는 cmd 없이 바로 부른다. Windows 경로엔 " 가 못 들어가서 따옴표로 감싸면 공백·한글이 안전하다. % 는 cmd가 변수로 펼쳐서 거부.
export function editorCommand(editor: string, dir: string, platform = process.platform, env: NodeJS.ProcessEnv = process.env, isFile = isFileOnDisk): Command {
  const resolved = resolveCommand(editor, env, platform, isFile);
  if (!resolved) throw new Error(`에디터 명령 "${editor}"를 PATH에서 못 찾았다. 설정 › 일반에 전체 경로(예: VS Code의 bin\\code.cmd)를 넣을 수 있다`);
  if (platform === 'win32') {
    for (const [what, s] of [['경로', dir], ['에디터 명령', resolved]] as const) {
      if (/["%\r\n]/.test(s)) throw new Error(`${what}에 cmd가 해석하는 문자(" % 줄바꿈)가 있어서 열 수 없다: ${s}`);
    }
    if (/\.(cmd|bat)$/i.test(resolved)) return { cmd: 'cmd.exe', args: ['/d', '/s', '/c', `""${resolved}" "${dir}""`], verbatim: true };
    return { cmd: resolved, args: [dir] };
  }
  return { cmd: resolved, args: [dir] };
}

// cmd·Windows 프로그램의 출력은 콘솔 코드페이지(한국어 Windows는 CP949)라 UTF-8로 읽으면 깨진다.
// UTF-8로 읽어 보고 틀리면 euc-kr(WHATWG에선 windows-949와 같음)로 읽는다.
export function decodeOutput(buf: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* UTF-8 아님 */ }
  try { return new TextDecoder('euc-kr').decode(buf); } catch { return buf.toString('latin1'); }
}

// 폴더 열기: 탐색기는 성공해도 종료 코드 1을 내는 경우가 있어서 종료 코드를 보지 않는다. 실행 자체가 안 되면 실패.
export function launchDetached(c: Command): Promise<LaunchResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: !!c.verbatim });
    } catch (e: any) {
      resolve({ ok: false, message: e.message });
      return;
    }
    child.once('error', (e) => resolve({ ok: false, message: `${c.cmd} 실행 실패: ${e.message}` }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true }); });
  });
}

// 에디터: 명령이 끝날 때까지(최대 waitMs) 기다려 종료 코드·stderr로 실패를 잡는다.
// VS Code의 code 는 창을 넘겨주고 바로 끝난다. waitMs 안에 안 끝나면(창을 붙잡는 에디터) 떠 있는 것으로 보고 성공.
export function launchAndWait(c: Command, waitMs = 15000): Promise<LaunchResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(c.cmd, c.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: !!c.verbatim });
    } catch (e: any) {
      resolve({ ok: false, message: e.message });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const take = (d: Buffer) => { if (size < 8000) { chunks.push(d); size += d.length; } };
    child.stdout!.on('data', take);
    child.stderr!.on('data', take);
    let done = false;
    const finish = (r: LaunchResult) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => { child.stdout!.destroy(); child.stderr!.destroy(); child.unref(); finish({ ok: true }); }, waitMs);
    child.once('error', (e) => finish({ ok: false, message: `${c.cmd} 실행 실패: ${e.message}` }));
    // close: 프로세스가 끝나고 출력도 다 읽힌 뒤
    child.once('close', (code) => {
      const out = decodeOutput(Buffer.concat(chunks)).trim();
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, message: `종료 코드 ${code}${out ? ` — ${out.split(/\r?\n/).slice(-3).join(' / ')}` : ''}` });
    });
  });
}

// 예전 이름 (테스트·서버가 주입하는 실행기 타입)
export type Launcher = (c: Command, kind: 'folder' | 'editor') => Promise<LaunchResult>;
export const launch: Launcher = (c, kind) => (kind === 'editor' ? launchAndWait(c) : launchDetached(c));
