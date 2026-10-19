// 필기 렌더링 비용 측정: 한 페이지에 획 1500개(필압, 120점)를 넣고 drawInk 시간과 팬 프레임 측정
const h = require('./harness');
(async () => {
  const { browser, page, cdp } = await h.launch({ viewport: { width: 1280, height: 800 }, dpr: 2 });
  await page.goto((process.env.APP_URL || 'http://localhost:8080/') + (process.env.Q || ''));
  await page.waitForTimeout(500);
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const r = await page.evaluate(async () => {
    const { state, viewer } = __flexnote;
    const items = [];
    let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const N = +(new URLSearchParams(location.search).get('n') || 400), P = +(new URLSearchParams(location.search).get('p') || 60);
    for (let s = 0; s < N; s++) {
      const pts = []; let x = rnd() * 500 + 40, y = rnd() * 760 + 40;
      let pr = 0.5; for (let i = 0; i < P; i++) { x += (rnd() - 0.5) * 3 + 0.9; y += Math.sin(i / 5) * 1.4; pr = Math.min(0.95, Math.max(0.25, pr + (rnd() - 0.5) * 0.06)); pts.push(+x.toFixed(2), +y.toFixed(2), +pr.toFixed(3)); }
      items.push({ id: 's' + s, t: 's', tool: 'pen', c: '#222222', w: 1.5 + (s % 4) * 1.5, pr: true, pts });
    }
    state.doc.setItems(0, items);
    viewer.drawInk(); // 캐시 생성
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) { viewer.drawInk(); viewer.inkCtx.getImageData(0, 0, 1, 1); }
    const draw = (performance.now() - t0) / 20;
    // 첫 그리기(경로 생성 포함)
    const fresh = items.map((it) => ({ ...it }));
    state.doc.setItems(0, fresh);
    const t1 = performance.now(); viewer.drawInk(); viewer.inkCtx.getImageData(0, 0, 1, 1); const first = performance.now() - t1;
    return { drawMs: draw.toFixed(1), firstDrawMs: first.toFixed(1) };
  });
  console.log(JSON.stringify(r));
  await browser.close();
})();
