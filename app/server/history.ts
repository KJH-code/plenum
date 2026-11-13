// 지난 세션: <claudeHome>/projects/*/<세션ID>.jsonl 에서 그 프로젝트 세션 목록과 이어하기용 기록을 만든다.
// 폴더 이름으로 대조하지 않는다 — 한글 경로끼리 같은 이름이 된다(pathkey.ts). 줄의 cwd 로 대조한다.
// 줄 type 근거: test/fixtures/history (claude 2.1.323). 모르는 type 은 건너뛴다. JSON 이 아닌 줄도 건너뛴다.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { modeFromSkill, type ModeName, type SessionSummary, type TranscriptItem } from './chatTypes.ts';
import { UserError } from './errors.ts';
import { samePath } from './pathkey.ts';
import { readSessions } from './store.ts';

export interface HistoryOptions {
  claudeHome: string;
  cfgDir: string;
  platform?: NodeJS.Platform;
  runningOf?(sessionId: string): 'chat' | 'terminal' | null;
}

const SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isSessionId(s: unknown): s is string { return typeof s === 'string' && SID.test(s); }

// ── 줄 읽기 ───────────────────────────────────────────
async function forEachLine(file: string, fn: (j: any) => void) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let j: any;
    try { j = JSON.parse(line); } catch { continue; }
    if (j && typeof j === 'object' && !Array.isArray(j)) fn(j);
  }
}

// 사람 메시지: type user, isMeta·isSidechain 아님, toolUseResult 없음, 글이 있음(tool_result 만 있는 건 아님). 아니면 null
function humanText(j: any): string | null {
  if (j.type !== 'user' || j.isMeta || j.isSidechain || j.toolUseResult !== undefined) return null;
  const c = j.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return null;
  const texts = c.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text as string);
  return texts.length ? texts.join('\n') : null;
}

function assistantText(j: any): string | null {
  if (j.type !== 'assistant' || j.isSidechain) return null;
  const c = j.message?.content;
  if (!Array.isArray(c)) return null;
  const t = c.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text as string).join('\n');
  return t.trim() ? t : null;
}

function toolUses(j: any): { id: string; name: string; input: any }[] {
  if (j.type !== 'assistant' || j.isSidechain || !Array.isArray(j.message?.content)) return [];
  return j.message.content.filter((b: any) => b && b.type === 'tool_use' && typeof b.name === 'string').map((b: any) => ({ id: String(b.id ?? ''), name: b.name, input: b.input }));
}

// ── 한 파일 요약 (경로·mtime·크기 기준 캐시) ───────────────
interface Parsed {
  cwd: string | null;
  firstQuestion: string | null;
  humans: number;
  assistantIds: number;   // 글이 있는 assistant 메시지의 서로 다른 message.id 수
  firstAt: string | null;
  lastAt: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  summary: string | null;
  skillMode: ModeName | null;
}
const cache = new Map<string, { mtimeMs: number; size: number; parsed: Parsed }>();

async function parseFile(file: string): Promise<Parsed | null> {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.parsed;
  const p: Parsed = { cwd: null, firstQuestion: null, humans: 0, assistantIds: 0, firstAt: null, lastAt: null, customTitle: null, aiTitle: null, summary: null, skillMode: null };
  const ids = new Set<string>();
  try {
    await forEachLine(file, (j) => {
      if (p.cwd === null && typeof j.cwd === 'string') p.cwd = j.cwd;
      if (typeof j.timestamp === 'string') { if (p.firstAt === null) p.firstAt = j.timestamp; p.lastAt = j.timestamp; }
      if (j.type === 'custom-title' && typeof j.customTitle === 'string' && j.customTitle.trim()) p.customTitle = j.customTitle;
      else if (j.type === 'ai-title' && typeof j.aiTitle === 'string' && j.aiTitle.trim()) p.aiTitle = j.aiTitle;
      else if (j.type === 'summary' && typeof j.summary === 'string' && j.summary.trim()) p.summary = j.summary;
      const h = humanText(j);
      if (h !== null) { p.humans++; if (p.firstQuestion === null && !isCommandLine(h)) p.firstQuestion = h; }
      if (assistantText(j) !== null) ids.add(String(j.message?.id ?? j.uuid ?? ''));
      for (const t of toolUses(j)) if (t.name === 'Skill') { const m = modeFromSkill(t.input?.skill); if (m) p.skillMode = m; }
    });
  } catch { return null; } // 읽는 중 지워졌거나 권한 없음
  p.assistantIds = ids.size;
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, parsed: p });
  return p;
}

// projects/*/ 바로 아래 *.jsonl (하위 폴더 <sid>/subagents 는 안 본다). 정렬된 순회
function sessionFiles(claudeHome: string, only?: string): { sid: string; file: string }[] {
  const root = path.join(claudeHome, 'projects');
  let dirs: fs.Dirent[];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out: { sid: string; file: string }[] = [];
  for (const d of dirs.filter((x) => x.isDirectory()).map((x) => x.name).sort()) {
    let files: fs.Dirent[];
    try { files = fs.readdirSync(path.join(root, d), { withFileTypes: true }); } catch { continue; }
    for (const f of files.filter((x) => x.isFile() && x.name.endsWith('.jsonl')).map((x) => x.name).sort()) {
      const sid = f.slice(0, -'.jsonl'.length);
      if (only !== undefined && sid !== only) continue;
      out.push({ sid, file: path.join(root, d, f) });
    }
  }
  return out;
}

// 명령 줄: /model·/usage 같은 내장 명령(<command-name> 으로 시작)과 그 출력(<local-command-stdout>·<local-command-stderr>).
// 첫 질문 후보에서 건너뛴다. <command-message> 로 시작하는 스킬 호출은 진짜 질문이다
function isCommandLine(s: string): boolean {
  return /^\s*<(command-name|local-command-stdout|local-command-stderr)>/.test(s);
}

// 스킬·슬래시 명령으로 시작한 첫 질문(<command-message>…<command-name>/x</command-name><command-args>y</command-args>)은 "/x y" 로 보인다
export function promptLabel(s: string): string {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(s);
  if (!name) return s;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s);
  return [name[1].trim(), args ? args[1].trim() : ''].filter(Boolean).join(' ');
}

function oneLine(s: string, n: number): string {
  return Array.from(s.replace(/\s*[\r\n]+\s*/g, ' ').trim()).slice(0, n).join('');
}

export async function listSessions(projectPath: string, opts: HistoryOptions): Promise<SessionSummary[]> {
  const platform = opts.platform ?? process.platform;
  const meta = readSessions(opts.cfgDir);
  const out: SessionSummary[] = [];
  for (const { sid, file } of sessionFiles(opts.claudeHome)) {
    const p = await parseFile(file);
    if (!p || p.cwd === null || !samePath(p.cwd, projectPath, platform)) continue;
    if (p.firstQuestion === null) continue; // 진짜 사람 메시지가 없음(/usage 만 친 세션 등)
    const ai = p.customTitle ?? p.aiTitle ?? p.summary;
    const m = meta[sid]?.mode;
    out.push({
      id: sid,
      title: ai !== null ? ai.trim() : oneLine(promptLabel(p.firstQuestion), 80),
      titleSource: ai !== null ? 'ai' : 'first',
      startedAt: p.firstAt,
      lastAt: p.lastAt,
      messages: p.humans + p.assistantIds,
      mode: m ?? p.skillMode ?? null,
      running: opts.runningOf?.(sid) ?? null,
    });
  }
  // lastAt 내림차순(없으면 맨 뒤), 같으면 id 오름차순
  out.sort((a, b) => {
    const ta = a.lastAt ? Date.parse(a.lastAt) : -Infinity;
    const tb = b.lastAt ? Date.parse(b.lastAt) : -Infinity;
    if (ta !== tb) return tb - ta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return out;
}

// cwd 가 같은 <sid>.jsonl. 없으면 null
export async function findSessionFile(projectPath: string, sid: string, opts: HistoryOptions): Promise<string | null> {
  const platform = opts.platform ?? process.platform;
  for (const { file } of sessionFiles(opts.claudeHome, sid)) {
    const p = await parseFile(file);
    if (p && p.cwd !== null && samePath(p.cwd, projectPath, platform)) return file;
  }
  return null;
}

// AskUserQuestion 답 label 에서 추천 표시를 뗀다 ("a.txt (Recommended)" → "a.txt")
function cleanLabel(s: string): string { return s.replace(/\s*\((?:추천|Recommended)\)\s*$/i, '').trim(); }

function resultText(block: any): string {
  const c = block?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b: any) => b && b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n');
  return '';
}

// 답한 질문의 label 들. toolUseResult.answers 가 먼저, 없으면 tool_result 글의 "질문"="label" 꼴에서
function answerLabels(line: any, block: any): string[] {
  const a = line.toolUseResult?.answers;
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    return Object.keys(a).map((k) => a[k]).filter((v): v is string => typeof v === 'string').flatMap((v) => v.split(', ')).map(cleanLabel).filter(Boolean);
  }
  const t = resultText(block);
  if (!/^Your questions have been answered/.test(t)) return [];
  return Array.from(t.matchAll(/"="([^"]*)"/g), (m) => cleanLabel(m[1])).filter(Boolean);
}

// 사용자가 거부한 도구: tool_result.is_error 이고 그 줄의 permissionDecision 이 { decision: 'reject', source: 'user_reject' }.
// 승인 요청에 답이 없어 막힌 것(source 'config', toolDenialUnanswered 'stream-closed')은 사람이 고른 게 아니라 뺀다.
function userDenied(line: any, block: any): boolean {
  const pd = line.permissionDecision;
  return block?.is_error === true && !!pd && pd.decision === 'reject' && pd.source === 'user_reject';
}

function toolDetail(input: any): string {
  const v = input?.command ?? input?.file_path ?? input?.path ?? input?.url ?? '';
  return typeof v === 'string' ? oneLine(v, 60) : '';
}

export async function readTranscript(projectPath: string, sid: string, opts: HistoryOptions): Promise<TranscriptItem[]> {
  if (!isSessionId(sid)) throw new UserError(400, `세션 ID 모양이 아니다: ${String(sid)}`);
  const file = await findSessionFile(projectPath, sid, opts);
  if (!file) throw new UserError(404, '이 프로젝트에 없는 세션');
  const items: TranscriptItem[] = [];
  const uses = new Map<string, { name: string; input: any }>();
  let tools: { type: 'tools'; names: string[]; count: number } | null = null;
  const push = (it: TranscriptItem) => { items.push(it); tools = null; };
  await forEachLine(file, (j) => {
    const at = typeof j.timestamp === 'string' ? j.timestamp : null;
    const h = humanText(j);
    if (h !== null) { push({ type: 'user', text: h, at }); return; }
    if (j.type === 'assistant' && !j.isSidechain) {
      const t = assistantText(j);
      if (t !== null) push({ type: 'assistant-text', text: t, at });
      for (const u of toolUses(j)) {
        uses.set(u.id, { name: u.name, input: u.input });
        if (u.name === 'AskUserQuestion') continue; // 답한 질문 줄로 보인다
        if (!tools) { tools = { type: 'tools', names: [], count: 0 }; items.push(tools); }
        if (!tools.names.includes(u.name)) tools.names.push(u.name);
        tools.count++;
      }
      return;
    }
    if (j.type === 'user' && !j.isSidechain && Array.isArray(j.message?.content)) {
      for (const b of j.message.content) {
        if (!b || b.type !== 'tool_result') continue;
        const u = uses.get(String(b.tool_use_id ?? ''));
        if (!u) continue;
        if (u.name === 'AskUserQuestion' && !b.is_error) {
          const labels = answerLabels(j, b);
          if (labels.length) push({ type: 'answered', kind: 'question', summary: labels.join(', '), outcome: 'answered' });
        } else if (userDenied(j, b)) {
          const d = toolDetail(u.input);
          push({ type: 'answered', kind: 'permission', summary: `${u.name}${d ? ' ' + d : ''}`, outcome: 'denied' });
        }
      }
    }
  });
  return items;
}
