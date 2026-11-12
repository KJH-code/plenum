// 워커 model·effort 저장 파이프라인: 로컬 bare 원격 + 한글·공백 경로로 진짜 git·npm·컴파일러를 돌린다.
// 실패 장면은 레포 상태(HEAD, porcelain, 원격 HEAD)를 직접 단언한다.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { Command } from '../server/open.ts';
import { readVersions } from '../server/kitedit.ts';
import { resetSaveState, saveSettled, startSave } from '../server/kitsave.ts';
import { git, inProcess } from './helpers.ts';
import { makeKitRepo, setGitIdentity, type KitRepo } from './kitrepo.ts';

let restore: () => void;
const servers: { close: () => Promise<void> }[] = [];
beforeAll(() => { restore = setGitIdentity(); });
afterAll(async () => {
  for (const s of servers) await s.close();
  restore();
});
beforeEach(() => resetSaveState());

async function setup(opts: Parameters<typeof makeKitRepo>[0] = {}) {
  const kr = makeKitRepo(opts);
  const launched: Command[] = [];
  const srv = await inProcess({ cfgDir: path.join(kr.root, 'cfg'), launcher: async (c) => { launched.push(c); return { ok: true }; } });
  servers.push(srv);
  const put = await srv.call('PUT', '/api/settings', { kitRepoPath: kr.repo });
  expect(put.status).toBe(200);
  return { kr, srv, launched };
}

type Srv = Awaited<ReturnType<typeof inProcess>>;
async function save(srv: Srv, body: { worker: string; model: string; effort: string }) {
  const r = await srv.call('POST', '/api/kit/save', body);
  expect(r.status).toBe(202);
  expect(r.body.status).toBe('running');
  await saveSettled();
  return (await srv.call('GET', '/api/kit/save')).body;
}

// 다른 clone 에서 커밋해 원격에 올린다
function pushFromOther(kr: KitRepo, rel = 'NOTES.md', content = '다른 곳에서\n'): string {
  const o = kr.other();
  const sha = kr.commitFile(o, rel, content, '다른 곳의 커밋');
  git(o, 'push', '-q', 'origin', 'main');
  return sha;
}

const changedFiles = (kr: KitRepo, rev = 'HEAD') => kr.git('show', '--name-only', '--format=', rev).split('\n').filter(Boolean);
const diffLines = (kr: KitRepo, file: string) => kr.git('diff', '-U0', 'HEAD~1', 'HEAD', '--', file).split('\n').filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+) /.test(l));

describe('정상 저장', () => {
  test('impl sonnet medium → opus xhigh: 커밋 1개가 원격에, 바뀐 파일·줄·버전·메시지', async () => {
    const { kr, srv } = await setup();
    const base = kr.head();
    expect((await srv.call('GET', '/api/kit/save')).body.status).toBe('idle');

    const first = await srv.call('POST', '/api/kit/save', { worker: 'impl', model: 'opus', effort: 'xhigh' });
    expect(first.status).toBe(202);
    // 도는 중에는 하나 더 못 시작한다
    const second = await srv.call('POST', '/api/kit/save', { worker: 'rev', model: 'sonnet', effort: 'medium' });
    expect(second.status).toBe(409);
    await saveSettled();
    const job = (await srv.call('GET', '/api/kit/save')).body;

    expect(job.status).toBe('done');
    expect(job.error).toBeNull();
    expect(job.steps.map((s: any) => s.key)).toEqual(['check', 'build', 'commit', 'push']);
    expect(job.steps.every((s: any) => s.state === 'ok' || s.state === 'warn')).toBe(true);
    expect(job.baseSha).toBe(base);
    expect(job.newVersion).toBe('0.0.2');
    const head = kr.head();
    expect(job.commit).toEqual({ sha: head, short: head.slice(0, 7) });
    expect(kr.git('rev-parse', 'HEAD~1').trim()).toBe(base);
    expect(kr.remoteHead()).toBe(head);
    expect(kr.porcelain()).toBe('');

    const files = changedFiles(kr);
    for (const f of ['kit/workers/impl.md', 'kit/kit.yaml', 'package.json', 'package-lock.json']) expect(files).toContain(f);
    expect(files.filter((f) => !['kit/workers/impl.md', 'kit/kit.yaml', 'package.json', 'package-lock.json'].includes(f)).every((f) => f.startsWith('build/claude-code/'))).toBe(true);
    expect(files).toContain('build/claude-code/agents/impl.md');

    expect(diffLines(kr, 'kit/workers/impl.md')).toEqual(['-model: sonnet', '-effort: medium', '+model: opus', '+effort: xhigh']);
    expect(diffLines(kr, 'kit/kit.yaml')).toEqual(['-version: "0.0.1"', '+version: "0.0.2"']);
    expect(readVersions(kr.repo)).toEqual({ kitYaml: '0.0.2', packageJson: '0.0.2', lockTop: '0.0.2', lockRoot: '0.0.2' });
    expect(kr.git('log', '-1', '--format=%B').trim()).toBe('impl: model sonnet → opus, effort medium → xhigh (0.0.2)');
    expect(job.commitMessage).toBe('impl: model sonnet → opus, effort medium → xhigh (0.0.2)');
    expect(fs.readFileSync(path.join(kr.repo, 'build', 'claude-code', 'agents', 'impl.md'), 'utf8')).toMatch(/^model: opus$/m);
  });
});

describe('빌드 ERROR·WARN', () => {
  test('tiers에 없는 계층(Sonnet high) → tier 오류, 레포·원격 그대로', async () => {
    const { kr, srv } = await setup();
    const head = kr.head();
    const remote = kr.remoteHead();
    const job = await save(srv, { worker: 'impl', model: 'sonnet', effort: 'high' });
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ kind: 'tier', tier: 'Sonnet high' });
    expect(job.steps.map((s: any) => s.state)).toEqual(['fail', 'skip', 'skip', 'skip']);
    expect(kr.head()).toBe(head);
    expect(kr.porcelain()).toBe('');
    expect(kr.remoteHead()).toBe(remote);
  });

  test('산문 옛 모델 WARN → 저장은 되고, 경고는 kit 원본 줄 번호', async () => {
    const LINE = '리뷰 담당 `rev`는 Sonnet high로 돈다.';
    const { kr, srv } = await setup({ setup: (repo) => fs.appendFileSync(path.join(repo, 'kit', 'skills', 'demo', 'SKILL.md'), `\n${LINE}\n`) });
    const job = await save(srv, { worker: 'rev', model: 'sonnet', effort: 'medium' });
    expect(job.status).toBe('done');
    expect(job.steps[0].state).toBe('warn');
    const kitLine = fs.readFileSync(path.join(kr.repo, 'kit', 'skills', 'demo', 'SKILL.md'), 'utf8').split('\n').indexOf(LINE) + 1;
    expect(kitLine).toBeGreaterThan(0);
    // build 쪽은 표가 펼쳐져서 줄 번호가 다르다 — 매핑이 실제로 일어났는지
    const buildLines = fs.readFileSync(path.join(kr.repo, 'build', 'claude-code', 'skills', 'demo', 'SKILL.md'), 'utf8').split('\n');
    expect(buildLines[kitLine - 1]).not.toBe(LINE);
    expect(job.warnings).toContainEqual({ file: 'kit/skills/demo/SKILL.md', line: kitLine, message: expect.stringContaining('`rev`') });
    // kit 원본에 없는 줄(표 자리표시가 펼쳐진 줄)은 build 경로·줄 그대로
    expect(job.warnings).toContainEqual({ file: 'build/claude-code/README.md', line: 3, message: expect.stringContaining('Opus xhigh') });
    expect(job.warnings).toHaveLength(2);
    expect(kr.porcelain()).toBe('');
    expect(kr.remoteHead()).toBe(kr.head());
  });
});

describe('빌드 단계 실패 → 손댄 경로만 롤백', () => {
  test('npm version 실패 → 워커 파일·kit.yaml 되돌림, HEAD·porcelain 그대로', async () => {
    const { kr, srv } = await setup();
    const head = kr.head();
    // PATH 맨 앞에 실패하는 가짜 npm
    const fake = path.join(kr.root, '가짜 npm');
    fs.mkdirSync(fake);
    fs.writeFileSync(path.join(fake, 'npm'), '#!/bin/sh\necho 일부러 실패 >&2\nexit 3\n', { mode: 0o755 });
    fs.writeFileSync(path.join(fake, 'npm.cmd'), '@echo 일부러 실패 1>&2\r\n@exit /b 3\r\n');
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const saved = process.env[key];
    process.env[key] = `${fake}${path.delimiter}${saved}`;
    try {
      const job = await save(srv, { worker: 'impl', model: 'opus', effort: 'xhigh' });
      expect(job.status).toBe('failed');
      expect(job.error.kind).toBe('other');
      expect(job.error.message).toMatch(/npm version patch 실패/);
      expect(job.error.message).toMatch(/되돌렸다/);
      expect(job.steps.map((s: any) => s.state)).toEqual(['warn', 'fail', 'skip', 'skip']);
    } finally { process.env[key] = saved; }
    expect(kr.head()).toBe(head);
    expect(kr.porcelain()).toBe('');
    expect(readVersions(kr.repo).kitYaml).toBe('0.0.1');
    expect(fs.readFileSync(path.join(kr.repo, 'kit', 'workers', 'impl.md'), 'utf8')).toMatch(/^model: sonnet$/m);
  });
});

describe('저장을 막는 조건 — 레포 그대로', () => {
  const cases: [string, (kr: KitRepo) => void, string, RegExp][] = [
    ['main 아닌 브랜치', (kr) => kr.git('checkout', '-q', '-b', 'dev'), 'blocked', /main이 아니다/],
    ['dirty (untracked 파일)', (kr) => fs.writeFileSync(path.join(kr.repo, '메모 파일.txt'), 'x'), 'blocked', /커밋 안 된 변경/],
    ['ahead (push 안 한 커밋)', (kr) => kr.commitFile(kr.repo, 'NOTES.md', 'x', '로컬만'), 'blocked', /push 안 된 커밋이 1개/],
    ['컴파일러 없음', (kr) => fs.rmSync(path.join(kr.repo, 'node_modules', 'plenum'), { recursive: true }), 'compiler', /npm ci 필요/],
    ['버전 불일치', (kr) => {
      kr.commitFile(kr.repo, 'package.json', '{\n  "name": "demo-kit",\n  "version": "0.0.5",\n  "private": true\n}\n', '버전 어긋남');
      kr.git('push', '-q', 'origin', 'main');
    }, 'version', /버전이 서로 다르다/],
  ];
  for (const [name, arrange, kind, msg] of cases) {
    test(name, async () => {
      const { kr, srv } = await setup();
      arrange(kr);
      const head = kr.head();
      const porc = kr.porcelain();
      const remote = kr.remoteHead();
      const job = await save(srv, { worker: 'impl', model: 'opus', effort: 'xhigh' });
      expect(job.status).toBe('failed');
      expect(job.error.kind).toBe(kind);
      expect(job.error.message).toMatch(msg);
      expect(job.steps.map((s: any) => s.state)).toEqual(['fail', 'skip', 'skip', 'skip']);
      expect(kr.head()).toBe(head);
      expect(kr.porcelain()).toBe(porc);
      expect(kr.remoteHead()).toBe(remote);
      expect(readVersions(kr.repo).kitYaml).toBe('0.0.1');
    });
  }

  test('바뀌는 것이 없음·없는 워커·모르는 값 → blocked', async () => {
    const { kr, srv } = await setup();
    const head = kr.head();
    for (const body of [{ worker: 'impl', model: 'sonnet', effort: 'medium' }, { worker: '없는워커', model: 'opus', effort: 'xhigh' }, { worker: 'impl', model: 'gpt', effort: 'xhigh' }]) {
      resetSaveState();
      const job = await save(srv, body);
      expect(job.status).toBe('failed');
      expect(job.error.kind).toBe('blocked');
    }
    expect(kr.head()).toBe(head);
    expect(kr.porcelain()).toBe('');
  });
});

describe('원격과 비교', () => {
  test('뒤처짐 → 저장 거부 → 받아오기 → same → 저장', async () => {
    const { kr, srv } = await setup();
    const theirs = pushFromOther(kr);
    const st = await srv.call('GET', '/api/kit/remote');
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ branch: 'main', state: 'behind', ahead: 0, behind: 1, fetchError: null, remote: theirs });
    const blocked = await save(srv, { worker: 'impl', model: 'opus', effort: 'xhigh' });
    expect(blocked.status).toBe('failed');
    expect(blocked.error).toMatchObject({ kind: 'blocked', message: expect.stringMatching(/뒤처졌다/) });

    const pull = await srv.call('POST', '/api/kit/pull');
    expect(pull.status).toBe(200);
    expect(pull.body.ok).toBe(true);
    expect(pull.body.remote).toMatchObject({ state: 'same', blockers: [] });
    expect(kr.head()).toBe(theirs);
    // 받을 게 없으면 거부
    expect((await srv.call('POST', '/api/kit/pull')).body.ok).toBe(false);

    const job = await save(srv, { worker: 'impl', model: 'opus', effort: 'xhigh' });
    expect(job.status).toBe('done');
    expect(kr.git('rev-parse', 'HEAD~1').trim()).toBe(theirs);
    expect(kr.remoteHead()).toBe(kr.head());
  });

  test('갈라짐 → 저장도 받아오기도 거부', async () => {
    const { kr, srv } = await setup();
    const mine = kr.commitFile(kr.repo, 'MINE.md', 'x', '로컬 커밋');
    pushFromOther(kr);
    const remote = kr.remoteHead();
    const st = await srv.call('GET', '/api/kit/remote');
    expect(st.body).toMatchObject({ state: 'diverged', ahead: 1, behind: 1 });
    const job = await save(srv, { worker: 'impl', model: 'opus', effort: 'xhigh' });
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ kind: 'blocked', message: expect.stringMatching(/갈라졌다/) });
    const pull = await srv.call('POST', '/api/kit/pull');
    expect(pull.body.ok).toBe(false);
    expect(pull.body.message).toMatch(/갈라져/);
    expect(kr.head()).toBe(mine);
    expect(kr.porcelain()).toBe('');
    expect(kr.remoteHead()).toBe(remote);
  });

  test('원격에 닿지 못하면 fetchError + 저장 막음', async () => {
    const { kr, srv } = await setup();
    kr.git('remote', 'set-url', 'origin', path.join(kr.root, '없는 원격.git'));
    const st = await srv.call('GET', '/api/kit/remote');
    expect(st.body.fetchError).toBeTruthy();
    expect(st.body.blockers.join(' ')).toMatch(/원격을 확인하지 못했다/);
    const head = kr.head();
    const job = await save(srv, { worker: 'impl', model: 'opus', effort: 'xhigh' });
    expect(job.error.kind).toBe('blocked');
    expect(kr.head()).toBe(head);
    expect(kr.porcelain()).toBe('');
  });
});

describe('push 거부', () => {
  // 검사 뒤·push 직전에 다른 clone 이 push → 우리 push 거부
  async function rejected(otherVersion?: string) {
    const s = await setup();
    const base = s.kr.head();
    let theirs = '';
    startSave(s.kr.repo, { worker: 'impl', model: 'opus', effort: 'xhigh' }, {
      hooks: {
        beforePush: async () => {
          const o = s.kr.other();
          if (otherVersion) {
            for (const f of ['kit/kit.yaml', 'package.json', 'package-lock.json']) {
              const p = path.join(o, ...f.split('/'));
              fs.writeFileSync(p, fs.readFileSync(p, 'utf8').split('0.0.1').join(otherVersion));
            }
            git(o, 'add', '.');
          }
          theirs = s.kr.commitFile(o, 'NOTES.md', '다른 곳\n', '다른 곳의 커밋');
          git(o, 'push', '-q', 'origin', 'main');
        },
      },
    });
    const job = await saveSettled();
    expect(job.status).toBe('push-failed');
    expect(job.pushError!.kind).toBe('rejected');
    expect(job.steps.map((x) => x.state)).toEqual(['warn', 'ok', 'ok', 'fail']);
    expect(job.commit!.sha).toBe(s.kr.head());
    expect(s.kr.remoteHead()).toBe(theirs);
    return { ...s, base, theirs, job };
  }

  test('커밋 취소 → 저장 전 HEAD, 깨끗, cancelled', async () => {
    const { kr, srv, base, job } = await rejected();
    // HEAD 가 우리 커밋이 아니면 거부
    kr.commitFile(kr.repo, 'EXTRA.md', 'x', '딴 커밋');
    const refused = await srv.call('POST', '/api/kit/save/cancel');
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/방금 만든 커밋/);
    kr.git('reset', '-q', '--hard', job.commit!.sha);

    const r = await srv.call('POST', '/api/kit/save/cancel');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('cancelled');
    expect(kr.head()).toBe(base);
    expect(kr.porcelain()).toBe('');
    expect(readVersions(kr.repo).kitYaml).toBe('0.0.1');
    // 한 번 더는 못 한다
    expect((await srv.call('POST', '/api/kit/save/cancel')).status).toBe(409);
    expect((await srv.call('POST', '/api/kit/save/retry')).status).toBe(409);
  });

  test('받아와서 다시 push → 다른 clone 커밋 위에 우리 커밋, 버전은 새 base +1', async () => {
    const { kr, srv, theirs, job } = await rejected('0.0.5');
    const r = await srv.call('POST', '/api/kit/save/retry');
    expect(r.status).toBe(200);
    expect(r.body.id).toBeGreaterThan(job.id);
    const done = await saveSettled();
    expect(done.status).toBe('done');
    expect(done.newVersion).toBe('0.0.6');
    expect(kr.remoteHead()).toBe(kr.head());
    expect(kr.git('rev-parse', 'HEAD~1').trim()).toBe(theirs);
    expect(kr.git('rev-list', '--count', `${theirs}..HEAD`).trim()).toBe('1');
    expect(readVersions(kr.repo)).toEqual({ kitYaml: '0.0.6', packageJson: '0.0.6', lockTop: '0.0.6', lockRoot: '0.0.6' });
    expect(kr.git('log', '-1', '--format=%s').trim()).toBe('impl: model sonnet → opus, effort medium → xhigh (0.0.6)');
    expect(kr.porcelain()).toBe('');
  });
});

describe('미리보기·열기', () => {
  test('preview: diff 줄·커밋 메시지·authorEmail, 레포에 안 쓴다', async () => {
    const { kr, srv } = await setup();
    kr.git('config', 'user.email', 'jaehyuk@example.com');
    const r = await srv.call('POST', '/api/kit/preview', { worker: 'impl', model: 'opus', effort: 'xhigh' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      files: [
        { path: 'kit/workers/impl.md', lines: [{ sign: '-', text: 'model: sonnet' }, { sign: '+', text: 'model: opus' }, { sign: '-', text: 'effort: medium' }, { sign: '+', text: 'effort: xhigh' }] },
        { path: 'kit/kit.yaml', lines: [{ sign: '-', text: 'version: "0.0.1"' }, { sign: '+', text: 'version: "0.0.2"' }] },
        { path: 'package.json', lines: [{ sign: '-', text: '  "version": "0.0.1",' }, { sign: '+', text: '  "version": "0.0.2",' }] },
        { path: 'package-lock.json', lines: [
          { sign: '-', text: '  "version": "0.0.1",' }, { sign: '+', text: '  "version": "0.0.2",' },
          { sign: '-', text: '      "version": "0.0.1"' }, { sign: '+', text: '      "version": "0.0.2"' },
        ] },
      ],
      commitMessage: 'impl: model sonnet → opus, effort medium → xhigh (0.0.2)',
      authorEmail: 'jaehyuk@example.com',
      newVersion: '0.0.2',
      from: { model: 'sonnet', effort: 'medium' },
    });
    // 한쪽만 바뀌면 그것만
    const one = await srv.call('POST', '/api/kit/preview', { worker: 'impl', model: 'opus', effort: 'medium' });
    expect(one.body.commitMessage).toBe('impl: model sonnet → opus (0.0.2)');
    expect(one.body.files[0].lines).toEqual([{ sign: '-', text: 'model: sonnet' }, { sign: '+', text: 'model: opus' }]);
    for (const bad of [{ worker: 'impl', model: 'sonnet', effort: 'medium' }, { worker: '없음', model: 'opus', effort: 'xhigh' }, { worker: 'impl', model: 'opus', effort: 'ultra' }, {}]) {
      const e = await srv.call('POST', '/api/kit/preview', bad);
      expect(e.status).toBe(400);
      expect(e.body.error).toBeTruthy();
    }
    expect(kr.porcelain()).toBe('');

    const kit = await srv.call('GET', '/api/kit/workers');
    expect(kit.body.options).toEqual({ models: ['opus', 'sonnet', 'haiku', 'fable'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
    expect(kit.body.tiers).toEqual(['Sonnet medium', 'Opus xhigh']);
  });

  test('open: 레포 밖은 400, code 에디터면 -g <abs>:<line>', async () => {
    const { kr, srv, launched } = await setup();
    const code = path.join(kr.root, '에디터 bin', 'code');
    fs.mkdirSync(path.dirname(code));
    fs.writeFileSync(code, '');
    expect((await srv.call('PUT', '/api/settings', { editorCommand: code })).status).toBe(200);
    for (const file of ['../밖.md', path.join(kr.root, 'remote.git', 'HEAD'), '', '.']) {
      const r = await srv.call('POST', '/api/kit/open', { file });
      expect(r.status).toBe(400);
    }
    expect(launched).toEqual([]);
    const ok = await srv.call('POST', '/api/kit/open', { file: 'kit/skills/demo/SKILL.md', line: 12 });
    expect(ok.status).toBe(200);
    const abs = path.join(kr.repo, 'kit', 'skills', 'demo', 'SKILL.md');
    expect(launched[0]).toEqual({ cmd: code, args: ['-g', `${abs}:12`] });
    await srv.call('POST', '/api/kit/open', { file: 'kit/kit.yaml' });
    expect(launched[1]).toEqual({ cmd: code, args: [path.join(kr.repo, 'kit', 'kit.yaml')] });
  });

  test('kit 레포 경로가 없으면 400', async () => {
    const { srv } = await setup();
    await srv.call('PUT', '/api/settings', { kitRepoPath: null });
    expect((await srv.call('GET', '/api/kit/remote')).status).toBe(400);
    expect((await srv.call('POST', '/api/kit/save', { worker: 'impl', model: 'opus', effort: 'xhigh' })).status).toBe(400);
  });
});
