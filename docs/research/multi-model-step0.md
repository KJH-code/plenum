# 멀티 모델(프로바이더) 0단계 — 조사와 설계

작성 2026-11-16 · 대상 Plenum 0.3.0 (`997cfe0`) · 코드 변경 없음(조사·설계만)

Plenum 은 지금 `claude -p` stream-json 하나만 다룬다. 이 문서는 아무 하네스(claude, codex, opencode …)나 등록해 메인 또는 워커로 쓰는 구조를 조사하고 설계한다.

## 요약

- **목표 구조**: 프로바이더 = 하네스, 모델 = 그 하네스가 받는 모델. 새 모델 = 설정 파일 하나(I절). 새 프로토콜만 드라이버 코드. 역할은 기능 목록으로 판정한다. 메인 = 세션 + 승인 카드 + 이어하기, 워커 = 단발 실행 + 결과(G절 `roleOf`).
- **드라이버는 셋**: Claude 직접(`claude-stream`, 지금 코드), 범용 ACP(`acp` — Codex 는 공식 어댑터 codex-acp 로 여기에 붙는다), ACP 없는 하네스용 단발(`oneshot`, 지금 대상 없음). 추천 근거는 F.6.
- **Codex 로 가는 길은 둘**: 플러그인 워커는 `codex exec --json`(W1, Plenum 을 거치지 않음), Plenum 은 codex-acp(W2). 형식 변화 감시도 두 길을 따로 한다(D.1, H.4).
- **형식 변화 대응**: 원문 보존 + `unknown` 이벤트(절대 throw 안 함), `--help`·스키마 기반 기능 감지, 버전별 녹화 fixture 와 계약 테스트, 토큰 없는 주간 drift CI, 실제 녹화는 노트북 탐침(E·G·H절).
- **Codex**: `codex exec` 는 승인을 사람에게 넘기지 못한다 → 워커 전용, 샌드박스로 막는다. 승인·질문·이어하기·한도는 `codex app-server`(experimental)에 있고, 공식 ACP 어댑터 `codex-acp` 가 그 위에 있다(C·D절).
- **약관·인증**: Plenum 은 인증을 다루지 않는다. 각 CLI 에 이미 된 로그인(구독이든 API 키든)을 그대로 쓰고, 수정 안 한 공식 CLI 를 실행하며, 자격 증명을 읽거나 보관하지 않는다. Anthropic 쪽은 문서와 맞지만, OpenAI 구독 로그인으로 자동 실행하는 것은 이용약관 2(c)(iv)와 회색 지대다(개인·로컬 위험 낮음, 추측). 서드파티 래핑도 애매한 곳이 남는다(A절). README 에 "각자 약관 확인, 자동화에는 API 키 권장"을 적는다.

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
| ① 〃 | OpenAI | **회색 지대** [Codex 0.169.0] | **약관**: 이용약관 2(c)(iv)는 API 를 거치지 않는 자동·프로그램 방식의 출력 추출을 금지한다(원문은 사람이 브라우저로 확인, 2026-11-16). **제품 문서**: 요금 페이지의 기능 표에서 "Codex SDK, `codex exec`, and scriptable workflows"가 Plus·Pro에 available로 나온다. "`codex exec` reuses saved CLI authentication by default." 조건이 두 가지 있다. 자동화에는 API 키를 권장한다("The right way to authenticate automation is with an API key"). ChatGPT 로그인으로 CI를 돌리는 방법은 신뢰된 비공개 러너에만 쓰고, "Do not use this workflow for public or open-source repositories." → 문서는 스크립트 실행을 안내하고 약관은 API 밖 자동 추출을 금지해 둘이 맞물리지 않는다. 개인이 로컬에서 자기 계정으로 쓰는 위험은 낮다고 본다(추측). | https://openai.com/policies/terms-of-use/ · https://developers.openai.com/codex/auth · https://learn.chatgpt.com/docs/pricing · https://learn.chatgpt.com/docs/non-interactive-mode · https://learn.chatgpt.com/docs/auth/ci-cd-auth |
| ② Codex(ChatGPT 로그인)가 `claude -p`를 하위 프로세스로 부름 | Anthropic | **애매 (허용 쪽 근거 있음)** [CC 2.1.325] | 소비자 약관은 자동화 접근을 금지하면서 예외를 둔다: "Except … where we otherwise explicitly permit it, to access the Services through automated or non-human means…". Claude Code 문서는 구독 OAuth를 스크립트용으로 안내한다: "For CI pipelines, scripts … generate a one-year OAuth token with `claude setup-token`" / "This token authenticates with your Claude subscription". 하지만 다른 회사 에이전트가 호출하는 경우는 명시가 없다. 또 "usage limits … assume ordinary, individual usage of Claude Code and the Agent SDK"라는 전제가 붙어 있다. | https://www.anthropic.com/legal/consumer-terms (Effective Oct 8, 2025) · https://code.claude.com/docs/en/authentication · https://code.claude.com/docs/en/legal-and-compliance |
| ② 〃 | OpenAI | **애매 (명시 없음)** | Codex 가 다른 회사 에이전트 CLI 를 실행하는 것을 다루는 조항은 문서·약관에 없다. 이용약관 2(c)(iv)(API 밖 자동 추출 금지)는 Codex 출력에 대한 조항이라 이 경우(Codex 가 남을 부름)에는 직접 걸리지 않는다(추측). Usage Policies 는 못 받았다(403). | https://openai.com/policies/terms-of-use/ · https://learn.chatgpt.com/docs/auth · (못 받음) https://openai.com/policies/usage-policies |
| ③ 서드파티 앱(Plenum)이 `claude -p`를 사용자의 구독 로그인으로 래핑 | Anthropic | **애매. 경계선은 금지 명시** [CC 2.1.325] | **금지 명시:** "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through … plan credentials on behalf of their users." / "developers may not collect, store, or intermediate Claude.ai credentials or session tokens". **금지 아님 명시:** "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". **애매:** Agent SDK 문서에 "does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK"가 있고, 헤드리스 문서는 `claude -p`를 "the Agent SDK via the CLI"라고 부른다. | https://code.claude.com/docs/en/legal-and-compliance · https://code.claude.com/docs/en/agent-sdk/overview · https://code.claude.com/docs/en/headless · AUP |
| ③ 서드파티 앱이 Codex를 ChatGPT 로그인으로 래핑 | OpenAI | **회색 지대 (문서는 허용, 약관은 ①과 같은 긴장)** [Codex 0.169.0] | 이용약관 2(c)(iv) 는 ①과 같다. app-server 문서: "Use it when you want a deep integration inside your own product: authentication, conversation history, approvals, and streamed agent events." 인증 모드에 대해서는 "`chatgpt` – Codex owns the ChatGPT OAuth flow, persists tokens, and refreshes them". SDK 문서: "Integrate Codex within your own application". 클라이언트 식별에 대해서는 "Use `clientInfo.name` to identify your client". | https://openai.com/policies/terms-of-use/ · https://learn.chatgpt.com/docs/app-server · https://learn.chatgpt.com/docs/codex-sdk |

### A.2 해설

**① Claude 메인 + Codex 워커**
- OpenAI 쪽은 문서와 약관이 엇갈린다. 제품 문서는 유료 요금제 기능 표에 스크립트 실행을 넣고 `codex exec` 가 저장된 ChatGPT 로그인을 그대로 쓴다고 안내한다 [Codex 0.169.0]. 같은 문서가 자동화에는 API 키를 권장한다. 이용약관 2(c)(iv)는 API 를 거치지 않는 자동·프로그램 방식의 출력 추출을 금지한다.
- Anthropic 쪽은 이 행위를 직접 다루는 조항이 없다. AUP 때문에 "OpenAI 약관을 지킬 것"이 간접 조건이 될 뿐이다.
- 결론: **회색 지대.** 개인이 자기 기기에서 자기 계정으로 쓰는 위험은 낮다고 본다(추측). Plenum 은 사용자마다 각자 로그인하고 자격 증명을 공유·보관하지 않는다(A.3). README 에 "각 CLI 약관은 각자 확인, 자동화에는 API 키가 권장된다"를 적는다.

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
| 1. Plenum은 인증을 다루지 않는다. 각 CLI에 이미 된 로그인(구독 로그인이든 API 키든)을 그대로 쓴다 (현행) | 0 | 가장 낮음. Anthropic 쪽은 문서의 "수정 안 한 바이너리 + 본인 로그인"과 맞는다. OpenAI 쪽은 구독 로그인이면 이용약관 2(c)(iv)와 회색 지대(개인·로컬 위험 낮음, 추측), API 키 로그인이면 문서 권장과 맞는다 — 어느 쪽인지는 사용자가 CLI에서 고른 로그인이 정한다 | 쉬움 |
| 2. Plenum이 토큰을 받아 주입 (`CLAUDE_CODE_OAUTH_TOKEN` 보관, Codex `chatgptAuthTokens`) | 중간 | Anthropic 쪽은 금지 명시("collect, store, or intermediate")에 걸림. Codex 쪽 모드는 experimental | 되돌리기 어려움 (저장된 토큰 처리 문제) |
| 3. Plenum이 API 키 경로를 따로 만든다(키 입력 칸 등) | 낮음 | 가장 명확함 (Anthropic은 Agent SDK 개발자에게 API 키를, OpenAI는 자동화에 API 키를 권장). 대신 사용자에게 과금됨 | 쉬움 |

→ **결정(결정 4): 1안.** Plenum은 인증을 다루지 않고, 각 CLI에 이미 된 로그인을 그대로 쓴다. API 키로 쓰고 싶은 사용자는 CLI 자체에서 API 키로 로그인하면 되므로 3안처럼 Plenum이 따로 길을 만들 필요가 없다. 2안은 하지 않는다. Plenum이 하는 일은 로그인 상태·방식을 **읽어서 보여 주는 것**뿐이다(I.1). 1안이 약관 위험을 없애 주지는 않는다 — OpenAI 구독 로그인 경로는 여전히 회색 지대다(A.1 ①·③).

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
12. README에 "각 CLI의 약관과 요금제 조건은 각자 확인한다. 자동화에는 API 키가 권장된다(OpenAI 문서). Plenum은 자격 증명을 다루지 않는다"고 고지한다. (근거: OpenAI 이용약관 2(c)(iv), [Codex auth](https://developers.openai.com/codex/auth))

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
| https://openai.com/policies/terms-of-use/ | 이 환경에서는 못 받음 (403). **사람이 브라우저로 확인**(2026-11-16): 2(c)(iv) API 밖 자동·프로그램 방식 출력 추출 금지 | 위 표의 약관 판정은 이 확인 기준 |
| https://openai.com/policies/usage-policies | **못 받음** (403) | |
| https://help.openai.com/en/articles/11369540 | **못 받음** (403) | |
| https://learn.chatgpt.com/docs/auth, /non-interactive-mode, /auth/ci-cd-auth, /codex-sdk, /app-server, /pricing | 받아 봄 (200) | developers.openai.com/codex/*에서 리다이렉트됨 |
| openai/codex 저장소 README | 받아 봄 (clone, HEAD f1ebc7b 2026-11-16) | "Sign in with ChatGPT … as part of your Plus, Pro, … plan" |

## B. Codex 기능 지도

기준: Codex CLI 0.169.0(`--help`·`app-server generate-json-schema` 실측, 소스 태그 `rust-v0.169.0`, 공식 문서 2026-11-16). 왼쪽 열은 Claude Code 플러그인이 흔히 쓰는 기능 종류다(특정 플러그인의 내부 구조는 적지 않는다).

| Claude Code 쪽 기능 | Codex 대응물 | 상태 | 차이·우회 | 근거 |
|---|---|---|---|---|
| 스킬 (`SKILL.md`, 이름·설명 머리말) | 스킬 (`SKILL.md`, `name`·`description` 필수). 위치 `$CWD/.agents/skills`, 상위 폴더, `$REPO_ROOT/.agents/skills`, `$HOME/.agents/skills` | **있음** | 형식이 거의 같다. 폴더 위치와 부르는 문법이 다름(`$skill-name`). 빌드 대상 하나로 복사·변환 가능 | [skills](https://developers.openai.com/codex/skills) |
| 서브에이전트 (에이전트 파일: 모델·노력·도구 고정) | 서브에이전트. 내장 `default`·`worker`·`explorer`, 커스텀은 `~/.codex/agents/`·`.codex/agents/` 의 TOML. 동시 수 `agents.max_concurrent_threads_per_session` | **있음 (모양 다름)** | 머리말 마크다운이 아니라 TOML. 부모 세션의 샌드박스·승인 설정을 **상속**한다 → 에이전트별 권한 제한은 Claude 보다 약함(추측: 도구 목록 제한 칸이 있는지 미확인) | [subagents](https://developers.openai.com/codex/subagents), exec 이벤트 `collab_tool_call`(`codex-rs/exec/src/exec_events.rs`) |
| 훅 (UserPromptSubmit, PreToolUse, PreCompact, SessionStart …) | 훅. PreModelRequest, PostModelRequest, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart, SessionEnd, SubagentStart, SubagentStop, UserPromptSubmit, Stop, Interrupt. `config.toml [hooks.<Event>]` | **있음** | 이벤트 이름이 거의 같다. 훅 "신뢰(trust)" 승인 단계가 따로 있다(`--dangerously-bypass-hook-trust`). 입출력 JSON 모양 대조는 탐침 후 | [hooks](https://developers.openai.com/codex/hooks), `codex exec --help` |
| 권한 규칙 (`permissions.allow/deny`, `Bash(git *)` 꼴) | execpolicy `.rules` (Starlark 풍 `prefix_rule(pattern=[…], decision=…)`), `~/.codex/rules/default.rules` + 샌드박스 모드 + 승인 정책 | **있음 (모양 다름)** | 규칙 언어가 다르다. 파일 경로 단위 Read/Edit 규칙은 없고 샌드박스(read-only / workspace-write / `--add-dir`)가 맡는다. 변환은 명령 접두 규칙만 1:1 | [rules](https://developers.openai.com/codex/rules), [sandbox](https://developers.openai.com/codex/sandbox) |
| 패키징 (플러그인 + 마켓플레이스) | `codex plugin add/list/remove`, `codex plugin marketplace add/list/remove/upgrade` | **있음** | 플러그인 형식(묶을 수 있는 것: 스킬·훅·MCP?)은 이번에 확인 못 함 → 다음 단계 조사 | `codex plugin --help`(0.169.0) |
| 압축 전 상태 저장 (PreCompact 훅) | PreCompact·PostCompact 훅, `thread/compact/start`, `compact_prompt`·`experimental_compact_prompt_file` | **있음** | 훅으로 같은 일을 할 수 있다. 압축 프롬프트 파일을 직접 줄 수 있어 Claude 보다 넓다 | [config reference](https://developers.openai.com/codex/config-reference) |
| 명령 검사 훅 (PreToolUse 훅이 특정 셸 명령, 예 `git push` 를 검사해 막음) | PreToolUse 훅 + execpolicy `prefix_rule(["git","push"], decision="prompt")` | **있음 (우회 필요)** | 훅이 같은 자리에 있으므로 같은 검사 스크립트를 쓸 수 있다(추측: 훅 입력의 명령 칸 이름 확인 필요). 더 확실한 이중 장치는 레포의 `core.hooksPath` git 훅(하네스와 무관하게 동작) | 위 hooks, rules |
| 프로젝트 지침 (`CLAUDE.md`) | `AGENTS.md` (전역 → 레포 루트 → cwd 순서로 쌓임), `project_doc_fallback_filenames` | **있음** | Claude Code 2.1.277+ 는 CLAUDE.md 가 없을 때만 AGENTS.md 를 읽는다. 공용 지침은 AGENTS.md 하나 + CLAUDE.md 에서 `@AGENTS.md` import | [AGENTS.md](https://developers.openai.com/codex/guides/agents-md), [Claude Code memory](https://code.claude.com/docs/en/memory) |
| 모델·노력 고정 워커 | `-m <모델>`, `-c model_reasoning_effort=<값>`, 프로필 `-p` (`$CODEX_HOME/<이름>.config.toml`) | **있음** | 노력 값은 열거형이 아니라 "모델이 광고하는 문자열"(`ReasoningEffort`). 허용 값은 app-server `model/list` 로 조회 | 스키마 `ReasoningEffort`, `codex exec --help` |
| 남은 한도 표시 | app-server `account/rateLimits/read`·`account/rateLimits/updated` (`usedPercent`, `windowDurationMins`, `resetsAt`) | **있음 (app-server 만)** | `exec --json` 에는 토큰 수만. 창 이름(5시간/주간)은 `windowDurationMins` 값으로 판별 | 스키마 `GetAccountRateLimitsResponse` |
| 질문 도구 (AskUserQuestion) | `request_user_input` → app-server `item/tool/requestUserInput` (experimental, 1~3개 질문) | **있음 (app-server 만)** | exec 에서는 "not supported in exec mode" 로 거절 | `codex-rs/exec/src/lib.rs`(0.169.0), 스키마 `ToolRequestUserInputParams` |

요약: **대응물이 없는 기능은 없다.** 차이는 모양(TOML·Starlark·폴더 위치)과 "exec 단발 모드에서는 승인·질문이 안 된다"는 점이다. 따라서 플러그인 쪽에서 Codex 를 워커로 쓸 때는 승인 대신 **샌드박스로 막고**, 질문이 필요한 일은 워커로 보내지 않는다.

## C. Codex 비대화 실행

기준 버전: **Codex CLI 0.169.0** (npm `@openai/codex`, 2026-11-12 태그 `rust-v0.169.0`). 클라우드 컨테이너(Linux)에 설치해 `--help` 74개(+ `--version` 1개)와 app-server 스키마를 받았다. 로그인·모델 호출은 하지 않았다. 실제 출력은 E절 탐침으로 받는다.

### C.1 두 가지 실행 방식

| | `codex exec` (단발) | `codex app-server` (장기 실행) |
|---|---|---|
| 형식 | `--json`: 이벤트 JSONL, 최상위 `type` 8종 | JSON-RPC 2.0 (stdio JSONL, `"jsonrpc"` 칸 생략). ClientRequest 109·ServerNotification 86·ServerRequest 10 |
| 상태 | 안정 | help 에 `[experimental]` 표시 |
| 승인 | **사람에게 못 넘긴다.** 기본 `approval_policy: Never`, 승인·질문 서버 요청은 거절. 예외: `--approve-for-me` 로 자동 리뷰어를 고르면 정책을 다시 만들어 그 리뷰어가 답한다(`exec/src/lib.rs` "Rebuild below if the fully resolved reviewer is AutoReview") | 서버→클라이언트 요청으로 넘긴다 |
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
| `--approve-for-me` | 최상위 `codex` 와 `exec`·`resume`·`fork`·`archive`·`unarchive`·`delete` help 에 있음. 승인 요청을 사람 대신 자동 리뷰어로 보냄. 스키마 `ApprovalsReviewer`: `user`, `auto_review`, `guardian_subagent` | `codex --help`, `codex exec --help` |
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

워커는 단발 실행 후 결과를 돌려준다. Codex 로 가는 길은 **둘뿐**이고, 서로 다른 프로그램이 쓴다.
- **W1. 플러그인 워커 → `codex exec --json`** — Claude 메인 세션 안의 워커 에이전트가 셸 명령으로 부른다. Plenum 을 거치지 않는다(Plenum 이 꺼져 있어도 됨). 승인이 없으므로 샌드박스로 막는다.
- **W2. Plenum → ACP(codex-acp)** — Plenum 이 Codex 를 띄울 때는 **항상** 이 길이다. 대화(메인 후보)든 워커든 같은 ACP 드라이버를 쓰고, 워커는 "세션 하나 + 프롬프트 하나 + 결과 받고 닫기"로 돌린다(F절 추천 (2)). Plenum 에 `codex exec` 드라이버는 만들지 않는다.

형식 변화 감시도 이 두 길을 따로 한다(H.4).

| 지금 Claude 흐름 | W1 `codex exec --json` | W2 ACP (codex-acp → app-server) | 근거 |
|---|---|---|---|
| 승인 카드 `control_request can_use_tool` → `allow`/`deny` | **✗** 승인을 밖으로 못 넘김(기본 승인 정책 `never`. 예외: `--approve-for-me` 로 자동 리뷰어를 고르면 그 리뷰어가 답함 — 사람에게 오지 않는 것은 같다). **대신 샌드박스로 막는다**: `--sandbox workspace-write` + 전용 git worktree. 막힌 명령은 `command_execution.status = declined`/`failed` 로 보고에 남는다 | ✓ `session/request_permission` (옵션 kind `allow_once`·`allow_always`·`reject_once`·`reject_always`) ← app-server `requestApproval` | `exec/src/lib.rs`(0.169.0), codex-acp `src/permissions/options.ts` |
| 거부 이유 문구(deny `message`) | ✗ | △ ACP 응답에 이유 칸이 없다. `reject_once` 만 전달 → 이유는 다음 프롬프트로 따로 보낸다 | ACP schema `RequestPermissionOutcome` |
| 도구 입력 고치기(`updatedInput`) | ✗ | ✗ app-server 답에 해당 칸 없음 | 스키마 `CommandExecutionRequestApprovalResponse` |
| "이 세션 동안 허용" `addRules` destination `session` | ✗ (샌드박스 범위로 대신) | ✓ 단, **kind 가 아니라 optionId 로 고른다.** codex-acp 2.6.0 에서 kind `allow_always` 는 범위가 다른 옵션 여럿에 쓰인다: 세션 범위 = `allow_for_session`(← `acceptForSession`), `allow_permissions_session`, MCP `allow_session` / **영구** = `accept_execpolicy_amendment`("commands that start with …"), `apply_network_policy_amendment:<n>`("in the future", 거부 쪽은 `reject_always`), MCP `allow_always`. claude-agent-acp 의 `allow_always` 도 CLI 제안 그대로라 영구일 수 있다 → 드라이버가 **프로바이더별 optionId 표**(D.4)로 `scope` 를 채우고, Plenum 은 허용 중 `once`·`session` 만 보여 준다(G절). 파일 변경의 `acceptForSession` 은 "같은 파일" 범위다(스키마 설명) | codex-acp `src/permissions/options.ts`·`option-ids.ts`·`mcp.ts`, claude-agent-acp `src/permissions/effects.ts` |
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

### D.4 codex-acp 2.6.0 optionId → 범위 표

ACP `PermissionOption.kind` 만으로는 범위를 알 수 없으므로 드라이버는 이 표로 `scope` 를 정한다(G절). 이 표는 P3 에서 `app/providers/codex.options.json` 으로 만들고, drift 감시(H.4 `codex-acp`)와 P5 드라이버가 같이 쓴다. 근거: codex-acp `src/permissions/option-ids.ts`·`options.ts`·`mcp.ts`(태그 2.6.0 소스), 번들 `dist/index.js` 에 같은 문자열이 있는 것을 확인(npm `@agentclientprotocol/codex-acp@2.6.0`).

| 요청 종류 | optionId | kind | scope | Plenum 버튼 |
|---|---|---|---|---|
| 명령 실행 | `allow_once` | allow_once | once | 보임 |
| 명령 실행 | `allow_for_session` (← `acceptForSession`) | allow_always | session | 보임 ("이 세션 동안") |
| 명령 실행 | `accept_execpolicy_amendment` | allow_always | persistent | 숨김 |
| 명령 실행 | `apply_network_policy_amendment:<n>` (허용) | allow_always | persistent | 숨김 |
| 명령 실행 | `apply_network_policy_amendment:<n>` (차단) | reject_always | persistent | 보임 (한 번 거절로 보냄 — 영구 차단 규칙은 만들지 않음) |
| 명령 실행 | `decline` | reject_once | once | 보임 |
| 명령 실행 | `cancel` | reject_once | once | 보임 (턴도 멈춤) |
| 파일 변경 | `allow_once` | allow_once | once | 보임 |
| 파일 변경 | `allow_for_session` | allow_always | session (**같은 파일**) | 보임 |
| 파일 변경 | `cancel` | reject_once | once | 보임 — 파일 변경에는 `decline` 이 없다(`options.ts`) |
| 권한 요청 | `allow_permissions_turn`, `allow_permissions_turn_strict_auto_review` | allow_once | once(턴) | 보임 |
| 권한 요청 | `allow_permissions_session` | allow_always | session | 보임 |
| 권한 요청 | `reject_permissions` | reject_once | once | 보임 |
| MCP 도구 | `allow_once`(도구) / `accept`(도구 아닌 요청) | allow_once | once | 보임 |
| MCP 도구 | `allow_session` | allow_always | session | 보임 |
| MCP 도구 | `allow_always` | allow_always | persistent | 숨김 |
| MCP 도구 | `decline`, `cancel` | reject_once | once | 보임 |

표에 없는 optionId 가 오면 scope `unknown` → 허용이면 숨기고 경고 1줄, 거부면 보인다(G절 규칙).

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
| `lib/redact.mjs` | 홈 경로(세 표기)·사용자 이름·컴퓨터 이름·이메일·계정/설치 id·JWT·`sk-` 키·**요금제 칸**(`planType`·`plan_type`·`planName`·`limitName`·`chatgptPlanType` 값 → `PLAN`, 한도 숫자는 그대로) 가리기, 남은 의심 패턴 리포트 |
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
- [실측, 0.169.0 로그인 없이] app-server 는 한 줄에 JSON 하나, 응답에 `jsonrpc` 칸이 없고 요청에서 빼도 받는다. `initialize` 응답 `{userAgent, codexHome, platformFamily, platformOs}`. 로그인 없이 `account/read` = `{account: null, requiresOpenaiAuth: true}`, `account/rateLimits/read` = 오류 -32600 "authentication required". 알림에 `installationId`·`serverName`(컴퓨터 이름)이 섞여 나와서 가리기 대상에 넣었다. 요금제 칸은 공개 레포 fixture 로 들어가므로 가린다(한도 해석은 `windowDurationMins`·`usedPercent` 로 충분).
- 확인 못 한 것(노트북에서 처음): 승인·중단·이어하기 실제 흐름. ③의 `git --version` 은 안전 명령으로 분류돼 승인 없이 실행될 수 있다(추측) — 그러면 녹화에 "승인 요청 없음"이 남고 그것도 정보다.

### 실행 안내 (PowerShell)

블록마다 `cd` 로 시작하고 한 줄에 명령 하나다.

```powershell
cd $HOME\Downloads
Expand-Archive .\plenum-probe-step0.zip -DestinationPath . -Force
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

넘기기 전에 `redaction-report.txt` 가 "남은 것 없음" 인지, `versions.json` 에 이상한 값이 없는지 본다. 결과 `probe-result.zip` 은 다음 단계(P4)에서 fixture 로 들어간다. 탐침 묶음 자체는 P3 에서 `tools/probe/` 로 레포에 넣는다(결정 9).

### 클라우드에서 한 확인

- 모든 `.mjs` `node --check` 통과. `pwsh` 가 없어 `probe.ps1` 파싱 검사는 노트북 첫 실행으로 미룸.
- 드라이런(로컬 codex 0.169.0 + claude 2.1.325): help claude 50여 개·codex 74개(+ `--version`), 스키마 2종, ⑥ 핸드셰이크까지 돌고 모델 턴 0, 리포트 "남은 것 없음".
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
| **`@agentclientprotocol/codex-acp`** (공식. 레지스트리 저자: OpenAI, JetBrains, Zed). TypeScript로 `codex app-server` JSON-RPC 위에 구현 | 2.6.0 (2026-11-08), preview 2.6.1-preview.5 | `6567651` 2026-11-12 | `@openai/codex` ^0.166.0 (=0.166.x 고정), `@agentclientprotocol/sdk` ~2.4.0(npm 판) / ~2.6.0(HEAD) | ✓ `session/request_permission`. `accept`→`allow_once`, `acceptForSession`→`allow_always`(optionId `allow_for_session`, 세션 범위), **`acceptWithExecpolicyAmendment`→`allow_always`(optionId `accept_execpolicy_amendment`, 영구)**, 네트워크 규칙→`allow_always`/`reject_always`(영구), `decline`/`cancel`→`reject_once`. **kind 만으로는 세션/영구를 못 가른다 → optionId 로 판별** | ✓ `request_user_input`과 `request_user_input_async`를 form elicitation으로 전달 | ✓ `loadSession: true` | `account/rateLimits/updated`를 받아 **세션 상태에만 저장**하고 `/status` 명령 텍스트로만 보여 준다. 구조화된 전달은 없다. `_meta.quota`에는 토큰 수만 | npx(Node). win32 spawn 분기는 있으나 README에 Windows 언급이 없어 실동작 미확인 | [npm][npm-cxa], [package.json][cxa-pkg], [options.ts][cxa-opt], [CodexElicitationHandler][cxa-elic], [CodexAsyncQuestions][cxa-async], [loadSession][cxa-load], [rateLimits 처리][cxa-rl], [/status][cxa-status], [CodexCli.ts][cxa-cli] |
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
| 승인 카드 (한 번 / 세션 동안 / 거절) | ✓ (세션 범위 = optionId `allow_for_session`. 같은 kind `allow_always` 인 영구 옵션은 드라이버가 숨김) | [options.ts][cxa-opt] |
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
- 질문 카드는 ACP `elicitation`(form) 이름을 쓴다. ACP 에 없는 개념(한도 창, 하위 작업)만 Plenum 이름을 쓰고 `ext: true` 표시를 단다. ACP 에 같은 개념이 생기면 이름을 맞춰 옮긴다.
- 지금 `app/server/chatTypes.ts` 의 `ChatEvent`·`Card` 는 이 모델의 Claude 전용 부분집합이다. 0.4.x에서 아래 타입으로 옮기되, 화면이 보는 SSE 모양은 한 번에 바꾸지 않고 어댑터 층이 지금 모양으로 다시 펼친다(동작 그대로).

```ts
// provider/events.ts — 초안. 드라이버 → 앱 공용 계약.
// 원칙: 모든 이벤트는 raw(원문)를 들고 다닌다. 드라이버가 이해 못 한 것은 버리지 않고 'unknown' 으로 올린다.

export type ProviderId = string;              // 설정 파일의 id ("claude", "codex", "opencode" …)
// F절 추천 (2): Claude 는 직접 드라이버, 나머지는 범용 ACP. 단발 실행(oneshot 블록)은 Plenum 드라이버가 아니라 플러그인 워커 몫(I.1)
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
  /** 허용·거부의 범위. ACP 에는 이 칸이 없고 kind(allow_always)만으로는 세션/영구를 구분할 수 없다
   *  (codex-acp 2.6.0: allow_for_session·accept_execpolicy_amendment 가 둘 다 allow_always).
   *  그래서 드라이버가 kind 가 아니라 **optionId 를 프로바이더별 표**(D.4, 파일 `app/providers/<id>.options.json`)로 보고 채운다. 표에 없는 optionId 는 'unknown'.
   *  Claude addRules(destination session) = 'session'.
   *  Plenum 은 'once'·'session' 허용과 모든 거부(kind reject_*, 범위 무관 — 한 번 거절로 보냄)를 버튼으로 보이고,
   *  'persistent'·'unknown' 허용은 숨긴다. 그 결과 거부 버튼이 하나도 없으면 '취소' 버튼(outcome cancelled)을 붙인다 */
  scope: 'once' | 'session' | 'persistent' | 'unknown';
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

// ── 질문 카드 (ACP elicitation/create, form 모드 — 스키마 1.7.0 에서 안정). Claude AskUserQuestion, Codex request_user_input
//    Claude 직접 드라이버는 AskUserQuestion 을, ACP 드라이버는 elicitation form 을 이 모양으로 바꾼다
export type QuestionEvent = Base & {
  type: 'elicitation';
  mode: 'form';                               // ACP 의 url 모드는 지금 다루지 않음(오면 unknown)
  requestId: string;
  questions: { question: string; header?: string; multiSelect: boolean;
               options: { label: string; description?: string; recommended: boolean }[]; allowFreeText: boolean }[];
};
export type QuestionOutcome = { action: 'accept'; answers: Record<string, string> } | { action: 'decline' } | { action: 'cancel' };  // ACP elicitation 응답 action 과 같은 이름

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
  // 워커 조건: oneshot (설정에 worker 블록이 있을 때만 워커로 씀 — roleOf)
  oneshot: boolean;          // 프롬프트 하나 → 끝 → 결과 텍스트. ACP 는 session/new + prompt 1회 + 닫기로 되므로 항상 true
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
- 플래그가 있으면 켠다: 예 Claude `--effort` → `effortSelect`, `--permission-prompt-tool` → `permissionCards`, `--resume` → `resume`. Claude 직접 드라이버는 `-p` 가 있으면 `oneshot` true.
- ACP 드라이버는 `--help` 대신 `initialize` 응답의 `agentCapabilities`(`loadSession` → `resume`, `promptCapabilities` …)와 `protocolVersion` 으로 정한다. `session`·`oneshot` 은 ACP 면 항상 true, `permissionCards` 도 true(클라이언트가 권한 요청을 받음). `--version`·`--help` 는 어댑터·CLI 버전 기록과 drift 검사에만 쓴다.
- 설정 파일의 `capabilities` 는 **상한**이다. 감지가 켜도 설정이 끄면 끈다. 감지가 못 찾으면 켜지 않고 경고를 낸다.
- 최소 버전보다 낮거나, 알려진 최신 fixture 버전보다 **높으면** 경고("녹화 안 된 버전")만 내고 막지 않는다.

### G.1 P1에서 더한 칸·바뀐 점 (동작 보존용)

위 G절 초안과 실제 `app/server/provider/events.ts` 가 다른 점. 필수 = `?` 없는 칸(드라이버가 늘 채운다), 선택 = `?` 칸(없으면 안 붙인다).

| 칸 | 필수/선택 | 타입 | 왜 |
|---|---|---|---|
| `SessionStartedEvent.version`, `permissionMode` | 필수 | `string \| null` | init 이벤트가 화면에 그대로 냄 |
| `TurnEndEvent.rawSubtype`, `isError` | 필수 | `string`, `boolean` | result 이벤트가 하네스 subtype 원문을 화면에 냄(채팅 매니저는 `stopReason` 이 아니라 이 원문을 쓴다) |
| `MessageEvent.index?` | 선택 | `number` | text-delta 의 content block index |
| `ToolCallEvent.toolNameNotString?` | 선택 | `true` | 원래 `name` 이 문자열이 아니었음(`toolName` 은 `String(...)` 값). Skill 모드 감지는 원래 값이 문자열 `'Skill'` 일 때만 |
| `UsageEvent.rejected?` | 선택 | `{ window: string; resetsAt: number \| null } \| null` | 한도 막기 규칙(창 이름 정렬 후 첫 rejected, 없으면 최상위 status·rateLimitType) |
| `LimitWindow.rawStatus?` | 선택 | `string \| null` | 하네스 status 원문(`status` 는 ok·warning·rejected 로 좁힘). 화면의 창 status 는 원문 |
| `PermissionRequestEvent.ext?` | 선택 | `{ claude: { sessionRules: { toolName; ruleContent? }[]; toolUseId?: string } }` | "이 세션 동안 허용"은 addRules 만 destination session 으로 보냄 |
| `QuestionEvent.ext?` | 선택 | `{ claude: { toolUseId?: string } }` | 질문 카드의 toolUseId |
| `SessionStartedEvent.noSessionId?` | 선택 | `true` | init 에 session_id 가 없을 때. 빈 문자열과 구분해 이전 세션 id 를 유지 |
| `UnknownEvent.reply?` | 선택 | `unknown` | 답을 기다리는 요청에 드라이버가 만든 기본 거부 원문(`answeredWithDefault: true` 일 때) |
| `UnknownEvent.requestId?` | 선택 | `string` | 그 요청의 id(안내 카드에 씀) |
| `UnknownEvent.thrown?` | 선택 | `true` | decode 가 그 줄에서 예외를 잡았음(`reason: 'field'`). 그 줄이 `request_id` 문자열인 `control_request` 면 `reply`·`requestId`·`answeredWithDefault: true` 도 붙여 거부로 답한다(claude 가 기다리지 않게) |
| `driver.stats()` | 드라이버(Claude) | `() => { thrown: number }` | decode 가 안에서 잡은 예외 수. 계약 테스트 (b) 가 fixture 전체 뒤 0 인지 본다 |
| `Driver.initialize()`, `Driver.prompt(text)` | 필수 | `() => unknown`, `(text: string) => unknown` | 핸드셰이크·사용자 글의 원문 만들기 |
| `Driver.detect?` | 선택으로 바뀜 | — | 기능 감지는 P2 에서 구현. P1 드라이버에는 없다 |

그 밖의 규칙:
- `raw`: 초안은 "모든 이벤트가 raw 를 들고 다닌다"였지만, P1 은 **unknown 에만** 붙인다(필수). 다른 이벤트의 `Base.raw?` 는 비워 둔다.
- `seq`·`at`: 드라이버는 0 으로 둔다. 채팅 매니저(`chat.ts` emit)가 ChatEvent 로 바꿀 때 붙인다.
- `stopReason` `cancelled`(Claude): 이번 턴에 드라이버가 `interrupt()` 원문을 만든 뒤 오는 result 가 `error_during_execution` 이면 `cancelled`. result 를 받으면 그 표시를 내린다(턴 경계). 표시 없이 온 `error_during_execution` 은 `error`.

P1에서 unknown 이벤트는 만들되 화면·로그에는 아직 보내지 않는다(로그 파일은 P5).

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
    2.1.323/            # 지금 fixtures/stream/ 을 옮김 (녹화 6개)
      meta.json         # { provider, version, os, recordedAt(날짜만), command(argv, 경로 가림), scenes:[…] }
      help/claude.txt   # --help 전문
      01-cards.jsonl    # {"dir":"in"|"out"|"err"|"exit", "msg"|"text"}  (지금 stream/ 형식 그대로)
      01-cards.expect.json   # decode 결과 요약(이벤트 type 순서, 카드 수, stopReason, 창, unknown 수) — 계약 테스트가 비교(unknown 수는 래칫)
      *.golden.json     # 리팩터 전 chat.ts 의 ChatEvent·stdin 덤프 — P1 계약 기준
    <노트북 버전>/      # 탐침이 2.1.248 이 아닌 버전을 만났을 때만 생김(녹화 4개 + compare.md).
                        # 2.1.248 원본 녹화는 남아 있지 않다 — 2.1.248 이면 help 만 들어간다
  codex/                # 경로 W1: codex exec --json (플러그인 워커가 씀)
    0.169.0/
      help/{codex,codex.exec,codex.exec.resume,…}.txt
      01-read.jsonl, 04-resume.jsonl
  codex-app-server/     # 경로 W2 의 아래층: codex-acp 가 부르는 app-server 프로토콜
    0.169.0/
      schema/           # codex app-server generate-json-schema 출력 (CI 가 만드는 것과 같은 명령)
      02-file-approval.jsonl, 03-shell-approval.jsonl, 05-interrupt.jsonl, 06-handshake.jsonl
  codex-acp/            # 경로 W2: Plenum ↔ ACP 어댑터
    2.6.0/
      meta.json         # 어댑터가 묶은 codex 버전(package.json 의 @openai/codex 범위), 번들에서 찾은 optionId 목록 (P3)
      01-*.jsonl        # Plenum 가짜 클라이언트 ↔ codex-acp 녹화 (P5 에서 처음 생김)
  acp/                  # W2 공통: ACP 스키마
    sdk-2.7.0/
      schema.json       # @agentclientprotocol/sdk 패키지의 schema/v1/schema.json 중 드라이버가 쓰는 메서드·타입 요약 (P3)
  _latest.json          # 경로별 "녹화된 최신 버전" — 감지가 이보다 높으면 경고
```

- 지금 `app/test/fixtures/stream/` 은 `providers/claude/2.1.323/` 로 옮겼다(P1)(파일 이동만).
- 버전 폴더는 지우지 않는다. 옛 버전 해석이 계속 되는지가 하위 호환 검사다.
- 개인 정보: 지금 `fixtures-privacy.test.ts` 가 `fixtures/` 아래를 재귀로 보므로 새 폴더도 자동으로 검사된다. Codex 녹화에서 추가로 막을 것: `~/.codex` 경로, `account_id`·`chatgpt_account_id`·`user_id`·`installationId` 칸, `serverName`(컴퓨터 이름), 요금제 칸(`planType`·`plan_type`·`planName`·`limitName` 값이 `PLAN` 이 아니면 실패). 탐침이 저장 전에 이미 가리지만, 검사기가 한 번 더 막는다(P3).

### 계약 테스트

`app/test/contract.test.ts`(다음 단계) — fixture 폴더마다:
1. 녹화 파일이 **1개 이상**이다(0개면 실패 — 조용히 통과 방지).
2. `out` 줄을 순서대로 `driver.decode` 에 넣는다. **예외 0** — decode 는 예외를 안에서 잡아 unknown 으로 바꾸므로 밖으로 나온 throw 가 아니라 드라이버의 예외 카운터(`stats().thrown`)와 unknown 의 `thrown` 표시가 0 인지 본다.
3. 장면별 `unknown` 수는 `expect.json` 값을 넘으면 실패(래칫). 같거나 줄면 통과하고, 줄었으면 "expect 갱신 가능" 경고를 낸다. 2.1.323 녹화 기준 103개(system 하위 이벤트·`active_goal`·`autocompact_state`)는 기준으로 두고, 매핑으로 줄이는 일은 P5 몫. 나머지 요약 칸은 정확히 비교한다(type 순서는 `unknown` 을 뺀 순서).
4. 장면별 핵심 단언: 승인 카드 수, scope `session` 인 허용 옵션 유무(kind 가 아니라 D.4 표로 판정), 질문 카드 수, `turnEnd.stopReason`, 사용량 창 이름.
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
      - run: node app/scripts/provider-drift.mjs --out drift/
      - uses: actions/upload-artifact@v4
        with: { name: drift-${{ matrix.os }}, path: drift/ }
```

`provider-drift.mjs` 의 인자: `--out <폴더>`(결과), `--only <감시 항목 id>`(하나만), `--pin <항목>=<버전>`(최신 대신 그 버전 설치 — 로컬 재현용), `--baseline <폴더>`(비교 기준. 생략하면 `app/test/fixtures/providers/`). 종료 코드 0 = 깨지는 차이 없음, 1 = 드라이버가 쓰는 플래그·필드가 사라짐, 2 = 설치·실행 실패.

### H.4 감시 항목 — Codex 는 두 경로를 따로 본다

감시 항목은 프로바이더 설정 파일의 `install[].watch` 값에서 만들어진다(I절). 아래 6개는 앱 기본 파일(claude, codex)과 공통 스키마가 만드는 항목이다. 사용자가 프로바이더 파일을 추가하면 그 `watch` 값이 새 항목이 된다(예: I.4 `acme`).

| 항목 id | 경로 | 설치 | 받는 것 (로그인 없음) | 실패 조건 | 기준 폴더 |
|---|---|---|---|---|---|
| `claude` | Plenum 메인 | `@anthropic-ai/claude-code` | `claude --help` | 드라이버가 늘 넘기는 `-p`, `--input-format`, `--output-format`, `--verbose`, `--include-partial-messages`, `--permission-prompt-tool`, `--permission-mode`, `--resume`, `--model` 중 하나라도 사라짐. `--effort` 는 조건부(없으면 실패가 아니라 "노력 선택 꺼짐" 경고) | `claude/<버전>/help/` |
| `codex-exec` | **W1** 플러그인 워커 | `@openai/codex` | **명령별로 따로**: `codex exec --help`, `codex exec resume --help` | `exec`: `--json`, `--sandbox`(값 `read-only`·`workspace-write`), `-o/--output-last-message`, `--skip-git-repo-check`, `-C`, `-m`, `-c`. `exec resume`: `--json`, `--last`, `-m`, `-c` (resume 에는 `--sandbox`·`-C` 가 없으므로 검사하지 않는다). 이벤트 줄 모양(`thread.started`·`turn.completed`·`item.*`)은 CI 가 못 받으므로 녹화 계약 테스트가 맡음 | `codex/<버전>/help/` |
| `codex-app-server` | **W2 아래층** | `@openai/codex` — codex-acp 가 묶은 버전(`^0.166.0` 안의 최신)과 npm 최신 **둘 다** | `codex app-server generate-json-schema` | 메서드 `thread/start`·`turn/start`·`turn/interrupt`·`thread/resume`, 서버 요청 `item/commandExecution/requestApproval`·`item/fileChange/requestApproval`·`item/tool/requestUserInput`, 결정 값 `accept`·`acceptForSession`·`decline`·`cancel`, `RateLimitWindow.{usedPercent,windowDurationMins,resetsAt}` 중 하나라도 사라짐 | `codex-app-server/<버전>/schema/` |
| `codex-acp` | **W2** Plenum ↔ 어댑터 | `@agentclientprotocol/codex-acp` | `npm pack` 으로 받은 tarball 의 `package.json`(묶인 `@openai/codex` 범위)과 **번들 `dist/index.js`** | D.4 표의 optionId 문자열(`"allow_for_session"` 등, 따옴표 포함) 중 하나라도 번들에서 **못 찾으면 실패**. 번들 파일 자체가 없거나 이름이 바뀌어도 실패. 표에 없는 새 id 는 번들 문자열로는 가려낼 수 없으므로 감시하지 않는다 — 실행 중 `unknown` optionId 경고(G절)가 맡는다. 묶인 codex 범위가 바뀌면 `codex-app-server` 를 그 버전으로 한 번 더 | `codex-acp/<버전>/meta.json` |
| `codex-home` | **W1·W2 공유 상태** | (설치 없음 — 위 두 항목의 버전 비교) | `codex-exec` 의 버전과 `codex-acp` 가 묶은 codex 버전 | 두 경로는 같은 `~/.codex`(설정 `config.toml`, 로그인 `auth.json`, 세션 기록 `sessions/`, 규칙 `rules/`)를 쓴다. **W1 은 설치된 codex(지금 0.169.0), W2 는 어댑터가 묶은 codex(0.166.x)** 라 한쪽이 새 형식으로 쓴 파일을 다른 쪽이 못 읽을 수 있다(예: 0.169.0 의 `migrate-rollouts` 로 바뀌는 세션 기록 형식). 두 버전의 마이너가 다르면 **경고**를 내고 요약에 "W1·W2 codex 버전 차이 0.169 ↔ 0.166" 을 남긴다. 실패로 치는 것: 한쪽 help 에 `migrate-*` 같은 저장 형식 이전 명령이 새로 생김. Codex 데스크톱 앱(노트북 26.1111)도 같은 `~/.codex` 를 쓸 수 있다 → 데스크톱 앱 버전도 기록 | `codex-home/_versions.json` |
| `acp-schema` | W2 공통 | `@agentclientprotocol/sdk` | 패키지의 `schema/v1/schema.json` | `session/request_permission`·`elicitation/create`·`session/cancel`·`session/load`, `PermissionOptionKind` 값, elicitation 응답 `action` 값 중 하나라도 사라짐. 프로토콜 정수 버전 1 이 없어지면 실패 | `acp/<버전>/schema.json` |

순서: 각 항목의 `latest` 를 `npm view` 로 보고 `_latest.json` 보다 새 버전이면 임시 폴더에 설치(`npm i --prefix`) → 위 "받는 것"을 저장 → 기준과 비교. 플래그는 글자 diff 가 아니라 **플래그 집합**, 스키마는 **메서드·타입 필드 집합**으로 비교한다(설명 문구 변화는 무시). 실패면 작업이 빨간 불, 성공해도 새 버전이 있으면 요약에 "녹화 필요 — 노트북 탐침"을 남긴다.

구독 토큰을 CI 에 넣지 않는다(`secrets.` 참조 0). 실제 실행 녹화는 노트북 탐침(E절) 뿐이다. W1 의 이벤트 모양(`exec --json` 줄)과 W2 의 실제 왕복은 CI 로는 못 잡으므로, 새 버전이 보이면 탐침을 다시 돌리는 것이 사람 몫이다.

## I. 프로바이더 설정 형식

### I.1 세 단 구조

| 단 | 위치 | 누가 쓰나 | 담는 것 |
|---|---|---|---|
| 1. 앱 기본 | Plenum `app/providers/<id>.json` (앱과 함께 배포) | Plenum | **실행 방법**: 명령·드라이버·로그인 확인·모델 목록·단발 실행 방법 |
| 2. 사용자 폴더 | `<Plenum 설정 폴더>/providers/<id>.json` (Windows `%APPDATA%\plenum\providers\`, 그 밖 `~/.config/plenum/providers/`, 테스트 `PLENUM_CONFIG_DIR`) | 사용자(손으로 또는 Plenum 설정 화면) | 1단과 같은 칸. **키 단위로 1단을 덮어쓴다.** 새 프로바이더 추가 = 이 폴더에 파일 하나 |
| 3. kit 참조 | kit `providers.yaml` → 빌드가 플러그인에 `providers.json` 으로 싣는다 | kit 작성자 | **프로바이더 id 와 어느 워커가 어느 프로바이더를 쓰는지만.** 실행 방법은 적지 않는다 |

- 실행 방법은 1·2단에만 있다. kit 은 id 로 가리키기만 하므로, 같은 kit 을 다른 사람이 써도 각자 자기 설치 경로·로그인으로 돈다.
- **형식은 JSON 이다.** 설치된 플러그인 안의 스크립트(`provider-run.js`)가 의존성 없이 `JSON.parse` 로 2단을 읽어야 하기 때문이다(플러그인 스크립트에는 YAML 파서가 없다). 주석 대신 `"$comment"` 키를 쓴다. 모르는 키는 무시한다.
- 키는 하나씩 검증한다. 키 하나가 틀리면 그 키만 버리고 경고를 낸다. 파일 전체를 버리는 것은 `id`·`driver`·`command` 가 틀릴 때뿐이다.
- 우선순위: 드라이버 기본값 → 1단 → 2단 → 기능 감지(상한은 1·2단을 합친 값) → 실행할 때 화면에서 고른 값(모델·노력).
- **인증은 다루지 않는다**(결정 4). Plenum 은 각 CLI 에 이미 된 로그인(ChatGPT 든 API 키든)을 그대로 쓴다. 로그인 확인 명령은 "로그인 돼 있는가, 어떤 방식인가"를 **읽어서 보여 주기만** 한다. 막지 않고, 자격 증명 파일·환경 변수를 읽거나 지우지 않는다. 특정 방식만 쓰고 싶은 사용자(예: API 과금을 피하려는 사람)는 2단에 `auth.allowMethods` 를 적는다 — 그때만 실행 전에 확인한다.

드라이버 종류(처음 요구한 "claude / codex / acp / 단발 실행"과의 대응):
- `claude-stream` = claude 직접(지금 코드).
- `acp` = 범용 ACP. **Codex 는 별도 드라이버 없이 이것으로 붙는다**(공식 어댑터 codex-acp, F절 추천 (2)). 그래서 `codex` 드라이버 종류는 만들지 않는다.
- `oneshot` = "프롬프트 하나 → 결과 텍스트"만 되는 실행 방법. 설정 파일의 `oneshot` 블록에 적는다. **Plenum 은 이 블록을 쓰지 않는다.** 플러그인 워커(W1, `provider-run.js`)만 쓴다(D.1).

### I.2 스키마 초안 (TypeScript 로 적은 모양. 파일은 JSON)

```ts
export interface ProviderConfig {
  schema: 1;                                  // 파일 형식 번호. 모르는 키는 무시하므로 키 추가로는 안 올린다
  id: string;                                 // [a-z0-9-]+, 파일 이름과 같음. kit providers.yaml 의 id 와 같은 값
  name: string;                               // 화면 이름
  driver: 'claude-stream' | 'acp';            // Plenum 이 세션(메인·워커)을 돌리는 방법
  command: {
    bin: string;                              // PATH 에서 찾을 이름 또는 절대 경로 (셸 없이 execFile)
    args?: string[];                          // 드라이버가 붙이는 인자 앞에 들어감
    env?: Record<string, string>;             // 추가 환경 변수(비밀 금지)
  };
  oneshot?: {                                 // 플러그인 워커(W1)용 단발 실행. Plenum 은 안 씀
    bin: string;
    args: string[];                           // 자리표시: {sandbox} {cwd} {lastMessageFile} {model} {effort}
    sandbox: { implement: string; review: string };   // 역할별 샌드박스 값(하네스 값 그대로)
    output: 'jsonl-events' | 'last-message';
    timeoutSec: number;
  };
  install?: { npm: string; role: 'cli' | 'adapter' | 'schema'; watch: string }[];
                                              // 설치 안내 + drift 감시. watch 값이 H.4 감시 항목 id 가 된다(파일마다 고유)
  minVersion?: string;
  models: { id: string; label?: string; efforts?: string[]; default?: boolean }[];
  modelArg?: string[];                        // 예 ["-m", "{model}"]. ACP 는 session/set_config_option 이 기본이라 생략
  effortArg?: string[];
  capabilities?: Partial<Capabilities>;       // G절. 상한. 생략하면 감지 결과 그대로
  auth: {
    /** 로그인 상태 읽기. 출력은 화면에 보이지 않고 판정·방식만 쓴다 */
    check?: {
      bin?: string;                           // 생략 = command.bin
      args: string[];
      stream: 'stdout' | 'stderr' | 'both';   // codex 0.169.0 login status 는 stderr 에만 쓴다
      okPattern: string;                      // 정규식. 첫 캡처 그룹 = 로그인 방식(화면 표시용)
    };
    loginHint: string;                        // 로그인 안 됐을 때 보여 줄 문장
    allowMethods?: string[];                  // 2단(사용자)만. 있으면 이 방식이 아닐 때 실행 전에 멈춤
  };
  limits: {
    /** 외부 워커로 보낼 단위: 'hard-only'(기본) = 메인이 어렵다고 판단한 단위만, 'any', 'never' */
    policy: 'hard-only' | 'any' | 'never';
    windows?: string[];                       // 한도 창을 읽을 수 있으면 그 이름. 없으면 화면은 "—"
    stopBelowPct?: number;
  };
  worker?: {
    /** Plenum 이 이 프로바이더를 워커로 쓸 때: 같은 driver 로 세션 하나를 열고 프롬프트 하나를 보낸 뒤 결과를 받고 닫는다.
     *  이 블록이 없으면 워커로 쓰지 않는다(역할 판정, G절 roleOf). 승인 요청은 policy 대로 자동 답한다 */
    permission: 'reject-all' | 'allow-in-worktree';   // allow-in-worktree = 작업 폴더 안 파일 변경만 allow_once, 나머지 거부
    worktree: boolean;
    timeoutSec: number;
  };
  docs?: string[];
}
```

### I.3 예시 1 — Codex (1단, 앱 기본 `app/providers/codex.json`)

```json
{
  "schema": 1,
  "id": "codex",
  "name": "Codex",
  "$comment": "Plenum 은 driver(acp, codex-acp 경유)를 쓰고, 플러그인 워커는 oneshot(codex exec)을 쓴다. 두 경로는 D.1 W2·W1",
  "driver": "acp",
  "command": { "bin": "npx", "args": ["-y", "@agentclientprotocol/codex-acp@2.6.0"] },
  "oneshot": {
    "bin": "codex",
    "args": ["exec", "--json", "--sandbox", "{sandbox}", "--skip-git-repo-check", "-C", "{cwd}", "-o", "{lastMessageFile}"],
    "sandbox": { "implement": "workspace-write", "review": "read-only" },
    "output": "jsonl-events",
    "timeoutSec": 1800
  },
  "install": [
    { "npm": "@agentclientprotocol/codex-acp", "role": "adapter", "watch": "codex-acp" },
    { "npm": "@openai/codex", "role": "cli", "watch": "codex-exec" },
    { "npm": "@openai/codex", "role": "schema", "watch": "codex-app-server" }
  ],
  "minVersion": "2.6.0",
  "models": [{ "id": "<탐침의 model/list 결과>", "efforts": ["<모델이 광고하는 값>"], "default": true }],
  "auth": {
    "check": { "bin": "codex", "args": ["login", "status"], "stream": "both", "okPattern": "^Logged in using (.+)$" },
    "loginHint": "터미널에서 codex login"
  },
  "limits": { "policy": "hard-only", "windows": [], "stopBelowPct": 10 },
  "capabilities": { "questionCards": true },
  "worker": { "permission": "allow-in-worktree", "worktree": true, "timeoutSec": 1800 },
  "docs": ["https://github.com/agentclientprotocol/codex-acp", "https://developers.openai.com/codex/noninteractive"]
}
```

2단 예 — API 과금을 피하고 싶은 사용자의 `<설정 폴더>/providers/codex.json` (1단을 덮어쓰는 키만):

```json
{ "schema": 1, "id": "codex", "auth": { "allowMethods": ["ChatGPT"] } }
```

3단 예 — kit `providers.yaml` (id 와 워커 연결만):

```yaml
providers:
  - id: claude
  - id: codex
    used_by: [w-external]   # 이 워커가 외부 실행기로 codex 를 부른다
```

### I.4 예시 2 — 가상의 ACP 하네스 "acme" (2단, 사용자가 추가)

ACP 를 지원하는 하네스는 드라이버 코드 없이 사용자 폴더에 이 파일 하나로 붙는다. `watch: "acme"` 는 이 파일이 새 감시 항목 `acme` 를 만든다는 뜻이다(H.4 표의 기본 항목 외).

```json
{
  "schema": 1,
  "id": "acme",
  "name": "Acme Agent (가상)",
  "driver": "acp",
  "command": { "bin": "acme", "args": ["acp"] },
  "install": [{ "npm": "acme-agent", "role": "cli", "watch": "acme" }],
  "models": [
    { "id": "ollama/qwen3:8b", "label": "로컬 Qwen3 8B", "default": true },
    { "id": "openrouter/some-free-model", "label": "무료 클라우드" }
  ],
  "capabilities": { "questionCards": false, "usageWindows": false },
  "auth": { "check": { "args": ["auth", "status"], "stream": "stdout", "okPattern": "^Signed in(?: as .+)?$" }, "loginHint": "acme auth login" },
  "limits": { "policy": "hard-only" },
  "worker": { "permission": "reject-all", "worktree": false, "timeoutSec": 900 }
}
```

판정 예: Codex(ACP) = `initialize` 에서 `loadSession: true` + 권한 요청 사용 → 메인 조건 충족(메인 가능). `worker` 블록이 있고 ACP 세션은 프롬프트 하나로 끝낼 수 있으니(`oneshot` 기능) 워커도 가능. acme = `loadSession: false` 면 메인 불가, `worker` 블록이 있으니 워커만.

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
- 8GB VRAM 기준으로는 가중치 5.2GB에 KV 캐시가 더해지므로, 실제로 쓸 수 있는 컨텍스트는 16~32K 정도로 보인다(추측).
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

번호는 처음 판 그대로다. 7번은 이 문서의 범위가 아니라 다른 문서로 옮겼다.

| # | 결정 | 정한 것 / 추천 | 상태 | 근거 절 |
|---|---|---|---|---|
| 1 | 드라이버 구조 | (2) Claude 직접 + 범용 ACP | **정함** | F.5–F.6 |
| 2 | 플러그인 안 Codex 워커 경로 | `codex exec --json` 단발(샌드박스 + 전용 worktree). Plenum 을 거치지 않음 | **정함** | D.1 |
| 3 | Codex 워커 샌드박스 기본값 | 구현 = `workspace-write` + 전용 worktree, 리뷰 = `read-only` | **정함** | C.3, D.1 |
| 4 | 인증 처리 | Plenum 은 인증을 다루지 않는다. 각 CLI 에 이미 된 로그인(구독이든 API 키든)을 그대로 쓴다. 로그인 상태·방식은 읽어서 보여 주기만 하고, 특정 방식만 쓰려는 사용자는 사용자 설정에 `auth.allowMethods` 를 적는다 | **정함** | A.2, I.1 |
| 5 | 서드파티 래핑 애매함 | README 고지("각자 약관 확인, 자동화에는 API 키 권장"). 공개 배포 전에 문의 여부를 다시 정함 | **정함** | A.1–A.3 |
| 6 | OpenAI 약관 원문 확인 | 사람이 확인함 — 이용약관 2(c)(iv), 결론 회색 지대 | **정함** | A.1–A.2 |
| 8 | 데모 두 번째 프로바이더 | OpenCode 하나로 클라우드 무료 모델 + 로컬 Ollama `qwen3:8b`(8GB VRAM 기준). 가입 때 카드 요구가 나오면 로컬만 | **정함** | J.4 |
| 9 | 탐침 스크립트 보관 | P3 에서 `tools/probe/` 로 레포에 넣는다(형식 변화 감지에 계속 쓰므로) | **정함** | E, P3 |
| 10 | 노트북 claude 가 2.1.248 이 아닐 때 | 탐침이 자동으로 재녹화 + `compare.md`. 사라진 키가 있으면 다음 단계 첫 일 | **정함** | E, H |
| 11 | codex-acp 가 묶은 codex 버전 지연(0.166.x, CLI 최신 0.169.0) | 어댑터 기본 사본을 쓴다. W1(설치된 0.169)과 W2(어댑터 안 0.166)가 같은 `~/.codex` 를 쓰는 점은 H.4 `codex-home` 항목이 감시 | **정함** | F.3, H.4 |
| 12 | 프로바이더 설정 위치 | 3단: 앱 기본 → 사용자 폴더가 키 단위로 덮어씀(실행 방법: 명령·드라이버·로그인 확인), kit `providers.yaml` 은 id 로 참조만(어느 워커가 어느 프로바이더를 쓰는지). 형식은 JSON | **정함** | G, I.1 |

남은 미정 결정은 없다. 다음 단계에서 새로 정할 것은 각 작업 단위 안에 적었다.

## 다음 단계 작업 단위 (Plenum)

jh-kit 쪽 단위(2.9.0, 처음 계획은 2.8.0)는 jh-kit 레포의 계획 문서에 있다. 여기는 Plenum 만. 순서는 P1 → P2 → (P3 ∥ P4) → P5 → P6. 각 단위는 **동작을 바꾸지 않는 것(P1·P2·P3)** 과 **새 기능(P4~P6)** 으로 나뉜다.

### P1. 어댑터 층 — 이벤트 모델 도입 (동작 그대로) — 완료(작업 브랜치, PR 검토 중)
- 바꿀 파일: `app/server/provider/events.ts`(새, G절 타입), `app/server/provider/claude.ts`(새: `chat.ts` 의 줄 해석을 `decode(raw) → ProviderEvent[]` 로 옮김), `app/server/chat.ts`(해석 대신 `decode` 호출 + 내부 이벤트 → 지금 `ChatEvent` 로 다시 펼침), `app/test/fixtures/stream/` → `app/test/fixtures/providers/claude/2.1.323/`(이동 + `meta.json`), `app/test/contract.test.ts`(새), 기존 테스트의 fixture 경로
- 목표: 화면·SSE·API 모양은 한 글자도 안 바뀌고, Claude 해석이 드라이버 하나로 모인다. 모르는 이벤트는 `unknown` 으로 남고 throw 하지 않는다
- 완료 기준:
  - `cd app && npm test` 전부 통과(0.3.0 의 276개 + 새 계약 테스트), `npm run typecheck` 0 오류
  - `cd app && npx vitest run test/contract.test.ts` — fixture 폴더 ≥1, 모든 `out` 줄 decode 예외 0(`stats().thrown`), 장면별 `unknown` 수는 `expect.json` 값을 넘으면 실패(래칫). 2.1.323 녹화 기준 103개(system 하위 이벤트·`active_goal`·`autocompact_state`)는 기준으로 두고, 매핑으로 줄이는 일은 P5 몫
  - `cd app && npm run e2e` 9+19 흐름 통과(지금과 같음)
  - `git diff main -- app/web/` 비어 있음(화면 코드 안 바뀜)
  - 기준 덤프(`*.golden.json`)와 재생 결과 완전 일치
  - 노트북 회귀 절차: `docs/checks/p1-regression.md`
  - 노트북 결과(2026-11-21, claude 2.1.248): 8개 중 7개 통과. ② 실패 — PowerShell 도구에서 세션 허용(addRules)이 안 먹음(같은 명령에 카드가 또 뜸). main 0.3.1 에서도 재현돼 P1 회귀가 아니라 원래 있던 버그. Bash 에서는 됐는지, addRules 의 toolName·ruleContent 가 PowerShell 규칙 형식에 맞는지 확인 필요(README "남은 일")

### P2. 프로바이더 설정·기능 감지 (동작 그대로)
- 바꿀 파일: `app/server/provider/config.ts`(새: I절 스키마 로더 — 1단 앱 기본 + 2단 사용자 폴더 키 단위 덮어쓰기, 키별 검증), `app/providers/claude.json`(새: 지금 동작을 설정으로), `app/server/claudecaps.ts` → `app/server/provider/detect.ts`(일반화, 캐시 키 그대로), `app/test/providerconfig.test.ts`(새)
- 목표: Claude 실행 인자·최소 버전·기능이 설정 파일 + 감지로 정해진다. 결과는 지금과 같다
- 완료 기준:
  - `cd app && npx vitest run test/providerconfig.test.ts` — 키 하나가 틀린 파일은 그 키만 버리고 경고, `id`/`driver`/`command` 가 틀리면 파일 거부, 2단 파일이 1단을 **키 단위로** 덮음(2단에 `auth.allowMethods` 만 있어도 나머지는 1단 값), `JSON.parse` 만으로 읽힘(YAML 아님)
  - `chatArgs` 결과가 P2 전후 같음(기존 `chat.test.ts` 통과)
  - `--effort` 없는 가짜 claude 로 `effortSelect: false`(기존 테스트 통과)

### P3. 형식 변화 감지 CI + 탐침 정식 편입
- 바꿀 파일:
  - `.github/workflows/provider-drift.yml`(새, H절), `app/scripts/provider-drift.mjs`(새)
  - `tools/probe/`(새: 0단계 탐침 묶음을 레포에 넣음 — 결정 9. 형식 변화 감지에 계속 쓰므로. `dist/` zip 은 `npm run probe:pack` 같은 스크립트로 여기서 만든다)
  - `app/providers/codex.options.json`(새: D.4 optionId → scope 표. drift 와 P5 드라이버가 같이 씀 — P5 보다 먼저 생긴다)
  - 기준 자료(H.4 항목 6개 전부): `app/test/fixtures/providers/claude/<받은 버전>/help/claude.txt`(P3 작업 때 설치본 `claude --help` 를 받아 그 버전 폴더에. 2.1.323 녹화 폴더에는 help 가 없으므로 섞지 않는다), `codex/0.169.0/help/`, `codex-app-server/0.169.0/schema/`(전체 4.7MB 대신 드라이버가 쓰는 메서드·타입만 뽑은 요약 JSON), `codex-acp/2.6.0/meta.json`(묶인 codex 범위 + 번들에서 찾은 optionId 목록), `codex-home/_versions.json`, `acp/sdk-2.7.0/schema.json`(요약), `_latest.json`
  - `app/test/fixtures-privacy.test.ts`(Codex 패턴 추가: `account_id`·`chatgpt_account_id`·`user_id`·`installationId` 칸, `serverName`, `~/.codex` 경로, 요금제 칸 `planType`·`plan_type`·`planName`·`plan_name`·`limitName`·`limit_name`·`chatgptPlanType` 의 값이 `PLAN` 이 아니면 실패 — 공백·이스케이프된 중첩 JSON 형태 포함)
- 목표: 매주 토큰 없이 H.4 의 감시 항목 6개(`claude`, `codex-exec`(W1), `codex-app-server`·`codex-acp`(W2), `codex-home`(W1·W2 공유), `acp-schema`)를 각각 기준과 비교해, 드라이버가 쓰는 플래그·필드·optionId 가 사라지면 빨간 불
- 완료 기준:
  - 로컬: `node app/scripts/provider-drift.mjs --out /tmp/drift --only codex-exec --pin codex-exec=0.169.0` → 종료 코드 0, 요약 "차이 없음"
  - 로컬: `node app/scripts/provider-drift.mjs --out /tmp/drift --only codex-acp --pin codex-acp=2.6.0` → 종료 0, `meta.json` 의 optionId 가 D.4 표와 같음
  - `cd app && npx vitest run test/drift.test.ts`(새) — (1) 기준 help 에는 `--json` 이 있고 새 help 에는 없는 문자열 쌍을 `diffFlags` 에 넣으면 `requiredMissing: ['--json']`, 설명 문구만 바뀐 쌍은 차이 0 (2) `exec resume` help 에 `--sandbox` 가 없어도 실패하지 않음(명령별 검사) (3) 가짜 번들 문자열에서 `"allow_for_session"` 을 지우면 `codex-acp` 실패 (4) 번들 파일이 없으면 실패 (5) W1 0.169.0 · W2 0.166.3 이면 `codex-home` 경고 1개
  - `cd app && npx vitest run test/fixtures-privacy.test.ts` — `"plan_type": "plus"`, `\"planType\":\"pro\"` 를 넣은 임시 fixture 가 실패
  - `ls tools/probe/probe.ps1 tools/probe/probe.mjs tools/probe/lib` 존재, `node --check tools/probe/*.mjs tools/probe/lib/*.mjs` 통과
  - GitHub Actions `workflow_dispatch` 1회 실행 성공(ubuntu·windows), 비밀 변수 참조 0(`grep -n secrets .github/workflows/provider-drift.yml` 비어 있음)
- 탐침 메모(노트북 2026-11-16):
  - redact 규칙 추가: 경로의 `Users\\<U+FFFD 여러 개>` → `Users\\hong` (노트북 결과에서 손으로 가림)
  - redact 규칙 추가: account/rateLimits 응답의 `RateLimitResetCredit_<hex>` id → `RateLimitResetCredit_REDACTED` (손으로 가림)
  - 임시 폴더 삭제가 EPERM 으로 한 번 실패했고, 그 오류 메시지에 사용자 이름이 Latin-1 로 깨진 형태로 남았다. 지금 가리기 규칙이 이 형태를 못 잡는다 → 가리기 추가
  - 탐침이 "claude mcp Examples:" 를 하위 명령으로 잘못 읽음 → help 재귀 수집 수정

### P4. Codex 녹화 fixture 넣기 (탐침 결과)
- 바꿀 파일: `app/test/fixtures/providers/codex/<노트북 버전>/`(W1 녹화 ①④·help), `app/test/fixtures/providers/codex-app-server/<노트북 버전>/`(②③⑤⑥·스키마), `.../expect.json`, (claude 버전이 달랐다면) `app/test/fixtures/providers/claude/<버전>/`
- 목표: Codex 실제 출력이 계약 테스트의 입력이 된다
- 완료 기준:
  - `cd app && npx vitest run test/fixtures-privacy.test.ts` 통과(`PLENUM_PRIVATE_WORDS` 를 노트북 값으로 넣고 한 번 더). P3 의 요금제 칸 검사가 들어간 뒤라야 한다
  - 탐침 `redaction-report.txt` 가 "남은 것 없음"
  - `grep -rniE '(plan_?type|plan_?name|limit_?name|chatgptPlanType)\\?"[[:space:]]*:[[:space:]]*\\?"[^P\\]' app/test/fixtures/providers` 출력 없음(보조 검사. 주 검사는 P3 의 privacy 테스트)
  - (P5 전에는) 계약 테스트가 codex 폴더를 "드라이버 없음 — 건너뜀" 으로 표시하고 실패하지 않음
- 탐침 메모:
  - 노트북 codex 는 0.166.0(npm, ChatGPT 로그인)이다 — codex-acp 에 묶인 버전과 같다. 이 문서의 `codex/0.169.0`·`codex-app-server/0.169.0` 폴더 이름은 클라우드 설치 기준 가정이었다. 실제 넣을 폴더 이름은 P4에서 노트북 버전으로 정한다
  - 노트북 claude 2.1.248
  - ④ 이어하기(같은 세션 id), ⑤ 중단(interrupted), app-server 핸드셰이크(0.166 스키마) 모두 정상
  - Codex 가 PowerShell 출력(CP949)을 UTF-8 로 읽어 한글 메시지와 경로가 U+FFFD 로 깨진다(복구 불가). 실행할 때 출력 인코딩을 맞추는 법(예: 실행 전 코드 페이지·`[Console]::OutputEncoding`)은 조사 항목이다 — 효과는 아직 확인 전

### P5. 범용 ACP 드라이버 + Codex 연결
- 바꿀 파일: `app/server/provider/acp.ts`(새: initialize·session/new·load·prompt·update·request_permission·elicitation·cancel, v1 만. scope 는 P3 의 `codex.options.json` 으로), `app/providers/codex.json`(I.3 예시 1), `app/server/provider/config.ts`(1단·2단 합치기), `app/server/chat.ts`(드라이버 선택), `app/test/fakeacp.ts`(새: 가짜 ACP 에이전트), `app/test/acp.test.ts`(새)
- 목표: Codex 를 Plenum 안 채팅으로 띄워 승인 카드·질문 카드·이어하기·중단이 된다(메인 조건 판정 실측). Plenum 이 Codex 를 워커로 쓸 때도 같은 드라이버(I절 `worker` 블록). 모르는 `session/update` 종류는 원문 줄로 보이고 대화는 계속된다
- 완료 기준:
  - `cd app && npx vitest run test/acp.test.ts` — 가짜 ACP 에이전트로: 명령 실행 카드에 optionId `allow_once`·`allow_for_session`·`decline`·`cancel` 버튼이 보이고, **파일 변경 카드**(`allow_once`·`allow_for_session`·`cancel` — `decline` 없음)에도 거부 버튼(`cancel`)이 보이고, 같은 kind `allow_always` 인 `accept_execpolicy_amendment`·`apply_network_policy_amendment:0` 은 **숨겨짐**(scope persistent), 표에 없는 optionId 는 숨겨지고 경고 1줄, elicitation form 왕복(`action: accept` + answers), 모르는 update 1개 → `unknown` + 로그 파일 1줄, 앱 계속
  - 노트북: Codex 채팅에서 셸 명령 승인 카드 → "이 세션 동안 허용" → **같은 명령**이 다시 안 물음, 다른 명령은 물음 (사람이 확인)
  - 노트북: 파일 쓰기 승인 카드 → "이 세션 동안 허용" → **같은 파일** 다시 쓰기는 안 물음(파일 변경 `acceptForSession` 은 파일 단위 — 스키마 설명) (사람이 확인)
  - 노트북: 이어하기로 앞 대화 기억
  - Claude 계약 테스트의 unknown 래칫: 2.1.323 녹화의 unknown 103개(system 하위 이벤트·`active_goal`·`autocompact_state`)를 매핑으로 줄이고 `UPDATE_EXPECT=1` 로 기준을 낮춘다
  - Claude 드라이버의 중단 표시(`cancelled` 판정)는 result 를 받아야 내려간다. idle 중에 `interrupt()` 를 보내 result 가 안 오면 다음 턴의 `error_during_execution` 도 `cancelled` 로 판정된다. P1 화면은 subtype 원문을 써서 영향 없음 — stopReason 을 화면·워커 결과에 쓰기 시작할 때 표시를 내리는 시점(예: 다음 `prompt()` 가 idle 에서 나갈 때)을 정한다
- 탐침 메모:
  - 노트북 ②에서 파일 쓰기 요청이 fileChange 가 아니라 commandExecution 승인(PowerShell Set-Content)으로 왔다 → 완료 기준의 "파일 쓰기 승인 카드" 장면은 그 경로도 포함
  - sandbox read-only 에서는 acceptForSession 을 해도 PermissionDenied 로 못 쓴다. 승인 ≠ 샌드박스 권한

### P6. UI — 프로바이더·모델 선택, 역할 표시
- 바꿀 파일: `app/web/src/`(새 채팅 시작 화면의 프로바이더·모델·노력 선택, 설정 › 프로바이더 목록: 감지 버전·기능·역할(메인/워커)·로그인 상태), `app/server/` 의 목록 API, `app/e2e/`
- 목표: 등록된 프로바이더마다 "메인 가능 / 워커만 / 안 됨" 과 이유(빠진 기능)가 보이고, 메인 가능한 것으로 채팅을 시작할 수 있다. `unknown` 이벤트는 접힌 "원문 보기"
- 완료 기준:
  - `cd app && npm run e2e` 새 흐름(프로바이더 고르기, 원문 보기 펼치기) 통과, `npm test` 대비 테스트(contrast) 통과
  - 로그인 안 된 프로바이더는 시작 버튼 대신 `loginHint` 문장
  - `npm run screens` 다크 스크린샷에 프로바이더 목록 화면 추가
- 탐침 메모: 승인 카드에 샌드박스 상태 표시(승인과 샌드박스 권한은 별개 — P5 메모)

