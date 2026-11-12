// kit 레포 읽기. 파서는 컴파일러(compiler/lib/kit.js) 것을 그대로 쓴다 — 앱과 빌드가 같은 규칙으로 읽는다.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const COMPILER_LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'compiler', 'lib');
// 컴파일러는 루트 패키지라 그 의존성(js-yaml)은 루트 node_modules에 있다. app/ 의 npm ci·install 이 postinstall 로 루트도 설치한다.
let compiler: { loadKit: any; validate: any };
try {
  compiler = { loadKit: require(path.join(COMPILER_LIB, 'kit.js')).loadKit, validate: require(path.join(COMPILER_LIB, 'claude-code.js')).validate };
} catch (e: any) {
  if (e && e.code === 'MODULE_NOT_FOUND') {
    throw new Error(`컴파일러 의존성이 없다 (${String(e.message).split('\n')[0]}). plenum 루트에서 npm ci 를 하거나 app/ 에서 npm ci 를 다시 한다 (postinstall 이 루트를 설치한다)`);
  }
  throw e;
}
const { loadKit, validate } = compiler;

// 모드 파일 id → 화면 이름. 순서도 이 순서 (mode 스킬의 선택지 순서). tables/ 중에는 check 만 "쓰는 모드"로 센다
// (tables/workers.yaml 은 references/workers.md 전체 목록이라 모드가 아니다).
const MODE_ORDER: [kind: 'modes' | 'tables', id: string, label: string][] = [
  ['modes', 'lite', '절약'],
  ['modes', 'orchestrate', '기본'],
  ['modes', 'plus', '강화'],
  ['modes', 'super', '최대'],
  ['modes', 'fable', '극한'],
  ['tables', 'check', '/check'],
];

export interface ModeUse { mode: string; fallback: boolean }

export interface WorkerView {
  name: string;
  file: string;          // kit 레포 기준 경로 (kit/workers/<이름>.md)
  stage: string;
  summary: string;
  description: string;   // {{tier}} 등을 채운 값
  model: string;
  effort: string;
  tools: string;
  maxTurns: number | null;
  isolation: string | null;
  modes: ModeUse[];
}

export interface KitView {
  ok: true;
  repo: string;
  name: string;
  version: string;
  stages: string[];
  workers: WorkerView[];
}

export interface KitProblem { ok: false; repo: string | null; message: string }

const cap = (m: string) => m.charAt(0).toUpperCase() + m.slice(1);

export function readKit(repo: string | null): KitView | KitProblem {
  if (!repo) return { ok: false, repo: null, message: 'kit 레포 경로가 지정되지 않았다' };
  const kitDir = path.join(repo, 'kit');
  if (!fs.existsSync(path.join(kitDir, 'kit.yaml'))) return { ok: false, repo, message: `kit/kit.yaml이 없다: ${kitDir}` };
  let kit: any;
  try {
    kit = loadKit(kitDir);
    validate(kit);
  } catch (e: any) {
    return { ok: false, repo, message: `kit을 읽지 못했다 — ${e.message}` };
  }
  const uses = new Map<string, ModeUse[]>();
  const add = (w: string, u: ModeUse) => {
    const list = uses.get(w) || [];
    if (!list.some((x) => x.mode === u.mode && x.fallback === u.fallback)) list.push(u);
    uses.set(w, list);
  };
  for (const [kind, id, label] of MODE_ORDER) {
    const t = kit[kind].get(id);
    if (!t) continue;
    for (const s of t.slots) add(String(s.worker), { mode: label, fallback: false });
    for (const f of t.fallback || []) add(String(f), { mode: label, fallback: true });
  }
  const workers: WorkerView[] = [];
  for (const w of kit.workers.values()) {
    const f = w.fields;
    const tier = `${cap(w.model)} ${w.effort}`;
    const description = String(f.description || '').split('{{tier}}').join(tier).split('{{Model}}').join(cap(w.model)).split('{{effort}}').join(w.effort);
    workers.push({
      name: w.name,
      file: `kit/workers/${w.file}`,
      stage: String(f.stage),
      summary: String(f.summary),
      description,
      model: w.model,
      effort: w.effort,
      tools: Array.isArray(f.tools) ? f.tools.join(', ') : String(f.tools ?? ''),
      maxTurns: typeof f.maxTurns === 'number' ? f.maxTurns : null,
      isolation: f.isolation === undefined || f.isolation === null ? null : String(f.isolation),
      modes: uses.get(w.name) || [],
    });
  }
  const stages: string[] = kit.meta.stages.map(String);
  const order = (s: string) => stages.indexOf(s);
  workers.sort((a, b) => order(a.stage) - order(b.stage) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, repo, name: String(kit.meta.name), version: String(kit.meta.version), stages, workers };
}
