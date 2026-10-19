// 오프라인 실행 테스트: 첫 접속에서 캐시 → 네트워크 차단 후 새로고침해도 앱·문서·필기가 열리는지
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, context, page, cdp, logs } = await h.launch();
  const url = process.env.APP_URL || 'http://localhost:8080/';
  await page.goto(url);
  // 서비스 워커 설치 + 사전 캐시 완료 대기
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return !!(reg && reg.active && navigator.serviceWorker.controller);
  }, null, { timeout: 30000 }).catch(() => {});
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) { await page.reload(); await page.waitForTimeout(1000); }
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys(); const c = await caches.open(keys.find((k) => k.startsWith('flexnote-')));
    const reqs = await c.keys(); return { n: reqs.length, worker: reqs.some((r) => r.url.endsWith('pdf.worker.min.mjs')), cmap: reqs.some((r) => r.url.includes('/cmaps/')) };
  });
  check('precache complete (worker + cmaps)', cached.n > 200 && cached.worker && cached.cmap, JSON.stringify(cached));
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const vp = await page.locator('#viewport').boundingBox();
  await h.pen(cdp, h.line(vp.x + 200, vp.y + 300, vp.x + 400, vp.y + 320, 10));
  await page.waitForTimeout(1200);
  // 완전 오프라인
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('#editor:not([hidden])', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => ({ editor: !document.querySelector('#editor').hidden, items: window.__flexnote?.state.doc?.totalItems(), rendered: window.__flexnote?.viewer.pages.filter((p) => p.base).length, online: navigator.onLine }));
  check('offline relaunch opens last doc with ink', st.editor && st.items === 1 && !st.online, JSON.stringify(st));
  check('offline: PDF pages render (worker from cache)', st.rendered >= 1);
  // 오프라인에서 필기 + 저장
  await h.pen(cdp, h.line(vp.x + 200, vp.y + 400, vp.x + 400, vp.y + 420, 10));
  await page.waitForTimeout(1200);
  check('offline: writing autosaves', (await page.locator('#saveState').getAttribute('data-state')) === 'saved');
  // 오프라인에서 새 노트 만들기 (pdf-lib 동적 import 도 캐시에서)
  await page.click('#btnBack');
  await page.click('#btnNewNote');
  await page.click('#nnOk');
  await page.waitForFunction(() => window.__flexnote.state.pdf?.numPages === 20, null, { timeout: 15000 }).catch(() => {});
  check('offline: new note (lazy export.js) works', (await page.evaluate(() => window.__flexnote.state.pdf?.numPages)) === 20);
  // 주소에 쿼리가 붙어도 실행
  await page.goto(url + '?from=homescreen');
  await page.waitForSelector('#editor:not([hidden])', { timeout: 15000 }).catch(() => {});
  check('offline: launch URL with query works', await page.locator('#editor').isVisible());
  await context.setOffline(false);
  console.log(results.join('\n'));
  const errs = logs.filter((l) => /pageerror/.test(l));
  if (errs.length) console.log(errs.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1); });
