# 진짜 claude 녹화 (stream-json)

`claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --model haiku`
를 claude 2.1.323(클라우드 컨테이너, 구독 로그인)에서 돌린 그대로의 줄. 한 줄 = `{"dir":"in"|"out"|"exit"|"raw", "t"?, "msg"?}`.
`in`은 Plenum 쪽이 stdin 으로 보낸 것, `out`은 claude stdout 한 줄, `exit`는 프로세스 종료(code·sig·ms).
개인 정보 치환: 홈 `/home/hong`, 작업 폴더 `/tmp/plenum-rec-홍길동-AbCdEf`, 플러그인 경로의 조직·계정 id → `ORG_ACCOUNT`. stderr 줄은 뺐다.
시스템 프롬프트·계정 맥락(`prompt_snapshot`·`session_context`·`skill_listing`·`credential_org` 첨부, init 의 스킬·명령 목록 설명)은 지웠다. 개인 정보 검사: `test/fixtures-privacy.test.ts`(이메일·홈 경로·`PLENUM_PRIVATE_WORDS`).

| 파일 | 장면 | 확인된 것 |
|---|---|---|
| 01-cards | AskUserQuestion → Bash 허용 → Bash "이 세션 동안 허용"(addRules 만, destination session) → 같은 명령 다시(안 물음) → rm 거부+이유 | `permission_suggestions` = addRules(localSettings)·addDirectories(session)·setMode acceptEdits(session). addRules 만 session 으로 보내면 같은 명령은 다시 안 묻고 다른 명령(rm)은 묻는다. 레포에 `.claude/` 안 생김. 거부는 `result.permission_denials` |
| 02-resume | 01 세션을 `--resume` | 같은 session_id, 앞 대화 기억 |
| 03-mode | jh-kit UserPromptSubmit 훅 → 모드 질문(AskUserQuestion, header "모드") → "모드 없음" → Edit 승인 | Edit 제안은 setMode acceptEdits 하나뿐 |
| 04-agents | Agent 전경 1 + run_in_background 1 | `system/task_started`(tool_use_id·description·subagent_type·is_backgrounded) → `task_progress` → `task_updated`(patch.status completed) → `task_notification`(status·summary) / `background_tasks_changed` |
| 05-interrupt | 스트리밍 중 `control_request {subtype:"interrupt"}` | 응답 `{still_queued:[]}`, `result/error_during_execution`, 종료 코드 1 |
| 06-slash-stdin-close | `/jh-kit:start …`를 글자 그대로 보내고 첫 assistant 줄에서 stdin 닫기 | `-p`에서도 스킬이 돈다(클라우드). stdin 이 닫혀도 **턴을 끝까지 돌고** 끝난다(21초). 그동안 온 승인 요청은 답할 길이 없어 거부(`permission_denials`) |

## 노트북 2.1.248 과 필드 대조

노트북 확인(2026-11-13)에서 쓴 `probe.js`가 읽은 필드는 모두 이 녹화에도 같은 이름으로 있다. 노트북 원본 출력 줄은 남아 있지 않아 노트북 확인 때 다시 대조한다.

| 필드 | 2.1.248(노트북) | 2.1.323(녹화) |
|---|---|---|
| `system/init.claude_code_version`·`apiKeySource`·`permissionMode` | 있음 | 있음 (`default`, `none`) |
| `control_request.request.subtype = can_use_tool`, `tool_name`, `input` | 있음 | 있음 |
| `control_response.response.{subtype:success, request_id, response:{behavior, updatedInput / message}}` | 동작 | 동작 |
| AskUserQuestion `updatedInput.answers`(질문 → label) | 동작 | 동작 |
| `rate_limit_event.rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt}` | 있음 (0.34·0.19) | 있음 (+ `status`) |
| `result.session_id`·`permission_denials` | 있음 | 있음 |
| `permission_suggestions` 모양, `updatedPermissions`, `interrupt`, `system/task_*`, `stream_event`, `--effort` 플래그 | 미확인 | 있음 → 노트북 확인 항목 |
