# 1-2 Gemini 폐급리스트 테스트

Gemini API를 브라우저에서 직접 호출하지 않고 Node.js 서버를 거쳐 호출하는 1차 실험 프로젝트입니다.

## 준비

- Node.js 18 이상
- Gemini API 키

## 실행

### 1. 압축 해제 후 폴더 이동

```bash
cd 1-2-gemini-test
```

### 2. 패키지 설치

```bash
npm install
```

### 3. 환경변수 파일 만들기

`.env.example`을 복사해서 `.env`로 이름을 바꾸고:

```env
GEMINI_API_KEY=여기에_테스트용_키
GEMINI_MODEL=gemini-2.5-flash
PORT=3000
```

### 4. 서버 실행

```bash
npm start
```

브라우저에서:

http://localhost:3000

## API

POST `/api/waste/analyze`

```json
{
  "name": "철수",
  "actions": [
    "수업 시간에 몰래 게임함",
    "급식 줄을 새치기함"
  ]
}
```

서버가 Gemini에 요청하고 구조화된 JSON 결과를 웹페이지에 표시합니다.

## 모델 변경

`.env`의 `GEMINI_MODEL`을 바꾸면 됩니다.

예:

```env
GEMINI_MODEL=gemini-3.7-flash
```

사용 가능한 모델은 Gemini API 문서를 기준으로 확인하세요.

## 보안

`.env`는 절대 GitHub 등에 올리지 마세요. API 키는 서버에서만 사용하고 브라우저 코드에는 넣지 않습니다.
