# FlexNote 작업 지침

- 태블릿(S Pen) PDF 필기 웹앱. 빌드 없음: HTML/CSS/ES 모듈 그대로 배포 (GitHub Pages: main 브랜치 루트).
- **파일을 추가·수정하면 `node tools/gen-sw.js` 실행** (오프라인 사전 캐시 목록·버전 갱신. 안 하면 사용자 기기가 옛 코드를 계속 씀). `npm test` 가 `--check` 로 검사한다.
- 실행: `node server.js` → http://localhost:8080 (file:// 불가)
- 회귀 테스트: `cd tests && npm i && npm run fixtures && npm test` (Playwright, 펜/터치는 CDP로 주입). 수정 후 반드시 실행.
- 입력은 js/input.js 의 PenInput / TouchInput / MouseInput 으로 분리되어 있다. 한 곳에 섞지 말 것.
- 필기는 페이지 좌표(PDF 1배율)로 저장, 객체는 불변으로 다루고 document.js 의 setItems/begin/commit 으로만 수정 (Undo·자동 저장 일관성).
- 렌더 중 애니메이션/큰 리페인트는 펜 지연을 만든다 (shimmer 제거 사례). 성능 확인: `npm run perf`.
- 제스처(펜 버튼/꾹 누르기/두 번 탭/두·세 손가락 탭/손가락 꾹 누르기)는 settings.gestures 의 동작을 router.runGesture → main.runAction 으로 실행. 새 동작은 settings.js GESTURE_ACTIONS 와 runAction 에 함께 추가.
- 보조 버튼은 pointerType 과 무관하게 buttons&2 / button=2 / contextmenu 를 모두 받는다 (크롬이 펜→마우스 우클릭으로 바꿔 보내는 경우 포함). 펜 상태 꼬임 복구 로직(호버·window up·stale·touchend 0개)은 tests/spen.js 로 검증.
- 펜은 다음 획에도 같은 pointerId 를 쓴다: 지연 정리 코드는 id 가 아니라 획 객체로 비교할 것.
- S Pen 보조 버튼은 실제 기기 로그(설정 → 입력 디버그 로그)로 검증 전까지 미확정.
