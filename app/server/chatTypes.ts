// 3단계 채팅·세션·작동 중 공용 계약. 서버 모듈(chat·history·activity·terminal)과 웹이 같이 쓴다.
// 이 파일을 바꾸면 모든 단위에 영향이 간다 — 단위 작업 중에는 필드를 "추가"만 하고 지우거나 이름을 바꾸지 않는다.
//
// 프로토콜 근거: test/fixtures/stream/*.jsonl (claude 2.1.323 녹화) + 노트북 2.1.248 사전 조사. 필드 대조는 fixtures/stream/README.md.

export const MIN_CLAUDE_VERSION = '2.1.248';

// ── 모드 ─────────────────────────────────────────────
export type ModeName = '모드 없음' | '절약' | '기본' | '강화' | '최대' | '극한';
const SKILL_MODE: Record<string, ModeName> = { lite: '절약', orchestrate: '기본', plus: '강화', super: '최대', fable: '극한' };
// Skill 도구 입력의 skill 이름("jh-kit:orchestrate" 또는 "orchestrate") → 모드. 모드 스킬이 아니면 null
export function modeFromSkill(skill: unknown): ModeName | null {
  if (typeof skill !== 'string') return null;
  const m = /^(?:jh-kit:)?(lite|orchestrate|plus|super|fable)$/.exec(skill.trim());
  return m ? SKILL_MODE[m[1]] : null;
}
// 모드 질문(jh-kit mode 스킬) 답에서 "모드 없음"을 고른 경우만 모드로 친다. 나머지 모드는 Skill 호출이 진실
export function modeFromAnswer(label: unknown): ModeName | null {
  return typeof label === 'string' && /^모드 없음/.test(label.trim()) ? '모드 없음' : null;
}

// ── 한도 ─────────────────────────────────────────────
// rate_limit_event.rate_limit_info.unifiedWindows 의 five_hour·seven_day. 칸이 없으면 undefined(화면은 "—")
export interface LimitWindow { pct: number; resetsAt: number | null; status: string | null } // pct = utilization*100, resetsAt = 유닉스 초
export interface Limits {
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
  receivedAt: number;                                      // 받은 시각(ms)
  rejected: { window: string; resetsAt: number | null } | null; // status === 'rejected' 인 창
}

// ── 채팅 카드 ─────────────────────────────────────────
export interface QuestionOption { label: string; description?: string; recommended: boolean } // recommended: label에 "(추천)"/"(Recommended)"
export interface Question { question: string; header?: string; multiSelect: boolean; options: QuestionOption[] }
export interface SessionRule { toolName: string; ruleContent?: string }
export type Card =
  | { kind: 'question'; requestId: string; toolUseId?: string; questions: Question[]; isModeQuestion: boolean }
  | { kind: 'permission'; requestId: string; toolUseId?: string; toolName: string; input: unknown; description?: string;
      // "이 세션 동안 허용"에 쓸 규칙: permission_suggestions 중 type==='addRules' 인 것의 rules 만(재혁 결정 2026-11-13).
      // setMode·addDirectories 는 버린다(setMode acceptEdits 가 rm 까지 묻지 않고 실행시킴 — 녹화로 확인). 비면 버튼을 안 보인다
      sessionRules: SessionRule[];
      diff?: { path: string; old: string; new: string } }    // Edit/Write/MultiEdit 접힌 diff
  | { kind: 'unknown'; requestId: string; subtype: string; version: string | null }; // 처리 못 하는 control_request → 터미널로 열기 안내

// 카드 답 (POST /api/chats/:chatId/respond)
export type CardReply =
  | { requestId: string; action: 'allow' }
  | { requestId: string; action: 'allow-session' }
  | { requestId: string; action: 'deny'; reason?: string }                 // 이유는 deny message 로 Claude 에 전달(비면 기본 문구)
  | { requestId: string; action: 'answer'; answers: Record<string, string> }; // 질문 문장 → label(여러 개면 ", "로 이음, 기타 입력은 그 글자)

// ── 채팅 이벤트 (SSE, seq 는 채팅마다 1부터) ─────────────────
export type ChatState = 'starting' | 'running' | 'waiting' | 'idle' | 'ended';
export type ChatEvent = { seq: number; at: number } & (
  | { type: 'init'; sessionId: string; version: string | null; model: string | null; permissionMode: string | null }
  | { type: 'user'; text: string }
  | { type: 'text-delta'; messageId: string; index: number; text: string }      // 스트리밍 조각(--include-partial-messages)
  | { type: 'assistant-text'; messageId: string; text: string }                 // 끝난 글 블록(조각을 대체)
  | { type: 'tool'; toolUseId: string; name: string; input: unknown; parentToolUseId: string | null }
  | { type: 'tool-result'; toolUseId: string; isError: boolean; text: string }  // text 는 앞 2000자
  | { type: 'card'; card: Card }
  | { type: 'card-resolved'; requestId: string; outcome: 'allow' | 'allow-session' | 'deny' | 'answered' | 'cancelled'; detail?: string }
  | { type: 'worker'; worker: WorkerRun }                                       // 시작·갱신·끝 모두 같은 id 로 다시 보냄
  | { type: 'mode'; mode: ModeName }
  | { type: 'limits'; limits: Limits }
  | { type: 'state'; state: ChatState }
  | { type: 'result'; subtype: string; isError: boolean; text: string | null; denials: number }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; code: 'version-old' | 'concurrent' | 'unknown-request' | 'exit' | 'limit-rejected' | 'other'; message: string }
  | { type: 'exit'; code: number | null; signal: string | null }
);

// ── 워커(작동 중) ─────────────────────────────────────
// 채팅: id = Agent tool_use id(system/task_started 의 tool_use_id), 터미널: id = 훅의 agent_id
export interface WorkerRun {
  id: string;
  worker: string;            // subagent_type (예: jh-kit:w-implement 또는 w-implement)
  model: string | null;      // kit 워커 정의에서 읽은 모델(없으면 null)
  description: string | null;
  background: boolean;
  state: 'running' | 'done' | 'error';
  startedAt: number;
  endedAt: number | null;
}

export interface ActiveSession {
  sessionId: string;
  source: 'chat' | 'terminal';
  chatId: string | null;
  title: string | null;
  mode: ModeName | null;
  state: 'running' | 'waiting' | 'idle';
  workers: WorkerRun[];      // 턴 끝(Stop)에 끝난 전경 워커는 지운다. 백그라운드는 자기 결과까지 남김
  since: number;
}
// GET /api/projects/:id/activity
export interface ProjectActivity { projectId: string; sessions: ActiveSession[] }

// ── 지난 세션 ─────────────────────────────────────────
// GET /api/projects/:id/sessions
export interface SessionSummary {
  id: string;
  title: string;             // AI 제목 우선, 없으면 첫 질문(앞 80자)
  titleSource: 'ai' | 'first';
  startedAt: string | null;  // ISO
  lastAt: string | null;
  messages: number;
  mode: ModeName | null;     // sessions.json
  running: 'chat' | 'terminal' | null;
}
// GET /api/projects/:id/sessions/:sid/transcript — 이어하기 때 다시 그릴 기록(읽기 전용)
export type TranscriptItem =
  | { type: 'user'; text: string; at: string | null }
  | { type: 'assistant-text'; text: string; at: string | null }
  | { type: 'tools'; names: string[]; count: number }                          // 연속된 도구 호출을 한 줄로
  | { type: 'answered'; kind: 'question' | 'permission'; summary: string };     // 지난 카드: "답함: ○○"

// ── 실행 중 채팅 목록 ─────────────────────────────────
// GET /api/projects/:id/chats
export interface ChatInfo {
  chatId: string;
  projectId: string;
  sessionId: string | null;
  state: ChatState;
  mode: ModeName | null;
  model: string | null;
  effort: string | null;
  version: string | null;
  lastSeq: number;
}

// 모듈 사이 연결(app.ts 가 만든다). 단위 테스트는 가짜를 넣는다.
export interface ChatRegistry {
  findBySession(sessionId: string): ChatInfo | null;
  isPlenumChat(sessionId: string): boolean;                // 훅 중복 방지: Plenum 채팅 세션 훅은 무시
  close(chatId: string): Promise<void>;                    // stdin 닫고 기다림 → 시간 넘으면 트리째 종료
  onEvent(listener: (chat: ChatInfo, ev: ChatEvent) => void): () => void;
}
export interface ActivityView {
  terminalAlive(sessionId: string): boolean;               // 훅 SessionStart 뒤 SessionEnd 없음(유령 정리 포함)
  forProject(projectPath: string): ActiveSession[];
}
