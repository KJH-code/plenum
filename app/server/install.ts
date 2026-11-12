// "설치본에 반영": 로컬 Claude Code 설치본을 kit 레포의 새 버전으로 바꾼다.
// claude plugin marketplace update kjh-code → claude plugin update <kit 이름>@kjh-code 를 차례로 돌리고,
// installed_plugins.json 을 다시 읽어 설치본 버전 == 소스 버전(kit.yaml version)일 때만 성공으로 본다.
// 마켓플레이스를 먼저 갱신하지 않으면 plugin update 가 새 버전을 못 본다. -y 는 넘기지 않는다(마켓플레이스가 선언한 명령을 자동 수락하게 된다).
// claude 는 실행할 때마다 PATH에서 찾는다(저장하지 않는다).
import { readKit } from './kit.ts';
import { commandFor, resolveCommand, runCommand } from './open.ts';
import { UserError } from './projects.ts';
import { compareVersions, MARKETPLACE } from './versions.ts';

export interface InstallStepResult { label: string; command: string; code: number | null; output: string; timedOut: boolean; error?: string }
export interface InstallState {
  status: 'idle' | 'running' | 'ok' | 'fail';
  steps: InstallStepResult[];
  message: string;            // 사람이 읽을 결론 한 줄 (실패 이유 포함)
  claudePath: string | null;  // 이번에 찾은 claude 절대 경로 (표시만, 저장 안 함)
  sourceVersion: string | null;
  installedVersion: string | null;
}

export interface InstallOptions { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; timeoutMs?: number }

export const INSTALL_TIMEOUT_MS = 2 * 60 * 1000;
const OUTPUT_MAX = 4000;
const tail = (s: string) => (s.length > OUTPUT_MAX ? s.slice(-OUTPUT_MAX) : s);

const failed = (r: InstallStepResult) => r.code !== 0 || r.timedOut || !!r.error;

function why(r: InstallStepResult, timeoutMs: number): string {
  if (r.timedOut) return `${Math.round(timeoutMs / 1000)}초 안에 안 끝나서 멈췄다`;
  if (r.error) return r.error;
  return `종료 코드 ${r.code}`;
}

export async function runInstall(opts: { kitRepo: string; plugin: string; sourceVersion: string } & InstallOptions, state?: InstallState): Promise<InstallState> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const timeoutMs = opts.timeoutMs ?? INSTALL_TIMEOUT_MS;
  // state 를 받으면 그 객체를 채워 가며 진행 상황을 보여 준다
  const s: InstallState = state ?? { status: 'running', steps: [], message: '', claudePath: null, sourceVersion: null, installedVersion: null };
  Object.assign(s, { status: 'running', steps: [], message: '설치본에 반영하는 중', claudePath: null, sourceVersion: opts.sourceVersion, installedVersion: null });
  const fail = (message: string) => Object.assign(s, { status: 'fail', message });

  const claude = resolveCommand('claude', env, platform);
  if (!claude) return fail('claude를 PATH에서 못 찾았다 — Claude Code가 설치돼 있고 터미널에서 claude가 실행되는지 확인');
  s.claudePath = claude;

  const plans: { label: string; args: string[] }[] = [
    { label: '마켓플레이스 갱신', args: ['plugin', 'marketplace', 'update', MARKETPLACE] },
    { label: '플러그인 업데이트', args: ['plugin', 'update', `${opts.plugin}@${MARKETPLACE}`] },
  ];
  for (const p of plans) {
    const command = ['claude', ...p.args].join(' ');
    let r: InstallStepResult;
    try {
      const c = commandFor(claude, p.args, platform);
      const out = await runCommand(c, { cwd: opts.kitRepo, env, timeoutMs });
      r = { label: p.label, command, code: out.code, output: tail(out.output), timedOut: out.timedOut, ...(out.error ? { error: out.error } : {}) };
    } catch (e: any) {
      r = { label: p.label, command, code: null, output: '', timedOut: false, error: e && e.message ? e.message : String(e) };
    }
    s.steps.push(r);
    if (failed(r)) return fail(`${p.label}(${command})이 실패했다 — ${why(r, timeoutMs)}`);
  }

  const v = compareVersions(opts.kitRepo, { name: opts.plugin, version: opts.sourceVersion }, env);
  s.installedVersion = v.installed ? v.installed.version : null;
  if (s.installedVersion === opts.sourceVersion) return Object.assign(s, { status: 'ok', message: `설치본을 ${opts.sourceVersion}으로 바꿨다` });
  const now = s.installedVersion ?? `없음(${v.installedProblem ?? '설치본 못 찾음'})`;
  return fail(`명령은 끝났지만 설치본이 아직 ${now}다 — 소스는 ${opts.sourceVersion}. kit 레포의 새 버전이 push 됐는지 확인`);
}

// 서버 전역 작업 하나. 실행 중이면 다시 시작하지 않는다.
const idle = (): InstallState => ({ status: 'idle', steps: [], message: '', claudePath: null, sourceVersion: null, installedVersion: null });
let current: InstallState = idle();
let job: Promise<InstallState> | null = null;

const snapshot = (s: InstallState): InstallState => ({ ...s, steps: s.steps.map((x) => ({ ...x })) });

export function startInstall(kitRepo: string | null, opts: InstallOptions = {}): InstallState {
  if (job) throw new UserError(409, '이미 설치본에 반영하는 중이다');
  const k = readKit(kitRepo);
  if (!k.ok) throw new UserError(400, k.message);
  const state = idle();
  state.status = 'running';
  state.sourceVersion = k.version;
  current = state;
  job = runInstall({ kitRepo: k.repo, plugin: k.name, sourceVersion: k.version, ...opts }, state)
    .catch((e: any) => Object.assign(state, { status: 'fail' as const, message: `서버 오류: ${e && e.message ? e.message : String(e)}` }))
    .finally(() => { job = null; });
  return snapshot(state);
}

export function getInstall(): InstallState {
  return snapshot(current);
}

// 테스트용: 진행 중인 작업이 끝날 때까지 기다린다
export function waitInstall(): Promise<InstallState | null> {
  return job ? job.then(() => snapshot(current)) : Promise.resolve(null);
}

// 테스트용 초기화 (진행 중인 작업이 있으면 끝난 뒤에 부른다)
export function resetInstall(): void {
  current = idle();
  job = null;
}
