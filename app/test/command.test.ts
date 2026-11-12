// 명령 만들기(commandFor·editorCommand의 줄 열기)와 runCommand. 실제 실행은 node 로만 한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandFor, editorCommand, isVsCode, runCommand } from '../server/open.ts';

const yes = () => true;

describe('commandFor', () => {
  it('Windows .cmd 는 cmd.exe /d /s /c 로 인자마다 따옴표', () => {
    const c = commandFor('C:\\Users\\홍길동\\bin\\npm.cmd', ['version', 'patch', '--no-git-tag-version'], 'win32');
    expect(c).toEqual({ cmd: 'cmd.exe', args: ['/d', '/s', '/c', '""C:\\Users\\홍길동\\bin\\npm.cmd" "version" "patch" "--no-git-tag-version""'], verbatim: true });
  });
  it('Windows .exe·POSIX 는 그대로', () => {
    expect(commandFor('C:\\a\\claude.exe', ['plugin', 'update', 'jh-kit@kjh-code'], 'win32')).toEqual({ cmd: 'C:\\a\\claude.exe', args: ['plugin', 'update', 'jh-kit@kjh-code'] });
    expect(commandFor('/usr/bin/claude', ['plugin'], 'linux')).toEqual({ cmd: '/usr/bin/claude', args: ['plugin'] });
  });
  it('.cmd 인자에 " % 가 있으면 거부', () => {
    expect(() => commandFor('C:\\a\\x.cmd', ['50%'], 'win32')).toThrow(/cmd가 해석하는 문자/);
  });
});

describe('editorCommand 줄 열기', () => {
  it('code 면 -g 파일:줄', () => {
    expect(editorCommand('/opt/code', '/r/kit/kit.yaml', 'linux', {}, yes, 12)).toEqual({ cmd: '/opt/code', args: ['-g', '/r/kit/kit.yaml:12'] });
    expect(editorCommand('C:\\VS\\bin\\code.cmd', 'C:\\r\\kit\\kit.yaml', 'win32', {}, yes, 3).args[3]).toBe('""C:\\VS\\bin\\code.cmd" "-g" "C:\\r\\kit\\kit.yaml:3""');
  });
  it('다른 에디터는 줄을 주어도 파일만', () => {
    expect(editorCommand('/opt/subl', '/r/a.md', 'linux', {}, yes, 12)).toEqual({ cmd: '/opt/subl', args: ['/r/a.md'] });
  });
  it('isVsCode', () => {
    expect(isVsCode('code')).toBe(true);
    expect(isVsCode('C:\\x\\bin\\code.cmd')).toBe(true);
    expect(isVsCode('codium')).toBe(false);
  });
});

describe('runCommand', () => {
  it('종료 코드와 출력', async () => {
    const r = await runCommand({ cmd: process.execPath, args: ['-e', 'console.log("안녕"); console.error("err"); process.exit(3)'] });
    expect(r.code).toBe(3);
    expect(r.output).toContain('안녕');
    expect(r.output).toContain('err');
    expect(r.timedOut).toBe(false);
  });
  it('시간 넘으면 timedOut', async () => {
    const r = await runCommand({ cmd: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'] }, { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
  });
  // 감싼 셸만 죽고 손자 프로세스가 출력 파이프를 붙잡아도 시간 제한이 듣는다 (Windows .cmd = cmd.exe → node 와 같은 꼴)
  it('손자 프로세스가 남아도 시간 제한 안에 끝난다', async () => {
    const forever = `"${process.execPath}" -e "setTimeout(() => {}, 60000)"`;
    let c;
    if (process.platform === 'win32') {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), '홍길동 hang-'));
      const cmdFile = path.join(dir, 'hang.cmd');
      fs.writeFileSync(cmdFile, `@${forever}\r\n`);
      c = commandFor(cmdFile, []);
    } else {
      c = { cmd: '/bin/sh', args: ['-c', `${forever}; true`] };
    }
    const t0 = Date.now();
    const r = await runCommand(c, { timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10000);
  }, 20000);
  it('없는 프로그램은 error', async () => {
    const r = await runCommand({ cmd: '/no/such/prog-xyz', args: [] });
    expect(r.code).toBe(null);
    expect(r.error).toMatch(/실행 실패/);
  });
});
