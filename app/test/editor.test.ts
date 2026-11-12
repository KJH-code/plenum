// 버그 6: 외부 에디터를 실제로 띄운다.
// 가짜 에디터는 진짜 VS Code의 code.cmd 와 같은 구조다: PATH에 있는 bin\<이름>.cmd 가 %~dp0..\<실제 프로그램> 을 부른다.
// 실제 프로그램은 받은 첫 인자(폴더) 안에 opened.txt 를 만든다. 경로가 깨지거나 %~dp0 가 틀리면 파일이 안 생긴다.
// Linux·mac은 같은 구조를 sh로 ($(dirname "$0")/../real-editor).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { decodeOutput, editorCommand, launchAndWait, resolveCommand } from '../server/open.ts';
import { tmpDir } from './helpers.ts';

const WIN = process.platform === 'win32';
const NAME = 'plenumfakecode';
let target: string, marker: string, binDir: string, failing: string;
const oldPath = process.env.PATH;

beforeAll(() => {
  const root = path.join(tmpDir(), '홍길동 에디터');
  binDir = path.join(root, 'Fake Code', 'bin');
  target = path.join(root, '영상 편집 (2)');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  marker = path.join(target, 'opened.txt');
  if (WIN) {
    fs.writeFileSync(path.join(binDir, `${NAME}.cmd`), '@echo off\r\ncall "%~dp0..\\real-editor.cmd" %*\r\nexit /b %errorlevel%\r\n');
    fs.writeFileSync(path.join(root, 'Fake Code', 'real-editor.cmd'), '@echo off\r\ntype nul > "%~1\\opened.txt"\r\nexit /b 0\r\n');
    failing = path.join(binDir, 'fail editor.cmd');
    fs.writeFileSync(failing, '@echo off\r\necho editor broken 1>&2\r\nexit /b 3\r\n');
  } else {
    fs.writeFileSync(path.join(binDir, NAME), '#!/bin/sh\nexec "$(dirname "$0")/../real-editor" "$@"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'Fake Code', 'real-editor'), '#!/bin/sh\n: > "$1/opened.txt"\n', { mode: 0o755 });
    failing = path.join(binDir, 'fail editor');
    fs.writeFileSync(failing, '#!/bin/sh\necho "editor broken" >&2\nexit 3\n', { mode: 0o755 });
  }
  process.env.PATH = `${binDir}${path.delimiter}${oldPath}`;
});
afterAll(() => { process.env.PATH = oldPath; });
beforeEach(() => fs.rmSync(marker, { force: true }));

describe('외부 에디터 실행', () => {
  test('이름만 주면 PATH에서 절대 경로를 찾는다', () => {
    const found = resolveCommand(NAME);
    expect(found).toBe(path.join(binDir, WIN ? `${NAME}.cmd` : NAME));
  });

  test('PATH의 에디터를 이름으로: 한글·공백·괄호 경로가 그대로 가고 %~dp0 구조도 동작', async () => {
    const r = await launchAndWait(editorCommand(NAME, target));
    expect(r).toEqual({ ok: true });
    expect(fs.existsSync(marker)).toBe(true);
  });

  // 0.1.1 방식 재현: 배치 파일을 따옴표 붙은 이름("plenumfakecode")으로 PATH에서 찾게 하면 %~dp0 가 현재 폴더가 된다
  test.runIf(WIN)('재현: 0.1.1 방식(따옴표 붙은 이름)은 %~dp0 가 현재 폴더가 되어 실패한다', async () => {
    const r = await launchAndWait({ cmd: 'cmd.exe', args: ['/d', '/s', '/c', `""${NAME}" "${target}""`], verbatim: true });
    expect(r.ok).toBe(false);
    // %~dp0 가 배치 파일 폴더가 아니라 현재 폴더(process.cwd())로 잡힌 흔적: "<cwd>\..\real-editor.cmd" 를 찾다 실패
    // (진짜 code.cmd 는 Code.exe 를 바로 불러 9009, 이 가짜는 call 을 거쳐 1)
    if (!r.ok) expect(r.message).toContain(`${process.cwd()}\\..\\real-editor.cmd`);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test.runIf(WIN)('대조군: verbatim 없이 넘기면 경로가 깨진다', async () => {
    await launchAndWait({ ...editorCommand(NAME, target), verbatim: false });
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('종료 코드가 0이 아니면 실패와 stderr를 돌려준다', async () => {
    const r = await launchAndWait(editorCommand(failing, target));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/종료 코드 3/);
      expect(r.message).toContain('editor broken');
    }
  });

  test('PATH에 없는 명령은 실행 전에 이유와 함께 거부', () => {
    expect(() => editorCommand('plenum-no-such-editor-xyz', target)).toThrow(/PATH에서 못 찾았다/);
  });
});

test('CP949(한국어 Windows 콘솔) 출력도 읽는다', () => {
  const cp949 = Buffer.from('b3bbbace20b6c7b4c220bfdcbace20b8edb7c9', 'hex'); // '내부 또는 외부 명령'
  expect(decodeOutput(cp949)).toBe('내부 또는 외부 명령');
  expect(decodeOutput(Buffer.from('한글 UTF-8', 'utf8'))).toBe('한글 UTF-8');
});
