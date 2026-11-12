# Plenum

Claude Code 세션 런처. 흡기 플레넘처럼 모았다가 나눠 보낸다.

- **kit 컴파일러**: 사람이 고치는 원본 `kit/`(중립 형식)을 Claude Code 플러그인 `build/claude-code/`로 만든다. 워커 하나의 모델을 바꾸면 고치는 파일은 하나다
- **앱** (`app/`, 1단계): 프로젝트 홈, 설정 › 워커 보기, 소스/설치본 버전 비교. 세션·채팅은 이후 단계

## 컴파일러 쓰기

kit 레포의 `package.json`:

```json
{
  "scripts": { "build": "plenum-compile", "pack": "plenum-pack" },
  "dependencies": { "plenum": "github:KJH-code/plenum#v0.1.0" }
}
```

```bash
npm run build
```

`kit/` 형식은 [KJH-code/jh-kit](https://github.com/KJH-code/jh-kit)의 README가 기준이다.

## 앱 실행 (Node 20.19 이상)

새 클론에서 이대로 하면 된다. `app/`의 `npm ci`가 루트(컴파일러) 의존성까지 같이 설치한다(postinstall).

Windows PowerShell — `npm`이 "스크립트를 실행할 수 없으므로"로 막히면 `npm.cmd`로 부른다:

```powershell
node -v
git clone https://github.com/KJH-code/plenum
cd plenum\app
npm.cmd ci
npm.cmd start
```

macOS·Linux:

```bash
git clone https://github.com/KJH-code/plenum && cd plenum/app && npm ci && npm start
```

브라우저로 `http://127.0.0.1:4317`을 연다(사용 중이면 다음 빈 포트 — 터미널에 찍힌 주소). 설정 › kit에 kit 레포를 clone한 폴더의 **전체 경로**(예: `C:\Users\<이름>\Documents\GitHub\jh-kit`)를 넣으면 설정 › 워커와 상단 버전 비교가 채워진다.

- `npm install` 대신 `npm ci`를 쓴다. lock 파일 그대로 설치한다(npm 10에서 lock 파일 없이 `npm install` 하면 vitest 4 의존성 계산 중 `Cannot read properties of null (reading 'edgesOut')`로 멈춘다)
- 외부 에디터 기본 명령은 `code`(VS Code). 설정 › 일반에서 바꾼다. 실패하면 종료 코드와 메시지를 보여 준다

## 개발

```bash
npm test
```

```bash
cd app && npm run typecheck && npm test && npm run e2e
```

Node 18 이상 (컴파일러), Node 20.19 이상 (앱). GitHub Actions가 ubuntu·windows에서 한글 이름 임시 폴더로 돌린다(`.github/workflows/test.yml`).

## 변경 기록

### 0.1.2
- 외부 에디터가 Windows에서 안 열리던 원인: `code.cmd`를 따옴표 붙은 이름(`"code"`)으로 PATH에서 찾아 부르면 cmd가 배치 파일 안의 `%~dp0`를 현재 폴더로 잡아서 `"%~dp0..\Code.exe"`를 못 찾았다(종료 코드 9009). 이제 PATH·PATHEXT에서 절대 경로를 먼저 찾아 그 경로로 부른다. `.exe`는 cmd 없이 바로. PATH에 없으면 실행 전에 이유를 보여 준다
- cmd 오류 메시지(한국어 Windows는 CP949)를 깨지지 않게 읽는다

### 0.1.1
- 새 클론에서 `app/`만 설치하면 `Cannot find module 'js-yaml'` — app의 postinstall이 루트를 설치한다
- kit 레포·clone 폴더·로컬 프로젝트 경로: 상대 경로·`owner/repo`·URL은 이유와 함께 거부, kit은 `kit/kit.yaml`·`build/claude-code`가 있어야 저장. 상단 버전 표시는 "지정 안 됨" 대신 실제 문제를 보여 준다
- 소스와 설치본이 줄바꿈(CRLF/LF)만 다르면 "줄바꿈만 다름"과 해결 명령(설정 › kit)
- 외부 에디터: 끝날 때까지 기다려 종료 코드·stderr로 실패를 잡는다 (전에는 실행만 되면 "열었다")
- 폴더 자체엔 `.git`이 없는데 상위 폴더가 레포면 경고
- 개발 의존성 보안: vite 6.4.5, vitest 4.1.12 (npm audit 0)
- GitHub Actions: ubuntu·windows, 한글 임시 폴더, 새 클론 연기 테스트
