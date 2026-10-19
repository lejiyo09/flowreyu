# FlexNote — 태블릿용 PDF 필기 웹앱

HTML·CSS·JavaScript(빌드 과정 없음)로 만든 PDF 필기 앱입니다. 기존 프로토타입 코드는 쓰지 않고 새로 작성했습니다.
PDF.js 4.10.38과 pdf-lib 1.17.1은 `vendor/`에 같이 들어 있어서 인터넷 없이도 동작합니다.

## 실행

```bash
cd notes-app
node server.js            # http://localhost:8080
node server.js 8080 --lan # 같은 Wi-Fi의 태블릿에서 접속 (주소가 콘솔에 표시됨)
```

`index.html`을 더블클릭(file://)해서 열면 **동작하지 않습니다.** 브라우저가 ES 모듈과 PDF.js 워커를 막기 때문이고, 이 경우 화면에 안내 문구가 표시됩니다.
`python3 -m http.server`도 쓸 수 있지만, `.mjs` 파일의 MIME 타입이 올바르게 나가는 `server.js`를 권장합니다.

### 갤럭시 탭(S Pen)에서 테스트하는 방법 (권장 순서)

1. **HTTPS 정적 호스팅**: 폴더를 GitHub Pages, Netlify, Cloudflare Pages 중 하나에 그대로 올립니다. 이 방법만 모든 기능(오프라인 설치, 영구 저장 요청)을 쓸 수 있습니다.
2. **USB + adb reverse**: PC에서 `node server.js`를 실행한 뒤 `adb reverse tcp:8080 tcp:8080`을 입력하고, 탭의 Chrome에서 `http://localhost:8080`으로 접속합니다. localhost는 보안 컨텍스트로 취급되므로 기능 제한이 없습니다. PC Chrome의 `chrome://inspect`를 열면 탭의 콘솔도 볼 수 있습니다.
3. **같은 Wi-Fi**: `node server.js 8080 --lan`을 실행하고 `http://<PC IP>:8080`으로 접속합니다. 필기와 저장은 되지만, http라서 서비스 워커(오프라인)와 영구 저장 요청은 동작하지 않습니다.

Chrome 메뉴의 "홈 화면에 추가"로 설치해 두면 전체 화면으로 실행되고, 브라우저 제스처와 겹치는 일이 줄어듭니다.

## 조작

| 입력 | 동작 |
|---|---|
| S Pen | 선택한 도구로 필기 (필압 반영) |
| S Pen 버튼을 누른 채 화면 터치 | 도구 메뉴 (설정에서 "누르는 동안 지우개"로 바꿀 수 있음) |
| S Pen을 대고 0.7초 정지 | 도구 메뉴 (시간 300~5000ms, 허용 이동 거리, 표시 조건 설정 가능) |
| 손가락 1개 드래그 | 화면 이동 (관성 있음) |
| 손가락 2개 | 확대·축소와 이동 동시 |
| 두 손가락 탭 / 세 손가락 탭 | 실행 취소 / 다시 실행 |
| 마우스 | 왼쪽 버튼 필기, 오른쪽 버튼 메뉴, 휠 스크롤, Ctrl+휠 확대 |
| 키보드 | Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, Delete(선택 삭제), P·H·E·L·T·S(도구 전환), PageUp/PageDown |

도구는 펜, 형광펜, 지우개(획 단위·부분), 올가미(선택·이동·크기 조절·삭제·복제·색 변경), 텍스트, 도형(직선·화살표·사각형·원)입니다.
선택된 도구 버튼을 한 번 더 누르면 색상과 굵기 설정 팝업이 열립니다.

## S Pen 버튼 진단 (실제 기기에서 꼭 해 주세요)

1. 설정 → 진단 → **입력 디버그 로그**를 켭니다.
2. 버튼을 누르지 않고 한 번 쓰고, 이어서 버튼을 누른 채로 한 번 터치합니다.
3. 패널 위쪽 노란 줄에 `buttons=2`, `button=2`, `contextmenu`, `auxclick` 같은 이벤트가 잡히는지 봅니다. 버튼 관련 행은 강조 표시됩니다.
4. **복사** 또는 **저장** 버튼으로 로그를 받아 둡니다. 다음 작업의 근거 자료가 됩니다.
5. 디버그 모드에서 메뉴가 열리면, 메뉴 아래에 어느 경로로 열렸는지가 표시됩니다(`pointerdown:pen buttons=3`, `contextmenu:pen`, `hold` 등).

앱은 아래 경로를 모두 받아서 처리하고, 같은 조작으로 메뉴가 두 번 열리지 않게 막습니다.

- `pointerdown` / `pointermove`에서 펜의 `buttons & 2`(보조 버튼), `button === 2`
- 필기 중에 버튼을 누른 경우(`buttons` 값이 1에서 3으로 바뀜): 짧은 점은 버리고 메뉴를 엽니다
- 펜을 띄운 채(호버) 버튼을 누른 경우 `buttons=2`
- `pointerType`이 `mouse`이고 `button=2`인 경우 (일부 안드로이드 Chrome은 펜 버튼을 마우스 오른쪽 버튼으로 보냄)
- `contextmenu`, `auxclick` (pointerType이 없으면 1초 안에 들어온 펜·마우스 입력으로 판단, 손가락으로 길게 누른 경우는 무시)
- 펜 지우개 끝(`buttons & 32`, `button 5`)은 지우개로 처리

**제약**: 펜을 띄운 상태에서 버튼을 누르면 삼성 OS가 먼저 Air Command로 가로챌 수 있고, 이 경우 브라우저에는 아무 신호도 오지 않습니다. 버튼을 **누른 상태로 화면에 닿는** 방식이 가장 확실하고, 위 로그로 그 여부를 확인할 수 있습니다. 어떤 경로로도 신호가 오지 않는 기기에서는 **정지 감지**가 대안입니다.

## 구조

```
index.html            화면 구조 (라이브러리 / 편집기 / 설정 / 디버그 패널)
css/app.css           Flexcil 스타일, 라이트·다크 테마 토큰
js/main.js            앱 연결: 라이브러리, 가져오기, 도구 UI, 빠른 메뉴, 선택 상자, 텍스트 편집, 설정
js/viewer.js          카메라(확대·이동), 페이지 배치, PDF 렌더링(base + 고해상도 detail), 필기 레이어
js/input.js           입력 엔진: PenInput / TouchInput / MouseInput 분리, InputRouter는 분배만 담당
js/tools.js           펜·형광펜·지우개·올가미·텍스트·도형
js/ink.js             필기 객체 모델, 렌더링(가변 두께), 히트 테스트, 검증
js/document.js        문서별 필기 상태, Undo/Redo, 자동 저장(재시도 포함)
js/store.js           IndexedDB (docs / files / pages / kv)
js/thumbs.js          페이지 썸네일 (보이는 것만 렌더)
js/export.js          필기 포함 PDF 내보내기, 빈 노트(무지·줄·모눈·점) 생성
js/debug.js           입력 이벤트 기록기
sw.js, manifest       오프라인 실행 / 홈 화면 설치
server.js             개발용 정적 서버
tests/                Playwright 자동 테스트
```

### 저장 방식
- PDF 원본은 IndexedDB `files` 스토어에 Blob으로 저장합니다(Base64 변환 없음). 메타데이터와 같은 트랜잭션으로 저장되므로 둘 중 하나만 남는 경우가 없습니다.
- 필기는 **페이지 단위** 레코드로 저장하고, 바뀐 페이지만 0.5초 디바운스 후 기록합니다. 앱이 백그라운드로 가거나 페이지를 벗어날 때는 즉시 저장합니다.
- 저장에 실패하면 상단에 "저장 실패"가 표시되고 알림이 뜹니다. 실패한 페이지는 지워지지 않고 남아 있다가 2초, 4초, 8초… 간격으로 다시 저장을 시도합니다.
- 불러올 때 모든 객체를 검증합니다. 손상된 객체는 건너뛰고 몇 개를 건너뛰었는지 알려 줍니다.
- 브라우저가 저장소를 지울 수 있으므로, 설정 → 저장소에서 **영구 저장 요청**과 **필기 백업(JSON) 내보내기·가져오기**를 제공합니다.
- 설정값은 localStorage에 저장합니다.

## 자동 테스트

```bash
cd tests
npm i                                  # playwright, pdf-lib
npm run fixtures                       # 테스트 PDF 생성
npm test                               # 기능 39개 + 저장 실패·손상 데이터 + 추가 입력 경로
npm run perf                           # 300쪽 PDF에서 렌더링 중 펜 지연 측정
```
