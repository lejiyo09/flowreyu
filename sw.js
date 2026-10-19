// 서비스 워커: 오프라인 실행용 캐시 (네트워크 우선 → 실패 시 캐시)
// 네트워크 우선이라 코드 업데이트가 바로 반영되고, 오프라인일 때만 캐시를 쓴다.
const CACHE = 'flexnote-v1';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg',
  'js/main.js', 'js/util.js', 'js/settings.js', 'js/store.js', 'js/ink.js', 'js/document.js',
  'js/viewer.js', 'js/input.js', 'js/tools.js', 'js/thumbs.js', 'js/debug.js', 'js/export.js',
  'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs', 'vendor/pdf-lib/pdf-lib.esm.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
