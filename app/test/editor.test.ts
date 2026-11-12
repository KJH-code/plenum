// 버그 6: 에디터를 실제로 띄워 인자(한글·공백·괄호 경로)가 그대로 가는지, 실패(종료 코드·stderr)를 잡는지.
// 가짜 에디터는 받은 첫 인자(폴더) 안에 opened.txt 를 만든다. 경로가 깨져서 오면 그 폴더에 파일이 안 생긴다.
// Windows에서는 .cmd(배치 파일) — 실제 code.cmd 와 같은 길(cmd.exe /d /s /c). 한글은 배치 파일 글자를 거치지 않고 인자로만 간다.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { editorCommand, launchAndWait } from '../server/open.ts';
import { tmpDir } from './helpers.ts';

const WIN = process.platform === 'win32';
let target: string, marker: string, editor: string, failing: string;

beforeAll(() => {
  const dir = path.join(tmpDir(), '홍길동 에디터');
  target = path.join(dir, '영상 편집 (2)');
  fs.mkdirSync(target, { recursive: true });
  marker = path.join(target, 'opened.txt');
  if (WIN) {
    editor = path.join(dir, 'fake editor.cmd');
    fs.writeFileSync(editor, '@echo off\r\ntype nul > "%~1\\opened.txt"\r\nexit /b 0\r\n');
    failing = path.join(dir, 'fail editor.cmd');
    fs.writeFileSync(failing, '@echo off\r\necho editor broken 1>&2\r\nexit /b 3\r\n');
  } else {
    editor = path.join(dir, 'fake editor.sh');
    fs.writeFileSync(editor, '#!/bin/sh\n: > "$1/opened.txt"\n', { mode: 0o755 });
    failing = path.join(dir, 'fail editor.sh');
    fs.writeFileSync(failing, '#!/bin/sh\necho "editor broken" >&2\nexit 3\n', { mode: 0o755 });
  }
});
beforeEach(() => fs.rmSync(marker, { force: true }));

describe('외부 에디터 실행', () => {
  test('한글·공백·괄호 경로가 인자 하나로 그대로 간다', async () => {
    const r = await launchAndWait(editorCommand(editor, target));
    expect(r).toEqual({ ok: true });
    expect(fs.existsSync(marker)).toBe(true);
  });

  test('종료 코드가 0이 아니면 실패와 stderr를 돌려준다 ("열었다"라고 하지 않는다)', async () => {
    const r = await launchAndWait(editorCommand(failing, target));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/종료 코드 3/);
      expect(r.message).toContain('editor broken');
    }
  });

  test('없는 명령도 실패로 잡는다', async () => {
    const r = await launchAndWait(editorCommand('plenum-no-such-editor-xyz', target));
    expect(r.ok).toBe(false);
  });

  // 재혁 가설 확인용 대조군: verbatim(windowsVerbatimArguments) 없이 같은 인자를 넘기면 Node가 안쪽 따옴표를 \" 로 바꿔서 경로가 깨진다
  test.runIf(WIN)('Windows 대조군: verbatim 없이 넘기면 폴더에 파일이 안 생긴다', async () => {
    await launchAndWait({ ...editorCommand(editor, target), verbatim: false });
    expect(fs.existsSync(marker)).toBe(false);
  });
});
