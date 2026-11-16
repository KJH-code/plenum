'use strict';
// 판(variant): plenum-pack --kit/--variant/--variant-file. fixture 사본에 테스트용 파일을 더해서 쓴다 (공용 fixture는 그대로)
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { copyFixture, compile, pack } = require('./lib/run');
const { listFiles, makeTmp, rmTmp } = require('./lib/tree');
const { readZip } = require('./lib/zip');

let tmp;
before(() => { tmp = makeTmp('plenum-variant-'); });
after(() => rmTmp(tmp));

// 손으로 한 줄씩 쓴 hooks.json (JSON.stringify(…, null, 2)와 바이트가 다른 모양)
const HOOKS_JSON = [
  '{ "hooks": {',
  '  "PreToolUse": [',
  '    { "matcher": "Bash", "hooks": [',
  '      { "type": "command", "command": "node \\"${CLAUDE_PLUGIN_ROOT}/hooks/guard.js\\"" },',
  '      { "type": "command", "command": "node \\"${CLAUDE_PLUGIN_ROOT}/hooks/h.js\\"" }',
  '    ] }',
  '  ],',
  '  "Stop": [',
  '    { "hooks": [ { "type": "command", "command": "node \\"${CLAUDE_PLUGIN_ROOT}/hooks/notify.js\\"" } ] }',
  '  ],',
  '  "SessionStart": [',
  '    { "hooks": [',
  '      { "type": "command", "command": "node \\"${CLAUDE_PLUGIN_ROOT}/hooks/notify.js\\"", "timeout": 5 },',
  '      { "type": "command", "command": "node \\"${CLAUDE_PLUGIN_ROOT}/hooks/h.js\\"" }',
  '    ] }',
  '  ]',
  '} }',
  '',
].join('\n');

const cmd = (n) => `node "\${CLAUDE_PLUGIN_ROOT}/hooks/${n}.js"`;

// 언급 검사용 docs/notes.md. [줄, 맞아야 하는 경고 이름 목록]
const NOTES = [
  ['# notes', []],
  ['', []],
  ['리뷰는 rev가 맡는다.', ['agent rev']],
  ['rev-x 는 다른 이름이다.', []],
  ['슬래시 /extra 로 부른다.', ['skill extra']],
  ['백틱 `extra` 스킬.', ['skill extra']],
  ['플러그인 demo-kit:extra 로 부른다.', ['skill extra']],
  ['경로 skills/extra/SKILL.md 참고.', ['skill extra']],
  ['맨 낱말 extra 는 그냥 영어다.', []],
  ['a/extra 는 경로 조각이다.', []],
  ['other:extra 는 남의 플러그인.', []],
  ['덮어쓴 이름 demo-share:extra 도 본다.', ['skill extra']],
  ['훅 guard 가 막는다.', ['hook guard']],
  ['guard-data 는 딸린 파일.', []],
  ['rev 와 rev 가 한 줄에 두 번.', ['agent rev']],
  ['공유 문구 둘.', []],
  ['', []],
  ['## 변경 기록', []],
  ['- rev 를 고쳤다.', []],
  ['### 하위', []],
  ['- rev 하위 기록.', []],
  ['## 다음 절', []],
  ['rev 가 다시 나온다.', ['agent rev']],
  ['```', []],
  ['## 변경 기록', []],
  ['rev in code', ['agent rev']],
  ['```', []],
  ['rev after fence', ['agent rev']],
  ['', []],
];
const NOTES_TEXT = NOTES.map((l) => l[0]).join('\n');
const MSG = { 'agent rev': '뺀 에이전트 rev 언급이 남아 있음', 'skill extra': '뺀 스킬 extra 언급이 남아 있음', 'hook guard': '뺀 훅 guard 언급이 남아 있음' };

const EXTRA_SKILL = '---\nname: extra\ndescription: 두 번째 스킬\n---\n\n# extra\n\n긴 공유 문구 하나.\n';

let n = 0;
// 새 사례 폴더: fixture 사본 + 테스트용 파일. variants: {이름: yaml} 이면 kit/variants/에 쓴다
function kitCase({ variants = null } = {}) {
  const dir = path.join(tmp, `case-${n++}`);
  fs.mkdirSync(dir);
  const kit = copyFixture(dir);
  const put = (rel, text, mode = 0o644) => {
    const f = path.join(kit, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    fs.chmodSync(f, mode);
  };
  put('skills/extra/SKILL.md', EXTRA_SKILL);
  put('hooks/guard.js', '#!/usr/bin/env node\nconsole.log("guard");\n', 0o755);
  put('hooks/notify.js', '#!/usr/bin/env node\nconsole.log("notify");\n', 0o755);
  put('hooks/guard-data.json', '{"deny": []}\n');
  put('hooks/hooks.json', HOOKS_JSON);
  put('docs/notes.md', NOTES_TEXT);
  if (variants) for (const [name, y] of Object.entries(variants)) put(`variants/${name}.yaml`, y);
  return { dir, kit };
}

// 판 파일을 kit 밖 임시 폴더에 쓴다
function variantFile(dir, name, text) {
  const f = path.join(dir, 'v', `${name}.yaml`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
}

function packOk(args, opts) {
  const r = pack(args, opts);
  assert.strictEqual(r.status, 0, r.stderr);
  return r;
}
function zipOf(file) { return readZip(fs.readFileSync(file)); }
const text = (z, name) => z.files.get(name).toString('utf8');

// 판 하나로 묶어 zip을 연다
function packVariant(c, name, yamlText, extra = []) {
  const vf = variantFile(c.dir, name, yamlText);
  const out = path.join(c.dir, `${name}.zip`);
  const r = packOk(['--kit', c.kit, '--variant-file', vf, '--out', out, ...extra]);
  return { r, z: zipOf(out), out };
}
function packBase(c) {
  const out = path.join(c.dir, 'base.zip');
  packOk(['--kit', c.kit, '--out', out]);
  return zipOf(out);
}

const ALL_EXTRA = ['skills/extra/SKILL.md', 'hooks/guard.js', 'hooks/notify.js', 'hooks/guard-data.json', 'docs/notes.md'];

// ---- 1. 기본 판 해석 ----

test('기본 판: variants/ 없음 → 판 없이 그대로 묶인다', () => {
  const c = kitCase();
  const r = packOk([], { cwd: c.dir });
  assert.match(r.stdout, /^dist\/demo-kit-0\.0\.1\.zip \(14 files\)\s*$/);
  const z = zipOf(path.join(c.dir, 'dist', 'demo-kit-0.0.1.zip'));
  for (const f of ALL_EXTRA) assert.ok(z.files.has(f), f);
});

test('기본 판: variants/demo-kit.yaml 있으면 그 판이 적용된다', () => {
  const c = kitCase({ variants: { 'demo-kit': 'harness: claude-code\nexclude:\n  skills: [extra]\n', other: 'harness: claude-code\n' } });
  const r = packOk([], { cwd: c.dir });
  assert.match(r.stdout, /^dist\/demo-kit-0\.0\.1\.zip \(13 files\)\s*$/);
  const z = zipOf(path.join(c.dir, 'dist', 'demo-kit-0.0.1.zip'));
  assert.ok(!z.files.has('skills/extra/SKILL.md'));
  assert.ok(z.files.has('skills/demo/SKILL.md'));
});

test('기본 판: variants/는 있는데 demo-kit.yaml이 없으면 ERROR', () => {
  const c = kitCase({ variants: { other: 'harness: claude-code\n' } });
  const r = pack([], { cwd: c.dir });
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stderr, /^ERROR 기본 판 없음: variants\/demo-kit\.yaml \(있는 것: other\)$/m);
  assert.ok(!fs.existsSync(path.join(c.dir, 'dist')));
});

test('variants/의 .yaml 아닌 파일·점 파일·폴더는 건너뛴다 (build·pack 둘 다 성공, 판 목록에 안 들어감)', () => {
  const c = kitCase({ variants: { 'demo-kit': 'harness: claude-code\nexclude:\n  skills: [extra]\n' } });
  const vdir = path.join(c.kit, 'variants');
  fs.writeFileSync(path.join(vdir, 'notes.txt'), '메모');
  fs.writeFileSync(path.join(vdir, '.DS_Store'), '');
  fs.writeFileSync(path.join(vdir, '.hidden.yaml'), 'harness: agents-md\n');
  fs.mkdirSync(path.join(vdir, 'drafts.yaml'));
  const b = compile([], { cwd: c.dir });
  assert.strictEqual(b.status, 0, b.stderr);
  const r = packOk([], { cwd: c.dir });
  assert.match(r.stdout, /\(13 files\)\s*$/);
  assert.ok(!r.stderr.includes('ERROR'), r.stderr);
  for (const name of ['notes', '.hidden', 'drafts']) {
    const e = pack(['--variant', name], { cwd: c.dir });
    assert.strictEqual(e.status, 1, name);
    assert.match(e.stderr, /없는 판: .* \(있는 것: demo-kit\)/, name);
  }
});
test('--variant <이름>은 kit/variants/<이름>.yaml을 쓴다', () => {
  const c = kitCase({ variants: { 'demo-kit': 'harness: claude-code\n', share: 'harness: claude-code\nexclude:\n  agents: [rev]\n' } });
  const out = path.join(c.dir, 's.zip');
  packOk(['--kit', c.kit, '--variant', 'share', '--out', out]);
  const z = zipOf(out);
  assert.ok(!z.files.has('agents/rev.md'));
  assert.ok(z.files.has('agents/impl.md'));
});

// ---- 2. variants/는 출력에 안 들어간다 ----

test('variants/는 plenum-compile 출력과 zip에 들어가지 않는다', () => {
  const c = kitCase({ variants: { 'demo-kit': 'harness: claude-code\n' } });
  assert.ok(fs.existsSync(path.join(c.kit, 'variants', 'demo-kit.yaml')));
  const out = path.join(c.dir, 'build');
  const r = compile(['--kit', c.kit, '--out', out]);
  assert.strictEqual(r.status, 0, r.stderr);
  const built = listFiles(out);
  assert.ok(built.includes('docs/notes.md'));
  assert.deepStrictEqual(built.filter((f) => f.startsWith('variants')), []);
  const zr = packOk(['--kit', c.kit, '--out', path.join(c.dir, 'z.zip')]);
  assert.match(zr.stdout, /\(14 files\)/);
  const z = zipOf(path.join(c.dir, 'z.zip'));
  assert.deepStrictEqual(z.order.filter((f) => f.startsWith('variants')), []);
  assert.deepStrictEqual(z.order, built);
});

// ---- 3. 등가 ----

test('등가: 빈 판·판 없음·plenum-compile 후 --build 의 zip이 바이트까지 같다. 두 번 묶어도 같다', () => {
  const c = kitCase();
  const noVar = path.join(c.dir, 'novar.zip');
  const noVar2 = path.join(c.dir, 'novar2.zip');
  const empty = path.join(c.dir, 'empty.zip');
  const viaBuild = path.join(c.dir, 'build.zip');
  packOk(['--kit', c.kit, '--out', noVar]);
  packOk(['--kit', c.kit, '--out', noVar2]);
  packOk(['--kit', c.kit, '--variant-file', variantFile(c.dir, 'empty', 'harness: claude-code\n'), '--out', empty]);
  const build = path.join(c.dir, 'build');
  const cr = compile(['--kit', c.kit, '--out', build]);
  assert.strictEqual(cr.status, 0, cr.stderr);
  packOk(['--build', build, '--out', viaBuild]);

  // 기본 판(variants/demo-kit.yaml이 빈 판)도 같다
  const c2 = kitCase({ variants: { 'demo-kit': 'harness: claude-code\n' } });
  const viaDefault = path.join(c2.dir, 'default.zip');
  packOk(['--kit', c2.kit, '--out', viaDefault]);

  const ref = fs.readFileSync(viaBuild);
  const z = readZip(ref);
  assert.strictEqual(z.order.length, 14);
  for (const f of ALL_EXTRA) assert.ok(z.files.has(f), f);
  assert.strictEqual(z.modes.get('hooks/guard.js'), 0o755);
  assert.strictEqual(z.modes.get('hooks/guard-data.json'), 0o644);
  for (const f of [noVar, noVar2, empty, viaDefault]) assert.ok(fs.readFileSync(f).equals(ref), f);
});

// ---- 4. 빼기 ----

test('빼기: 네 단위 각각, 빼기 전에는 있었다', () => {
  const c = kitCase();
  const base = packBase(c);
  const cases = [
    ['skills', 'exclude:\n  skills: [extra]\n', ['skills/extra/SKILL.md']],
    ['agents', 'exclude:\n  agents: [rev]\n', ['agents/rev.md']],
    ['hooks', 'exclude:\n  hooks: [guard]\n', ['hooks/guard.js']],
    ['files', 'exclude:\n  files: [hooks/guard-data.json, docs/]\n', ['hooks/guard-data.json', 'docs/notes.md']],
  ];
  assert.strictEqual(cases.length, 4);
  for (const [label, y, gone] of cases) {
    const { z } = packVariant(c, `ex-${label}`, `harness: claude-code\n${y}`);
    for (const f of gone) {
      assert.ok(base.files.has(f), `${label}: 빼기 전 zip에 ${f}가 있어야 한다`);
      assert.ok(!z.files.has(f), `${label}: ${f}가 빠져야 한다`);
    }
    // 뺀 것 말고는 그대로
    const rest = base.order.filter((f) => !gone.includes(f));
    assert.deepStrictEqual(z.order, rest, label);
    for (const f of rest) {
      if (f === 'hooks/hooks.json') continue; // 훅을 빼면 바뀐다 (장면 6)
      assert.ok(z.files.get(f).equals(base.files.get(f)), `${label}: ${f}`);
    }
  }
});

// ---- 5. include ----

test('include: 적은 것만 남는다', () => {
  const c = kitCase();
  const base = packBase(c);
  const { z } = packVariant(c, 'inc', 'harness: claude-code\ninclude:\n  skills: [demo]\n  agents: [impl]\n  hooks: [h]\n');
  for (const f of ['skills/extra/SKILL.md', 'agents/rev.md', 'hooks/guard.js', 'hooks/notify.js']) {
    assert.ok(base.files.has(f), f);
    assert.ok(!z.files.has(f), f);
  }
  for (const f of ['skills/demo/SKILL.md', 'agents/impl.md', 'hooks/h.js', 'hooks/guard-data.json', 'docs/notes.md', 'scripts/s.js']) {
    assert.ok(z.files.has(f), f);
  }
  const hj = JSON.parse(text(z, 'hooks/hooks.json'));
  assert.deepStrictEqual(Object.keys(hj.hooks), ['PreToolUse', 'SessionStart']);
  assert.ok(!/guard\.js|notify\.js/.test(text(z, 'hooks/hooks.json')));
});

// ---- 6. 훅 ----

test('훅: guard를 빼면 스크립트·호출이 빠지고 h.js·notify.js 호출은 남는다', () => {
  const c = kitCase();
  const { z } = packVariant(c, 'g', 'harness: claude-code\nexclude:\n  hooks: [guard]\n');
  assert.ok(!z.files.has('hooks/guard.js'));
  assert.ok(z.files.has('hooks/guard-data.json'));
  const raw = text(z, 'hooks/hooks.json');
  assert.ok(!raw.includes('guard.js'));
  assert.deepStrictEqual(JSON.parse(raw), { hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: cmd('h') }] }],
    Stop: [{ hooks: [{ type: 'command', command: cmd('notify') }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: cmd('notify'), timeout: 5 }, { type: 'command', command: cmd('h') }] }],
  } });
  assert.strictEqual(raw, JSON.stringify(JSON.parse(raw), null, 2) + '\n');
});

test('훅: notify를 빼면 notify.js만 있던 이벤트(Stop)가 통째로 사라진다', () => {
  const c = kitCase();
  const { z } = packVariant(c, 'nt', 'harness: claude-code\nexclude:\n  hooks: [notify]\n');
  const hj = JSON.parse(text(z, 'hooks/hooks.json'));
  assert.deepStrictEqual(Object.keys(hj.hooks), ['PreToolUse', 'SessionStart']);
  assert.deepStrictEqual(hj.hooks.SessionStart, [{ hooks: [{ type: 'command', command: cmd('h') }] }]);
  assert.strictEqual(hj.hooks.PreToolUse[0].hooks.length, 2);
});

test('훅: 훅을 안 뺀 판은 hooks.json이 원문 바이트 그대로', () => {
  const c = kitCase();
  const src = fs.readFileSync(path.join(c.kit, 'hooks', 'hooks.json'));
  // 다시 직렬화하면 달라지는 원문이어야 이 단언이 의미가 있다
  assert.notStrictEqual(src.toString('utf8'), JSON.stringify(JSON.parse(src.toString('utf8')), null, 2) + '\n');
  const { z } = packVariant(c, 'sk', 'harness: claude-code\nexclude:\n  skills: [extra]\n  files: [docs/]\n');
  assert.ok(z.files.get('hooks/hooks.json').equals(src));
});

test('훅: 스크립트를 exclude.files로만 빼면 없는 스크립트 호출 ERROR', () => {
  const c = kitCase();
  const vf = variantFile(c.dir, 'bad', 'harness: claude-code\nexclude:\n  files: [hooks/guard.js]\n');
  const r = pack(['--kit', c.kit, '--variant-file', vf, '--out', path.join(c.dir, 'bad.zip')]);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stderr, /hooks\/hooks\.json이 출력에 없는 스크립트를 부름: hooks\/guard\.js — exclude\.hooks: \[guard\] 로 빼면 호출 항목도 같이 빠진다/);
  assert.ok(!fs.existsSync(path.join(c.dir, 'bad.zip')));
});

// ---- 7. 치환 ----

test('치환: 전체 텍스트 파일', () => {
  const c = kitCase();
  const { z } = packVariant(c, 'r1', 'harness: claude-code\nreplace:\n  - from: "공유 문구"\n    to: "SHARED"\n');
  assert.strictEqual(text(z, 'skills/extra/SKILL.md'), EXTRA_SKILL.replace('공유 문구', 'SHARED'));
  assert.ok(text(z, 'docs/notes.md').includes('SHARED 둘.'));
  assert.ok(!text(z, 'docs/notes.md').includes('공유 문구'));
});

test('치환: files 한정이면 다른 파일의 같은 문구는 그대로', () => {
  const c = kitCase();
  const base = packBase(c);
  const { z } = packVariant(c, 'r2', 'harness: claude-code\nreplace:\n  - from: "공유 문구"\n    to: "SHARED"\n    files: [skills/extra/]\n');
  assert.ok(text(z, 'skills/extra/SKILL.md').includes('긴 SHARED 하나.'));
  assert.ok(z.files.get('docs/notes.md').equals(base.files.get('docs/notes.md')));
  assert.ok(text(z, 'docs/notes.md').includes('공유 문구 둘.'));
});

test('치환: 적은 순서대로 (긴 규칙 다음 짧은 규칙)', () => {
  const c = kitCase();
  const { z } = packVariant(c, 'r3', [
    'harness: claude-code', 'replace:',
    '  - from: "긴 공유 문구"', '    to: "LONG"',
    '  - from: "공유"', '    to: "SHORT"', '',
  ].join('\n'));
  assert.ok(text(z, 'skills/extra/SKILL.md').includes('LONG 하나.'), text(z, 'skills/extra/SKILL.md'));
  assert.ok(text(z, 'docs/notes.md').includes('SHORT 문구 둘.'));
});

test('치환: 0번 맞으면 ERROR, optional: true면 통과', () => {
  const c = kitCase();
  const y = 'harness: claude-code\nreplace:\n  - from: "공유 문구"\n    to: "S"\n  - from: "없는 문구"\n    to: "X"\n';
  const vf = variantFile(c.dir, 'r4', y);
  const r = pack(['--kit', c.kit, '--variant-file', vf, '--out', path.join(c.dir, 'r4.zip')]);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.match(r.stderr, /replace\[1\]: "없는 문구"이 한 번도 안 맞음 \(0번 맞아도 되면 optional: true\)/);
  const { z } = packVariant(c, 'r5', `${y}    optional: true\n`);
  assert.ok(text(z, 'docs/notes.md').includes('S 둘.'));
});

// ---- 8. 매니페스트 ----

test('매니페스트: 값이 바뀌고 zip 이름이 <name>-<version>.zip', () => {
  const c = kitCase();
  const vf = variantFile(c.dir, 'share', [
    'harness: claude-code', 'manifest:', '  name: demo-share', '  version: "1.0.0"',
    '  description: "공유판"', '  author: { name: "친구" }', '',
  ].join('\n'));
  const r = packOk(['--kit', c.kit, '--variant-file', vf], { cwd: c.dir });
  assert.match(r.stdout, /^dist\/demo-share-1\.0\.0\.zip \(14 files\)\s*$/);
  const z = zipOf(path.join(c.dir, 'dist', 'demo-share-1.0.0.zip'));
  const raw = text(z, '.claude-plugin/plugin.json');
  assert.strictEqual(raw, JSON.stringify({ name: 'demo-share', version: '1.0.0', description: '공유판', author: { name: '친구' } }, null, 2) + '\n');
});

test('매니페스트: manifest가 없으면 plugin.json 원문 그대로', () => {
  const c = kitCase();
  const base = packBase(c);
  const { z } = packVariant(c, 'nm', 'harness: claude-code\nexclude:\n  agents: [rev]\nreplace:\n  - from: "없음"\n    to: "x"\n    optional: true\n');
  assert.ok(z.files.get('.claude-plugin/plugin.json').equals(base.files.get('.claude-plugin/plugin.json')));
});

// ---- 9. 남은 언급 WARN ----

const warnsOf = (stderr) => [...stderr.matchAll(/^WARN (\S+):(\d+) (.*)$/gm)].map((m) => ({ file: m[1], line: Number(m[2]), message: m[3] }));

test('남은 언급 WARN: docs/notes.md 줄마다 맞음·안 맞음', () => {
  const c = kitCase();
  const { r } = packVariant(c, 'mention', [
    'harness: claude-code', 'exclude:', '  skills: [extra]', '  agents: [rev]', '  hooks: [guard]',
    'manifest:', '  name: demo-share', '',
  ].join('\n'));
  const warns = warnsOf(r.stderr).filter((w) => w.message.startsWith('뺀 '));
  const got = warns.filter((w) => w.file === 'docs/notes.md').map((w) => `${w.line} ${w.message}`);
  const want = [];
  NOTES.forEach(([, keys], i) => { for (const k of keys) want.push(`${i + 1} ${MSG[k]}`); });
  // 기대값이 비면 아래 비교가 의미 없다
  assert.ok(want.length >= 10, want.join('\n'));
  // 직접 값 몇 개: 3줄(rev), 4줄(rev-x 아님), 9줄(맨 extra 아님), 19줄(변경 기록 안), 26줄(코드 블록 안)
  assert.ok(got.includes(`3 ${MSG['agent rev']}`));
  assert.ok(!got.some((g) => g.startsWith('4 ')));
  assert.ok(!got.some((g) => g.startsWith('9 ')));
  assert.ok(!got.some((g) => g.startsWith('19 ')));
  assert.ok(got.includes(`26 ${MSG['agent rev']}`));
  assert.deepStrictEqual(got.sort(), want.sort());
  // 다른 파일의 언급도 잡는다 (SKILL.md의 `rev`)
  assert.ok(warns.some((w) => w.file === 'skills/demo/SKILL.md' && w.message === MSG['agent rev']), r.stderr);
});

test('남은 언급 WARN: 뺀 것이 없는 판은 0개', () => {
  const c = kitCase();
  const { r } = packVariant(c, 'none', 'harness: claude-code\nmanifest:\n  name: demo-share\nreplace:\n  - from: "공유"\n    to: "x"\n');
  assert.deepStrictEqual(warnsOf(r.stderr).filter((w) => w.message.startsWith('뺀 ')), []);
});

// ---- 10. ERROR 장면 ----

const V = (body) => ({ yaml: `harness: claude-code\n${body}` });
const ERRORS = [
  ['harness agents-md', { yaml: 'harness: agents-md\n' }, /하네스 agents-md는 아직 없음 \(지금은 claude-code만\)/],
  ['모르는 하네스', { yaml: 'harness: cursor\n' }, /모르는 하네스 cursor \(있는 것: claude-code\)/],
  ['모르는 최상위 칸', V('extras: 1\n'), /모르는 칸 "extras" \(허용: harness, include, exclude, replace, manifest\)/],
  ['맵이 아님', { yaml: '- a\n' }, /맵이 아님 \(허용 칸: harness, include, exclude, replace, manifest\)/],
  ['harness 없음', { yaml: 'exclude:\n  skills: [extra]\n' }, /harness가 없음/],
  ['같은 단위에 include·exclude', V('include:\n  skills: [demo]\nexclude:\n  skills: [extra]\n'), /skills가 include와 exclude에 둘 다 있음/],
  ['include.files', V('include:\n  files: [docs/]\n'), /include\.files: files는 exclude만 받는다/],
  ['exclude 모르는 칸', V('exclude:\n  workers: [rev]\n'), /exclude: 모르는 칸 "workers" \(허용: skills, agents, hooks, files\)/],
  ['같은 값 두 번', V('exclude:\n  skills: [extra, extra]\n'), /exclude\.skills: 같은 값이 두 번: extra/],
  ['이름 꼴', V('exclude:\n  agents: ["re v"]\n'), /exclude\.agents\[0\]: 이름은/],
  ['경로에 ..', V('exclude:\n  files: [docs/../x]\n'), /exclude\.files\[0\]: \.\. 조각은 쓸 수 없음/],
  ['경로가 /로 시작', V('exclude:\n  files: [/docs/]\n'), /exclude\.files\[0\]: \/로 시작하면 안 됨/],
  ['경로에 \\', V('exclude:\n  files: ["docs\\\\notes.md"]\n'), /exclude\.files\[0\]: \\ 대신 \/로 나눈다/],
  ['없는 스킬', V('exclude:\n  skills: [nope]\n'), /exclude\.skills: 출력에 없는 스킬 nope \(있는 것: demo, extra\)/],
  ['없는 에이전트', V('include:\n  agents: [nope]\n'), /include\.agents: 출력에 없는 에이전트 nope \(있는 것: impl, rev\)/],
  ['없는 훅', V('exclude:\n  hooks: [nope]\n'), /exclude\.hooks: 출력에 없는 훅 nope \(있는 것: guard, h, notify\)/],
  ['없는 경로', V('exclude:\n  files: [nope.md]\n'), /exclude\.files: 출력에 없는 경로 nope\.md/],
  ['없는 폴더', V('exclude:\n  files: [nope/]\n'), /exclude\.files: 출력에 없는 폴더 nope\//],
  ['plugin.json 빼기', V('exclude:\n  files: [.claude-plugin/plugin.json]\n'), /\.claude-plugin\/plugin\.json는 뺄 수 없음/],
  ['plugin.json 폴더째 빼기', V('exclude:\n  files: [.claude-plugin/]\n'), /\.claude-plugin\/plugin\.json는 뺄 수 없음 \(\.claude-plugin\/\)/],
  ['replace가 목록 아님', V('replace:\n  from: a\n'), /replace: 목록이어야 함/],
  ['replace from 빈 문자열', V('replace:\n  - from: ""\n    to: x\n'), /replace\[0\]\.from: 비어 있지 않은 문자열/],
  ['replace to 없음', V('replace:\n  - from: a\n'), /replace\[0\]\.to: 문자열이어야 함/],
  ['replace optional 불리언 아님', V('replace:\n  - from: a\n    to: b\n    optional: "yes"\n'), /replace\[0\]\.optional: true 또는 false/],
  ['replace files 경로가 남은 파일에 없음', V('replace:\n  - from: a\n    to: b\n    optional: true\n    files: [nope/]\n'), /replace\[0\]\.files: 남은 파일에 없는 경로 nope\//],
  ['replace 0번 맞음', V('replace:\n  - from: "없는 문구"\n    to: b\n'), /replace\[0\]: "없는 문구"이 한 번도 안 맞음/],
  ['manifest 모르는 칸', V('manifest:\n  homepage: x\n'), /manifest: 모르는 칸 "homepage" \(허용: name, version, author, description\)/],
  ['manifest.version 숫자', V('manifest:\n  version: 1.0\n'), /manifest\.version: 숫자로 읽힘 \(1\) — "1\.0\.0"처럼 따옴표로 감싸라/],
  ['manifest.name 꼴', V('manifest:\n  name: Demo\n'), /manifest\.name: .* 꼴의 문자열이어야 함: Demo/],
  ['판 파일이 .yaml 아님', { file: 'v.yml', yaml: 'harness: claude-code\n' }, /판 파일은 \.yaml로 끝나야 함/],
  ['판 파일 없음', { args: (c) => ['--variant-file', path.join(c.dir, 'nope.yaml')] }, /nope\.yaml: 판 파일이 없음/],
  ['--variant와 --variant-file 같이', { args: (c) => ['--variant', 'demo-kit', '--variant-file', variantFile(c.dir, 'x', 'harness: claude-code\n')], variants: { 'demo-kit': 'harness: claude-code\n' } }, /--variant와 --variant-file은 같이 쓸 수 없음/],
  ['--build와 --variant 같이', { args: (c) => ['--build', c.dir, '--variant', 'demo-kit'], noKit: true }, /--build는 --kit·--variant·--variant-file과 같이 쓸 수 없다/],
  ['없는 판 이름', { args: () => ['--variant', 'nope'], variants: { 'demo-kit': 'harness: claude-code\n' } }, /없는 판: nope \(있는 것: demo-kit\)/],
  ['--variant인데 variants/ 없음', { args: () => ['--variant', 'demo-kit'] }, /판 demo-kit: kit에 variants\/ 폴더가 없음/],
  ['판 이름 꼴', { args: () => [], variants: { 'demo-kit': 'harness: claude-code\n', Big: 'harness: claude-code\n' } }, /variants\/Big\.yaml: 판 이름은/],
  ['--variant 값 없음', { args: () => ['--variant'], last: true }, /알 수 없는 인자: --variant\n쓰는 법: plenum-pack /],
];

for (const [label, sc, re] of ERRORS) {
  test(`ERROR: ${label}`, () => {
    const c = kitCase({ variants: sc.variants || null });
    if (sc.prep) sc.prep(c);
    let args;
    if (sc.args) args = sc.args(c);
    else args = ['--variant-file', variantFile(c.dir, 'v', sc.yaml)];
    if (sc.file) {
      const f = path.join(c.dir, 'v', sc.file);
      fs.writeFileSync(f, sc.yaml);
      args = ['--variant-file', f];
    }
    const out = path.join(c.dir, 'out.zip');
    const head = sc.noKit ? [] : ['--kit', c.kit];
    const r = pack(sc.last ? [...head, '--out', out, ...args] : [...head, ...args, '--out', out], { cwd: c.dir });
    assert.strictEqual(r.status, 1, `${label}: 성공하면 안 된다\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^ERROR /m);
    assert.match(r.stderr, re, r.stderr);
    assert.ok(!fs.existsSync(out), `${label}: zip을 만들면 안 된다`);
  });
}

test('ERROR 장면 개수 확인 (표가 비면 위 반복이 0번 돈다)', () => {
  assert.strictEqual(ERRORS.length, 37);
});

test('ERROR: 판 형식 오류 메시지는 넘겨받은 판 경로로 시작한다', () => {
  const c = kitCase({ variants: { 'demo-kit': 'harness: claude-code\nextras: 1\n' } });
  const r1 = pack(['--kit', c.kit], { cwd: c.dir });
  assert.strictEqual(r1.status, 1);
  assert.match(r1.stderr, /^ERROR variants\/demo-kit\.yaml: 모르는 칸 "extras"/m);
  const given = path.join('v', 'mine.yaml');
  variantFile(c.dir, 'mine', 'harness: claude-code\nextras: 1\n');
  const r2 = pack(['--kit', c.kit, '--variant-file', given], { cwd: c.dir });
  assert.strictEqual(r2.status, 1);
  assert.ok(r2.stderr.startsWith(`ERROR ${given}: 모르는 칸 "extras"`), r2.stderr);
});
