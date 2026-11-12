// 워커 파일·kit.yaml 편집: 바뀌는 줄의 값만, 나머지는 바이트 그대로
import { describe, expect, test } from 'vitest';
import { bumpPatch, commitMessage, getKitYamlVersion, getWorkerFields, setKitYamlVersion, setWorkerFields, versionProblem } from '../server/kitedit.ts';

const WORKER = [
  '---',
  'name: impl',
  'description: "구현 워커 ({{tier}}). model: 은 여기서 안 바뀐다"',
  'tools: Read, Edit',
  'model: sonnet',
  'effort: medium',
  'maxTurns: 80',
  '---',
  '',
  '본문 첫 줄',
  'model: sonnet',
  'effort: medium',
  '',
].join('\n');

describe('setWorkerFields', () => {
  test('머리말의 model·effort 줄만 바뀌고 나머지는 바이트 그대로', () => {
    const out = setWorkerFields(WORKER, { model: 'opus', effort: 'xhigh' });
    const a = WORKER.split('\n');
    const b = out.split('\n');
    expect(b.length).toBe(a.length);
    const changed = a.map((l, i) => (l === b[i] ? null : i)).filter((i) => i !== null);
    expect(changed).toEqual([4, 5]);
    expect(b[4]).toBe('model: opus');
    expect(b[5]).toBe('effort: xhigh');
    // 본문의 같은 문자열은 그대로
    expect(b[10]).toBe('model: sonnet');
    expect(b[11]).toBe('effort: medium');
    expect(getWorkerFields(out)).toEqual({ model: 'opus', effort: 'xhigh' });
  });

  test('CRLF 파일은 CRLF 유지', () => {
    const crlf = WORKER.split('\n').join('\r\n');
    const out = setWorkerFields(crlf, { model: 'haiku', effort: 'low' });
    expect(out).toBe(crlf.replace('model: sonnet\r\n', 'model: haiku\r\n').replace('effort: medium\r\n', 'effort: low\r\n'));
    expect(out.split('\r\n').length).toBe(crlf.split('\r\n').length);
    expect((out.match(/\r\n/g) || []).length).toBe((crlf.match(/\r\n/g) || []).length);
    expect(getWorkerFields(out)).toEqual({ model: 'haiku', effort: 'low' });
  });

  test('한 줄만 CRLF여도 그 줄 것을 유지', () => {
    const mixed = WORKER.replace('model: sonnet\n', 'model: sonnet\r\n');
    const out = setWorkerFields(mixed, { model: 'opus', effort: 'high' });
    expect(out).toContain('model: opus\r\neffort: high\nmaxTurns');
  });

  test('따옴표·주석 모양 유지', () => {
    const q = WORKER.replace('model: sonnet\n', 'model: "sonnet"  # 메모\n');
    expect(setWorkerFields(q, { model: 'opus', effort: 'medium' })).toContain('model: "opus"  # 메모\n');
  });

  test('줄이 없거나 두 번 있으면 오류', () => {
    expect(() => setWorkerFields(WORKER.replace('effort: medium\nmaxTurns', 'maxTurns'), { model: 'opus', effort: 'high' })).toThrow(/effort: 줄이 없다/);
    expect(() => setWorkerFields(WORKER.replace('maxTurns: 80', 'model: haiku'), { model: 'opus', effort: 'high' })).toThrow(/model: 줄이 2번/);
    // 머리말 밖에만 있으면 없는 것
    expect(() => setWorkerFields('---\nname: x\n---\nmodel: a\neffort: b\n', { model: 'opus', effort: 'high' })).toThrow(/model: 줄이 없다/);
    expect(() => setWorkerFields('', { model: 'opus', effort: 'high' })).toThrow(/머리말/);
    expect(() => setWorkerFields('---\nmodel: a\n', { model: 'opus', effort: 'high' })).toThrow(/머리말 끝/);
  });

  test('모르는 값은 오류', () => {
    expect(() => setWorkerFields(WORKER, { model: 'gpt', effort: 'high' })).toThrow(/모르는 model/);
    expect(() => setWorkerFields(WORKER, { model: 'opus', effort: 'ultra' })).toThrow(/모르는 effort/);
  });
});

describe('버전', () => {
  test('bumpPatch', () => {
    expect(bumpPatch('2.1.1')).toBe('2.1.2');
    expect(bumpPatch('0.0.9')).toBe('0.0.10');
    expect(() => bumpPatch('2.1')).toThrow();
    expect(() => bumpPatch('')).toThrow();
  });

  const YAML = 'name: demo-kit\nversion: "0.0.1"\ndescription: "version: 1.0.0 은 산문"\ntiers:\n  - tier: Sonnet medium\n    version: "9.9.9"\n';

  test('kit.yaml version 줄만 바뀐다 (따옴표 모양 유지)', () => {
    const out = setKitYamlVersion(YAML, '0.0.2');
    expect(out).toBe(YAML.replace('version: "0.0.1"', 'version: "0.0.2"'));
    expect(getKitYamlVersion(out)).toBe('0.0.2');
    const bare = YAML.replace('"0.0.1"', '0.0.1');
    expect(setKitYamlVersion(bare, '0.0.2')).toBe(bare.replace('version: 0.0.1', 'version: 0.0.2'));
    const crlf = YAML.split('\n').join('\r\n');
    expect(setKitYamlVersion(crlf, '0.0.2')).toBe(crlf.replace('version: "0.0.1"\r\n', 'version: "0.0.2"\r\n'));
  });

  test('version 줄이 없거나 두 번이면 오류', () => {
    expect(() => setKitYamlVersion('name: x\n', '0.0.2')).toThrow(/없다/);
    expect(() => setKitYamlVersion('version: "0.0.1"\nversion: "0.0.1"\n', '0.0.2')).toThrow(/2번/);
    expect(() => setKitYamlVersion('version: abc\n', '0.0.2')).toThrow(/x\.y\.z/);
  });

  test('세 곳 일치 검사', () => {
    expect(versionProblem({ kitYaml: '1.0.0', packageJson: '1.0.0', lockTop: '1.0.0', lockRoot: '1.0.0' })).toBeNull();
    expect(versionProblem({ kitYaml: '1.0.0', packageJson: '1.0.1', lockTop: '1.0.0', lockRoot: '1.0.0' })).toMatch(/package\.json 1\.0\.1/);
    expect(versionProblem({ kitYaml: '1.0.0', packageJson: '1.0.0', lockTop: '1.0.0', lockRoot: null })).toMatch(/없음/);
    expect(versionProblem({ kitYaml: null, packageJson: null, lockTop: null, lockRoot: null })).not.toBeNull();
  });

  test('커밋 메시지는 바뀐 칸만', () => {
    expect(commitMessage('impl', { model: 'sonnet', effort: 'medium' }, { model: 'opus', effort: 'xhigh' }, '0.0.2')).toBe('impl: model sonnet → opus, effort medium → xhigh (0.0.2)');
    expect(commitMessage('impl', { model: 'sonnet', effort: 'medium' }, { model: 'sonnet', effort: 'high' }, '0.0.2')).toBe('impl: effort medium → high (0.0.2)');
    expect(commitMessage('impl', { model: 'sonnet', effort: 'medium' }, { model: 'opus', effort: 'medium' }, '0.0.2')).toBe('impl: model sonnet → opus (0.0.2)');
  });
});
