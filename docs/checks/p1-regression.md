# P1 노트북 회귀 확인

P1(어댑터 층)은 동작을 바꾸지 않는 리팩터다. 그래서 3단계 확인 항목이 0.3.1 과 같게 동작하는지 본다.
기준 = plenum 0.3.0 노트북 완료 기준.

Windows PowerShell 에서 한다. 블록마다 `cd` 로 시작하고 한 줄에 명령 하나다. npm 은 실행 정책에 막히지 않게 처음부터 `npm.cmd` 로 부른다.

첫 실행(2026-11-21, claude 2.1.248, haiku) 결과로 고친 판이다.
- ①② 명령: 읽기 전용 명령은 승인 없이 실행될 수 있다. 그래서 `$env:TEMP` 에 파일을 쓰는 명령으로 바꿨다.
- 이어하기: 자동 메모리에 남지 않게 하고, 채팅 프로세스를 끝낸 뒤 묻도록 터미널로 열기 다음(⑤)으로 옮겼다.
- ⑦ 기대 결과: 실제 동작(서버 창을 닫으면 채팅 claude 가 스스로 끝남)에 맞췄다.

## 준비

```powershell
cd $HOME\Documents\GitHub\plenum
git fetch origin
git checkout claude/awesome-bell-zvjj96
git pull
```

```powershell
cd $HOME\Documents\GitHub\plenum\app
npm.cmd ci
npm.cmd test
npm.cmd start
```

- 브라우저로 `http://127.0.0.1:4317` 을 연다(사용 중이면 터미널에 찍힌 주소). 프로젝트 하나를 골라 새 세션(앱 안 채팅)을 연다.

## 확인할 항목

### ① 질문·승인 카드

할 것:
- 채팅에 보낸다: `AskUserQuestion 도구로 나에게 선택지 3개짜리 질문을 하나 해줘. 주제는 점심 메뉴.`
- 질문 카드에서 선택지 하나를 누른다.
- 채팅에 보낸다: `PowerShell 로 Set-Content -Path $env:TEMP\plenum-p1-a.txt -Value one 을 그대로 실행해줘.`
- 승인 카드에서 "허용"을 누른다.

기대 결과:
- 질문 카드에 선택지 버튼(추천 강조, 기타 직접 입력)이 뜨고, Claude 가 고른 답을 받아 이어서 답한다.
- 명령 승인 카드에 허용 / 이 세션 동안 허용 / 거부… 가 보인다. 허용하면 명령이 실행되고 결과로 답한다.

결과: [ ] 통과 [ ] 실패 — 메모:

### ② 이 세션 동안 허용

할 것:
- 같은 채팅에서 보낸다: `PowerShell 로 Set-Content -Path $env:TEMP\plenum-p1-b.txt -Value two 를 그대로 실행해줘.`
- 승인 카드에서 "이 세션 동안 허용"을 누른다.
- 글자까지 같은 명령을 다시 시킨다(위 문장을 그대로 다시 보낸다).
- 다른 명령을 시킨다: `PowerShell 로 Set-Content -Path $env:TEMP\plenum-p1-c.txt -Value three 를 그대로 실행해줘.`

기대 결과:
- 카드가 "허용 · 이 세션 동안 다시 묻지 않음"으로 바뀐다.
- 같은 명령은 다시 묻지 않고 실행된다.
- 다른 명령은 승인 카드가 다시 뜬다.

알려진 문제(0.3.1 부터, P1 회귀 아님): PowerShell 도구에서는 같은 명령을 다시 시키면 카드가 또 뜬다(2026-11-21 노트북, main 0.3.1 에서도 재현). README "남은 일" 참고. 이 항목이 이 증상으로만 실패하면 "알려진 문제"로 적는다.

결과: [ ] 통과 [ ] 실패 [ ] 알려진 문제 — 메모:

### ③ 이유 달아 거부

할 것:
- 보낸다: `PowerShell 로 Set-Content -Path $env:TEMP\plenum-p1-d.txt -Value four 를 그대로 실행해줘.`
- 승인 카드에서 "거부…"를 누르고, 이유(예: `지금은 실행하지 마`)를 넣고 "거부 보내기"를 누른다.
- 채팅에 보낸다: `방금 거부된 이유가 뭐였어?`

기대 결과:
- 카드가 `거부함 · "<이유>"를 Claude에게 전달` 로 바뀐다.
- Claude 가 "사용자가 직접 거부했다(훅 아님). 이유: …"를 읽고, 사용자가 거부했다는 것과 그 이유를 말한다.

결과: [ ] 통과 [ ] 실패 — 메모:

### ④ 터미널로 열기

할 것:
- 새 세션을 열고 채팅에 보낸다: `내가 좋아하는 숫자는 7이야. 파일이나 메모리에 저장하지 말고 이 대화로만 기억해.`
- 답을 받은 뒤(응답 중이 아닐 때) "터미널로 열기"를 누른다.
- 열린 터미널에서 `/exit` 로 claude 를 끝내고 창을 닫는다.

기대 결과:
- 채팅 프로세스가 먼저 끝난다. 그다음 Windows Terminal(없으면 cmd)의 PowerShell 에서 `claude --resume <ID>` 로 같은 세션이 열린다.
- 터미널에서 열려 있는 동안에는 그 세션의 채팅 이어하기가 막힌다.

결과: [ ] 통과 [ ] 실패 — 메모:

### ⑤ 이어하기

④ 바로 다음에 한다. ④에서 채팅 프로세스와 터미널이 모두 끝나서, 대화 내용은 세션 기록에만 남아 있다.

할 것:
- 지난 세션 목록에서 ④의 세션을 고르고 "이어하기"를 누른다.
- 채팅에 보낸다: `내가 좋아하는 숫자가 뭐였지?`

기대 결과:
- 지난 기록이 다시 그려진다.
- Claude 가 앞 대화를 기억하고 답한다(7).
- 메모리 파일을 읽어서 답했다면 무효다. 도구 줄에 메모리·파일 읽기가 없는지도 본다.

결과: [ ] 통과 [ ] 실패 — 메모:

### ⑥ 한도 표시

할 것:
- 채팅에서 한 턴을 주고받은 뒤 화면 상단을 본다.

기대 결과:
- 상단에 5시간·주간 % 가 "HH:MM 기준"과 함께 보인다(값이 없으면 "—").

결과: [ ] 통과 [ ] 실패 — 메모:

### ⑦ 고아 프로세스 정리

할 것:
- Claude 데스크톱 앱을 켜 둔다. 이름이 같은 `claude.exe` 라서, 잘못 죽이지 않는지 본다.
- 채팅에 오래 걸리는 일을 시켜 응답 중으로 만든다(예: `1부터 300까지 한 줄에 하나씩 써줘.`).
- 응답 중에 `npm.cmd start` 를 돌린 서버 창을 강제로 닫는다(창의 X 버튼).
- 새 PowerShell 창에서 채팅 claude(명령줄에 `stream-json` 이 있는 것)만 걸러 본다:

```powershell
cd $HOME\Documents\GitHub\plenum\app
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*stream-json*' } | Select-Object ProcessId,Name,CommandLine | Format-List
```

- 서버를 다시 켠다:

```powershell
cd $HOME\Documents\GitHub\plenum\app
npm.cmd start
```

- 다른 PowerShell 창에서 위 확인 명령을 한 번 더 돌린다.
- 데스크톱 앱이 살아 있는지 본다:

```powershell
cd $HOME\Documents\GitHub\plenum\app
Get-Process claude -ErrorAction SilentlyContinue | Select-Object Id,Path
```

기대 결과:
- 서버 창을 닫으면 채팅 claude 는 stdin 이 닫혀 스스로 끝난다. 그래서 첫 확인에서 `stream-json` 프로세스가 0개인 것이 정상이다(고아가 안 생김).
- 첫 확인에서 남아 있었다면, `npm.cmd start` 를 다시 켠 뒤에는 사라져야 한다(`chat-pids.json` 으로 정리).
- 데스크톱 앱 claude(`AnthropicClaude\app-*` 경로)는 내내 살아 있다.

결과: [ ] 통과 [ ] 실패 — 메모:

### ⑧ 서버 꺼짐 안내

할 것:
- 서버 창에서 Ctrl+C 로 서버를 끈다.
- 브라우저 탭을 닫지 말고 화면을 조작한다(예: 채팅에 글을 보내거나 지난 세션 목록을 누른다).

기대 결과:
- "Failed to fetch" 대신 "Plenum 서버가 꺼져 있음 — 터미널에서 다시 켜기" 가 보인다.

결과: [ ] 통과 [ ] 실패 — 메모:

## 정리

```powershell
cd $HOME\Documents\GitHub\plenum
Remove-Item $env:TEMP\plenum-p1-*.txt -ErrorAction SilentlyContinue
```

## 결과 보고

항목 번호별로 통과/실패/알려진 문제를 적는다. 실패면 화면 문구를 그대로 옮긴다.

## 실행 기록

| 날짜 | 환경 | 결과 |
|---|---|---|
| 2026-11-21 | Windows 11, claude 2.1.248, haiku, 이 문서를 고치기 전 판 | ①③④⑤⑥⑦⑧ 통과(옛 번호). ② 실패: PowerShell 세션 허용 뒤 같은 명령에 카드가 다시 뜸. main 0.3.1 에서도 재현 → 원래 있던 버그 |
