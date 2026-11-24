# tools/probe — 진짜 claude 녹화

`claude -p` stream-json 을 장면대로 돌려 stdin·stdout 줄을 그대로 녹화하고, 개인 정보를 치환해 fixture(`app/test/fixtures/providers/claude/<버전>/`)로 만든다.
CLI 버전이 바뀔 때마다 다시 녹화한다. 승인·질문의 답은 레포 드라이버(`app/server/provider/claude.ts`)가 만든 원문을 보낸다 — 드라이버를 고치면 녹화도 고친 동작을 담는다.

## 명령 (`app/` 에서)

```
npm run probe -- ../tools/probe/scenes/07-powershell-session.json [--out <폴더>] [--dry-run] [--allow-empty-words]
npm run probe:redact -- <out>/<장면>-raw.jsonl [--dest <폴더>] [--allow-empty-words]
```

- 둘 다 `PLENUM_PRIVATE_WORDS`(쉼표 구분: 이메일 아이디·실명 등)가 비어 있으면 거부한다(종료 코드 4). 낱말 없이 하려면 `--allow-empty-words` 를 붙인다. `--dry-run` 은 경고만 한다.
- `probe`: 작업 폴더를 만들고 claude 를 띄운다. claude 를 못 띄움·`--version` 실패·init 버전 없음·턴 끝 없음·종료 코드 ≠0·시간 초과면 0 아닌 코드로 끝난다. stdin 이 닫혀 못 보낸 답은 콘솔에 `dropped` 로 알리고 녹화에 남기지 않는다. 결과 `<out>/<장면>-raw.jsonl`·`<장면>-meta.json`. 기본 out 은 `os.tmpdir()/plenum-probe/`(Windows `$env:TEMP\plenum-probe\`). `--dry-run` 은 claude 를 띄우지 않고 작업 폴더·프롬프트·인자만 출력한다.
- `probe:redact`: 치환한 `<dest>/<장면>.jsonl` 과 `<dest>/meta.json`(scenes 에 추가). 기본 dest 는 `app/test/fixtures/providers/claude/<meta.version>/`. 치환 뒤 낱말·깨진 형태·홍길동 아닌 Windows 홈·`RateLimitResetCredit` 실제 값이 남으면 파일을 쓰지 않고 실패한다(종료 코드 3).
  U+FFFD 가 있던 줄은 번호를 알린다. 홈 폴더 이름 자리가 U+FFFD·깨진 형태로만 되어 있으면(원래 바이트를 잃은 사용자 이름) 그 자리는 `홍길동` 으로 바꾼다. 그 밖에 남은 U+FFFD 는 실패가 아니다(보고에 적는다).

## 병합 전 검사 (`probe:scan`)

```
npm run probe:scan -- [--range <범위>] [--repo <폴더>]
```

노트북에서 진짜 낱말을 `PLENUM_PRIVATE_WORDS` 에 넣고 병합 전에 돌린다(비면 거부, 종료 코드 4). 낱말마다 원래 형태와 깨진 형태 전부를 (a) `git log -p --format=fuller <범위>`(기본 `1b8402f..HEAD`, 커밋 메시지·작성자 이름·이메일 포함)와 (b) 작업 트리의 `git ls-files` 텍스트 파일(바이너리 건너뜀)에서 찾는다. 출력에는 낱말을 찍지 않고 `낱말 #n 형태 k: <파일>:<줄>` / `낱말 #n 형태 k: 커밋 <해시> <diff 파일>` 과 합계만 찍는다(경로에 낱말이 있으면 경로도 가린다). 0건이면 종료 코드 0, 있으면 1, git 실패는 2.

원본에는 개인 정보가 그대로 있다. 원본은 레포 밖에만 두고, 치환한 것만 fixture 로 넣는다.
치환 뒤 `app/` 에서 `npm test`(개인 정보 검사 `test/fixtures-privacy.test.ts`)를 돌리고, 파일을 눈으로 한 번 훑은 뒤 커밋한다.

치환: 홈(`X:\Users\`·`//c/Users/`·`/c/Users/`·`/mnt/c/Users/`·평탄화 `C--Users-`, 한글 N글자 이름의 평탄화 꼴은 `C--Users----`) → `홍길동`, POSIX 홈 → `/home/hong`, 비공개 낱말·env 의 Windows 사용자 이름(폴더 이름·Windows 의 `USERNAME`, 경로 밖 맨 이름 포함, ASCII 는 대소문자 무시) → `홍길동`/`hong`(깨진 형태는 `홍길동`), 허용 밖 이메일 → `hong@example.invalid`, 계정·조직 UUID 칸 → `00000000-0000-4000-8000-00000000000N`, `synced/<uuid>_<uuid>` → `synced/ORG_ACCOUNT`, `RateLimitResetCredit_<영숫자·->` → `_0`, 작업 폴더 랜덤 → `AbCdEf`. 깨진 형태는 `variants.ts` 의 5종(UTF-8→Latin-1·CP1252, CP949→Latin-1·CP1252·UTF-8. U+FFFD 뿐인 것은 낱말 검사에서 빼고 홈 자리 규칙이 맡는다). 지움: 계정 맥락 첨부(`prompt_snapshot`·`session_context`·`skill_listing`·`credential_org`), 시스템 프롬프트 칸, init 의 명령·에이전트·스킬 설명.

## 장면 JSON (`scenes/*.json`)

| 칸 | 뜻 |
|---|---|
| `scene` | 장면 이름. 파일 이름이 된다 |
| `model` | `--model` 값 |
| `workdir` | `under: "tmp"` → `os.tmpdir()/<name>/<sub>` 를 claude 의 cwd 로 만든다. `name` 의 `{rand}` 는 영숫자 6자 |
| `turns[].prompt` | 턴마다 보낼 글. `{TMP}` 는 `os.tmpdir()` 실제 값으로 채운다 — PowerShell 작은따옴표 문자열 안에 둔다(`'{TMP}\x.txt'`, 값 안의 `'` 는 `''` 로 넣는다). 앞 턴의 `result` 가 오면 다음 턴을 보내고, 마지막 뒤에는 stdin 을 닫는다 |
| `answers[]` | 승인 요청 답. 위에서부터 보고 명령(`command`, 없으면 `file_path`)에 `match` 가 들어 있고 `nth`(그 match 의 몇 번째 요청, 1부터. 없으면 아무 번째나)가 맞으면 `optionId`(`allow_session`·`allow_once`·`reject_once`) |
| `defaultAnswer` | 맞는 규칙이 없을 때 답 |
| `timeoutMs` | 넘으면 프로세스 트리를 죽이고 끝낸다 |

질문(AskUserQuestion)은 label 이 "모드 없음"인 선택지를 고르고, 없으면 거부한다. 고른 답이 카드에 없으면(세션 규칙이 없어 `allow_session` 이 없는 카드) `allow_once` 로 답하고 콘솔에 적는다.

## 알려진 한계

- 심볼릭 링크 경로로 `record.ts`·`redact.ts` 를 직접 부르면 실행 파일 판정이 어긋나 아무것도 하지 않는다. `npm run probe`·`npm run probe:redact` 로 쓴다.
- POSIX 에서 Ctrl+C 로 끊으면 claude(별도 프로세스 그룹)가 고아로 남을 수 있다. 시간 초과 때는 트리째 죽인다.
- 이미 있는 버전 폴더에 합치면 `meta.json` 의 `os`·`command` 등은 기존 값을 유지한다(다르면 경고). golden·expect 는 이 도구가 만들지 않는다 — `UPDATE_GOLDEN=1`·`UPDATE_EXPECT=1` 로 따로 만든다(단계 C 에서 정리).
- `/cygdrive/c/Users/<이름>` 형태는 검사·치환하지 않는다.
- `RateLimitResetCredit_` 뒤 id 에 `_` 가 있으면 `_` 앞까지만 `0` 으로 바뀌고 뒷부분이 남는다.
- 흔한·짧은 Windows 사용자 이름(`User`·`Admin` 등, 2자 이하)은 경로 밖 맨 이름을 치환하지 않는다(경로 안은 치환). 필요하면 `PLENUM_PRIVATE_WORDS` 에 넣는다.
