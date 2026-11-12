// "설치본에 반영": claude plugin marketplace update kjh-code → claude plugin update <kit>@kjh-code, 그 뒤 설치본 버전으로 판정.
// 가짜 claude 는 PATH 이름으로 찾는다(fakeclaude.ts). CLAUDE_CONFIG_DIR·kit 레포는 모두 임시 한글 폴더.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getInstall, resetInstall, runInstall, waitInstall } from '../server/install.ts';
import { resolveCommand } from '../server/open.ts';
import { defaultForm, fakeEnv, makeFakeClaude, writeInstalled, type FakeForm } from './fakeclaude.ts';
import { APP, copyDir, inProcess, tmpDir } from './helpers.ts';

const WIN = process.platform === 'win32';
const FIXTURE_KIT = path.join(APP, '..', 'compiler', 'test', 'fixtures', 'kit'); // name: demo-kit, version: 0.0.1
const PLUGIN = 'demo-kit';
const SOURCE = '0.0.1';
const OLD = '0.0.0';

function setup(form: FakeForm = defaultForm()) {
  const root = path.join(tmpDir(), '홍길동 설치 테스트');
  const kitRepo = path.join(root, '데모 kit');
  copyDir(FIXTURE_KIT, path.join(kitRepo, 'kit'));
  fs.mkdirSync(path.join(kitRepo, 'build', 'claude-code', '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(kitRepo, 'build', 'claude-code', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN, version: SOURCE }));
  const configDir = path.join(root, '클로드 설정');
  fs.mkdirSync(path.join(configDir, 'plugins'), { recursive: true });
  writeInstalled(configDir, PLUGIN, OLD);
  const fake = makeFakeClaude(path.join(root, '가짜 claude'), form, { kitRepo });
  return { root, kitRepo, configDir, fake };
}

const installedVersion = (configDir: string) =>
  JSON.parse(fs.readFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), 'utf8')).plugins[`${PLUGIN}@kjh-code`][0].version;

async function scenarioOk(form: FakeForm) {
  const s = setup(form);
  const env = s.fake.env({ mode: 'ok', configDir: s.configDir, version: SOURCE });
  expect(resolveCommand('claude', env)).toBe(s.fake.claudePath);
  const r = await runInstall({ kitRepo: s.kitRepo, plugin: PLUGIN, sourceVersion: SOURCE, env });
  expect(r.status, r.message + JSON.stringify(r.steps)).toBe('ok');
  expect(r.message).toBe(`설치본을 ${SOURCE}으로 바꿨다`);
  expect(r.claudePath).toBe(s.fake.claudePath);
  expect(r.installedVersion).toBe(SOURCE);
  expect(r.steps.map((x) => [x.command, x.code, x.timedOut])).toEqual([
    ['claude plugin marketplace update kjh-code', 0, false],
    [`claude plugin update ${PLUGIN}@kjh-code`, 0, false],
  ]);
  expect(r.steps[1].output).toContain(`updated from ${OLD} to ${SOURCE}`);
  expect(installedVersion(s.configDir)).toBe(SOURCE);
  expect(s.fake.calls()).toEqual([['plugin', 'marketplace', 'update', 'kjh-code'], ['plugin', 'update', `${PLUGIN}@kjh-code`]]);
  return { ...s, env };
}

describe('runInstall', () => {
  it('ok: 두 명령이 순서대로 돌고 설치본이 소스 버전이 된다', async () => {
    await scenarioOk(defaultForm());
  });

  it('stale: 명령은 0으로 끝나도 설치본이 옛 버전이면 실패', async () => {
    const s = setup();
    const r = await runInstall({ kitRepo: s.kitRepo, plugin: PLUGIN, sourceVersion: SOURCE, env: s.fake.env({ mode: 'stale', configDir: s.configDir }) });
    expect(r.status).toBe('fail');
    expect(r.steps.map((x) => x.code)).toEqual([0, 0]);
    expect(r.steps[1].output).toContain(`already at the latest version (${OLD})`);
    expect(r.message).toContain(`설치본이 아직 ${OLD}다`);
    expect(r.installedVersion).toBe(OLD);
  });

  it('fail-market: 첫 명령이 실패하면 둘째는 안 돌리고 한글 오류를 그대로 보여 준다', async () => {
    const s = setup();
    const r = await runInstall({ kitRepo: s.kitRepo, plugin: PLUGIN, sourceVersion: SOURCE, env: s.fake.env({ mode: 'fail-market', configDir: s.configDir }) });
    expect(r.status).toBe('fail');
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].code).toBe(1);
    expect(r.steps[0].output).toContain('마켓플레이스를 갱신하지 못했다: 저장소 "kjh-code"에 연결할 수 없음');
    expect(r.message).toContain('종료 코드 1');
    expect(s.fake.calls()).toHaveLength(1);
    expect(installedVersion(s.configDir)).toBe(OLD);
  });

  it('PATH에 claude가 없으면 실행하지 않고 이유를 준다', async () => {
    const s = setup();
    const empty = path.join(s.root, '빈 PATH');
    fs.mkdirSync(empty);
    const env = fakeEnv([empty], { CLAUDE_CONFIG_DIR: s.configDir, FAKE_CLAUDE_LOG: s.fake.logFile });
    const r = await runInstall({ kitRepo: s.kitRepo, plugin: PLUGIN, sourceVersion: SOURCE, env });
    expect(r.status).toBe('fail');
    expect(r.steps).toHaveLength(0);
    expect(r.claudePath).toBeNull();
    expect(r.message).toContain('PATH');
    expect(s.fake.calls()).toHaveLength(0);
  });

  it('hang: 시간 제한을 넘으면 timedOut 으로 실패', async () => {
    const s = setup();
    // Windows .cmd 는 cmd.exe 만 죽고 손자 node 가 출력 파이프를 붙잡아서 hang 이 끝날 때(1.5초)까지 기다린다
    const r = await runInstall({ kitRepo: s.kitRepo, plugin: PLUGIN, sourceVersion: SOURCE, timeoutMs: 300, env: s.fake.env({ mode: 'hang', configDir: s.configDir, hangMs: 1500 }) });
    expect(r.status).toBe('fail');
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].timedOut).toBe(true);
    expect(r.message).toMatch(/안 끝나서 멈췄다/);
  });

  it('출력은 뒤쪽 4000자만 남긴다', async () => {
    const s = setup();
    const big = path.join(s.root, 'big');
    fs.mkdirSync(big);
    // 출력이 아주 긴 가짜: 마켓플레이스 갱신이 10000자를 내고 실패
    if (WIN) fs.writeFileSync(path.join(big, 'claude.cmd'), `@"${process.execPath}" -e "process.stdout.write('a'.repeat(9990)+'END-MARK'); process.exit(5)"\r\n`);
    else fs.writeFileSync(path.join(big, 'claude'), `#!/bin/sh\nexec '${process.execPath}' -e "process.stdout.write('a'.repeat(9990)+'END-MARK'); process.exit(5)"\n`, { mode: 0o755 });
    const r = await runInstall({ kitRepo: s.kitRepo, plugin: PLUGIN, sourceVersion: SOURCE, env: fakeEnv(WIN ? [big, path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : [big], { CLAUDE_CONFIG_DIR: s.configDir }) });
    expect(r.status).toBe('fail');
    expect(r.steps[0].code).toBe(5);
    expect(r.steps[0].output).toHaveLength(4000);
    expect(r.steps[0].output.endsWith('END-MARK')).toBe(true);
  });
});

describe('가짜 claude 형태별 (장면 ok)', () => {
  it.runIf(!WIN)('POSIX sh 스크립트', async () => { await scenarioOk('posix'); });
  it.runIf(WIN)('Windows .cmd (bin\\claude.cmd → %~dp0..\\real-claude.cmd)', async () => { await scenarioOk('cmd'); });
  // Windows 는 winget 설치 claude.exe 와 같은 형태, Linux 는 같은 트릭(node 복사본 이름 claude + cwd 의 plugin 스크립트)
  it('실행 파일 (node 복사본 claude[.exe], cwd 의 plugin 스크립트)', async () => { await scenarioOk('exe'); });
});

describe('/api/install', () => {
  afterEach(async () => { await waitInstall(); resetInstall(); });

  async function server(mode: 'ok' | 'hang', hangMs?: number) {
    const s = setup();
    const env = s.fake.env({ mode, configDir: s.configDir, version: SOURCE, hangMs });
    const srv = await inProcess({ cfgDir: path.join(s.root, 'cfg'), env });
    return { ...s, srv };
  }

  it('kit 경로가 없으면 400, 처음엔 idle', async () => {
    const { srv } = await server('ok');
    expect((await srv.call('GET', '/api/install')).body.status).toBe('idle');
    const r = await srv.call('POST', '/api/install');
    expect(r.status).toBe(400);
    await srv.close();
  });

  it('POST → 202 running, 끝나면 GET 이 ok, /api/versions 도 same', async () => {
    const s = await server('ok');
    expect((await s.srv.call('PUT', '/api/settings', { kitRepoPath: s.kitRepo })).status).toBe(200);
    expect((await s.srv.call('GET', '/api/versions')).body.status).toBe('version-differs');
    const r = await s.srv.call('POST', '/api/install');
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ status: 'running', sourceVersion: SOURCE });
    await waitInstall();
    const g = await s.srv.call('GET', '/api/install');
    expect(g.body).toMatchObject({ status: 'ok', installedVersion: SOURCE, sourceVersion: SOURCE, claudePath: s.fake.claudePath });
    expect(g.body.steps).toHaveLength(2);
    expect((await s.srv.call('GET', '/api/versions')).body.status).toBe('same');
    expect(s.fake.calls()).toEqual([['plugin', 'marketplace', 'update', 'kjh-code'], ['plugin', 'update', `${PLUGIN}@kjh-code`]]);
    await s.srv.close();
  });

  it('실행 중에 다시 POST 하면 409', async () => {
    const s = await server('hang', 1500);
    expect((await s.srv.call('PUT', '/api/settings', { kitRepoPath: s.kitRepo })).status).toBe(200);
    expect((await s.srv.call('POST', '/api/install')).status).toBe(202);
    const again = await s.srv.call('POST', '/api/install');
    expect(again.status).toBe(409);
    expect((await s.srv.call('GET', '/api/install')).body.status).toBe('running');
    await waitInstall();
    expect(getInstall().status).toBe('ok');
    // 끝나면 다시 시작할 수 있다
    expect((await s.srv.call('POST', '/api/install')).status).toBe(202);
    await s.srv.close();
  });
});
