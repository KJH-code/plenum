# 멀티 모델(프로바이더) 0단계 — 조사와 설계

작성 2026-11-16 · 대상 Plenum 0.3.0 (`997cfe0`) · 코드 변경 없음(조사·설계만)

Plenum 은 지금 `claude -p` stream-json 하나만 다룬다. 이 문서는 아무 하네스(claude, codex, opencode …)나 등록해 메인 또는 워커로 쓰는 구조를 조사하고 설계한다.

## 요약

- **목표 구조**: 프로바이더 = 하네스, 모델 = 그 하네스가 받는 모델. 새 모델 = 설정 파일 하나(I절). 새 프로토콜만 드라이버 코드. 역할은 기능 목록으로 판정한다. 메인 = 세션 + 승인 카드 + 이어하기, 워커 = 단발 실행 + 결과(G절 `roleOf`).
- **드라이버는 셋**: Claude 직접(`claude-stream`, 지금 코드), 범용 ACP(`acp`), 워커용 단발(`oneshot`). 추천 근거는 F.6.
- **형식 변화 대응**: 원문 보존 + `unknown` 이벤트(절대 throw 안 함), `--help`·스키마 기반 기능 감지, 버전별 녹화 fixture 와 계약 테스트, 토큰 없는 주간 drift CI, 실제 녹화는 노트북 탐침(E·G·H절).
- **Codex**: `codex exec` 는 승인을 밖으로 못 넘긴다 → 워커 전용, 샌드박스로 막는다. 승인·질문·이어하기·한도는 `codex app-server`(experimental)에 있고, 공식 ACP 어댑터 `codex-acp` 가 그 위에 있다(C·D절).
- **약관**: 사용자 본인 로그인 + 수정 안 한 공식 CLI 실행 + 자격 증명 비접촉이 두 회사 문서와 맞는 유일한 형태다. 서드파티 래핑은 애매한 곳이 남는다(A절).

| 절 | 내용 |
|---|---|
| A | 약관 (양방향) |
| B | Codex 기능 지도 |
| C | Codex 비대화 실행 |
| D | 프로토콜 대응 |
| E | 노트북 탐침 |
| F | ACP 평가 |
| G | 내부 이벤트 모델 |
| H | 형식 변화 감지 |
| I | 프로바이더 설정 형식 |
| J | 하네스 조사 |
| — | 결정이 필요한 것 · 다음 단계 작업 단위 |

표기: **[실측]** = 이 조사 환경(Linux 클라우드 컨테이너)에서 해당 버전을 설치해 `--help`·스키마를 직접 받음. 로그인·모델 호출은 하지 않았다. **추측** = 근거 없이 판단한 것. 링크가 없는 사실은 버전과 출처 파일을 적었다.

## A. 약관 (양방향)

> **법률 자문 아님, 원문 링크 참고.** 확인한 날짜: 2026-11-16. 원문을 받은 페이지와 못 받은 페이지는 절 끝 표에 적었다.
> CLI 사실의 기준 버전(npm 최신, 2026-11-13 배포): **Claude Code 2.1.325**, Claude Agent SDK(TS) 0.3.325, **Codex CLI 0.169.0**, Codex SDK 0.169.0. 문서 페이지에는 버전 표기가 없다. 그래서 "이 버전이 최신이던 시점의 문서"로 읽는다. 표에서는 [CC 2.1.325]와 [Codex 0.169.0]으로 표시한다.

### A.1 판정 표

| 경우 | 쪽 | 판정 | 근거 요지 (인용) | 출처 |
|---|---|---|---|---|
| ① Claude Code 세션이 Codex CLI를 하위 프로세스로 부름 | Anthropic | **애매 (명시 없음)** | Claude Code가 다른 CLI를 실행하는 것을 막는 조항은 찾지 못했다. 다만 AUP가 다른 회사 약관을 우회하는 행위를 금지하므로, OpenAI 약관을 지키는 것이 조건이 된다. "Engage in actions or behaviors that circumvent the guardrails or terms of other platforms or services" / "Users are responsible for ensuring that agents they build or deploy, including actions those agents take through tools … comply" | https://www.anthropic.com/legal/aup (Effective Nov 12, 2026) |
| ① 〃 | OpenAI | **허용 명시 (조건부)** [Codex 0.169.0] | 요금 페이지의 기능 표에서 "Codex SDK, `codex exec`, and scriptable workflows"가 Plus·Pro에 available로 나온다. "`codex exec` reuses saved CLI authentication by default." 조건이 두 가지 있다. 자동화에는 API 키를 권장한다("The right way to authenticate automation is with an API key"). ChatGPT 로그인으로 CI를 돌리는 방법은 신뢰된 비공개 러너에만 쓰고, "Do not use this workflow for public or open-source repositories." OpenAI 이용약관(ToU)은 못 받았다. | https://learn.chatgpt.com/docs/pricing · https://learn.chatgpt.com/docs/non-interactive-mode · https://learn.chatgpt.com/docs/auth/ci-cd-auth |
| ② Codex(ChatGPT 로그인)가 `claude -p`를 하위 프로세스로 부름 | Anthropic | **애매 (허용 쪽 근거 있음)** [CC 2.1.325] | 소비자 약관은 자동화 접근을 금지하면서 예외를 둔다: "Except … where we otherwise explicitly permit it, to access the Services through automated or non-human means…". Claude Code 문서는 구독 OAuth를 스크립트용으로 안내한다: "For CI pipelines, scripts … generate a one-year OAuth token with `claude setup-token`" / "This token authenticates with your Claude subscription". 하지만 다른 회사 에이전트가 호출하는 경우는 명시가 없다. 또 "usage limits … assume ordinary, individual usage of Claude Code and the Agent SDK"라는 전제가 붙어 있다. | https://www.anthropic.com/legal/consumer-terms (Effective Oct 8, 2025) · https://code.claude.com/docs/en/authentication · https://code.claude.com/docs/en/legal-and-compliance |
| ② 〃 | OpenAI | **애매 (명시 없음)** | 받아 본 Codex 문서에는 Codex가 다른 회사 에이전트 CLI를 실행하는 것을 다루는 조항이 없다. ToU와 Usage Policies는 못 받았다(403). | https://learn.chatgpt.com/docs/auth · (못 받음) https://openai.com/policies/usage-policies |
| ③ 서드파티 앱(Plenum)이 `claude -p`를 사용자의 구독 로그인으로 래핑 | Anthropic | **애매. 경계선은 금지 명시** [CC 2.1.325] | **금지 명시:** "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through … plan credentials on behalf of their users." / "developers may not collect, store, or intermediate Claude.ai credentials or session tokens". **금지 아님 명시:** "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". **애매:** Agent SDK 문서에 "does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK"가 있고, 헤드리스 문서는 `claude -p`를 "the Agent SDK via the CLI"라고 부른다. | https://code.claude.com/docs/en/legal-and-compliance · https://code.claude.com/docs/en/agent-sdk/overview · https://code.claude.com/docs/en/headless · AUP |
| ③ 서드파티 앱이 Codex를 ChatGPT 로그인으로 래핑 | OpenAI | **허용 명시 (기술 문서 기준. 약관은 미확인)** [Codex 0.169.0] | app-server 문서: "Use it when you want a deep integration inside your own product: authentication, conversation history, approvals, and streamed agent events." 인증 모드에 대해서는 "`chatgpt` – Codex owns the ChatGPT OAuth flow, persists tokens, and refreshes them". SDK 문서: "Integrate Codex within your own application". 클라이언트 식별에 대해서는 "Use `clientInfo.name` to identify your client". | https://learn.chatgpt.com/docs/app-server · https://learn.chatgpt.com/docs/codex-sdk |

### A.2 해설

**① Claude 메인 + Codex 워커**
- OpenAI 쪽은 근거가 가장 분명하다. Plus·Pro 기능 표에 스크립트 실행이 들어 있고, `codex exec`는 저장된 ChatGPT 로그인을 그대로 쓴다 [Codex 0.169.0].
- Anthropic 쪽은 이 행위를 직접 다루는 조항이 없다. AUP 때문에 "OpenAI 약관을 지킬 것"이 간접 조건이 될 뿐이다.
- 걸리는 점: OpenAI ToU 원문을 이번에 받지 못했다. 기억 기반 추측으로는 ToU에 "Output을 자동·프로그램으로 추출하지 말라"는 문구가 있었다. 이 문구와 Codex 제품 문서의 관계는 애매하다.

**② Codex 메인 + Claude 워커 (판정만 함)**
- Anthropic은 본인의 구독 토큰을 "scripts"에 쓰라고 안내한다. 그래서 사용자 본인이 수정하지 않은 `claude`를 스크립트로 돌리는 것은 허용 쪽으로 읽힌다.
- 다만 호출 주체가 다른 회사 에이전트인 경우는 명시가 없다. "ordinary, individual usage"가 무엇인지도 정의되어 있지 않다.
- OpenAI 쪽은 받은 문서에 관련 조항이 없다.

**③ Plenum이 래핑하는 경우**
- Anthropic은 "앱이 로그인을 제공하거나, 사용자 대신 요청을 라우팅하거나, 토큰을 수집·저장·중개하는 것"을 명시적으로 금지한다. 반면 "사용자가 수정 안 된 바이너리에 자기 구독으로 로그인하는 것"은 막지 않는다고 명시한다.
- Plenum의 현재 구조(사용자 기기, 사용자 본인 로그인, 공식 바이너리 실행)는 후자에 가깝다. 하지만 Agent SDK 문서의 "rate limits를 제품에 제공하지 말라"는 문구 때문에 완전히 확정할 수는 없다.
- 확신이 필요하면 Anthropic에 문의하는 길이 있다. 해당 페이지에 "contact sales" 안내가 있다.
- OpenAI는 app-server와 SDK를 "자기 제품에 넣는 용도"로 문서화했고 ChatGPT 로그인 모드도 지원한다.

**인증 처리 방식 비교 (설계 추천)**

| 안 | 구현 비용 | 약관 리스크 | 나중에 바꾸기 |
|---|---|---|---|
| 1. 각 CLI가 자체 로그인을 처리하고, Plenum은 자격 증명에 손대지 않음 (현행) | 0 | 가장 낮음 (A·O 문서 모두 이 형태와 맞음) | 쉬움 |
| 2. Plenum이 토큰을 받아 주입 (`CLAUDE_CODE_OAUTH_TOKEN` 보관, Codex `chatgptAuthTokens`) | 중간 | Anthropic 쪽은 금지 명시("collect, store, or intermediate")에 걸림. Codex 쪽 모드는 experimental | 되돌리기 어려움 (저장된 토큰 처리 문제) |
| 3. API 키 경로를 선택지로 추가 | 낮음 | 가장 명확함 (Anthropic은 Agent SDK 개발자에게 API 키를, OpenAI는 자동화에 API 키를 권장). 대신 사용자에게 과금됨 | 쉬움 |

→ **추천: 1안을 기본으로 하고 3안은 선택지로만 둔다.** 2안은 하지 않는다. 1안은 지금 구조를 그대로 두면서 두 회사 문서와 모두 맞는 유일한 안이다. 3안은 구독 한도 해석이 바뀔 때를 대비한 탈출구로 비용이 싸다.

### A.3 Plenum이 지켜야 할 것

근거가 있는 것:
1. **로그인은 각 CLI의 자체 흐름으로만 한다** (`claude`의 /login, `codex login`). Plenum이 자체 로그인 화면이나 OAuth를 만들지 않는다. 근거: Claude Code legal("sign-in … must complete through Anthropic's own flow"), Codex app-server `chatgpt` 모드("Codex owns the ChatGPT OAuth flow").
2. **토큰과 자격 증명을 읽거나, 복사하거나, 저장하거나, 전송하지 않는다.** 대상은 Claude 자격 증명 파일, `CLAUDE_CODE_OAUTH_TOKEN` 값, `~/.codex/auth.json`이다. Codex app-server의 `chatgptAuthTokens` 모드도 쓰지 않는다. 근거: legal("may not collect, store, or intermediate…"), Codex auth("Treat `~/.codex/auth.json` like a password").
3. **수정하지 않은 공식 바이너리를 실행하고, 내장 인증 방법을 제거하거나 제한하지 않는다.** 근거: legal("The Claude Code binary must not be modified"). 이 조건은 "제품에 Claude Code를 넣는 고객"용 조항이라 Plenum에 적용되는지는 애매하다. 하지만 지키는 비용이 0이다.
4. **사용자 본인 계정을 사용자 본인 기기에서만 쓴다.** 다른 사람에게 세션을 원격으로 열어 주거나, 호스팅·중계 서버를 만들거나, 계정 공유 기능을 넣지 않는다. 근거: 소비자 약관("may not … make your Account available to anyone else"), legal("on behalf of their users"), AUP("Resell, proxy … route requests through consumer subscriptions").
5. **클라이언트 신원을 위장하지 않는다.** `claude`의 UA나 헤더를 조작하지 않는다. Codex app-server의 `clientInfo.name`에는 Plenum 고유 이름을 넣는다. 근거: AUP("misrepresent the product or client being used"), app-server 문서.
6. **이름과 브랜딩.** 제품명과 로고에 "Claude Code"나 "Anthropic"을 쓰지 않는다. "Claude Code를 실행한다"는 평문 설명은 된다. 프로바이더 표시 이름은 "Claude"로 한다. Agent SDK 브랜딩 지침이 메뉴 표기로 "Claude Code"를 허용하지 않기 때문이다. 근거: legal "Using the Claude Code name and logo", Agent SDK "Branding guidelines". Codex 쪽 브랜딩 조항은 확인하지 못했다.
7. **Codex를 네트워크에 노출하지 않는다.** app-server는 stdio나 loopback으로만 쓴다. 근거: "Non-loopback WebSocket listeners currently allow unauthenticated connections by default", "Don't expose Codex execution in untrusted or public environments" [Codex 0.169.0].
8. **공개 저장소인 Plenum의 CI에서는 구독 로그인을 쓰지 않는다.** 실제 모델을 부르는 테스트는 목업으로 하거나, 하더라도 API 키로 한다. 근거: OpenAI ci-cd-auth("Do not use this workflow for public or open-source repositories"). Anthropic 쪽은 추측이다.
9. **두 모델의 출력을 모델 학습에 쓰지 않는다.** 근거: AUP("Use outputs to train an AI model … without prior authorization"), 소비자 약관(경쟁 모델 개발·학습 금지).

추측:
10. 워커마다 `CODEX_HOME`을 따로 두고 `auth.json`을 복사하지 않는다. 토큰 갱신이 서로 꼬일 수 있다. OpenAI가 CI 맥락에서 "Do not share the same file across concurrent jobs or multiple machines"라고 쓴 것을 로컬에도 적용한 추측이다.
11. 상시 무인 루프나 대량 병렬 워커는 "ordinary, individual usage"를 벗어날 수 있다. 동시 실행 워커 수에 상한을 두는 것을 권장한다.
12. README에 "각 CLI의 약관과 요금제 조건은 사용자 책임이며, Plenum은 자격 증명을 다루지 않는다"고 고지한다.

### A.4 확인한 페이지 (2026-11-16)

| 페이지 | 상태 | 비고 |
|---|---|---|
| https://www.anthropic.com/legal/consumer-terms | 받아 봄 (200) | Effective Oct 8, 2025 |
| https://www.anthropic.com/legal/aup | 받아 봄 (200) | Effective Nov 12, 2026. 최근 개정이며, 이전 판과의 차이는 확인하지 않음 |
| https://code.claude.com/docs/en/legal-and-compliance | 받아 봄 (200) | docs.claude.com에서 리다이렉트됨. 날짜 표기 없음 |
| https://code.claude.com/docs/en/agent-sdk/overview | 받아 봄 (200) | docs.claude.com에서 리다이렉트됨 |
| https://code.claude.com/docs/en/headless | 받아 봄 (200) | |
| https://code.claude.com/docs/en/authentication | 받아 봄 (200) | |
| https://support.claude.com/en/articles/11145838 | 받아 봄 (200) | 관련 조항 없음 |
| https://www.anthropic.com/legal/commercial-terms | 받아 봄 (200) | Effective Jun 17, 2025. 이 절의 쟁점과 직접 관련된 문구 없음 (훑기만 함) |
| https://openai.com/policies/terms-of-use (row-terms-of-use 포함) | **못 받음** (403) | 내용 칸에 쓴 것은 기억 기반 추측 |
| https://openai.com/policies/usage-policies | **못 받음** (403) | |
| https://help.openai.com/en/articles/11369540 | **못 받음** (403) | |
| https://learn.chatgpt.com/docs/auth, /non-interactive-mode, /auth/ci-cd-auth, /codex-sdk, /app-server, /pricing | 받아 봄 (200) | developers.openai.com/codex/*에서 리다이렉트됨 |
| openai/codex 저장소 README | 받아 봄 (clone, HEAD f1ebc7b 2026-11-16) | "Sign in with ChatGPT … as part of your Plus, Pro, … plan" |

## B. Codex 기능 지도

기준: Codex CLI 0.169.0(`--help`·`app-server generate-json-schema` 실측, 소스 태그 `rust-v0.169.0`, 공식 문서 2026-11-16). 왼쪽 열은 Claude Code 플러그인이 쓰는 기능 종류다(이 레포 작성자가 쓰는 플러그인 기준. 내부 구조는 적지 않는다).

| Claude Code 쪽 기능 | Codex 대응물 | 상태 | 차이·우회 | 근거 |
|---|---|---|---|---|
| 스킬 (`SKILL.md`, 이름·설명 머리말) | 스킬 (`SKILL.md`, `name`·`description` 필수). 위치 `$CWD/.agents/skills`, 상위 폴더, `$REPO_ROOT/.agents/skills`, `$HOME/.agents/skills` | **있음** | 형식이 거의 같다. 폴더 위치와 부르는 문법이 다름(`$skill-name`). 빌드 대상 하나로 복사·변환 가능 | [skills](https://developers.openai.com/codex/skills) |
| 서브에이전트 (에이전트 파일: 모델·노력·도구 고정) | 서브에이전트. 내장 `default`·`worker`·`explorer`, 커스텀은 `~/.codex/agents/`·`.codex/agents/` 의 TOML. 동시 수 `agents.max_concurrent_threads_per_session` | **있음 (모양 다름)** | 머리말 마크다운이 아니라 TOML. 부모 세션의 샌드박스·승인 설정을 **상속**한다 → 에이전트별 권한 제한은 Claude 보다 약함(추측: 도구 목록 제한 칸이 있는지 미확인) | [subagents](https://developers.openai.com/codex/subagents), exec 이벤트 `collab_tool_call`(`codex-rs/exec/src/exec_events.rs`) |
| 훅 (UserPromptSubmit, PreToolUse, PreCompact, SessionStart …) | 훅. PreModelRequest, PostModelRequest, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, SessionEnd, SubagentStart, SubagentStop, UserPromptSubmit, Stop, Interrupt. `config.toml [hooks.<Event>]` | **있음** | 이벤트 이름이 거의 같다. 훅 "신뢰(trust)" 승인 단계가 따로 있다(`--dangerously-bypass-hook-trust`). 입출력 JSON 모양 대조는 탐침 후 | [hooks](https://developers.openai.com/codex/hooks), `codex exec --help` |
| 권한 규칙 (`permissions.allow/deny`, `Bash(git *)` 꼴) | execpolicy `.rules` (Starlark 풍 `prefix_rule(pattern=[…], decision=…)`), `~/.codex/rules/default.rules` + 샌드박스 모드 + 승인 정책 | **있음 (모양 다름)** | 규칙 언어가 다르다. 파일 경로 단위 Read/Edit 규칙은 없고 샌드박스(read-only / workspace-write / `--add-dir`)가 맡는다. 변환은 명령 접두 규칙만 1:1 | [rules](https://developers.openai.com/codex/rules), [sandbox](https://developers.openai.com/codex/sandbox) |
| 패키징 (플러그인 + 마켓플레이스) | `codex plugin add/list/remove`, `codex plugin marketplace add/list/remove/upgrade` | **있음** | 플러그인 형식(묶을 수 있는 것: 스킬·훅·MCP?)은 이번에 확인 못 함 → 다음 단계 조사 | `codex plugin --help`(0.169.0) |
| 압축 전 상태 저장 (PreCompact 훅) | PreCompact·PostCompact 훅, `thread/compact/start`, `compact_prompt`·`experimental_compact_prompt_file` | **있음** | 훅으로 같은 일을 할 수 있다. 압축 프롬프트 파일을 직접 줄 수 있어 Claude 보다 넓다 | [config reference](https://developers.openai.com/codex/config-reference) |
| 커밋 신원 검사 (PreToolUse 훅이 `git commit`·`push` 명령을 검사해 막음) | PreToolUse 훅 + execpolicy `prefix_rule(["git","push"], decision="prompt")` | **있음 (우회 필요)** | 훅이 같은 자리에 있으므로 같은 검사 스크립트를 쓸 수 있다(추측: 훅 입력의 명령 칸 이름 확인 필요). 더 확실한 이중 장치는 레포의 `core.hooksPath` git 훅(하네스와 무관하게 동작) | 위 hooks, rules |
| 프로젝트 지침 (`CLAUDE.md`) | `AGENTS.md` (전역 → 레포 루트 → cwd 순서로 쌓임), `project_doc_fallback_filenames` | **있음** | Claude Code 2.1.277+ 는 CLAUDE.md 가 없을 때만 AGENTS.md 를 읽는다. 공용 지침은 AGENTS.md 하나 + CLAUDE.md 에서 `@AGENTS.md` import | [AGENTS.md](https://developers.openai.com/codex/guides/agents-md), [Claude Code memory](https://code.claude.com/docs/en/memory) |
| 모델·노력 고정 워커 | `-m <모델>`, `-c model_reasoning_effort=<값>`, 프로필 `-p` (`$CODEX_HOME/<이름>.config.toml`) | **있음** | 노력 값은 열거형이 아니라 "모델이 광고하는 문자열"(`ReasoningEffort`). 허용 값은 app-server `model/list` 로 조회 | 스키마 `ReasoningEffort`, `codex exec --help` |
| 남은 한도 표시 | app-server `account/rateLimits/read`·`account/rateLimits/updated` (`usedPercent`, `windowDurationMins`, `resetsAt`) | **있음 (app-server 만)** | `exec --json` 에는 토큰 수만. 창 이름(5시간/주간)은 `windowDurationMins` 값으로 판별 | 스키마 `GetAccountRateLimitsResponse` |
| 질문 도구 (AskUserQuestion) | `request_user_input` → app-server `item/tool/requestUserInput` (experimental, 1~3개 질문) | **있음 (app-server 만)** | exec 에서는 "not supported in exec mode" 로 거절 | `codex-rs/exec/src/lib.rs`(0.169.0), 스키마 `ToolRequestUserInputParams` |

요약: **대응물이 없는 기능은 없다.** 차이는 모양(TOML·Starlark·폴더 위치)과 "exec 단발 모드에서는 승인·질문이 안 된다"는 점이다. 따라서 jh-kit 쪽에서 Codex 를 워커로 쓸 때는 승인 대신 **샌드박스로 막고**, 질문이 필요한 일은 워커로 보내지 않는다.

## C. Codex 비대화 실행

기준 버전: **Codex CLI 0.169.0** (npm `@openai/codex`, 2026-11-12 태그 `rust-v0.169.0`). 클라우드 컨테이너(Linux)에 설치해 `--help` 75개와 app-server 스키마를 받았다. 로그인·모델 호출은 하지 않았다. 실제 출력은 E절 탐침으로 받는다.

### C.1 두 가지 실행 방식

| | `codex exec` (단발) | `codex app-server` (장기 실행) |
|---|---|---|
| 형식 | `--json`: 이벤트 JSONL, 최상위 `type` 8종 | JSON-RPC 2.0 (stdio JSONL, `"jsonrpc"` 칸 생략). ClientRequest 109·ServerNotification 86·ServerRequest 10 |
| 상태 | 안정 | help 에 `[experimental]` 표시 |
| 승인 | **밖으로 못 넘긴다.** `approval_policy: Never` 고정, 승인·질문 요청은 거절 | 서버→클라이언트 요청으로 넘긴다 |
| 스키마 | 소스 `codex-rs/exec/src/exec_events.rs` | `codex app-server generate-json-schema` / `generate-ts` 로 **버전마다 생성 가능** (`--experimental` 포함 여부로 다름) |
| Plenum 역할 | 워커 (단발 실행 + 결과) | 메인 조건을 채움 (D절) |

근거: `codex exec --help`, `codex app-server --help`(0.169.0), `codex-rs/exec/src/lib.rs` "Default to never ask for approvals in headless mode", [non-interactive](https://developers.openai.com/codex/noninteractive), [app-server](https://developers.openai.com/codex/app-server).

### C.2 `exec --json` 이벤트 (0.169.0)

| type | 칸 |
|---|---|
| `thread.started` | `thread_id` (이어하기 키) |
| `turn.started` | — |
| `turn.completed` | `usage{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}` |
| `turn.failed` | `error{message}` |
| `item.started` / `item.updated` / `item.completed` | `item{id, type, …}` |
| `error` | `message` |

item `type`: `agent_message`, `reasoning`, `command_execution{command, aggregated_output, exit_code, status: in_progress\|completed\|failed\|declined}`, `file_change{changes[{path, kind: add\|delete\|update}], status}`, `mcp_tool_call`, `collab_tool_call{tool: spawn_agent\|send_input\|wait\|close_agent}`, `web_search`, `todo_list`, `error`.

형식 변화의 실례: 공식 문서 샘플에는 `cache_write_input_tokens` 가 없는데 0.169.0 소스에는 있다(`#[serde(default)]`). 문서가 소스보다 늦다 → 문서가 아니라 **녹화와 스키마**를 기준으로 삼는다.

### C.3 승인·샌드박스 (0.169.0)

| 항목 | 값 | 근거 |
|---|---|---|
| `-s/--sandbox` | `read-only`(exec 기본), `workspace-write`, `danger-full-access` | `codex exec --help`, [sandbox](https://developers.openai.com/codex/sandbox) |
| `-a/--ask-for-approval` | 대화형 최상위 `codex` 에만. help 값 `on-request`, `never`. 스키마 `AskForApproval` 에는 `untrusted`·`on-request`·`never`·`granular{…}` | `codex --help`, 스키마 `ThreadStartParams` |
| `--full-auto` | **0.169.0 help 에 없음** (예전 문서·스크립트가 쓰던 플래그. 바뀐 사례) | `grep full-auto help/*` 0건 |
| `--approve-for-me` | exec 전용. 승인 요청을 자동 리뷰어로 보냄. 스키마 `ApprovalsReviewer`: `user`, `auto_review`, `guardian_subagent` | `codex exec --help` |
| `--dangerously-bypass-approvals-and-sandbox` | 승인·샌드박스 전부 끔. 외부 샌드박스 안에서만 | `codex exec --help` |
| app-server 승인 요청 | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`(범위 `turn`\|`session`), 구버전 `execCommandApproval`·`applyPatchApproval` | 스키마 `methods` |
| 승인 답 `decision` | `accept`, `acceptForSession`, `{acceptWithExecpolicyAmendment}`(영구 규칙), `{applyNetworkPolicyAmendment}`(영구), `decline`(거부·턴 계속), `cancel`(거부·턴 중단). 파일 변경은 앞의 넷 중 `accept\|acceptForSession\|decline\|cancel` | 스키마 `CommandExecutionApprovalDecision`, [app-server](https://developers.openai.com/codex/app-server) |

**Windows**(문서 기준, 실측 안 함): 네이티브 샌드박스 3종 `mxc`(호환 기기에서 권장), `elevated`(관리자 설정 필요), `unelevated`(네트워크 격리 약함). `config.toml` `windows.sandbox = "mxc"|"elevated"|"unelevated"`. 문서는 WSL 없이 PowerShell 네이티브 실행을 기본으로 안내한다. 문서가 언급하는 `codex sandbox setup --elevated` 는 0.169.0 help 에 없다(문서·help 불일치). app-server 에 `windowsSandbox/setupStart`·`windowsSandbox/readiness` 가 있다. 근거: [windows](https://developers.openai.com/codex/windows), `codex sandbox --help`.

### C.4 모델·노력·이어하기·종료 (0.169.0)

| 항목 | 방법 | 근거 |
|---|---|---|
| 모델 | `-m/--model <MODEL>`. 로컬은 `--oss --local-provider lmstudio\|ollama` | `codex exec --help` |
| 노력 | `-c model_reasoning_effort=<값>`. 값은 모델마다 다름(문서 예: low, medium, high, xhigh …). app-server `turn/start` 의 `effort`, 허용 값은 `model/list` | [config reference](https://developers.openai.com/codex/config-reference), 스키마 `ReasoningEffort` |
| 프로필 | `-p/--profile <이름>` = `$CODEX_HOME/<이름>.config.toml` 을 덧씌움 | `codex --help` |
| 이어하기 | `codex exec resume <SESSION_ID\|--last> [PROMPT]`, `codex exec fork <id>`. app-server `thread/resume`·`thread/fork`. 저장 `~/.codex/sessions/YYYY/MM/DD/rollout-…-<uuid>.jsonl`, `--ephemeral` 이면 저장 안 함. 0.169.0 에 `migrate-rollouts` 가 있어 저장 형식이 바뀌는 중(추측) | `codex exec resume --help`, `codex-rs/rollout/src/list.rs` |
| 결과 받기 | `-o/--output-last-message <FILE>`, `--output-schema <FILE>`(최종 응답 JSON Schema) | `codex exec --help` |
| 종료 | exec: SIGINT 를 받으면 안에서 `turn/interrupt` 를 보내고 턴이 `interrupted` 로 끝난 뒤 종료(`exec/src/lib.rs`). Windows Ctrl+C 전달은 미확인. app-server: `turn/interrupt {threadId, turnId}` → `turn/completed` 의 `turn.status = "interrupted"` | 소스, [app-server](https://developers.openai.com/codex/app-server) |
| 과금 방지 | `CODEX_API_KEY`·`OPENAI_API_KEY` 가 있으면 API 키 과금 경로로 갈 수 있다 → 워커 실행 env 에서 지운다 | [auth](https://developers.openai.com/codex/auth) |

### C.5 요금제별 한도와 남은 한도 읽기

- 공식 [pricing](https://developers.openai.com/codex/pricing)(2026-11-16 받음): CLI·SDK·`codex exec` 는 유료 ChatGPT 요금제 대부분과 API 키에서 쓸 수 있다. 한도는 "5시간당 로컬 메시지 수" **범위**로 적혀 있고(모델마다 다름), 문서 스스로 고정 한도가 아닌 추정이라고 밝힌다. 주간 한도가 추가로 걸릴 수 있고, 로컬 메시지와 클라우드 작업이 한도를 같이 쓴다. 상위 요금제는 낮은 요금제의 배수이고, 최상위 일부는 "현재 5시간 한도 없음"으로 적혀 있다. 숫자는 자주 바뀌므로 이 문서에 옮기지 않는다.
- 남은 한도를 기계로 읽는 길은 **app-server 뿐**이다: `account/rateLimits/read` → `RateLimitSnapshot{primary, secondary, credits, planType, limitId, …}`, 창마다 `{usedPercent, windowDurationMins, resetsAt}`. 알림 `account/rateLimits/updated`. 토큰은 `thread/tokenUsage/updated`.
- `exec --json` 에는 토큰 수(`turn.completed.usage`)만 있다. TUI `/status` 는 사람이 보는 화면이라 기계 판독에 쓰지 않는다.
- primary = 5시간, secondary = 주간이라는 대응은 **추측**이다. `windowDurationMins` 값으로 판별하게 만든다(탐침 ⑥으로 확인).

## D. 프로토콜 대응: 지금 Claude 흐름을 Codex 에서

기준: Claude Code 2.1.248(노트북)·2.1.323(녹화) 의 stream-json 흐름(Plenum 0.3.0 이 쓰는 것), Codex CLI 0.169.0 스키마, codex-acp 2.6.0 소스. ✓ = 같은 일을 할 수 있음, △ = 모양이 달라 바꿔야 함, ✗ = 안 됨.

### D.1 Codex 워커 (이번 설계의 주 경로)

워커는 단발 실행 후 결과를 돌려준다. 두 갈래가 있다.
- **W1. jh-kit 워커 → `codex exec`** — Claude 메인 세션 안에서 워커 에이전트가 Bash 로 부른다(지금 이미지 워커와 같은 길). Plenum 을 거치지 않는다.
- **W2. Plenum → ACP(codex-acp)** — Plenum 이 직접 Codex 세션을 띄울 때(F절 추천).

| 지금 Claude 흐름 | W1 `codex exec --json` | W2 ACP (codex-acp → app-server) | 근거 |
|---|---|---|---|
| 승인 카드 `control_request can_use_tool` → `allow`/`deny` | **✗** 승인을 밖으로 못 넘김(never 고정). **대신 샌드박스로 막는다**: `--sandbox workspace-write` + 전용 git worktree. 막힌 명령은 `command_execution.status = declined`/`failed` 로 보고에 남는다 | ✓ `session/request_permission` (옵션 `allow_once`·`allow_always`·`reject_once`) ← app-server `requestApproval` | `exec/src/lib.rs`(0.169.0), codex-acp `src/permissions/options.ts` |
| 거부 이유 문구(deny `message`) | ✗ | △ ACP 응답에 이유 칸이 없다. `reject_once` 만 전달 → 이유는 다음 프롬프트로 따로 보낸다 | ACP schema `RequestPermissionOutcome` |
| 도구 입력 고치기(`updatedInput`) | ✗ | ✗ app-server 답에 해당 칸 없음 | 스키마 `CommandExecutionRequestApprovalResponse` |
| "이 세션 동안 허용" `addRules` destination `session` | ✗ (샌드박스 범위로 대신) | ✓ `allow_always` = codex-acp 에서 `acceptForSession`("don't ask again for this command in this session"). **주의: claude-agent-acp 의 `allow_always` 는 영구 설정일 수 있어 뜻이 다르다** → 드라이버가 프로바이더별로 `scope` 를 채운다(G절) | codex-acp `options.ts`, claude-agent-acp `src/permissions/effects.ts` |
| 질문 카드 (AskUserQuestion → `updatedInput.answers`) | ✗ exec 는 `request_user_input` 을 거절. 질문이 필요한 일은 워커로 보내지 않는다(지시서를 완결되게 쓴다) | ✓ ACP `elicitation/create`(form) ← app-server `item/tool/requestUserInput`(experimental). 클라이언트가 `clientCapabilities.elicitation.form` 을 광고해야 함 | `exec/src/lib.rs`, codex-acp `CodexElicitationHandler.ts`, [ACP elicitation](https://agentclientprotocol.com/protocol/v1/elicitation) |
| 사용량 `rate_limit_event…unifiedWindows.five_hour/seven_day` | △ 토큰 수만(`turn.completed.usage`). 남은 한도 % 없음 | △ codex-acp 는 rate limit 을 `/status` 텍스트로만 준다. 구조화된 창 정보가 필요하면 app-server `account/rateLimits/read` 를 따로 한 번 부르는 작은 확인 명령이 필요(추측: 워커 시작 전 1회) | codex-acp `CodexEventHandler.ts`, 스키마 `GetAccountRateLimitsResponse` |
| 중단 `control_request interrupt` → stdin 닫기 → 트리 종료 | △ SIGINT → 안에서 `turn/interrupt` → 턴 종료. Windows 에서는 Ctrl+C 이벤트 전달이 어려워 **트리 종료(taskkill /T)** 로 대신(추측, 탐침 ⑤로 확인) | ✓ `session/cancel` → `stopReason: cancelled` | `exec/src/lib.rs`, [ACP cancellation](https://agentclientprotocol.com/protocol/v1/cancellation) |
| 이어하기 `--resume <session_id>` | ✓ `codex exec resume <thread_id>` | ✓ `session/load` (`loadSession: true`) | `codex exec resume --help`, codex-acp `CodexAcpServer.ts` |
| 결과 텍스트 `result.result` | ✓ `-o <파일>` 또는 마지막 `agent_message` | ✓ 마지막 `agent_message_chunk` 들 + `stopReason` | `codex exec --help` |
| 워커 현황 `system/task_*` | △ `collab_tool_call`(Codex 내부 서브에이전트) | △ unstable `subagent_update` | `exec_events.rs`, ACP schema.unstable |
| 모델·노력 `--model`·`--effort` | ✓ `-m`, `-c model_reasoning_effort=` | ✓ `session/set_config_option` 또는 실행 인자 | 위 C.4 |

결론: **워커 조건(단발 실행 + 결과)은 W1·W2 둘 다 채운다.** W1 은 승인·질문이 없으므로 "샌드박스 + 전용 worktree + 메인이 diff 검수"로 안전을 맞춘다. 이 방식이 1순위 용도(어려운 구현 단위)·2순위(교차 리뷰 = read-only 샌드박스)에 충분하다.

### D.2 Codex 메인 판정 (기능 목록만)

| 메인 조건 | `codex exec` | `codex app-server` 직접 | ACP(codex-acp 2.6.0) |
|---|---|---|---|
| 세션(여러 턴) | ✗ 단발 (resume 으로 이어 붙이기는 됨) | ✓ thread/turn | ✓ |
| 승인 카드 | ✗ | ✓ (`acceptForSession` 포함) | ✓ |
| 이어하기 | ✓ | ✓ | ✓ |
| 판정 | **워커만** | **메인 가능** (experimental 표시가 위험) | **메인 가능** (사용량 게이지만 빠짐) |

### D.3 안 되는 것 (정리)

1. `codex exec` 로는 승인 카드·질문 카드를 만들 수 없다(0.169.0). 우회 없음 — 쓰지 않는 것이 답.
2. 승인 거부 이유를 Codex 에 직접 전달하는 칸이 없다(app-server·ACP 둘 다). 다음 메시지로 보낸다.
3. 도구 입력을 고쳐서 허용하는 것(`updatedInput`)은 Codex 에 없다.
4. 남은 한도 %는 app-server 로만 읽힌다. ACP 경로에서는 표준 칸이 없다.

## E. 노트북 탐침

실제 실행 녹화는 구독 로그인이 있는 사용자 노트북(Windows)에서만 한다. CI 에는 구독 토큰을 넣지 않는다(H절). 탐침 묶음 `plenum-probe-step0.zip` 은 레포에 커밋하지 않는다(`dist/`, `.gitignore`).

### 구성

| 파일 | 하는 일 |
|---|---|
| `probe.ps1` | Node 20+ 확인 → `node probe.mjs` → `Compress-Archive` 로 `probe-result.zip`. PowerShell 5.1 이 BOM 없는 파일을 ANSI 로 읽으므로 ASCII 만 쓴다 |
| `probe.mjs` | CLI 찾기 → 버전 → help 재귀 수집 → app-server 스키마 생성 → Codex 장면 → (조건부) Claude 장면·비교 → 가리기 리포트 |
| `lib/cmd.mjs` | PATH·PATHEXT 에서 절대 경로를 찾고(`.cmd` 는 `cmd.exe /d /s /c` + verbatim 인자), UTF-8 실패 시 euc-kr 로 다시 읽고, 시간 초과면 프로세스 트리째 종료 |
| `lib/codex.mjs` | 장면 6개 + 작은 app-server 클라이언트. 플래그·승인 값은 **설치된 버전의 help·스키마를 읽고 고른다**(버전이 달라도 기억으로 박은 값을 쓰지 않음). 모델 턴 상한 8 |
| `lib/claude.mjs` | claude 가 기준 버전(2.1.248)이 아닐 때만 장면 01·02·04·05 재녹화. 승인 답, "이 세션 동안 허용"은 `addRules` 만 destination `session` |
| `lib/redact.mjs` | 홈 경로(세 표기)·사용자 이름·컴퓨터 이름·이메일·계정/설치 id·JWT·`sk-` 키 가리기, 남은 의심 패턴 리포트 |
| `lib/shapes.mjs` + `ref/claude-2.1.323-shapes.json` | 기존 녹화의 (type/subtype → 키 집합) 요약과 새 녹화를 비교한 `compare.md` — 형식 변화 감지의 첫 실전 |

### 장면 (Codex)

| # | 장면 | 경로 | 모델 턴 |
|---|---|---|---|
| ① | 파일 읽기만 | `codex exec --json --sandbox read-only --skip-git-repo-check` | 1 |
| ② | 파일 쓰기 승인: 거부 → 다시 요청 → 이 세션 동안 허용 | app-server, `item/fileChange/requestApproval` → `decline` / `acceptForSession` | 2 |
| ③ | 셸 명령 승인 | app-server, `item/commandExecution/requestApproval` → `accept` | 1 |
| ④ | 이어하기 | `codex exec resume <thread_id> --json` | 1 |
| ⑤ | 중단 | app-server, 첫 `item/agentMessage/delta` 뒤 `turn/interrupt` | 1 |
| ⑥ | 핸드셰이크·한도 | app-server `initialize` → `initialized` → `account/read` → `account/rateLimits/read` | 0 |

- 과금 방지: 모든 codex 실행 env 에서 `OPENAI_API_KEY`·`CODEX_API_KEY` 를 뺀다. `codex login status` 가 ChatGPT 로그인이 아니면 ①~⑤ 를 건너뛰고 ⑥ 만 한다.
- [실측, 0.169.0 로그인 없이] app-server 는 한 줄에 JSON 하나, 응답에 `jsonrpc` 칸이 없고 요청에서 빼도 받는다. `initialize` 응답 `{userAgent, codexHome, platformFamily, platformOs}`. 로그인 없이 `account/read` = `{account: null, requiresOpenaiAuth: true}`, `account/rateLimits/read` = 오류 -32600 "authentication required". 알림에 `installationId`·`serverName`(컴퓨터 이름)이 섞여 나와서 가리기 대상에 넣었다.
- 확인 못 한 것(노트북에서 처음): 승인·중단·이어하기 실제 흐름. ③의 `git --version` 은 안전 명령으로 분류돼 승인 없이 실행될 수 있다(추측) — 그러면 녹화에 "승인 요청 없음"이 남고 그것도 정보다.

### 실행 안내 (PowerShell)

블록마다 `cd` 로 시작하고 한 줄에 명령 하나다.

```powershell
cd $HOME\Downloads
Expand-Archive .\plenum-probe-step0.zip -DestinationPath .
```

```powershell
cd $HOME\Downloads\plenum-probe-step0
powershell -ExecutionPolicy Bypass -File .\probe.ps1 -DryRun
```

```powershell
cd $HOME\Downloads\plenum-probe-step0
powershell -ExecutionPolicy Bypass -File .\probe.ps1
```

```powershell
cd $HOME\Downloads\plenum-probe-step0
Get-Content .\out\redaction-report.txt
Get-Content .\out\versions.json
Get-Content .\out\run-log.txt
```

넘기기 전에 `redaction-report.txt` 가 "남은 것 없음" 인지, `versions.json` 에 이상한 값이 없는지 본다. 결과 `probe-result.zip` 은 다음 단계(P4)에서 fixture 로 들어간다.

### 클라우드에서 한 확인

- 모든 `.mjs` `node --check` 통과. `pwsh` 가 없어 `probe.ps1` 파싱 검사는 노트북 첫 실행으로 미룸.
- 드라이런(로컬 codex 0.169.0 + claude 2.1.325): help claude 50여 개·codex 74개, 스키마 2종, ⑥ 핸드셰이크까지 돌고 모델 턴 0, 리포트 "남은 것 없음".
- 가짜 codex·claude 로 모든 장면 끝까지: 거부 → 세션 허용 순서, 첫 델타 뒤 중단, `--resume` 인자, addRules 만 session, 손자 프로세스까지 시간 초과 트리 종료.

## F. ACP 평가

> 조사 기준일 2026-11-16. 저장소는 다음 커밋 기준이다: 명세 [`13b7658`][acp-repo], claude 어댑터 [`b1c1987`][caa], codex 어댑터 [`6567651`][cxa].

### F.1 버전

| 항목 | 값 | 날짜 | 근거 |
|---|---|---|---|
| 프로토콜 버전(정수, 안정) | **1** (`ProtocolVersion::LATEST = V1`). 깨지는 변경이 있을 때만 올린다 | — | [version.rs][acp-ver] |
| 프로토콜 v2 | 2. **초안**이다. `unstable_protocol_v2` 플래그를 켜고 명시적으로 골라야 한다 | — | [version.rs][acp-ver], [v2 이전 안내][acp-v2mig] |
| 스키마 크레이트 `agent-client-protocol-schema` | 1.18.0 | 2026-11-14 | [CHANGELOG][acp-cl] |
| JSON 스키마 패키지 v1 / v2 | 1.32.0 / 2.0.0-alpha.16 | — | [schema/v1/Cargo.toml][acp-s1], [schema/v2/Cargo.toml][acp-s2] |
| Rust SDK 크레이트 `agent-client-protocol` | 5.3.0 | 2026-11-14 | [crates.io][crate] |
| npm `@agentclientprotocol/sdk` | 2.7.0 | 2026-11-14 | [npm][npm-sdk] (npm view) |
| npm `@zed-industries/agent-client-protocol` | 0.4.5. **deprecated**: "renamed to @agentclientprotocol/sdk" | 2025-10-10 | [npm][npm-zed-sdk] (npm view) |

최근 변경 중 Plenum에 관련된 것:
- 0.13.6(2026-06-05): `usage_update` 안정화 ([CHANGELOG][acp-cl])
- 1.0.0(2026-06-24): 스키마 크레이트 1.0 ([CHANGELOG][acp-cl])
- 1.7.0(2026-08-20): **elicitation 안정화**. 질문 카드의 표준 통로가 생겼다 ([CHANGELOG][acp-cl])
- 1.11.0(2026-10-09): notice·compaction 안정화 ([CHANGELOG][acp-cl])
- 1.16.0(2026-11-09): 클라이언트 system prompt 안정화 ([CHANGELOG][acp-cl])
- 1.18.0(2026-11-14): unstable 쪽에 prompt suggestions와 skills 추가 ([CHANGELOG][acp-cl])
- v2 초안은 깨지는 재설계다. `session/prompt` 응답이 더 이상 턴 종료가 아니게 되고, 클라이언트 fs·terminal·session modes API가 없어진다. 공식 안내는 "v1과 v2를 나란히 지원하라"이다 ([v2 이전 안내][acp-v2mig]).

### F.2 개념 이름 (원문)

| 이름 | 방향 | 요지 | Plenum 현재 대응 | 근거 |
|---|---|---|---|---|
| `initialize` | 클라이언트→에이전트 | `protocolVersion`, `clientCapabilities`(fs, terminal, elicitation, auth…), `agentCapabilities`(loadSession, sessionCapabilities…)를 교환한다 | 없음(프로세스 실행 인자) | [initialization][acp-init] |
| `authenticate` / `logout` | 클라이언트→에이전트 | 에이전트가 제시한 인증 방식을 고른다 | 없음 | [meta.json][acp-meta] |
| `session/new` | 클라이언트→에이전트 | 세션을 만든다(cwd, mcpServers) | 첫 `-p` 실행 | [session-setup][acp-setup] |
| `session/load` | 클라이언트→에이전트 | 이력을 `session/update`로 재생하며 재개한다. `agentCapabilities.loadSession`이 있어야 한다 | 이어하기 | [session-setup][acp-setup] |
| `session/resume`, `session/close`, `session/list`, `session/delete` | 클라이언트→에이전트 | v1 안정 메서드 목록에 포함 | 이어하기·목록 | [meta.json][acp-meta], [session-list][acp-list] |
| `session/prompt` → `stopReason` | 클라이언트→에이전트 | 응답이 오면 턴이 끝난다(v1) | stdin user 메시지 → `result` | [prompt-turn][acp-turn] |
| `session/update` (안정) | 에이전트→클라이언트 | 종류: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update`, `notice`, `compaction_update`, `compaction_summary_chunk` | stream-json 이벤트 | [schema.json][acp-schema], [tool-calls][acp-tools], [agent-plan][acp-plan], [slash-commands][acp-cmds] |
| `session/update` (unstable 추가분) | 에이전트→클라이언트 | `plan_update`, `plan_removed`, `prompt_suggestions_update`, `subagent_update`, `session_message`, `session_message_chunk` | — | [schema.unstable.json][acp-schema-u] |
| `session/request_permission` | 에이전트→클라이언트 | 옵션 `kind`: `allow_once`, `allow_always`, `reject_once`, `reject_always`. **허용 범위(세션/영구) 필드는 없다** | `control_request can_use_tool` | [tool-calls][acp-tools], [schema.json][acp-schema] |
| `session/cancel` (알림) | 클라이언트→에이전트 | 보내면 `stopReason: cancelled`로 끝난다 | `control_request {subtype:"interrupt"}` | [cancellation][acp-cancel] |
| `session/set_mode` / `session/set_config_option` | 클라이언트→에이전트 | 모드나 설정 옵션(모델·effort 등)을 바꾼다 | 실행 인자 | [session-modes][acp-modes], [session-config-options][acp-config] |
| `stopReason` 값 | — | `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled` | `result.subtype` | [schema.json][acp-schema] |
| `usage_update` | 에이전트→클라이언트 | `used`(컨텍스트 토큰), `size`, `cost{amount,currency}`. **사용량 한도 창(5시간/7일) 필드는 없다** | `rate_limit_event…unifiedWindows` | [schema.json][acp-schema], [RFD session-usage][acp-usage] |
| `elicitation/create` / `elicitation/complete` | 에이전트→클라이언트 | form 모드와 url 모드. `clientCapabilities.elicitation.form`이 있어야 한다 | AskUserQuestion `updatedInput.answers` | [elicitation][acp-elic] |
| `fs/read_text_file`, `fs/write_text_file` | 에이전트→클라이언트 | `clientCapabilities.fs`가 있어야 한다 | 없음(CLI가 직접 수행) | [file-system][acp-fs] |
| `terminal/create`, `/output`, `/release`, `/wait_for_exit`, `/kill` | 에이전트→클라이언트 | `clientCapabilities.terminal`이 있어야 한다 | 없음 | [terminals][acp-term] |
| `$/cancel_request`, `_meta` | 양방향 | 요청 취소, 벤더 확장 자리 | — | [meta.json][acp-meta], [extensibility][acp-ext] |

### F.3 어댑터 유지 상태

| 어댑터 | npm 최신 (게시일) | 저장소 최근 커밋 | 의존 버전 | 승인 전달 | 질문(AskUserQuestion류) | 이어하기 | 사용량 | Windows | 근거 |
|---|---|---|---|---|---|---|---|---|---|
| **`@agentclientprotocol/claude-agent-acp`** (공식. 레지스트리 저자: Anthropic, Zed, JetBrains) | 0.107.0 (2026-11-13), preview 0.107.1-preview.2 | `b1c1987` 2026-11-14 | `@anthropic-ai/claude-agent-sdk` 0.3.323 (claudeCodeVersion 2.1.323), `@agentclientprotocol/sdk` 2.6.0(npm 판) / 2.7.0(HEAD), Node ≥22 | ✓ `session/request_permission`. 단 `allow_always`는 **Claude CLI가 제안한 갱신(suggestions)을 그대로** 적용하고, 제안이 없는 도구는 `destination: "localSettings"`를 쓴다. 클라이언트가 "세션 동안"을 고를 수 없다 | ✓ AskUserQuestion → `elicitation/create`(form). 클라이언트가 `elicitation.form`을 광고하지 않으면 AskUserQuestion은 **비활성** | ✓ `loadSession: true`, resume/close/fork/list | 표준 `usage_update`(used/size)에 원본 `rate_limit_info`를 **`_meta["_claude/rateLimit"]`**로 실어 보낸다(비표준). `/usage`는 마크다운 텍스트 | ✓ windows-x86_64/aarch64 바이너리 | [npm][npm-caa], [package.json][caa-pkg], [effects.ts][caa-eff], [normalization.ts][caa-norm], [acp-agent.ts AskUserQuestion][caa-ask], [disallowedTools][caa-dis], [loadSession][caa-load], [rate_limit_event][caa-rl], [registry][acp-reg] |
| `@zed-industries/claude-code-acp` | 0.16.2 (2026-03-26). **deprecated** → `@agentclientprotocol/claude-agent-acp` | — | claude-agent-sdk 0.2.44 | — | — | — | — | — | [npm][npm-zcca] |
| `@zed-industries/claude-agent-acp` | 0.23.1 (2026-03-26). **deprecated** → 위와 같음 | — | claude-agent-sdk 0.2.83 | — | — | — | — | — | [npm][npm-zcaa] |
| `claude-agent-acp` (스코프 없음) | 0.100.3 (2026-11-08). **제3자 포크**(저장소 dongitran/claude-agent-acp), 공식 아님 | — | claude-agent-sdk 0.3.312 | 미확인 | 미확인 | 미확인 | 미확인 | 미확인 | [npm][npm-fork] |
| **`@agentclientprotocol/codex-acp`** (공식. 레지스트리 저자: OpenAI, JetBrains, Zed). TypeScript로 `codex app-server` JSON-RPC 위에 구현 | 2.6.0 (2026-11-08), preview 2.6.1-preview.5 | `6567651` 2026-11-12 | `@openai/codex` ^0.166.0 (=0.166.x 고정), `@agentclientprotocol/sdk` ~2.4.0(npm 판) / ~2.6.0(HEAD) | ✓ `session/request_permission`. `accept`→`allow_once`, **`acceptForSession`→`allow_always`("이 세션 동안")**, `decline`/`cancel`→`reject_once` | ✓ `request_user_input`과 `request_user_input_async`를 form elicitation으로 전달 | ✓ `loadSession: true` | `account/rateLimits/updated`를 받아 **세션 상태에만 저장**하고 `/status` 명령 텍스트로만 보여 준다. 구조화된 전달은 없다. `_meta.quota`에는 토큰 수만 | npx(Node). win32 spawn 분기는 있으나 README에 Windows 언급이 없어 실동작 미확인 | [npm][npm-cxa], [package.json][cxa-pkg], [options.ts][cxa-opt], [CodexElicitationHandler][cxa-elic], [CodexAsyncQuestions][cxa-async], [loadSession][cxa-load], [rateLimits 처리][cxa-rl], [/status][cxa-status], [CodexCli.ts][cxa-cli] |
| `@zed-industries/codex-acp` (Rust, 구판) | 0.16.0. **deprecated** → `@agentclientprotocol/codex-acp` | `296069e` 2026-07-22 "Development has moved…" | ACP 0.14.0 | — | — | — | — | — | [npm][npm-zcxa], [README][zcxa] |
| 그 밖 공식 목록 | 레지스트리 46개(registry v1.0.0), 문서 목록 50여 개 | — | — | — | — | — | — | — | [registry.json][acp-reg], [agents][acp-agents]. 네이티브 지원 목록은 J.1 |

**어댑터가 CLI를 따라가는 속도**(npm 게시 시각과 어댑터의 "update to …" 커밋 시각을 비교):

| 어댑터 | 의존 대상 버전 | 대상 게시 → 어댑터 반영 | 지연 | 근거 |
|---|---|---|---|---|
| claude-agent-acp | claude-agent-sdk 0.3.321 | 11-09 19:03 → 11-09 19:43 | 약 40분 | [npm][npm-sdkc], [커밋 기록][caa] |
| claude-agent-acp | claude-agent-sdk 0.3.322 | 11-10 01:57 → 11-10 14:41 | 약 13시간 | [npm][npm-sdkc], [커밋 기록][caa] |
| claude-agent-acp | claude-agent-sdk 0.3.323 | 11-12 20:33 → 11-13 13:56 | 약 17시간 | [npm][npm-sdkc], [커밋 기록][caa] |
| codex-acp | codex 0.166.0 | 10-29 → 11-03 | 약 5일 | [npm][npm-codex], [CHANGELOG][cxa-cl] |
| codex-acp | codex 0.167.0 | 11-06 출시. HEAD(11-12)는 아직 ^0.166.0 | **6일 이상, 진행 중** | [npm][npm-codex], [package.json][cxa-pkg] |

두 어댑터 모두 기본으로 **자기가 묶어 둔 CLI 사본**을 실행한다.
- claude 쪽 순서: `CLAUDE_CODE_EXECUTABLE` → 함께 배포된 CLI → SDK 플랫폼 패키지 ([claude-cli.ts][caa-cli])
- codex 쪽: `@openai/codex` 의존성을 실행하며, 경로를 따로 주면 그 경로를 쓴다 ([CodexCli.ts][cxa-cli])
- 그래서 사용자가 CLI를 업데이트해도 어댑터가 깨지지 않는다. 대신 새 기능과 모델은 어댑터가 버전을 올린 뒤에야 들어온다(추측).

### F.4 Codex 메인 판정 (기능 목록 기준, codex-acp 2.6.0)

| 메인 조건 | 충족 | 근거 |
|---|---|---|
| 세션 (새로 만들기·프롬프트·스트리밍) | ✓ | [CodexAcpServer.ts][cxa-load] |
| 승인 카드 (한 번 / 세션 동안 / 거절) | ✓ (`acceptForSession`이 `allow_always`로 매핑) | [options.ts][cxa-opt] |
| 이어하기 | ✓ `loadSession: true` | [CodexAcpServer.ts][cxa-load] |
| 질문 카드 | ✓ form elicitation | [CodexElicitationHandler][cxa-elic] |
| 중단 | ✓ `session/cancel` | [cancellation][acp-cancel] |
| 사용량 게이지 | △ ACP로는 구조화 전달 없음. `codex app-server`를 직접 쓰면 `account/rateLimits/updated`(usedPercent, windowDurationMins)를 받을 수 있다 | [rateLimits 처리][cxa-rl], [app-server 문서][oai-app] |

**판정:** 메인 조건(세션·승인 카드·이어하기)은 충족한다. 사용량 게이지만 빠진다.

### F.5 세 안 비교

| 기준 | (1) 전부 ACP | (2) 직접 어댑터 + 범용 ACP 드라이버 | (3) 직접 어댑터만 |
|---|---|---|---|
| 구현 비용 | 높음. Claude 경로를 ACP 클라이언트로 다시 짜야 하고, elicitation 폼, `_claude/rateLimit` 파싱, 세션 허용 흉내까지 필요 ([caa-rl][caa-rl]) | 중간. ACP 클라이언트 드라이버 1개를 새로 만들고(initialize·session/new·prompt·update·request_permission·elicitation·cancel), Claude 경로는 그대로 ([acp-turn][acp-turn]) | 첫 하나는 가장 싸다. 대신 하네스마다 드라이버가 늘어난다(codex exec/app-server, OpenCode, …) ([oai-exec][oai-exec]) |
| 형식 변화 내성 | 어댑터가 흡수한다. claude 쪽은 40분~17시간 만에 따라오고, codex 쪽은 5일 이상 늦다 (F.3) | Claude는 지금처럼 Plenum이 흡수하고, 나머지는 어댑터·하네스가 흡수한다 | 전부 Plenum이 흡수한다. 예: `codex exec --full-auto` 지원 중단 ([oai-exec][oai-exec]), OpenCode v2의 패키지(`@opencode/cli`)와 문서 이동 ([oc-cmd][oc-cmd]) |
| 기능 손실 | Claude는 "세션 동안 허용"을 고를 수 없고 ([caa-eff][caa-eff]), 사용량 창은 비표준 `_meta` ([caa-rl][caa-rl]). Codex는 사용량 구조화가 없다 ([cxa-rl][cxa-rl]) | Claude 손실 없음. Codex 워커는 사용량 게이지만 없다(워커에는 불필요할 것으로 추측) | 없음 |
| 구독 로그인 | 두 어댑터 모두 벤더 CLI 로그인을 재사용한다 ([caa-auth][caa-auth], [goose 문서][goose-acpprov]). Anthropic 문서의 "제3자 제품이 claude.ai 로그인을 제공하는 것은 사전 승인 없이는 불가" 문구는 경로와 상관없이 적용될 수 있다(애매) ([cc-sdk][cc-sdk]) | 왼쪽과 같음 | 왼쪽과 같음 |
| Windows | claude 어댑터는 Windows 바이너리가 있다. codex 어댑터는 npx이고 실검증이 없다 ([registry][acp-reg]) | 왼쪽과 같음. Claude 경로는 현 상태 유지 | 각 CLI에 달림 |
| 체감·성능 | 프로세스가 한 겹 늘어난다(Node ≥22 어댑터 → CLI). 묶인 CLI가 설치된 CLI와 버전이 다를 수 있다 ([caa-pkg][caa-pkg], [caa-cli][caa-cli]) | Claude 메인은 그대로이고 워커 쪽만 한 겹 늘어난다 | 가장 가볍다 |
| 프로토콜 변화 | ACP v2(초안)의 깨지는 변경이 메인 경로에도 미친다 ([v2 이전 안내][acp-v2mig]) | v2 부담이 워커와 제3자 경로로 한정된다. v1만 협상하면 된다 ([acp-ver][acp-ver]) | 해당 없음 |
| 나중에 바꾸기 | 직접 경로를 지웠다면 되돌리기 비싸다(추측) | 양방향으로 쉽다. Claude→ACP 실험은 드라이버에 claude-agent-acp 설정 하나면 되고, Codex→직접은 작은 워커 드라이버 하나면 된다(추측) | (2)로 가려면 ACP 드라이버를 새로 써야 한다 |

### F.6 추천: (2) 직접 어댑터(Claude) + 범용 ACP 드라이버(Codex와 나머지 전부)

구성:
- Claude 메인은 지금의 stream-json 직접 드라이버를 유지한다.
- Codex 워커, OpenCode, Goose 등은 범용 ACP 드라이버를 쓰고, v1(`protocolVersion: 1`)만 협상한다.

근거:
1. **메인 기능을 지킨다.** ACP의 `request_permission`에는 허용 범위 필드가 없다 ([schema][acp-schema]). claude-agent-acp는 `allow_always`를 CLI 제안 그대로 적용하거나 `localSettings`로 보낸다 ([effects.ts][caa-eff], [normalization.ts][caa-norm]). 그래서 Plenum의 "이 세션 동안 허용"(`addRules` destination `session`)은 ACP로 표현할 수 없다.
2. **Claude를 ACP로 옮겨도 단순해지지 않는다.** 표준 `usage_update`는 used/size/cost뿐이다 ([schema][acp-schema]). 5시간/7일 창은 `_meta["_claude/rateLimit"]` 원본으로만 오므로 ([acp-agent.ts][caa-rl]) Claude 전용 파싱이 어차피 남는다.
3. **형식 변화 걱정은 나머지 프로바이더 쪽에서 ACP가 해결한다.** codex-acp는 OpenAI가 저자로 등재된 공식 어댑터다 ([registry][acp-reg]). 문서화된 `codex app-server` 위에 구현했고 ([app-server][oai-app]) 자체 codex 사본을 고정해 쓴다 ([package.json][cxa-pkg]). 직접 경로라면 `--full-auto` 제거 같은 변경을 Plenum이 떠안는다 ([exec 문서][oai-exec]).
4. **목표 설계 "새 프로토콜만 드라이버 코드"와 맞는다.** ACP 드라이버 하나로 레지스트리의 46개 에이전트를 받는다 ([registry][acp-reg]). API 키 모델과 로컬 모델은 OpenCode·Goose 설정 파일 하나로 붙는다 (J.3).
5. **Codex는 ACP로 워커 조건은 물론 메인 조건까지 채운다** (F.4). 나중에 Codex 메인 실험을 할 때 드라이버를 새로 만들 필요가 없다 ([options.ts][cxa-opt], [loadSession][cxa-load]).
6. **되돌리기 쉽고, 반대 방향의 외부 선례도 있다.** Goose는 claude/codex CLI를 직접 감싸던 "CLI providers"를 폐기하고 claude-agent-acp/codex-acp 경유를 권장한다 ([goose 문서][goose-acpprov]). 따라서 (2)에서 "Claude를 ACP로" 실험 설정을 열어 두고, 위 1·2번 손실이 ACP 확장으로 풀리면 (1)로 옮긴다(추측).
7. **위험과 보험.** codex-acp는 codex 0.166.x에 고정돼 있는데 codex 0.169.0이 이미 나왔다 ([npm][npm-codex]). 그래서 새 모델이 늦게 들어올 수 있다(추측). 워커 조건은 단발 실행 후 결과 반환뿐이므로, 필요하면 `codex exec --json` 직접 워커 드라이버를 작게 만들 수 있다 ([exec 문서][oai-exec]). 지금은 만들지 않는다.

[acp-repo]: https://github.com/agentclientprotocol/agent-client-protocol/tree/13b765828f961812f0c78ae577220e994209fa2f
[acp-ver]: https://github.com/agentclientprotocol/agent-client-protocol/blob/13b765828f961812f0c78ae577220e994209fa2f/agent-client-protocol-schema/src/version.rs
[acp-cl]: https://github.com/agentclientprotocol/agent-client-protocol/blob/13b765828f961812f0c78ae577220e994209fa2f/CHANGELOG.md
[acp-s1]: https://github.com/agentclientprotocol/agent-client-protocol/blob/13b765828f961812f0c78ae577220e994209fa2f/schema/v1/Cargo.toml
[acp-s2]: https://github.com/agentclientprotocol/agent-client-protocol/blob/13b765828f961812f0c78ae577220e994209fa2f/schema/v2/Cargo.toml
[acp-meta]: https://github.com/agentclientprotocol/agent-client-protocol/blob/13b765828f961812f0c78ae577220e994209fa2f/schema/v1/meta.json
[acp-schema]: https://github.com/agentclientprotocol/agent-client-protocol/blob/13b765828f961812f0c78ae577220e994209fa2f/schema/v1/schema.json
[acp-schema-u]: https://github.com/agentclientprotocol/agent-client-protocol/blob/13b765828f961812f0c78ae577220e994209fa2f/schema/v1/schema.unstable.json
[acp-v2mig]: https://agentclientprotocol.com/protocol/v2/migration
[acp-init]: https://agentclientprotocol.com/protocol/v1/initialization
[acp-setup]: https://agentclientprotocol.com/protocol/v1/session-setup
[acp-list]: https://agentclientprotocol.com/protocol/v1/session-list
[acp-turn]: https://agentclientprotocol.com/protocol/v1/prompt-turn
[acp-tools]: https://agentclientprotocol.com/protocol/v1/tool-calls
[acp-plan]: https://agentclientprotocol.com/protocol/v1/agent-plan
[acp-cmds]: https://agentclientprotocol.com/protocol/v1/slash-commands
[acp-modes]: https://agentclientprotocol.com/protocol/v1/session-modes
[acp-config]: https://agentclientprotocol.com/protocol/v1/session-config-options
[acp-cancel]: https://agentclientprotocol.com/protocol/v1/cancellation
[acp-fs]: https://agentclientprotocol.com/protocol/v1/file-system
[acp-term]: https://agentclientprotocol.com/protocol/v1/terminals
[acp-elic]: https://agentclientprotocol.com/protocol/v1/elicitation
[acp-usage]: https://agentclientprotocol.com/rfds/session-usage
[acp-ext]: https://agentclientprotocol.com/protocol/v1/extensibility
[acp-agents]: https://agentclientprotocol.com/get-started/agents
[acp-reg]: https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
[crate]: https://crates.io/crates/agent-client-protocol
[npm-sdk]: https://www.npmjs.com/package/@agentclientprotocol/sdk
[npm-zed-sdk]: https://www.npmjs.com/package/@zed-industries/agent-client-protocol
[caa]: https://github.com/agentclientprotocol/claude-agent-acp/tree/b1c198754d1cb4e086de6c6bc6a9659ae3351a0a
[caa-pkg]: https://github.com/agentclientprotocol/claude-agent-acp/blob/b1c198754d1cb4e086de6c6bc6a9659ae3351a0a/package.json
[caa-eff]: https://github.com/agentclientprotocol/claude-agent-acp/blob/b1c198754d1cb4e086de6c6bc6a9659ae3351a0a/src/permissions/effects.ts
[caa-norm]: https://github.com/agentclientprotocol/claude-agent-acp/blob/b1c198754d1cb4e086de6c6bc6a9659ae3351a0a/src/permissions/normalization.ts
[caa-ask]: https://github.com/agentclientprotocol/claude-agent-acp/blob/b1c198754d1cb4e086de6c6bc6a9659ae3351a0a/src/v1/acp-agent.ts#L8881-L8905
[caa-dis]: https://github.com/agentclientprotocol/claude-agent-acp/blob/b1c198754d1cb4e086de6c6bc6a9659ae3351a0a/src/v1/acp-agent.ts#L9878-L9881
[caa-load]: https://github.com/agentclientprotocol/claude-agent-acp/blob/b1c198754d1cb4e086de6c6bc6a9659ae3351a0a/src/v1/acp-agent.ts#L1848
[caa-rl]: https://github.com/agentclientprotocol/claude-agent-acp/blob/b1c198754d1cb4e086de6c6bc6a9659ae3351a0a/src/v1/acp-agent.ts#L6961-L6978
[caa-cli]: https://github.com/agentclientprotocol/claude-agent-acp/blob/b1c198754d1cb4e086de6c6bc6a9659ae3351a0a/src/claude-cli.ts
[caa-auth]: https://github.com/agentclientprotocol/claude-agent-acp/blob/b1c198754d1cb4e086de6c6bc6a9659ae3351a0a/src/auth-methods.ts
[npm-caa]: https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp
[npm-zcca]: https://www.npmjs.com/package/@zed-industries/claude-code-acp
[npm-zcaa]: https://www.npmjs.com/package/@zed-industries/claude-agent-acp
[npm-fork]: https://www.npmjs.com/package/claude-agent-acp
[npm-sdkc]: https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
[cxa]: https://github.com/agentclientprotocol/codex-acp/tree/656765115f82253c79f87918abb77189c114a799
[cxa-pkg]: https://github.com/agentclientprotocol/codex-acp/blob/656765115f82253c79f87918abb77189c114a799/package.json
[cxa-opt]: https://github.com/agentclientprotocol/codex-acp/blob/656765115f82253c79f87918abb77189c114a799/src/permissions/options.ts#L22-L56
[cxa-elic]: https://github.com/agentclientprotocol/codex-acp/blob/656765115f82253c79f87918abb77189c114a799/src/CodexElicitationHandler.ts
[cxa-async]: https://github.com/agentclientprotocol/codex-acp/blob/656765115f82253c79f87918abb77189c114a799/src/CodexAsyncQuestions.ts
[cxa-load]: https://github.com/agentclientprotocol/codex-acp/blob/656765115f82253c79f87918abb77189c114a799/src/CodexAcpServer.ts#L849
[cxa-rl]: https://github.com/agentclientprotocol/codex-acp/blob/656765115f82253c79f87918abb77189c114a799/src/CodexEventHandler.ts#L1369
[cxa-status]: https://github.com/agentclientprotocol/codex-acp/blob/656765115f82253c79f87918abb77189c114a799/src/CodexCommands.ts#L590-L601
[cxa-cli]: https://github.com/agentclientprotocol/codex-acp/blob/656765115f82253c79f87918abb77189c114a799/src/CodexCli.ts
[cxa-cl]: https://github.com/agentclientprotocol/codex-acp/blob/656765115f82253c79f87918abb77189c114a799/CHANGELOG.md
[npm-cxa]: https://www.npmjs.com/package/@agentclientprotocol/codex-acp
[npm-zcxa]: https://www.npmjs.com/package/@zed-industries/codex-acp
[zcxa]: https://github.com/zed-industries/codex-acp
[npm-codex]: https://www.npmjs.com/package/@openai/codex
[oai-app]: https://developers.openai.com/codex/app-server
[oai-exec]: https://developers.openai.com/codex/noninteractive
[cc-sdk]: https://code.claude.com/docs/en/agent-sdk/overview
[goose-acpprov]: https://goose-docs.ai/docs/guides/acp-providers

## G. 내부 이벤트 모델

드라이버가 하는 일은 하나다. **CLI 원문 한 줄(또는 JSON-RPC 메시지 하나)을 받아 내부 이벤트 0개 이상으로 바꾼다.** 화면·저장·워커 결과 처리는 내부 이벤트만 본다. CLI 형식이 바뀌면 드라이버의 매핑 표만 바뀐다.

이름 규칙:
- 개념 이름은 ACP를 따른다: `session`, `prompt`, `sessionUpdate`, `toolCall`, `requestPermission`, `stopReason`, `PermissionOption.kind`.
- ACP에 없는 개념(질문 카드, 한도)은 `x` 접두어 없이 Plenum 이름을 쓰되, `ext: true` 표시를 단다. ACP에 같은 개념이 생기면 이름을 맞춰 옮긴다.
- 지금 `app/server/chatTypes.ts` 의 `ChatEvent`·`Card` 는 이 모델의 Claude 전용 부분집합이다. 0.4.x에서 아래 타입으로 옮기되, 화면이 보는 SSE 모양은 한 번에 바꾸지 않고 어댑터 층이 지금 모양으로 다시 펼친다(동작 그대로).

```ts
// provider/events.ts — 초안. 드라이버 → 앱 공용 계약.
// 원칙: 모든 이벤트는 raw(원문)를 들고 다닌다. 드라이버가 이해 못 한 것은 버리지 않고 'unknown' 으로 올린다.

export type ProviderId = string;              // 설정 파일의 id ("claude", "codex", "opencode" …)
// F절 추천 (2): Claude 는 직접 드라이버, 나머지는 범용 ACP. oneshot 은 워커 전용(단발 실행 + 결과)
export type DriverKind = 'claude-stream' | 'acp' | 'oneshot';

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
  /** allow_always 의 범위. Claude addRules(session) = 'session', Codex acceptForSession = 'session'.
   *  'persistent'(설정 파일에 저장)는 Plenum 이 고르지 않는다 — 고르면 드라이버가 거부 */
  scope?: 'session' | 'persistent';
}
export type PermissionRequestEvent = Base & {
  type: 'requestPermission';
  requestId: string;
  toolCall: Pick<ToolCallEvent, 'toolCallId' | 'title' | 'kind' | 'toolName' | 'rawInput' | 'locations'>;
  options: PermissionOption[];                // 드라이버가 하네스에서 안전한 것만 골라 만든다
  diff?: { path: string; old: string; new: string }[];
  reason?: string;                            // 하네스가 붙인 설명(샌드박스 밖 쓰기 등)
};
export type PermissionOutcome =
  | { outcome: 'selected'; optionId: string; message?: string }   // reject_* 에 이유 문구
  | { outcome: 'cancelled' };

// ── 질문 카드 (ACP 에 없음 → ext). Claude AskUserQuestion, Codex request_user_input(있으면)
export type QuestionEvent = Base & {
  type: 'question'; ext: true;
  requestId: string;
  questions: { question: string; header?: string; multiSelect: boolean;
               options: { label: string; description?: string; recommended: boolean }[]; allowFreeText: boolean }[];
};
export type QuestionOutcome = { answers: Record<string, string> } | { outcome: 'cancelled' };

// ── 사용량 (ACP 는 토큰 사용량만 다룸 → 한도 창은 ext)
export interface LimitWindow { id: string; label: string; usedPct: number | null; resetsAt: number | null; status: 'ok' | 'warning' | 'rejected' | null }
export type UsageEvent = Base & {
  type: 'usage';
  tokens?: { input?: number; output?: number; cachedInput?: number; reasoning?: number };
  windows?: LimitWindow[];                    // Claude five_hour/seven_day, Codex primary/secondary … 이름은 하네스 것
  ext?: true;
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
};

// ── 종료 (ACP stopReason + 프로세스 종료를 분리)
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'error';
export type TurnEndEvent = Base & { type: 'turnEnd'; stopReason: StopReason; text: string | null; deniedCount?: number };
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
  // 워커 조건: oneshot
  oneshot: boolean;          // 프롬프트 하나 → 끝 → 결과 텍스트
  questionCards: boolean; interrupt: boolean; usageWindows: boolean; tokenUsage: boolean;
  allowForSession: boolean;  // allow_always(scope session)
  modelSelect: boolean; effortSelect: boolean; jsonOutput: boolean;
}
export type Role = 'main' | 'worker' | 'none';
export const roleOf = (c: Capabilities): Role[] =>
  [ ...(c.session && c.permissionCards && c.resume ? ['main' as const] : []), ...(c.oneshot ? ['worker' as const] : []) ];

export interface Driver {
  kind: DriverKind;
  /** --version·--help(+ 하위 명령 help, 스키마 명령) 결과로 기능을 정한다. 설정 파일의 capabilities 는 상한 */
  detect(probe: { version: string | null; help: Record<string, string> }): { capabilities: Capabilities; warnings: string[] };
  /** 원문 한 단위 → 내부 이벤트. 예외를 던지지 않는다(안에서 try/catch → unknown/parse) */
  decode(raw: Raw): ProviderEvent[];
  answerPermission(requestId: string, o: PermissionOutcome): unknown;  // 하네스에 쓸 원문
  answerQuestion(requestId: string, o: QuestionOutcome): unknown;
  interrupt(): unknown | null;
}
```

알 수 없는 이벤트 처리 규칙:
1. `decode` 는 예외를 밖으로 내지 않는다. 매핑 함수가 던지면 `unknown/field` 로 바꾼다. 테스트가 "fixture 전체를 decode 해도 throw 0" 을 잰다.
2. 답을 기다리는 요청(Claude `control_request`, JSON-RPC request with `id`)인데 모르면 **거부로 답하고** `answeredWithDefault: true`. 답을 안 하면 하네스가 멈춘다(지금 Plenum 0.3.0 의 `unknown` 카드와 같은 규칙).
3. 화면은 `unknown` 을 접힌 "원문 보기" 줄로 그린다(첫 120자 + 펼치기). 대화는 계속된다.
4. 로그: `<설정 폴더>/logs/unknown-<provider>-<version>.jsonl` 에 `{hint, reason, raw.text}` 를 남긴다. 같은 `hint` 는 세션당 1번만. 이 파일이 다음 탐침에서 fixture 후보가 된다.
5. 모르는 **칸**은 무시한다(아는 칸만 읽음). 필수 칸이 없을 때만 `unknown/field`.

기능 감지(`detect`) 규칙:
- 입력은 `--version` 과 `--help`(그리고 드라이버가 정한 하위 명령 help: codex 는 `exec --help`, `app-server --help`). 결과는 (명령 경로 + 버전) 키로 캐시한다(지금 `claudecaps.ts` 와 같은 방식).
- 플래그가 있으면 켠다: 예 Claude `--effort` → `effortSelect`, `--permission-prompt-tool` → `permissionCards`, `--resume` → `resume`. oneshot(Codex) `exec --json` → `jsonOutput`, `exec resume` → `resume`.
- ACP 드라이버는 `--help` 대신 `initialize` 응답의 `agentCapabilities`(`loadSession`, `promptCapabilities` …)와 `protocolVersion` 으로 정한다. `--version`·`--help` 는 어댑터·CLI 버전 기록과 drift 검사에만 쓴다.
- 설정 파일의 `capabilities` 는 **상한**이다. 감지가 켜도 설정이 끄면 끈다. 감지가 못 찾으면 켜지 않고 경고를 낸다.
- 최소 버전보다 낮거나, 알려진 최신 fixture 버전보다 **높으면** 경고("녹화 안 된 버전")만 내고 막지 않는다.

## H. 형식 변화 감지

세 겹으로 막는다. 겹마다 잡는 것이 다르다.

| 겹 | 어디서 | 무엇을 잡나 | 무엇을 못 잡나 |
|---|---|---|---|
| 1. 계약 테스트 | 모든 커밋 CI | 드라이버를 고쳤더니 녹화된 원문 해석이 달라짐 | 새 버전 CLI 의 형식 변화(녹화가 옛 것) |
| 2. 예약 CI (`--help`·스키마 비교) | 매주, 토큰 없이 | 새 버전의 플래그·하위 명령·프로토콜 스키마 변화 | 실제 출력 줄의 변화(로그인이 필요해서) |
| 3. 노트북 탐침 | 사람이, 새 버전이 보이면 | 실제 출력·승인 흐름 변화 | — (가장 비싸서 드물게) |
| (실행 중) unknown 로그 | 사용자 앱 | 녹화 사이에 생긴 새 이벤트 | — |

### fixture 구조

```
app/test/fixtures/providers/
  claude/
    2.1.248/            # 노트북 녹화
      meta.json         # { provider, version, os, recordedAt(날짜만), command(argv, 경로 가림), scenes:[…] }
      help/claude.txt   # --help 전문
      01-cards.jsonl    # {"dir":"in"|"out"|"err"|"exit", "msg"|"text"}  (지금 stream/ 형식 그대로)
      01-cards.expect.json   # decode 결과 요약(이벤트 type 순서, 카드 수, unknown 0) — 계약 테스트가 비교
    2.1.323/            # 지금 fixtures/stream/ 을 옮김
  codex/
    0.169.0/
      help/{codex,exec,app-server,…}.txt
      schema/           # app-server 가 생성하는 스키마 (CI 가 만드는 것과 같은 명령)
      01-read.jsonl … 06-app-server.jsonl
  _latest.json          # 프로바이더별 "녹화된 최신 버전" — 감지가 이보다 높으면 경고
```

- 지금 `app/test/fixtures/stream/` 은 `providers/claude/2.1.323/` 로 옮긴다(파일 이동만, 다음 단계 어댑터 단위에서).
- 버전 폴더는 지우지 않는다. 옛 버전 해석이 계속 되는지가 하위 호환 검사다.
- 개인 정보: 지금 `fixtures-privacy.test.ts` 가 `fixtures/` 아래를 재귀로 보므로 새 폴더도 자동으로 검사된다. Codex 녹화에서 추가로 가릴 것: `~/.codex` 경로, `account_id`·`chatgpt_account_id`·`user_id` 류 칸, 세션 파일 경로의 사용자 이름. 검사기에 해당 칸 이름 패턴을 추가한다(다음 단계).

### 계약 테스트

`app/test/contract.test.ts`(다음 단계) — fixture 폴더마다:
1. 녹화 파일이 **1개 이상**이다(0개면 실패 — 조용히 통과 방지).
2. `out` 줄을 순서대로 `driver.decode` 에 넣는다. **throw 0**.
3. `unknown` 이 `expect.json` 에 적은 수를 넘지 않는다(새 이벤트를 발견하면 수를 올리는 게 아니라 매핑을 추가하고 기대값을 고친다).
4. 장면별 핵심 단언: 승인 카드 수, `allow_always` 옵션 유무, 질문 카드 수, `turnEnd.stopReason`, 사용량 창 이름.
5. `in` 줄 재생: 앱이 그 시점에 보낼 답(`answerPermission` 등)을 만들어 녹화된 `in` 과 **모양**(키 집합·타입)이 같은지 비교한다. 이게 "우리가 보낸 답을 그 버전 CLI 가 받았다"의 근거다.
6. 매핑 표 도달 계측: 드라이버의 매핑 분기마다 카운터를 두고, fixture 전체를 돌린 뒤 한 번도 안 닿은 분기 목록을 출력한다(실패는 아님, 목록이 길어지면 녹화가 부족하다는 신호).

### 예약 CI

`.github/workflows/provider-drift.yml`(다음 단계):

```yaml
on:
  schedule: [{ cron: '23 18 * * 1' }]   # 매주 월요일 (UTC), 시각은 임의
  workflow_dispatch: {}
jobs:
  drift:
    strategy: { matrix: { os: [ubuntu-latest, windows-latest] } }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: node app/scripts/provider-drift.mjs --out drift/   # 아래
      - uses: actions/upload-artifact@v4
        with: { name: drift-${{ matrix.os }}, path: drift/ }
```

`provider-drift.mjs` 가 하는 일:
1. 프로바이더 설정마다 `install.npm` 패키지의 `latest` 버전을 `npm view` 로 본다.
2. `_latest.json` 보다 새 버전이면 임시 폴더에 그 버전을 설치(`npm i --prefix`), `--version`·`--help`·하위 명령 help·스키마 명령을 실행해 저장. **로그인·모델 호출 없음, 비밀 변수 없음.**
3. 녹화된 최신 버전의 `help/`·`schema/` 와 비교:
   - 플래그 비교는 글자 diff 가 아니라 **플래그 집합** 비교(설명 문구 변화는 무시). 드라이버가 쓰는 플래그(`driver.requiredFlags`)가 사라지면 **실패**, 그 밖의 추가·삭제는 요약만.
   - 스키마는 메서드·알림 이름 집합과, 드라이버가 읽는 타입의 필드 집합 비교. 쓰는 필드가 사라지거나 타입이 바뀌면 **실패**.
4. 실패 → 작업 실패(빨간 배지) + 요약 파일. 사람이 보고 탐침을 돌릴지 정한다. 성공해도 새 버전이 있으면 "녹화 필요" 요약을 남긴다.

구독 토큰을 CI 에 넣지 않는다. 실제 실행 녹화는 노트북 탐침(E절) 뿐이다.

## I. 프로바이더 설정 형식

한 프로바이더 = 파일 하나. 위치는 `<설정 폴더>/providers/<id>.yaml`(사용자 추가)과 앱에 딸린 `app/providers/<id>.yaml`(기본 제공). 같은 id 면 사용자 파일이 이긴다. 키는 하나씩 검증한다. 키 하나가 틀리면 그 키만 버리고 경고를 낸다. 파일 전체를 버리는 것은 `id`·`driver`·`command` 가 틀릴 때뿐이다.

우선순위: 드라이버 기본값 → 설정 파일 → 기능 감지(상한은 설정 파일) → 실행할 때 화면에서 고른 값(모델·노력).

### 스키마 초안 (TypeScript 로 적은 모양. 파일은 YAML)

```ts
export interface ProviderConfig {
  schema: 1;                                  // 파일 형식 번호. 모르는 키는 무시하므로 키 추가로는 안 올린다
  id: string;                                 // [a-z0-9-]+, 파일 이름과 같음
  name: string;                               // 화면 이름
  driver: 'claude-stream' | 'acp' | 'oneshot';   // 대화(메인)용 드라이버. 워커 단발 실행은 아래 worker 블록
  command: {
    bin: string;                              // PATH 에서 찾을 이름 또는 절대 경로 (셸 없이 execFile)
    args?: string[];                          // 드라이버가 붙이는 인자 앞에 들어감 (예: acp 어댑터 ["--acp"])
    env?: Record<string, string>;             // 추가 환경 변수(비밀 금지)
    unsetEnv?: string[];                      // 지울 환경 변수 — API 키가 있으면 구독 대신 과금되는 하네스용
  };
  install?: { npm?: string; url?: string };   // 설치 안내 + 예약 CI drift 검사 대상
  minVersion?: string;
  models: {
    id: string;                               // 하네스에 넘기는 값
    label?: string;
    efforts?: string[];                       // 그 모델이 받는 노력 값
    default?: boolean;
  }[];
  modelArg?: string[];                        // 예 ["-m", "{model}"]. 드라이버 기본값이 있으면 생략
  effortArg?: string[];                       // 예 ["-c", "model_reasoning_effort={effort}"]
  capabilities?: Partial<Capabilities>;       // G절. 상한. 생략하면 감지 결과 그대로
  auth: {
    /** 로그인 확인 명령. 종료 코드 0 = 로그인됨. 출력은 화면에 보이지 않고 판정만 */
    check?: { bin?: string; args: string[]; okPattern?: string };   // bin 생략 = command.bin
    loginHint: string;                        // 안 됐을 때 보여 줄 문장 ("터미널에서 `codex login`")
    /** 이 하네스가 구독 대신 API 과금으로 넘어가는 조건. 있으면 실행 전에 막는다 */
    billingGuard?: { envPresent?: string[] };
  };
  limits: {
    /** 외부 워커로 보낼 단위: 'hard-only'(기본) = 메인이 어렵다고 판단한 단위만, 'any', 'never' */
    policy: 'hard-only' | 'any' | 'never';
    /** 한도 창을 읽을 수 있으면 그 이름. 없으면 화면은 "—" */
    windows?: string[];
    /** 남은 비율이 이 아래면 워커로 보내지 않고 메인에게 알린다 */
    stopBelowPct?: number;
  };
  worker?: {
    /** 워커(단발) 실행. 생략하면 command 를 그대로 쓴다. 자리표시: {sandbox} {lastMessageFile} {model} {effort} */
    bin?: string; args?: string[];
    /** 승인을 앱으로 못 넘기는 단발 실행이면 샌드박스로 막는다 */
    sandbox: 'read-only' | 'workspace-write';
    timeoutSec: number;
    output: 'last-message' | 'json-events';
  };
  docs?: string[];                            // 근거 링크
}
```

### 예시 1 — Codex

대화(메인 후보)는 ACP(codex-acp 어댑터), 워커는 `codex exec` 단발. 한 파일에 둘 다 적는다.

```yaml
schema: 1
id: codex
name: Codex
driver: acp                       # F절 추천: Codex 대화는 공식 어댑터 경유
command:
  bin: npx                        # 또는 전역 설치한 codex-acp 절대 경로
  args: ["-y", "@agentclientprotocol/codex-acp@2.6.0"]   # 버전 고정 (drift CI 가 새 버전 알림)
  unsetEnv: [OPENAI_API_KEY, CODEX_API_KEY]               # 키가 있으면 구독이 아니라 API 과금
install: { npm: "@openai/codex" } # drift 검사 대상: CLI 와 어댑터 둘 다
minVersion: "0.169.0"             # 노트북 탐침 버전으로 확정 [확인 필요]
models:
  - { id: "<탐침의 model/list 결과>", efforts: ["<모델이 광고하는 값>"], default: true }  # 이름을 지어내지 않음
modelArg: ["-m", "{model}"]
effortArg: ["-c", "model_reasoning_effort={effort}"]
auth:
  check: { bin: codex, args: ["login", "status"], okPattern: "Logged in" }   # 출력 문구는 탐침 versions.json 으로 확정 [확인 필요]
  loginHint: "터미널에서 codex login (ChatGPT 계정)"
  billingGuard: { envPresent: [OPENAI_API_KEY, CODEX_API_KEY] }
limits:
  policy: hard-only               # 메인이 어렵다고 판단한 단위만 Codex 로
  windows: []                     # ACP 경로엔 구조화된 창이 없음 (D.1). 필요하면 app-server rateLimits 확인 명령
  stopBelowPct: 10
worker:
  bin: codex                      # 워커는 어댑터 없이 CLI 직접
  args: ["exec", "--json", "--sandbox", "{sandbox}", "--skip-git-repo-check", "-o", "{lastMessageFile}"]
  sandbox: workspace-write        # 구현 단위. 교차 리뷰는 read-only
  timeoutSec: 1800
  output: last-message
docs:
  - https://developers.openai.com/codex/noninteractive
  - https://github.com/agentclientprotocol/codex-acp
```

### 예시 2 — 가상의 ACP 하네스 "acme"

ACP 를 지원하는 하네스는 드라이버 코드 없이 이 파일 하나로 붙는다.

```yaml
schema: 1
id: acme
name: Acme Agent (가상)
driver: acp
command:
  bin: acme
  args: ["acp"]                   # ACP 서버 모드로 띄우는 인자
install: { npm: "acme-agent" }
models:
  - { id: "ollama/qwen3:8b", label: "로컬 Qwen3 8B", default: true }
  - { id: "openrouter/some-free-model", label: "무료 클라우드" }
modelArg: ["--model", "{model}"]
capabilities:
  questionCards: false            # ACP 에 질문 카드가 없음
  usageWindows: false
auth:
  check: { args: ["auth", "status"] }
  loginHint: "acme auth login"
limits:
  policy: hard-only
worker:
  sandbox: read-only
  timeoutSec: 900
  output: last-message
```

판정 예: Codex 대화(ACP) = `initialize` 에서 `loadSession: true` + 권한 요청 사용 → 메인 조건 충족(메인 가능). Codex 워커(`codex exec`) = oneshot → 워커. acme = `loadSession: false` 면 메인 불가, `worker` 블록이 있으면 워커만.

## J. 하네스 조사

### J.1 ACP 네이티브 지원 CLI (어댑터 없이)

"확인(레지스트리)"는 ACP 공식 레지스트리 JSON의 실행 인자 기준이다 ([registry.json][acp-reg]). 버전도 레지스트리 기준이다.

| CLI | 실행 | 버전 | 라이선스 | Windows | 확인 수준 | 근거 |
|---|---|---|---|---|---|---|
| OpenCode | `opencode acp` | 2.3.0 | MIT | x86_64·aarch64 바이너리 | 확인(레지스트리+문서) | [registry][acp-reg], [ACP 문서][oc-acp] |
| Goose | `goose acp` (`acp serve`로 HTTP/WS도 가능) | 1.59.1 | Apache-2.0 | x86_64 바이너리 | 확인(레지스트리+문서) | [registry][acp-reg], [CLI 문서][goose-cli] |
| Qwen Code | `qwen --acp` (레지스트리 인자: `--acp --experimental-skills`) | 0.27.4 | Apache-2.0 | npx | 확인(레지스트리+README) | [registry][acp-reg], [README][qwen-readme] |
| Gemini CLI (보류 대상) | `gemini --acp` | 0.68.0 | Apache-2.0 | npx | 확인(레지스트리) | [registry][acp-reg] |
| Kimi CLI | `kimi acp` | 1.52.0 | MIT | x86_64·aarch64 | 확인(레지스트리+README) | [registry][acp-reg], [README][kimi-readme] |
| Kimi Code | `kimi-code acp` | 2.6.2 | MIT | npx | 확인(레지스트리) | [registry][acp-reg] |
| Kilo CLI | `kilo acp` | 7.8.27 | MIT | x86_64 | 확인(레지스트리+문서) | [registry][acp-reg], [문서][kilo-cli] |
| Cline CLI | `cline --acp` | 3.0.74 | Apache-2.0 | npx | 확인(레지스트리) | [registry][acp-reg] |
| Augment (auggie) | `auggie --acp` | 0.37.0 | 독점 | npx | 확인(레지스트리) | [registry][acp-reg] |
| GitHub Copilot CLI | `copilot --acp` | 1.0.112 | 독점 | npx | 확인(레지스트리) | [registry][acp-reg] |
| Cursor | `cursor-agent acp` | 2026.11.13 | 독점 | x86_64·aarch64 | 확인(레지스트리) | [registry][acp-reg] |
| Mistral Vibe | 별도 실행 파일 `vibe-acp` | 3.1.1 | Apache-2.0 | x86_64 | 확인(레지스트리) | [registry][acp-reg] |
| Junie / Kiro / Factory Droid / Qoder | `--acp=true` / `kiro-cli acp` / `droid exec --output-format acp-daemon` / `--acp` | 4020.10.0 / 3.0.0 / 1.12.1 / 1.1.89 | 독점 등 | Kiro는 Windows 바이너리 없음 | 확인(레지스트리) | [registry][acp-reg] |
| **어댑터 필요**: Claude Code, Codex CLI, Amp, Pi | `claude-agent-acp` / `codex-acp` / `amp-acp` / `pi-acp` | 0.107.0 / 2.6.0 / 0.13.0 / 0.0.34 | — | — | 확인(레지스트리) | [registry][acp-reg] |
| Crush | ACP 하위 명령 없음 | 0.101.0 | FSL-1.1-MIT | — | 미지원 확인(소스) | [root.go][crush-root] |
| Aider | 레지스트리·목록 어디에도 없음 | 0.86.2 | Apache-2.0 | — | 미지원(추측) | [registry][acp-reg], [agents][acp-agents] |
| cagent (현 docker-agent) | 문서 목록에는 "Docker's cagent"가 있으나 레지스트리에 없고 README에 ACP 언급 없음 | 미확인 | 미확인 | — | 미확인 | [agents][acp-agents], [README][cagent] |

### J.2 AGENTS.md를 읽는 CLI

| CLI | 읽는가 | 조건 | 근거 |
|---|---|---|---|
| Codex CLI | ✓ 기본 | 전역 → 프로젝트 루트 → cwd 순서로 쌓인다 | [OpenAI 문서][oai-agentsmd] |
| Claude Code | △ v2.1.277 이상 | 작업 폴더나 그 상위에 `CLAUDE.md`·`.claude/CLAUDE.md`·`CLAUDE.local.md`가 **없을 때만** 읽는다. "Project instructions" 설정으로 둘 다 읽게 할 수 있고, `CLAUDE.md`에서 `@AGENTS.md`로 import도 된다. v2.1.281 이전 일부 세션(Bedrock, 텔레메트리 끔)은 CLAUDE.md만 읽는다 | [Claude Code memory 문서][cc-mem] |
| OpenCode (v2) | ✓ 기본 | 전역 `~/.config/opencode/AGENTS.md`와 작업 폴더부터 위쪽의 AGENTS.md | [Instructions 문서][oc-instr] |
| Gemini CLI | 설정 시 | `.gemini/settings.json`의 컨텍스트 파일 이름을 바꾼다 | [agents.md FAQ][agentsmd], [설정 문서][gemini-cfg] |
| Aider | 설정 시 | `.aider.conf.yml`에 `read: AGENTS.md` | [agents.md FAQ][agentsmd] |
| Goose, Cursor, Amp, Jules, Factory, Zed, Warp, VS Code, Devin, Junie, RooCode, Kilo Code, Phoenix, Semgrep, GitHub Copilot coding agent, Ona, Windsurf, Augment Code, UiPath | ✓ (agents.md 목록 기준) | 개별 문서는 확인하지 않음 | [agents.md][agentsmd] |
| Qwen Code, Kimi CLI, Crush | 미확인 | — | — |

Claude 메인과 Codex 워커가 같은 지침을 쓰려면 AGENTS.md 하나를 두고 CLAUDE.md에서 `@AGENTS.md`로 import하는 방식이 문서와 맞는다 ([cc-mem][cc-mem], [oai-agentsmd][oai-agentsmd]).

### J.3 API 키·로컬 모델을 받는 오픈 하네스

| 하네스 | 최신 버전 (날짜) | 라이선스 | 비대화 실행 | JSON 출력 | 승인 방식 | 이어하기 | ACP | Ollama | Windows | 근거 |
|---|---|---|---|---|---|---|---|---|---|---|
| **OpenCode** | npm `@opencode/cli` 2.3.0 (2026-11-13). 구 `opencode-ai`는 1.19.5에서 멈춤. 커밋 2026-11-15 | MIT | `opencode run "…"` | `--format json` (NDJSON) | 권한 규칙 + `--auto`(명시적으로 거부되지 않은 것은 자동 승인). ACP에서는 once/always/reject | `--continue`, `--session <id>`, ACP `session/load`·`resume`·`fork` | ✓ | ✓ `127.0.0.1:11434` 자동 탐지 | 바이너리 있음. v1 문서는 WSL 권장 | [commands][oc-cmd], [ACP][oc-acp], [providers][oc-prov], [npm][npm-oc], [WSL][oc-wsl] |
| **Goose** | 1.59.1 (레지스트리). 태그 v1.59.2 있음, 커밋 2026-11-16. 저장소가 aaif-goose로 이동 | Apache-2.0 | `goose run -t "…"` | `--output-format json\|stream-json` | 모드: Completely Autonomous(**기본**) / Manual / Smart Approval / Chat Only | `goose run --resume`, `session --resume` | ✓ | ✓ | ✓ 데스크톱과 CLI | [CLI][goose-cli], [권한][goose-perm], [README][goose-readme] |
| **Qwen Code** | 0.27.4 (npm 2026-11-15) | Apache-2.0 | `qwen -p "…"` | `--output-format json\|stream-json` (`system/session_start` 등 Claude Code와 비슷한 이벤트) | plan / 호출마다 확인 / auto-edit / Auto / YOLO | `--continue`, `--resume <id>` | ✓ | ✓ | ✓ (README Windows 설치) | [headless][qwen-headless], [README][qwen-readme] |
| Aider | 0.86.2 (PyPI 2026-02-12). 마지막 커밋 2026-05-22 → 정체 | Apache-2.0 | `aider --message "…"` | 없음(텍스트). JSON 출력 미확인 | `--yes-always` | `--restore-chat-history` | ✗ (추측) | ✓ (`OLLAMA_CONTEXT_LENGTH` 설정 권장) | 미확인 | [scripting][aider-script], [options][aider-opts], [ollama][aider-ollama], [PyPI][pypi-aider] |
| Crush | 0.101.0 (npm 2026-11-12). 커밋 2026-11-15 | FSL-1.1-MIT (조건 세부 미확인) | `crush run "…"` | 플래그 없음(텍스트, `-q`) | 기본은 승인 요청. `--yolo`(`-y`/`-yy`), permissions allow/deny | `--continue`, `--session` | ✗ | ✓ (`provider add ollama`) | ✓ PowerShell/WSL | [run.go][crush-run], [root.go][crush-root], [README][crush-readme] |
| Kilo CLI | 7.8.27 (npm 2026-11-13) | MIT | `kilo run` (추측: OpenCode 계열로 `opencode.json`을 읽음) | 미확인 | 미확인 | 미확인 | ✓ | 미확인 | ✓ 바이너리 | [문서][kilo-cli], [registry][acp-reg] |
| Cline CLI | 3.0.74 (npm 2026-11-11) | Apache-2.0 | `cline "…"` (파이프, 리다이렉트, `--json`일 때 headless) | `--json` (NDJSON) | 자율 실행 플래그 있음. 기본값 미확인 | 미확인 | ✓ | 미확인 | 미확인 | [CLI 문서][cline-cli], [registry][acp-reg] |

### J.4 데모용 두 번째 프로바이더 후보

| 후보 | 종류 | Windows | ACP | 비대화 JSON | 승인 요청 방식 | 무료 조건 | 서드파티 래핑 | 근거 |
|---|---|---|---|---|---|---|---|---|
| **C1. OpenCode 2.3.0 + Console 무료 모델** (예: GLM-5.3-Flash Free, DeepSeek V4.1 Flash Free) | 클라우드 | 바이너리 ✓ (WSL 권장) | ✓ 네이티브 | ✓ `run --format json` | ACP `request_permission` (once/always/reject) | "한정 기간" 무료. 모델마다 데이터 정책이 다르고(일부는 학습에 사용), LongCat은 하루 100회. 무료 모델 목록이 자주 폐기된다(Crouton Alpha Free 11-09, Pulse Alpha Free 11-06). 로그인·카드 필요 여부 **미확인** | 문서: "무료 모델은 OpenCode 안에서만, 다른 하네스는 HTTP 403". Plenum이 OpenCode를 실행하면 요청 주체가 OpenCode이므로 허용될 것(추측) | [Console models][oc-models], [harnesses][oc-harn] |
| C2. OpenRouter `:free` 모델 (OpenCode/Goose 경유) | 클라우드 | 하네스를 따름 | 하네스를 따름 | 하네스를 따름 | 하네스를 따름 | 분당 20회. 크레딧 $10 미만이면 하루 50회, $10 이상이면 하루 1000회. 신규 사용자에게 소액 무료 허용. 키 발급에 카드가 필요한지 **미확인** | 일반 API라 래핑 제약 없음(추측. 약관 세부 미확인) | [limits][or-limits], [FAQ][or-faq] |
| C3. Qwen Code 0.27.4 + Qwen OAuth | 클라우드 | ✓ | ✓ | ✓ | approval modes | **무료 아님.** Qwen OAuth에 chat.qwen.ai Plus/Pro 구독이 필요하다(현 문서) | — | [auth 문서][qwen-auth] |
| **L1. OpenCode 2.3.0 + Ollama `qwen3:8b`** | 로컬 | ✓ | ✓ | ✓ | ACP `request_permission` | 무료. 5.2GB, 40K 컨텍스트, tools·thinking 지원 | 해당 없음 | [qwen3][ollama-qwen3], [providers][oc-prov] |
| L2. OpenCode/Goose + Ollama `qwen2.5-coder:7b` | 로컬 | ✓ | ✓ | ✓ | 같음 | 무료. 4.7GB, 32K, tools 지원 | 해당 없음 | [qwen2.5-coder][ollama-q25c] |
| L3. Goose 1.59.1 + Ollama `qwen3:8b` | 로컬 | ✓ | ✓ | ✓ `--output-format json` | 기본이 Completely Autonomous라 승인 카드를 보이려면 Manual 모드로 설정해야 함. ACP 승인 동작은 미확인 | 무료 | 해당 없음 | [권한][goose-perm], [CLI][goose-cli] |

로컬 모델 주의점:
- 8B급 모델의 여러 단계 도구 호출은 신뢰도가 낮을 수 있다(추측).
- VRAM 8GB에서는 가중치 5.2GB에 KV 캐시가 더해지므로, 실제로 쓸 수 있는 컨텍스트는 16~32K 정도로 보인다(추측).
- aider 문서에 따르면 Ollama 기본 컨텍스트는 2k이고 넘치는 부분을 조용히 버린다. 그러면 하네스 시스템 프롬프트가 잘린다. `OLLAMA_CONTEXT_LENGTH` 설정이 필요하다 ([aider 문서][aider-ollama]. 현재 Ollama 기본값은 미확인).

**추천:**
- **클라우드: C1 (OpenCode + Console 무료 모델).**
  - ACP 네이티브이고, 승인·이어하기·`usage_update`(cost)가 모두 문서에 있다 ([ACP][oc-acp]).
  - Windows 바이너리가 있다.
  - 모델 이름은 하드코딩하지 말고 설정 파일로만 지정한다. 무료 목록이 자주 바뀌기 때문이다 ([models][oc-models]).
  - 무료 모델이 사라지면 같은 하네스에서 C2(OpenRouter)로 설정만 바꾼다(추측).
- **로컬: L1 (OpenCode + Ollama `qwen3:8b`).**
  - 클라우드와 같은 하네스, 같은 ACP 드라이버를 쓰고 모델 설정만 바꾼다. "새 모델 = 설정 파일 하나"를 그대로 시연할 수 있다 ([providers][oc-prov], [qwen3][ollama-qwen3]).
  - 도구 호출이 불안정하면 L2로 바꾼다(추측).

[cc-mem]: https://code.claude.com/docs/en/memory
[oai-agentsmd]: https://developers.openai.com/codex/guides/agents-md
[agentsmd]: https://agents.md
[gemini-cfg]: https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/configuration.md
[oc-instr]: https://opencode.ai/docs/instructions/
[oc-acp]: https://opencode.ai/docs/cli/acp/
[oc-cmd]: https://opencode.ai/docs/cli/commands/
[oc-prov]: https://opencode.ai/docs/providers/
[oc-models]: https://opencode.ai/docs/console/models/
[oc-harn]: https://opencode.ai/docs/console/harnesses/
[oc-wsl]: https://opencode.ai/v1/docs/windows-wsl/
[npm-oc]: https://www.npmjs.com/package/@opencode/cli
[goose-cli]: https://goose-docs.ai/docs/guides/goose-cli-commands
[goose-perm]: https://goose-docs.ai/docs/guides/managing-tools/goose-permissions
[goose-readme]: https://github.com/aaif-goose/goose
[qwen-readme]: https://github.com/QwenLM/qwen-code
[qwen-headless]: https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/
[qwen-auth]: https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/
[kimi-readme]: https://github.com/MoonshotAI/kimi-cli
[kilo-cli]: https://kilo.ai/docs/cli
[cline-cli]: https://docs.cline.bot/cline-cli/overview
[aider-script]: https://aider.chat/docs/scripting.html
[aider-opts]: https://aider.chat/docs/config/options.html
[aider-ollama]: https://aider.chat/docs/llms/ollama.html
[pypi-aider]: https://pypi.org/project/aider-chat/
[crush-readme]: https://github.com/charmbracelet/crush
[crush-run]: https://github.com/charmbracelet/crush/blob/main/internal/cmd/run.go
[crush-root]: https://github.com/charmbracelet/crush/blob/main/internal/cmd/root.go
[cagent]: https://github.com/docker/cagent
[or-limits]: https://openrouter.ai/docs/api/reference/limits
[or-faq]: https://openrouter.ai/docs/faq
[ollama-qwen3]: https://ollama.com/library/qwen3
[ollama-q25c]: https://ollama.com/library/qwen2.5-coder

## 결정이 필요한 것

| # | 결정 | 선택지 | 추천 | 근거 절 |
|---|---|---|---|---|
| 1 | 드라이버 구조 | (1) 전부 ACP / (2) Claude 직접 + 범용 ACP / (3) 직접만 | **(2)** — Claude "이 세션 동안 허용"·한도 창을 지키고, 나머지는 공식 어댑터가 형식 변화를 흡수 | F.5–F.6 |
| 2 | jh-kit 안 Codex 워커 경로 | `codex exec` 단발(샌드박스 + worktree) / Plenum 경유 ACP | **`codex exec` 단발** — Claude 세션 안에서 Bash 로 끝나고 Plenum 이 꺼져 있어도 된다. 승인 대신 샌드박스 | D.1 |
| 3 | Codex 워커 샌드박스 기본값 | 구현 `workspace-write` + 전용 worktree / 리뷰 `read-only` / 둘 다 `read-only` | 구현 = workspace-write + worktree, 리뷰 = read-only | C.3, D.1 |
| 4 | 인증 처리 | 각 CLI 자체 로그인만 / Plenum 이 토큰 주입 / API 키 선택지 | **자체 로그인만**(+ API 키 경로는 넣지 않음: 과금 금지 규칙) | A.2–A.3 |
| 5 | 서드파티 래핑 애매함 | 그대로 공개 / README 고지 추가 / Anthropic 에 문의 후 공개 | README 고지 추가. 공개 배포(4단계) 전에 문의 여부를 다시 정함 | A.1 ③ |
| 6 | OpenAI 약관 원문 확인 | 브라우저로 사람이 확인 / 확인 없이 진행 | **사람이 확인** — 이 환경에서 openai.com 정책 페이지가 403 이라 못 읽음 | A.4 |
| 7 | ChatGPT 구독 유지 | 유지 / Codex 워커 실험 기간만 / 해지 | 사람이 정함. 탐침 ⑥의 한도 값(primary/secondary 창)과 실제 워커 몇 회 결과를 보고 정하는 것을 추천 | C.5 |
| 8 | 데모 두 번째 프로바이더 | 클라우드 C1 OpenCode + 무료 모델 / C2 OpenRouter `:free` / 로컬 L1 OpenCode + Ollama qwen3:8b / L2 qwen2.5-coder:7b | **OpenCode 하나로 C1 + L1** — 같은 하네스·같은 ACP 드라이버에서 모델 설정만 바꿔 "새 모델 = 설정 파일 하나"를 보여 줌. C1 의 카드·로그인 필요 여부는 미확인 → 가입 단계에서 카드 요구가 나오면 L1 만 | J.4 |
| 9 | 탐침 스크립트 보관 | 레포에 커밋(`docs/research/probe/`) / zip 만(커밋 안 함) | 이번엔 zip 만(지시대로). 다음 단계 drift 작업에서 녹화 도구를 `app/scripts/` 로 정식 편입할지 정함 | E |
| 10 | 노트북 claude 버전이 2.1.248 이 아닐 때 | 재녹화 + 비교(탐침이 자동) / 업데이트 보류 | 탐침 자동(지시대로). 결과 `compare.md` 의 사라진 키가 있으면 다음 단계 첫 일로 | E, H |
| 11 | codex-acp 의 묶인 codex 버전 지연(0.166.x 고정, CLI 는 0.169.0) | 어댑터 기본 사본 사용 / 설치된 codex 경로를 넘김 | 어댑터 기본 사본(어댑터가 검증한 조합). 새 모델이 꼭 필요할 때만 경로 지정 | F.3 |
| 12 | 프로바이더 설정 파일 위치 | 앱 설정 폴더 / kit 레포 / 둘 다(앱 기본 + 사용자) | 둘 다: 앱에 딸린 기본 파일 + 사용자 설정 폴더가 덮어씀. jh-kit 의 `providers.yaml` 은 워커가 쓸 실행기 목록으로 따로 둠(같은 id 사용) | I |

## 다음 단계 작업 단위 (Plenum)

jh-kit 쪽 단위(2.8.0)는 jh-kit 레포의 계획 문서에 있다. 여기는 Plenum 만. 순서는 P1 → P2 → (P3 ∥ P4) → P5 → P6. 각 단위는 **동작을 바꾸지 않는 것(P1·P2·P3)** 과 **새 기능(P4~P6)** 으로 나뉜다.

### P1. 어댑터 층 — 이벤트 모델 도입 (동작 그대로)
- 바꿀 파일: `app/server/provider/events.ts`(새, G절 타입), `app/server/provider/claude.ts`(새: `chat.ts` 의 줄 해석을 `decode(raw) → ProviderEvent[]` 로 옮김), `app/server/chat.ts`(해석 대신 `decode` 호출 + 내부 이벤트 → 지금 `ChatEvent` 로 다시 펼침), `app/test/fixtures/stream/` → `app/test/fixtures/providers/claude/2.1.323/`(이동 + `meta.json`), `app/test/contract.test.ts`(새), 기존 테스트의 fixture 경로
- 목표: 화면·SSE·API 모양은 한 글자도 안 바뀌고, Claude 해석이 드라이버 하나로 모인다. 모르는 이벤트는 `unknown` 으로 남고 throw 하지 않는다
- 완료 기준:
  - `cd app && npm test` 전부 통과(0.3.0 의 276개 + 새 계약 테스트), `npm run typecheck` 0 오류
  - `cd app && npx vitest run test/contract.test.ts` — fixture 폴더 ≥1, 모든 `out` 줄 decode throw 0, `unknown` 수 = `expect.json` 값
  - `cd app && npm run e2e` 9+19 흐름 통과(지금과 같음)
  - `git diff main -- app/web/` 비어 있음(화면 코드 안 바뀜)

### P2. 프로바이더 설정·기능 감지 (동작 그대로)
- 바꿀 파일: `app/server/provider/config.ts`(새: I절 스키마 로더, 키별 검증), `app/providers/claude.yaml`(새: 지금 동작을 설정으로), `app/server/claudecaps.ts` → `app/server/provider/detect.ts`(일반화, 캐시 키 그대로), `app/test/providerconfig.test.ts`(새)
- 목표: Claude 실행 인자·최소 버전·기능이 설정 파일 + 감지로 정해진다. 결과는 지금과 같다
- 완료 기준:
  - `cd app && npx vitest run test/providerconfig.test.ts` — 키 하나가 틀린 파일은 그 키만 버리고 경고, `id`/`driver`/`command` 가 틀리면 파일 거부, 사용자 파일이 기본 파일을 덮음
  - `chatArgs` 결과가 P2 전후 같음(기존 `chat.test.ts` 통과)
  - `--effort` 없는 가짜 claude 로 `effortSelect: false`(기존 테스트 통과)

### P3. 형식 변화 감지 CI
- 바꿀 파일: `.github/workflows/provider-drift.yml`(새, H절), `app/scripts/provider-drift.mjs`(새), `app/test/fixtures/providers/_latest.json`(새), `app/test/fixtures-privacy.test.ts`(Codex 칸 이름 패턴 추가: `account_id`·`chatgpt_account_id`·`user_id`, `~/.codex` 경로)
- 목표: 매주 토큰 없이 새 CLI 버전의 help·스키마를 녹화본과 비교해, 드라이버가 쓰는 플래그·필드가 사라지면 빨간 불
- 완료 기준:
  - 로컬: `node app/scripts/provider-drift.mjs --out /tmp/drift --version-override codex=0.169.0` 이 help·스키마를 받고 "차이 없음" 요약
  - 일부러 기준 help 에서 `--json` 을 지운 사본으로 돌리면 종료 코드 1 + "requiredFlags 사라짐: --json"
  - GitHub Actions `workflow_dispatch` 1회 실행 성공(ubuntu·windows), 비밀 변수 참조 0(`grep -n secrets .github/workflows/provider-drift.yml` 비어 있음)

### P4. Codex 녹화 fixture 넣기 (탐침 결과)
- 바꿀 파일: `app/test/fixtures/providers/codex/<노트북 버전>/`(탐침 zip 에서 가린 녹화·help·스키마), `.../expect.json`, (claude 버전이 달랐다면) `app/test/fixtures/providers/claude/<버전>/`
- 목표: Codex 실제 출력이 계약 테스트의 입력이 된다
- 완료 기준:
  - `cd app && npx vitest run test/fixtures-privacy.test.ts` 통과(`PLENUM_PRIVATE_WORDS` 를 노트북 값으로 넣고 한 번 더)
  - 탐침 `redaction-report.txt` 가 "남은 것 없음"
  - (P5 전에는) 계약 테스트가 codex 폴더를 "드라이버 없음 — 건너뜀" 으로 표시하고 실패하지 않음

### P5. 범용 ACP 드라이버 + Codex 연결
- 바꿀 파일: `app/server/provider/acp.ts`(새: initialize·session/new·load·prompt·update·request_permission·elicitation·cancel, v1 만), `app/providers/codex.yaml`(I절 예시 1), `app/server/chat.ts`(드라이버 선택), `app/test/fakeacp.ts`(새: 가짜 ACP 에이전트), `app/test/acp.test.ts`(새)
- 목표: Codex 를 Plenum 안 채팅으로 띄워 승인 카드·질문 카드·이어하기·중단이 된다(메인 조건 판정 실측). 모르는 `session/update` 종류는 원문 줄로 보이고 대화는 계속된다
- 완료 기준:
  - `cd app && npx vitest run test/acp.test.ts` — 가짜 ACP 에이전트로 카드 4종(allow_once, allow_always=session, reject, elicitation) 왕복, 모르는 update 1개 → `unknown` + 로그 파일 1줄, 앱 계속
  - 노트북: Codex 채팅에서 파일 쓰기 승인 카드 → "이 세션 동안 허용" → 같은 명령이 다시 안 물음 (사람이 확인)
  - 노트북: 이어하기로 앞 대화 기억

### P6. UI — 프로바이더·모델 선택, 역할 표시
- 바꿀 파일: `app/web/src/`(새 채팅 시작 화면의 프로바이더·모델·노력 선택, 설정 › 프로바이더 목록: 감지 버전·기능·역할(메인/워커)·로그인 상태), `app/server/` 의 목록 API, `app/e2e/`
- 목표: 등록된 프로바이더마다 "메인 가능 / 워커만 / 안 됨" 과 이유(빠진 기능)가 보이고, 메인 가능한 것으로 채팅을 시작할 수 있다. `unknown` 이벤트는 접힌 "원문 보기"
- 완료 기준:
  - `cd app && npm run e2e` 새 흐름(프로바이더 고르기, 원문 보기 펼치기) 통과, `npm test` 대비 테스트(contrast) 통과
  - 로그인 안 된 프로바이더는 시작 버튼 대신 `loginHint` 문장
  - `npm run screens` 다크 스크린샷에 프로바이더 목록 화면 추가

