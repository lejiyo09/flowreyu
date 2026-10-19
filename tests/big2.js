const h = require('./harness');
(async () => {
  const { browser, page, cdp } = await h.launch({ viewport: { width: 1280, height: 800 }, dpr: 2 });
  await page.goto('http://localhost:8080/');
  await page.waitForTimeout(500);
  await page.setInputFiles('#fileInput', h.S + '/big.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(2500);
  await page.evaluate(() => { window.LT = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) LT.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); });
  for (const mode of ['idle-pen', 'render-only', 'pen-during-render']) {
    await page.evaluate(() => { __flexnote.viewer.goToPage(Math.floor(Math.random()*250)+20); });
    if (mode === 'idle-pen') await page.waitForTimeout(4000);
    await page.evaluate(() => { LT.length = 0; window.GAP = []; window.last = 0; if (!window.hooked) { window.hooked = 1; document.getElementById('viewport').addEventListener('pointermove', e => { const n = performance.now(); if (last) GAP.push(n - last); last = n; }); } });
    if (mode === 'render-only') await page.waitForTimeout(2500);
    else await h.pen(cdp, h.line(300, 300, 900, 500, 120));
    const r = await page.evaluate(() => ({ LT: LT.slice(), maxGap: GAP.length ? Math.max(...GAP).toFixed(0) : '-', med: GAP.length ? GAP.sort((a,b)=>a-b)[GAP.length>>1].toFixed(1) : '-' }));
    console.log(mode, JSON.stringify(r));
    await page.waitForTimeout(3000);
  }
  await browser.close();
})();
