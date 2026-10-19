// 서비스 워커: 와이파이·데이터 없이도 앱이 켜지도록 한다.
//
// - 설치 시 앱 실행에 필요한 파일 전부(PDF.js 워커, 한글 PDF용 CMap·표준 폰트 포함)를 미리 캐시
// - 캐시 우선: 네트워크가 없거나 "연결은 됐는데 인터넷이 안 되는" 와이파이에서도 즉시 실행
// - 업데이트: 파일이 바뀌면 VERSION 이 바뀌어 새 워커가 백그라운드에서 설치되고,
//   앱이 "업데이트" 알림을 띄운다. 사용자가 누르면 교체(SKIP_WAITING) 후 새로고침.
//   (실행 중에 코드가 섞이지 않도록 자동 교체는 하지 않는다)

// <precache> (tools/gen-sw.js 가 생성 — 직접 고치지 말 것)
const VERSION = '0ff7b75030a9';
const PRECACHE = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "css/app.css",
  "js/debug.js",
  "js/document.js",
  "js/export.js",
  "js/guides.js",
  "js/ink.js",
  "js/input.js",
  "js/main.js",
  "js/settings.js",
  "js/store.js",
  "js/thumbs.js",
  "js/tools.js",
  "js/util.js",
  "js/viewer.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon.svg",
  "vendor/pdf-lib/pdf-lib.esm.min.js",
  "vendor/pdfjs/cmaps/78-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/78-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/78-H.bcmap",
  "vendor/pdfjs/cmaps/78-RKSJ-H.bcmap",
  "vendor/pdfjs/cmaps/78-RKSJ-V.bcmap",
  "vendor/pdfjs/cmaps/78-V.bcmap",
  "vendor/pdfjs/cmaps/78ms-RKSJ-H.bcmap",
  "vendor/pdfjs/cmaps/78ms-RKSJ-V.bcmap",
  "vendor/pdfjs/cmaps/83pv-RKSJ-H.bcmap",
  "vendor/pdfjs/cmaps/90ms-RKSJ-H.bcmap",
  "vendor/pdfjs/cmaps/90ms-RKSJ-V.bcmap",
  "vendor/pdfjs/cmaps/90msp-RKSJ-H.bcmap",
  "vendor/pdfjs/cmaps/90msp-RKSJ-V.bcmap",
  "vendor/pdfjs/cmaps/90pv-RKSJ-H.bcmap",
  "vendor/pdfjs/cmaps/90pv-RKSJ-V.bcmap",
  "vendor/pdfjs/cmaps/Add-H.bcmap",
  "vendor/pdfjs/cmaps/Add-RKSJ-H.bcmap",
  "vendor/pdfjs/cmaps/Add-RKSJ-V.bcmap",
  "vendor/pdfjs/cmaps/Add-V.bcmap",
  "vendor/pdfjs/cmaps/Adobe-CNS1-0.bcmap",
  "vendor/pdfjs/cmaps/Adobe-CNS1-1.bcmap",
  "vendor/pdfjs/cmaps/Adobe-CNS1-2.bcmap",
  "vendor/pdfjs/cmaps/Adobe-CNS1-3.bcmap",
  "vendor/pdfjs/cmaps/Adobe-CNS1-4.bcmap",
  "vendor/pdfjs/cmaps/Adobe-CNS1-5.bcmap",
  "vendor/pdfjs/cmaps/Adobe-CNS1-6.bcmap",
  "vendor/pdfjs/cmaps/Adobe-CNS1-UCS2.bcmap",
  "vendor/pdfjs/cmaps/Adobe-GB1-0.bcmap",
  "vendor/pdfjs/cmaps/Adobe-GB1-1.bcmap",
  "vendor/pdfjs/cmaps/Adobe-GB1-2.bcmap",
  "vendor/pdfjs/cmaps/Adobe-GB1-3.bcmap",
  "vendor/pdfjs/cmaps/Adobe-GB1-4.bcmap",
  "vendor/pdfjs/cmaps/Adobe-GB1-5.bcmap",
  "vendor/pdfjs/cmaps/Adobe-GB1-UCS2.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Japan1-0.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Japan1-1.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Japan1-2.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Japan1-3.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Japan1-4.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Japan1-5.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Japan1-6.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Korea1-0.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Korea1-1.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Korea1-2.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Korea1-UCS2.bcmap",
  "vendor/pdfjs/cmaps/B5-H.bcmap",
  "vendor/pdfjs/cmaps/B5-V.bcmap",
  "vendor/pdfjs/cmaps/B5pc-H.bcmap",
  "vendor/pdfjs/cmaps/B5pc-V.bcmap",
  "vendor/pdfjs/cmaps/CNS-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/CNS-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/CNS1-H.bcmap",
  "vendor/pdfjs/cmaps/CNS1-V.bcmap",
  "vendor/pdfjs/cmaps/CNS2-H.bcmap",
  "vendor/pdfjs/cmaps/CNS2-V.bcmap",
  "vendor/pdfjs/cmaps/ETHK-B5-H.bcmap",
  "vendor/pdfjs/cmaps/ETHK-B5-V.bcmap",
  "vendor/pdfjs/cmaps/ETen-B5-H.bcmap",
  "vendor/pdfjs/cmaps/ETen-B5-V.bcmap",
  "vendor/pdfjs/cmaps/ETenms-B5-H.bcmap",
  "vendor/pdfjs/cmaps/ETenms-B5-V.bcmap",
  "vendor/pdfjs/cmaps/EUC-H.bcmap",
  "vendor/pdfjs/cmaps/EUC-V.bcmap",
  "vendor/pdfjs/cmaps/Ext-H.bcmap",
  "vendor/pdfjs/cmaps/Ext-RKSJ-H.bcmap",
  "vendor/pdfjs/cmaps/Ext-RKSJ-V.bcmap",
  "vendor/pdfjs/cmaps/Ext-V.bcmap",
  "vendor/pdfjs/cmaps/GB-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/GB-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/GB-H.bcmap",
  "vendor/pdfjs/cmaps/GB-V.bcmap",
  "vendor/pdfjs/cmaps/GBK-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/GBK-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/GBK2K-H.bcmap",
  "vendor/pdfjs/cmaps/GBK2K-V.bcmap",
  "vendor/pdfjs/cmaps/GBKp-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/GBKp-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/GBT-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/GBT-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/GBT-H.bcmap",
  "vendor/pdfjs/cmaps/GBT-V.bcmap",
  "vendor/pdfjs/cmaps/GBTpc-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/GBTpc-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/GBpc-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/GBpc-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/H.bcmap",
  "vendor/pdfjs/cmaps/HKdla-B5-H.bcmap",
  "vendor/pdfjs/cmaps/HKdla-B5-V.bcmap",
  "vendor/pdfjs/cmaps/HKdlb-B5-H.bcmap",
  "vendor/pdfjs/cmaps/HKdlb-B5-V.bcmap",
  "vendor/pdfjs/cmaps/HKgccs-B5-H.bcmap",
  "vendor/pdfjs/cmaps/HKgccs-B5-V.bcmap",
  "vendor/pdfjs/cmaps/HKm314-B5-H.bcmap",
  "vendor/pdfjs/cmaps/HKm314-B5-V.bcmap",
  "vendor/pdfjs/cmaps/HKm471-B5-H.bcmap",
  "vendor/pdfjs/cmaps/HKm471-B5-V.bcmap",
  "vendor/pdfjs/cmaps/HKscs-B5-H.bcmap",
  "vendor/pdfjs/cmaps/HKscs-B5-V.bcmap",
  "vendor/pdfjs/cmaps/Hankaku.bcmap",
  "vendor/pdfjs/cmaps/Hiragana.bcmap",
  "vendor/pdfjs/cmaps/KSC-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/KSC-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/KSC-H.bcmap",
  "vendor/pdfjs/cmaps/KSC-Johab-H.bcmap",
  "vendor/pdfjs/cmaps/KSC-Johab-V.bcmap",
  "vendor/pdfjs/cmaps/KSC-V.bcmap",
  "vendor/pdfjs/cmaps/KSCms-UHC-H.bcmap",
  "vendor/pdfjs/cmaps/KSCms-UHC-HW-H.bcmap",
  "vendor/pdfjs/cmaps/KSCms-UHC-HW-V.bcmap",
  "vendor/pdfjs/cmaps/KSCms-UHC-V.bcmap",
  "vendor/pdfjs/cmaps/KSCpc-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/KSCpc-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/Katakana.bcmap",
  "vendor/pdfjs/cmaps/NWP-H.bcmap",
  "vendor/pdfjs/cmaps/NWP-V.bcmap",
  "vendor/pdfjs/cmaps/RKSJ-H.bcmap",
  "vendor/pdfjs/cmaps/RKSJ-V.bcmap",
  "vendor/pdfjs/cmaps/Roman.bcmap",
  "vendor/pdfjs/cmaps/UniCNS-UCS2-H.bcmap",
  "vendor/pdfjs/cmaps/UniCNS-UCS2-V.bcmap",
  "vendor/pdfjs/cmaps/UniCNS-UTF16-H.bcmap",
  "vendor/pdfjs/cmaps/UniCNS-UTF16-V.bcmap",
  "vendor/pdfjs/cmaps/UniCNS-UTF32-H.bcmap",
  "vendor/pdfjs/cmaps/UniCNS-UTF32-V.bcmap",
  "vendor/pdfjs/cmaps/UniCNS-UTF8-H.bcmap",
  "vendor/pdfjs/cmaps/UniCNS-UTF8-V.bcmap",
  "vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap",
  "vendor/pdfjs/cmaps/UniGB-UCS2-V.bcmap",
  "vendor/pdfjs/cmaps/UniGB-UTF16-H.bcmap",
  "vendor/pdfjs/cmaps/UniGB-UTF16-V.bcmap",
  "vendor/pdfjs/cmaps/UniGB-UTF32-H.bcmap",
  "vendor/pdfjs/cmaps/UniGB-UTF32-V.bcmap",
  "vendor/pdfjs/cmaps/UniGB-UTF8-H.bcmap",
  "vendor/pdfjs/cmaps/UniGB-UTF8-V.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UCS2-H.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UCS2-HW-H.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UCS2-HW-V.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UCS2-V.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UTF16-H.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UTF16-V.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UTF32-H.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UTF32-V.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UTF8-H.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UTF8-V.bcmap",
  "vendor/pdfjs/cmaps/UniJIS2004-UTF16-H.bcmap",
  "vendor/pdfjs/cmaps/UniJIS2004-UTF16-V.bcmap",
  "vendor/pdfjs/cmaps/UniJIS2004-UTF32-H.bcmap",
  "vendor/pdfjs/cmaps/UniJIS2004-UTF32-V.bcmap",
  "vendor/pdfjs/cmaps/UniJIS2004-UTF8-H.bcmap",
  "vendor/pdfjs/cmaps/UniJIS2004-UTF8-V.bcmap",
  "vendor/pdfjs/cmaps/UniJISPro-UCS2-HW-V.bcmap",
  "vendor/pdfjs/cmaps/UniJISPro-UCS2-V.bcmap",
  "vendor/pdfjs/cmaps/UniJISPro-UTF8-V.bcmap",
  "vendor/pdfjs/cmaps/UniJISX0213-UTF32-H.bcmap",
  "vendor/pdfjs/cmaps/UniJISX0213-UTF32-V.bcmap",
  "vendor/pdfjs/cmaps/UniJISX02132004-UTF32-H.bcmap",
  "vendor/pdfjs/cmaps/UniJISX02132004-UTF32-V.bcmap",
  "vendor/pdfjs/cmaps/UniKS-UCS2-H.bcmap",
  "vendor/pdfjs/cmaps/UniKS-UCS2-V.bcmap",
  "vendor/pdfjs/cmaps/UniKS-UTF16-H.bcmap",
  "vendor/pdfjs/cmaps/UniKS-UTF16-V.bcmap",
  "vendor/pdfjs/cmaps/UniKS-UTF32-H.bcmap",
  "vendor/pdfjs/cmaps/UniKS-UTF32-V.bcmap",
  "vendor/pdfjs/cmaps/UniKS-UTF8-H.bcmap",
  "vendor/pdfjs/cmaps/UniKS-UTF8-V.bcmap",
  "vendor/pdfjs/cmaps/V.bcmap",
  "vendor/pdfjs/cmaps/WP-Symbol.bcmap",
  "vendor/pdfjs/pdf.min.mjs",
  "vendor/pdfjs/pdf.worker.min.mjs",
  "vendor/pdfjs/standard_fonts/FoxitDingbats.pfb",
  "vendor/pdfjs/standard_fonts/FoxitFixed.pfb",
  "vendor/pdfjs/standard_fonts/FoxitFixedBold.pfb",
  "vendor/pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb",
  "vendor/pdfjs/standard_fonts/FoxitFixedItalic.pfb",
  "vendor/pdfjs/standard_fonts/FoxitSerif.pfb",
  "vendor/pdfjs/standard_fonts/FoxitSerifBold.pfb",
  "vendor/pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb",
  "vendor/pdfjs/standard_fonts/FoxitSerifItalic.pfb",
  "vendor/pdfjs/standard_fonts/FoxitSymbol.pfb",
  "vendor/pdfjs/standard_fonts/LICENSE_FOXIT",
  "vendor/pdfjs/standard_fonts/LICENSE_LIBERATION",
  "vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf",
  "vendor/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf",
  "vendor/pdfjs/standard_fonts/LiberationSans-Italic.ttf",
  "vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf",
];
// </precache>

const CACHE = `flexnote-${VERSION}`;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // HTTP 캐시를 거치지 않고 받아서 이전 버전 파일이 섞이지 않게 한다
    await c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })));
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('flexnote-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // 페이지 이동(앱 실행)은 항상 캐시된 index.html — 주소 뒤 ?쿼리 가 붙어도 동일
    if (req.mode === 'navigate') {
      const hit = (await cache.match('./')) || (await cache.match('index.html'));
      if (hit) return hit;
      return fetch(req);
    }
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    // 목록에 없는 파일: 네트워크 (3초 넘으면 실패 처리해 화면이 멈춘 것처럼 보이지 않게)
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    try { return await fetch(req, { signal: ctl.signal }); }
    finally { clearTimeout(timer); }
  })());
});
