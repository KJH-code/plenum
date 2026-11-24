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

노트북에서 진짜 낱말을 넣고 병합 전에 돌린다(비면 거부, 종료 코드 4). 낱말은 `.ps1` 파일에 적지 말고 PowerShell 창에서 `$env:PLENUM_PRIVATE_WORDS = '낱말1,낱말2'` 로 바로 설정한다(PS 5.1 은 BOM 없는 파일을 CP949 로 읽어 낱말이 깨진다). 첫 줄들의 `낱말 #n: 한글 a자 / ASCII b자 / 그 밖 c자` 가 기대와 맞는지 본다. Windows 사용자 이름(폴더 이름·`USERNAME`)도 낱말에 넣는다 — redact 는 env 에서 자동으로 치환하지만 CI·scan 은 `PLENUM_PRIVATE_WORDS` 만 본다. 작업을 커밋한 뒤 돌린다(scan 은 HEAD 를 본다).

- 찾는 곳: (a) `git log -p --text --format=fuller <범위>`(기본 `1b8402f..HEAD`, 커밋 메시지·작성자 이름·이메일 포함), (b) HEAD 트리의 블롭 전부(디스크가 아니라 HEAD. 작업 트리가 HEAD 와 다르면 경고).
- 찾는 것: 낱말의 원래·깨진 형태·JSON `\uXXXX` 이스케이프 꼴(ASCII 는 대소문자 무시) + 원래 낱말의 바이트열(UTF-16LE·CP949, 텍스트가 아닌 버퍼는 UTF-8 도).
- fail-closed: `app/test/fixtures/providers/**` 블롭이 올바른 UTF-8 이 아니거나 BOM·NUL 이 있으면 내용과 상관없이 실패(개인 정보 검사 `test/fixtures-privacy.test.ts` 도 같은 규칙).
- 출력에는 낱말을 찍지 않고 `낱말 #n 형태 k: <파일>:<줄>` / `낱말 #n 형태 k: 커밋 <해시> <diff 파일>` / `낱말 #n 바이트 <종류>: …` 와 합계만 찍는다(경로에 낱말이 있으면 경로도 가린다). 0건이면 종료 코드 0, 있으면 1, git 실패는 2.

원본에는 개인 정보가 그대로 있다. 원본은 레포 밖에만 두고, 치환한 것만 fixture 로 넣는다.
치환 뒤 `app/` 에서 `npm test`(개인 정보 검사 `test/fixtures-privacy.test.ts`)를 돌리고, 파일을 눈으로 한 번 훑은 뒤 커밋한다.

치환: 홈(`X:\Users\`·`//c/Users/`·`/c/Users/`·`/mnt/c/Users/`·평탄화 `C--Users-`, 한글 N글자 이름의 평탄화 꼴은 `C--Users----`) → `홍길동`, POSIX 홈 → `/home/hong`, 비공개 낱말·env 의 Windows 사용자 이름(폴더 이름·Windows 의 `USERNAME`, 경로 밖 맨 이름 포함, ASCII 는 대소문자 무시) → `홍길동`/`hong`(깨진 형태는 `홍길동`), 허용 밖 이메일 → `hong@example.invalid`, 계정·조직 UUID 칸 → `00000000-0000-4000-8000-00000000000N`, `synced/<uuid>_<uuid>` → `synced/ORG_ACCOUNT`, `RateLimitResetCredit_<영숫자·->` → `_0`, 작업 폴더 랜덤 → `AbCdEf`. 깨진 형태는 `variants.ts` 의 5종(UTF-8→Latin-1·CP1252, CP949→Latin-1·CP1252·UTF-8). CP949→UTF-8 꼴은 U+FFFD 아닌 글자가 2개 이상일 때만 낱말 치환·검사(redact·CI·scan)에 쓰고, 홈 폴더 자리 규칙에는 글자 수와 상관없이 그 꼴 전체를 쓴다(`C:\Users\<그 꼴>` → `C:\Users\홍길동`). 홍길동 바로 뒤에 비ASCII 글자(U+FFFD·결합 문자 등)가 이어지면 다른 이름으로 보고 막는다. 낱말·사용자 이름의 JSON 이스케이프 꼴(`\uac11…`, 문자열 속 JSON 글의 `\\uac11…` 처럼 백슬래시가 여럿인 꼴 포함)도 백슬래시 개수를 유지한 채 홍길동의 같은 꼴로 바꾼다. 지움: 계정 맥락 첨부(`prompt_snapshot`·`session_context`·`skill_listing`·`credential_org`), 시스템 프롬프트 칸, init 의 명령·에이전트·스킬 설명.

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
- NFD(자모 분리)·percent-encoding(`%EA%B0%91`) 형태는 찾지 않는다.
- git 이 따옴표로 감싼 경로(특수 문자 등)는 scan 출력의 파일 라벨이 틀릴 수 있다(라벨만 틀리고 낱말이 새지는 않는다).
- small-icu Node(TextDecoder('euc-kr') 없음)면 CP949 깨진 형태·바이트열이 빠진다(경고가 나온다).
- 치환 값과 겹치는 낱말(`홍`·`길동`·`hong` 등)은 경고만 하고 치환·검사에서 뺀다.
- scan 이 안 보는 곳: PR 제목·본문, 태그, git notes, force-push 로 덮인 원격 커밋.
- UTF-16LE·바이너리 블롭 안의 ASCII 낱말은 바이트 검색이라 대소문자를 구분한다.
- 작업 트리가 HEAD 와 다르면 scan 은 경고만 하고 HEAD 를 본다 — 커밋한 뒤 돌린다.
- `git log -p` 는 병합 커밋의 diff 를 보여 주지 않는다(병합에서만 생긴 변경은 로그 쪽에서 안 보임, 트리 쪽은 HEAD 에 있으면 잡음).
- UTF-16LE 에서 낮은 바이트가 0x0A 인 글자(예: U+AC0A)는 로그 쪽 바이트 검색이 줄 나눔에 끊겨 못 잡을 수 있다(트리 쪽은 잡는다).
- Windows 사용자 이름은 redact 가 env 에서 자동으로 치환하지만 CI·scan 은 `PLENUM_PRIVATE_WORDS` 만 본다 — 사용자 이름(폴더 이름·`USERNAME`)도 낱말에 넣는다.
- POSIX 홈 `/home/<이름>` 뒤에 U+FFFD 가 이어지는 꼴은 다루지 않는다(Windows 노트북은 해당 없음).
- 흔한·짧은 Windows 사용자 이름(`User`·`Admin` 등, 2자 이하)은 경로 밖 맨 이름을 치환하지 않는다(경로 안은 치환). 필요하면 `PLENUM_PRIVATE_WORDS` 에 넣는다.
