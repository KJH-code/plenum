// 폴더 열기·외부 에디터. 실제 실행과 명령 만들기를 나눠서 명령 모양을 테스트한다.
import { spawn } from 'node:child_process';

export interface Command { cmd: string; args: string[]; verbatim?: boolean }

export function folderCommand(dir: string, platform = process.platform): Command {
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [dir] };
  if (platform === 'darwin') return { cmd: 'open', args: [dir] };
  return { cmd: 'xdg-open', args: [dir] };
}

// Windows의 `code`는 code.cmd(배치 파일)라 셸 없이 못 부른다 → cmd.exe /c 에 따옴표로 감싼 한 줄을 그대로 넘긴다.
// Windows 경로에는 " 가 들어갈 수 없어서 따옴표로 감싸면 공백·한글이 안전하다.
export function editorCommand(editor: string, dir: string, platform = process.platform): Command {
  if (platform === 'win32') {
    if (dir.includes('"') || editor.includes('"')) throw new Error('경로나 에디터 명령에 " 가 있다');
    return { cmd: 'cmd.exe', args: ['/d', '/s', '/c', `""${editor}" "${dir}""`], verbatim: true };
  }
  return { cmd: editor, args: [dir] };
}

export function launch(c: Command): Promise<{ ok: true } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(c.cmd, c.args, { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: !!c.verbatim });
    } catch (e: any) {
      resolve({ ok: false, message: e.message });
      return;
    }
    child.once('error', (e) => resolve({ ok: false, message: `${c.cmd} 실행 실패: ${e.message}` }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true }); });
  });
}
