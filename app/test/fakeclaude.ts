// 가짜 claude. "설치본에 반영"(server/install.ts) 테스트와 e2e에서 쓴다.
// 진짜와 같은 방식으로 PATH 이름("claude")으로 찾게 만든다 — 절대 경로로 부르면 Windows .cmd 의 %~dp0 함정을 못 잡는다.
// 받은 인자를 FAKE_CLAUDE_LOG 파일에 한 줄(JSON 배열)씩 적고, FAKE_CLAUDE_MODE 에 따라 움직인다:
//   ok          marketplace update → 성공. plugin update → installed_plugins.json 을 FAKE_CLAUDE_VERSION 으로 바꾼다
//   stale       둘 다 종료 0, plugin update 는 "already at the latest version (옛 버전)"만 내고 아무것도 안 바꾼다
//   fail-market marketplace update 가 한글 오류 메시지와 종료 1
//   hang        marketplace update 가 FAKE_CLAUDE_HANG_MS(기본 4000) 동안 멈췄다가 ok 처럼 움직인다
// CLAUDE_CONFIG_DIR 이 없으면 종료 2 (실제 ~/.claude 를 건드리지 않게).
// 형태: posix(sh 스크립트), cmd(Windows npm 설치 claude.cmd 와 같은 bin\claude.cmd → %~dp0..\real-claude.cmd), exe(node 복사본 claude[.exe]).
import fs from 'node:fs';
import path from 'node:path';

export type FakeMode = 'ok' | 'stale' | 'fail-market' | 'hang';
export type FakeForm = 'posix' | 'cmd' | 'exe';

export const defaultForm = (): FakeForm => (process.platform === 'win32' ? 'cmd' : 'posix');

// 가짜 동작 스크립트 (CommonJS — exe 형태에선 확장자 없는 "plugin" 파일로 읽히므로)
const SCRIPT = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
// exe 형태: node 복사본 claude 가 첫 인자 "plugin" 을 스크립트 파일로 읽는다 → 그 이름을 인자로 되돌린다
const args = path.basename(process.argv[1]) === 'plugin' ? ['plugin', ...process.argv.slice(2)] : process.argv.slice(2);
const env = process.env;
if (env.FAKE_CLAUDE_LOG) fs.appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify(args) + '\n');
const home = env.CLAUDE_CONFIG_DIR;
if (!home) { console.error('fake claude: CLAUDE_CONFIG_DIR 이 없다'); process.exit(2); }
const mode = env.FAKE_CLAUDE_MODE || 'ok';
const file = path.join(home, 'plugins', 'installed_plugins.json');
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { version: 2, plugins: {} }; } };
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(src, e.name), path.join(dest, e.name));
    else if (e.isFile()) fs.copyFileSync(path.join(src, e.name), path.join(dest, e.name));
  }
}
function market() {
  console.log('Updating marketplace: ' + args[3] + '...');
  console.log('Successfully updated marketplace: ' + args[3]);
  process.exit(0);
}
function update() {
  const id = args[2];
  const name = id.split('@')[0];
  const data = read();
  const list = (data.plugins && data.plugins[id]) || [];
  const old = list.length ? String(list[0].version) : 'none';
  if (mode === 'stale') { console.log('Plugin "' + name + '" is already at the latest version (' + old + ').'); process.exit(0); }
  const version = env.FAKE_CLAUDE_VERSION;
  if (!version) { console.error('fake claude: FAKE_CLAUDE_VERSION 이 없다'); process.exit(2); }
  const installPath = path.join(home, 'plugins', 'cache', id.split('@')[1], name, version);
  const build = path.join(process.cwd(), 'build', 'claude-code');
  if (fs.existsSync(build)) copyDir(build, installPath);
  else { fs.mkdirSync(installPath, { recursive: true }); fs.writeFileSync(path.join(installPath, 'plugin.json'), JSON.stringify({ name, version })); }
  data.plugins = data.plugins || {};
  data.plugins[id] = [{ scope: 'user', installPath, version, installedAt: 'x', lastUpdated: 'x', gitCommitSha: 'x' }];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log('Plugin "' + name + '" updated from ' + old + ' to ' + version + ' for scope user. Restart to apply changes.');
  process.exit(0);
}
const a = args.join(' ');
if (/^plugin marketplace update \S+$/.test(a)) {
  if (mode === 'fail-market') { console.error('마켓플레이스를 갱신하지 못했다: 저장소 "' + args[3] + '"에 연결할 수 없음'); process.exit(1); }
  if (mode === 'hang') setTimeout(market, Number(env.FAKE_CLAUDE_HANG_MS || 4000));
  else market();
} else if (/^plugin update \S+@\S+$/.test(a)) update();
else { console.error('fake claude: 모르는 명령: ' + a); process.exit(64); }
`;

export interface FakeClaude {
  form: FakeForm;
  binDir: string;      // PATH에 넣을 폴더
  claudePath: string;  // resolveCommand('claude') 가 찾아야 하는 경로
  logFile: string;
  // 진짜 claude 가 섞이지 않게 PATH 를 binDir(+Windows는 cmd.exe 가 있는 System32)만으로 만든 env
  env(o: { mode: FakeMode; configDir: string; version?: string; hangMs?: number }): NodeJS.ProcessEnv;
  calls(): string[][];
}

// dir 아래에 가짜를 만든다. exe 형태는 kitRepo(=runInstall 의 cwd)에 "plugin" 파일을 둔다.
export function makeFakeClaude(dir: string, form: FakeForm = defaultForm(), opts: { kitRepo?: string } = {}): FakeClaude {
  const win = process.platform === 'win32';
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'calls.log');
  let binDir: string, claudePath: string;
  if (form === 'posix') {
    if (win) throw new Error('posix 가짜는 Windows에서 못 쓴다');
    binDir = path.join(dir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const script = path.join(dir, 'fake-claude.js');
    fs.writeFileSync(script, SCRIPT);
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    claudePath = path.join(binDir, 'claude');
    // 셔뱅 #!/usr/bin/env node 대신 node 절대 경로를 박는다 (PATH 에 node 가 없어도 돈다). exec 라 시간 초과 때 node 가 바로 죽는다
    fs.writeFileSync(claudePath, `#!/bin/sh\nexec ${q(process.execPath)} ${q(script)} "$@"\n`, { mode: 0o755 });
  } else if (form === 'cmd') {
    if (!win) throw new Error('cmd 가짜는 Windows 전용');
    // npm 설치 claude.cmd 와 같은 구조: PATH 에는 bin 만, bin\claude.cmd 가 %~dp0..\ 의 실제 프로그램을 부른다
    binDir = path.join(dir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fake-claude.js'), SCRIPT);
    fs.writeFileSync(path.join(dir, 'real-claude.cmd'), `@"${process.execPath}" "%~dp0fake-claude.js" %*\r\n@exit /b %errorlevel%\r\n`);
    claudePath = path.join(binDir, 'claude.cmd');
    fs.writeFileSync(claudePath, '@"%~dp0..\\real-claude.cmd" %*\r\n');
  } else {
    // winget 설치(claude.exe)와 같은 형태: cmd 를 거치지 않는 실행 파일. node 를 claude[.exe] 로 복사한다.
    // 테스트 전용 트릭: node 는 첫 인자 "plugin" 을 스크립트 파일 이름으로 읽으므로, runInstall 이 cwd 로 쓰는
    // kit 레포에 "plugin" 이라는 이름으로 가짜 동작 스크립트를 둔다. 나머지 인자는 그 스크립트의 인자가 된다.
    if (!opts.kitRepo) throw new Error('exe 가짜는 kitRepo 가 필요하다 (cwd 에 plugin 스크립트를 둔다)');
    binDir = dir;
    claudePath = path.join(dir, win ? 'claude.exe' : 'claude');
    fs.copyFileSync(process.execPath, claudePath);
    if (!win) fs.chmodSync(claudePath, 0o755);
    fs.writeFileSync(path.join(opts.kitRepo, 'plugin'), SCRIPT);
  }
  return {
    form, binDir, claudePath, logFile,
    env: (o) => fakeEnv(win ? [binDir, path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : [binDir], {
      CLAUDE_CONFIG_DIR: o.configDir,
      FAKE_CLAUDE_MODE: o.mode,
      FAKE_CLAUDE_LOG: logFile,
      ...(o.version ? { FAKE_CLAUDE_VERSION: o.version } : {}),
      ...(o.hangMs !== undefined ? { FAKE_CLAUDE_HANG_MS: String(o.hangMs) } : {}),
    }),
    calls: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

// process.env 를 바탕으로 PATH 만 바꾼 env. Windows 는 키가 Path 일 수 있어 대소문자 무관하게 지우고 PATH 하나만 둔다
// (resolveCommand 는 env.PATH ?? env.Path 를 본다). PATHEXT·SystemRoot·ComSpec 는 그대로 남는다.
export function fakeEnv(pathDirs: string[], extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^path$/i.test(k) || /^(FAKE_CLAUDE_|CLAUDE_CONFIG_DIR$)/.test(k)) continue;
    env[k] = v;
  }
  env.PATH = pathDirs.join(path.delimiter);
  return { ...env, ...extra };
}

// 설치본 상태 만들기: installed_plugins.json 에 <plugin>@kjh-code 항목 하나 (installPath 폴더도 만든다)
export function writeInstalled(configDir: string, plugin: string, version: string): string {
  const installPath = path.join(configDir, 'plugins', 'cache', 'kjh-code', plugin, version);
  fs.mkdirSync(installPath, { recursive: true });
  fs.writeFileSync(path.join(installPath, 'plugin.json'), JSON.stringify({ name: plugin, version }));
  fs.writeFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: { [`${plugin}@kjh-code`]: [{ scope: 'user', installPath, version, installedAt: 'x', lastUpdated: 'x', gitCommitSha: 'x' }] },
  }));
  return installPath;
}
