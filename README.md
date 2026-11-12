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

```bash
cd app && npm install && npm start
```

브라우저로 `http://127.0.0.1:4317`을 연다. 설정 › kit에서 kit 레포(예: jh-kit 클론) 경로를 지정하면 설정 › 워커와 상단 버전 비교가 채워진다.

## 개발

```bash
npm test
```

Node 18 이상 (컴파일러), Node 20.19 이상 (앱).
