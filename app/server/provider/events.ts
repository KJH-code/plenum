// 드라이버 → 앱 공용 계약 (docs/research/multi-model-step0.md G절 초안).
// 원칙: 드라이버가 이해 못 한 것은 버리지 않고 'unknown' 으로 올린다. decode 는 throw 하지 않는다.
// G절 칸 이름·모양은 그대로 두고, 지금 채팅 동작을 바이트 단위로 지키는 데 필요한 값만 선택 칸으로 더했다(`// P1: 동작 보존`).

export type ProviderId = string;              // 설정 파일의 id ("claude", "codex", "opencode" …)
export type DriverKind = 'claude-stream' | 'acp';

/** 원문 보존. 화면의 "원문 보기", 로그, fixture 재생이 같이 쓴다. */
export interface Raw {
  provider: ProviderId;
  version: string | null;                     // 감지한 CLI 버전
  channel: 'stdout' | 'stderr' | 'jsonrpc' | 'file';
  text: string;                               // 받은 줄 그대로(잘라도 앞 64KB)
}

interface Base { seq: number; at: number; sessionId: string | null; raw?: Raw }

// ── 메시지 (ACP session/update: agent_message_chunk · agent_thought_chunk · user_message_chunk)
export type MessageEvent = Base & {
  type: 'message';
  role: 'user' | 'agent' | 'thought';
  messageId: string;
  /** 조각이면 'chunk', 끝난 블록이면 'final'(final 이 앞의 chunk 들을 대체) */
  phase: 'chunk' | 'final';
  text: string;
  index?: number;                             // P1: 동작 보존 — 조각의 content block 번호(text-delta.index)
};

// ── 도구 호출 (ACP tool_call / tool_call_update)
export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';
export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type ToolCallEvent = Base & {
  type: 'toolCall';
  toolCallId: string;
  title: string;                              // 한 줄 요약 (지금 toolLabel)
  kind: ToolKind;                             // 하네스 도구 이름 → kind 매핑은 드라이버 몫. 모르면 'other'
  status: ToolStatus;
  toolName?: string;                          // 하네스 원래 이름(Bash, shell, apply_patch …)
  rawInput?: unknown;
  output?: { text: string; isError: boolean };// 앞 2000자
  locations?: { path: string; line?: number }[];
  parentToolCallId?: string | null;           // 서브에이전트 안의 호출
};

// ── 승인 카드 (ACP session/request_permission)
export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
export interface PermissionOption {
  optionId: string;                           // 드라이버가 하네스 답으로 되돌릴 키
  name: string;                               // 버튼 글자
  kind: PermissionOptionKind;
  /** 허용·거부의 범위. Claude addRules(destination session) = 'session'. (G절 설명 참고) */
  scope: 'once' | 'session' | 'persistent' | 'unknown';
}
export type PermissionRequestEvent = Base & {
  type: 'requestPermission';
  requestId: string;
  toolCall: Pick<ToolCallEvent, 'toolCallId' | 'title' | 'kind' | 'toolName' | 'rawInput' | 'locations'>;
  options: PermissionOption[];                // 드라이버가 하네스에서 안전한 것만 골라 만든다
  diff?: { path: string; old: string; new: string }[];
  reason?: string;                            // 하네스가 붙인 설명(샌드박스 밖 쓰기 등)
  // P1: 동작 보존 — 지금 permission 카드의 sessionRules·toolUseId(tool_use_id 원값, 없으면 undefined)
  ext?: { claude: { sessionRules: { toolName: string; ruleContent?: string }[]; toolUseId?: string } };
};
export type PermissionOutcome =
  | { outcome: 'selected'; optionId: string; message?: string }   // reject_* 에 이유 문구
  | { outcome: 'cancelled' };

// ── 질문 카드 (ACP elicitation/create, form 모드). Claude AskUserQuestion, Codex request_user_input
export type QuestionEvent = Base & {
  type: 'elicitation';
  mode: 'form';                               // ACP 의 url 모드는 지금 다루지 않음(오면 unknown)
  requestId: string;
  questions: { question: string; header?: string; multiSelect: boolean;
               options: { label: string; description?: string; recommended: boolean }[]; allowFreeText: boolean }[];
  ext?: { claude: { toolUseId?: string } };   // P1: 동작 보존 — 지금 question 카드의 toolUseId
};
export type QuestionOutcome = { action: 'accept'; answers: Record<string, string> } | { action: 'decline' } | { action: 'cancel' };

// ── 사용량 (ACP 는 토큰 사용량만 다룸 → 한도 창은 ext)
export interface LimitWindow {
  id: string; label: string; usedPct: number | null; resetsAt: number | null; status: 'ok' | 'warning' | 'rejected' | null;
  rawStatus?: string | null;                  // P1: 동작 보존 — 하네스 status 글자 그대로(Limits 창의 status)
}
export type UsageEvent = Base & {
  type: 'usage';
  tokens?: { input?: number; output?: number; cachedInput?: number; reasoning?: number };
  windows?: LimitWindow[];                    // Claude five_hour/seven_day, Codex primary/secondary … 이름은 하네스 것
  ext?: true;
  rejected?: { window: string; resetsAt: number | null } | null;  // P1: 동작 보존 — Limits.rejected 와 같은 값
};

// ── 하위 작업 (서브에이전트·백그라운드 작업). Claude system/task_*
export type TaskEvent = Base & {
  type: 'task'; ext: true;
  taskId: string; parentToolCallId: string | null;
  name: string | null; description: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled'; background: boolean;
};

// ── 세션 시작·모드
export type SessionStartedEvent = Base & {
  type: 'sessionStarted';
  sessionId: string;
  model: string | null; mode: string | null;  // permission/approval 모드
  resumed: boolean;
  version: string | null;                     // P1: 동작 보존 — init 의 CLI 버전
  permissionMode: string | null;              // P1: 동작 보존 — init 의 permissionMode 원값(mode 와 같은 값)
  noSessionId?: true;                         // P1: 동작 보존 — session_id 가 문자열이 아니었음(sessionId 는 '')
};

// ── 종료 (ACP stopReason + 프로세스 종료를 분리)
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'error';
export type TurnEndEvent = Base & {
  type: 'turnEnd'; stopReason: StopReason; text: string | null; deniedCount?: number;
  rawSubtype: string;                         // P1: 동작 보존 — result.subtype 원값
  isError: boolean;                           // P1: 동작 보존 — result.is_error
};
export type ExitEvent = Base & { type: 'exit'; code: number | null; signal: string | null };

// ── 알 수 없는 이벤트: 절대 throw 하지 않는다
export type UnknownEvent = Base & {
  type: 'unknown';
  raw: Raw;                                   // 필수
  /** 'event' = 모르는 type/subtype, 'field' = 아는 type 인데 필수 칸이 없음/모양이 다름, 'parse' = JSON 아님 */
  reason: 'event' | 'field' | 'parse';
  hint: string | null;                        // 'item.started/todo_list' 같은 식별자
  /** 하네스가 답을 기다리는 요청이면 true → 드라이버가 안전 기본값(거부)으로 이미 답했음 */
  answeredWithDefault: boolean;
  reply?: unknown;                            // P1: 동작 보존 — 앱이 하네스에 쓸 기본 답 원문(answeredWithDefault 일 때)
  requestId?: string;                         // P1: 동작 보존 — 그 요청의 id(unknown 카드의 requestId)
};

export type ProviderEvent =
  | MessageEvent | ToolCallEvent | PermissionRequestEvent | QuestionEvent | UsageEvent | TaskEvent
  | SessionStartedEvent | TurnEndEvent | ExitEvent | UnknownEvent;

// ── 드라이버 계약
export interface Capabilities {
  // 메인 조건: session && permissionCards && resume
  session: boolean;          // 한 프로세스에 여러 턴 (stdin 스트림, JSON-RPC 스레드)
  permissionCards: boolean;  // 승인을 앱으로 넘길 수 있음
  resume: boolean;           // 세션 id 로 이어하기
  // 워커 조건: oneshot (설정에 worker 블록이 있을 때만 워커로 씀 — roleOf)
  oneshot: boolean;          // 프롬프트 하나 → 끝 → 결과 텍스트
  questionCards: boolean; interrupt: boolean; usageWindows: boolean; tokenUsage: boolean;
  allowForSession: boolean;  // scope 'session' 인 허용 옵션이 있음
  modelSelect: boolean; effortSelect: boolean; jsonOutput: boolean;
}
export type Role = 'main' | 'worker' | 'none';
// 역할 판정은 여기 한 곳. 기능(감지) + 설정(worker 블록 유무)
export const roleOf = (c: Capabilities, cfg: { worker?: unknown }): Role[] =>
  [ ...(c.session && c.permissionCards && c.resume ? ['main' as const] : []),
    ...(c.oneshot && cfg.worker ? ['worker' as const] : []) ];

export interface Driver {
  kind: DriverKind;
  /** --version·--help 결과로 기능을 정한다. P2 에서 구현 */
  detect?(probe: { version: string | null; help: Record<string, string> }): { capabilities: Capabilities; warnings: string[] };
  /** 원문 한 단위 → 내부 이벤트. 예외를 던지지 않는다(안에서 try/catch → unknown) */
  decode(raw: Raw): ProviderEvent[];
  answerPermission(requestId: string, o: PermissionOutcome): unknown;  // 하네스에 쓸 원문
  answerQuestion(requestId: string, o: QuestionOutcome): unknown;
  interrupt(): unknown | null;
  initialize(): unknown;                      // P1: 동작 보존 — 시작 때 쓰는 첫 요청 원문
  prompt(text: string): unknown;              // P1: 동작 보존 — 사용자 글 원문
}
