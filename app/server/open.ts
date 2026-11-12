// 폴더 열기·외부 에디터. 명령 만들기와 실행을 나눠서 명령 모양을 테스트한다.
import { spawn } from 'node:child_process';

export interface Command { cmd: string; args: string[]; verbatim?: boolean }
export type LaunchResult = { ok: true } | { ok: false; message: string };

export function folderCommand(dir: string, platform = process.platform): Command {
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [dir] };
  if (platform === 'darwin') return { cmd: 'open', args: [dir] };
  return { cmd: 'xdg-open', args: [dir] };
}

// Windows의 `code`는 code.cmd(배치 파일)라 셸 없이 못 부른다 → cmd.exe /d /s /c "<한 줄>".
// /s 는 /c 뒤 문자열의 맨 앞·맨 뒤 따옴표 한 쌍만 벗기고 나머지는 그대로 실행한다: ""code" "C:\경로""  →  "code" "C:\경로"
// verbatim(windowsVerbatimArguments)이 없으면 Node가 안쪽 따옴표를 \" 로 바꿔서 cmd가 이상한 줄을 받는다.
// Windows 경로에는 " 가 들어갈 수 없어서 따옴표로 감싸면 공백·한글이 안전하다. % 는 cmd가 변수로 펼치므로 거부한다.
export function editorCommand(editor: string, dir: string, platform = process.platform): Command {
  if (platform === 'win32') {
    for (const [what, s] of [['경로', dir], ['에디터 명령', editor]] as const) {
      if (/["%\r\n]/.test(s)) throw new Error(`${what}에 cmd가 해석하는 문자(" % 줄바꿈)가 있어서 열 수 없다: ${s}`);
    }
    return { cmd: 'cmd.exe', args: ['/d', '/s', '/c', `""${editor}" "${dir}""`], verbatim: true };
  }
  return { cmd: editor, args: [dir] };
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
    let out = '';
    child.stdout!.on('data', (d) => { if (out.length < 4000) out += d; });
    child.stderr!.on('data', (d) => { if (out.length < 4000) out += d; });
    let done = false;
    const finish = (r: LaunchResult) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => { child.stdout!.destroy(); child.stderr!.destroy(); child.unref(); finish({ ok: true }); }, waitMs);
    child.once('error', (e) => finish({ ok: false, message: `${c.cmd} 실행 실패: ${e.message}` }));
    child.once('exit', (code) => {
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, message: `종료 코드 ${code}${out.trim() ? ` — ${out.trim().split(/\r?\n/).slice(-3).join(' / ')}` : ''}` });
    });
  });
}

// 예전 이름 (테스트·서버가 주입하는 실행기 타입)
export type Launcher = (c: Command, kind: 'folder' | 'editor') => Promise<LaunchResult>;
export const launch: Launcher = (c, kind) => (kind === 'editor' ? launchAndWait(c) : launchDetached(c));
