# Plenum

Claude Code 세션 런처. 프로젝트를 고르고(세션은 3단계), kit 레포의 워커 정의를 본다. 루트 패키지는 kit 컴파일러이고, 앱은 `app/`에 따로 있다. 공개 레포.

DevVault: Projects/jh-kit

## 스택
- 컴파일러(`compiler/`, `bin/`): Node 18 이상, CommonJS JS. 의존성은 `js-yaml` 하나. kit 레포가 `github:KJH-code/plenum#<태그>`로 가져다 쓴다
- 앱(`app/`): TypeScript + React(Vite) + 로컬 Node 서버(`node:http`). Node 20.19 이상. 별도 package.json — 루트에 앱 의존성을 넣지 않는다(kit 레포 설치에 딸려 간다)
- 테스트: 컴파일러는 `node --test`(`compiler/run-tests.js`), 앱은 Vitest, 화면은 Playwright
- 새 의존성은 재혁 확인 후

## 구조
- `compiler/compile.js` — `plenum-compile [--kit <dir>] [--out <dir>] [--json]`. 기본 `<cwd>/kit` → `<cwd>/build/claude-code`
- `compiler/pack.js` — `plenum-pack [--build <dir>] [--out <file>]`. 기본 `<cwd>/dist/<name>-<version>.zip`
- `compiler/lib/` — `kit.js`(kit 읽기·모델), `claude-code.js`(타깃 컴파일러·검증), `render.js`(토큰), `prose.js`(산문 경고)
- `compiler/test/` — fixture kit(`fixtures/kit`)으로 도는 컴파일러·pack 테스트
- `app/server/` — `node:http` 서버. config(설정·목록), git(감지·clone), projects, kit(워커: 컴파일러의 `loadKit` 재사용), versions(트리 해시), open(폴더·에디터·외부 명령 실행 `commandFor`·`runCommand`), kitedit(워커 머리말·버전 줄 고치기, 미리보기), kitgit(원격 비교·받아오기·우리 커밋 되돌리기), kitsave(저장 job: 검사→빌드→commit→push), install(설치본 반영)
- `app/web/src/` — React. 설정 › 워커 편집은 `WorkerEdit.tsx`, 설치본 반영은 `InstallPanel.tsx`. `theme.css` 색 토큰 접두어 `--bg-*`·`--fg-*`·`--line-*`(대비 테스트가 모든 쌍을 잰다), 해시 라우팅
- `app/test/` — Vitest, `app/e2e/screens.ts` — Playwright 스크린샷

## 명령
- 컴파일러 테스트: `npm test` (루트)
- 앱 (`app/`에서): `npm ci`(postinstall이 루트도 설치) → `npm start`(웹 빌드 + 서버 127.0.0.1:4317, 사용 중이면 다음 빈 포트) · 개발은 `npm run serve` + `npm run dev`
- 앱 테스트: `npm test`(Vitest), `npm run typecheck`. 워커 대조 테스트는 옆 폴더 `../jh-kit`(또는 `PLENUM_TEST_KIT_REPO`)이 있어야 돈다. 없으면 건너뛴다고 표시된다
- 화면: `npm run screens -- <kit 레포> <출력 폴더>` (Playwright, 다크) · 브라우저 흐름: `npm run e2e [-- <kit 레포>]`
- CI: `.github/workflows/test.yml` (ubuntu·windows, 한글 임시 폴더, 새 클론 연기 테스트)
- 설정 파일: `%APPDATA%\plenum\config.json` (그 밖 `~/.config/plenum`, 테스트는 `PLENUM_CONFIG_DIR`). 설치본은 `~/.claude/plugins/installed_plugins.json`(`CLAUDE_CONFIG_DIR`)

## 규칙
- 생성물은 결정적이어야 한다 (날짜·시각·정렬 안 된 순회 금지)
- 머리말은 YAML로 다시 직렬화하지 않는다 (원문 줄 유지)
- 컴파일러를 바꾸면 jh-kit 레포에서 `plenum-compile` 결과가 커밋된 `build/`와 같은지(또는 의도한 차이만 있는지) 확인한다. 태그를 올려야 kit 레포에 반영된다
- 경로·명령 인자는 셸 없이 `execFile`에 배열로 넘긴다 (Windows 한글 사용자 이름 홈, 예: `C:\Users\홍길동`)
- 색은 `theme.css` `:root` 토큰에만 쓴다. 글자 4.5:1, 테두리 3:1 (contrast 테스트). 모르는 값은 지어내지 않고 `[…]` 자리표시
- 로컬 서버: 127.0.0.1에만, 바꾸는 요청은 `X-Plenum: 1` 헤더 필수, Host 검사, CORS 허용 헤더는 보내지 않는다
- 사용자가 넣는 경로는 절대 경로만(`server/paths.ts`). 상대 경로는 서버 cwd 기준이 돼서 엉뚱한 곳이 된다
- 개발 의존성은 lock 파일(npm 11로 생성)로 고정. npm 10에서 lock 없이 `npm install` 하면 vitest 4에서 멈춘다
- 커밋 메시지는 한국어. 커밋 본문에 모델 이름을 넣지 않는다. 예외: 끝의 `Co-Authored-By: Claude …` 트레일러
- 커밋 작성자: author = `KJH-code <248580898+KJH-code@users.noreply.github.com>`, committer = `Claude <noreply@anthropic.com>` (클라우드 세션 SSH 서명이 Verified로 뜬다). `--reset-author`는 쓰지 않는다(프로필 기여에서 빠진다)
