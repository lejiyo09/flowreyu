const h = require('./harness');
(async () => {
  const { browser, page, cdp, logs } = await h.launch();
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  // 저장 실패 시뮬레이션: pages 저장 put 을 QuotaExceededError 로 실패시킴
  await page.evaluate(() => {
    window.__orig = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...a) { if (this.name === 'pages') throw new DOMException('quota', 'QuotaExceededError'); return __orig.apply(this, a); };
  });
  await h.pen(cdp, h.line(300, 300, 500, 350, 10));
  await page.waitForTimeout(1200);
  const st1 = await page.locator('#saveState').getAttribute('data-state');
  const toast = await page.locator('#toast').textContent();
  console.log('during failure:', st1, '| toast:', toast);
  await page.evaluate(() => { IDBObjectStore.prototype.put = __orig; });
  await page.waitForTimeout(4500); // 재시도 대기 (2s backoff)
  console.log('after recovery:', await page.locator('#saveState').getAttribute('data-state'));
  await page.reload(); await page.waitForSelector('#editor:not([hidden])'); await page.waitForTimeout(800);
  console.log('items after reload:', await page.evaluate(() => __flexnote.state.doc.totalItems()));
  // 손상 데이터 주입
  await page.evaluate(async () => {
    const id = __flexnote.state.doc.id;
    await new Promise((res) => { const r = indexedDB.open('flexnote'); r.onsuccess = () => { const tx = r.result.transaction('pages', 'readwrite'); tx.objectStore('pages').put({ docId: id, page: 2, items: [{ t: 's', pts: [1, 2] }, { t: 's', id: 'ok', c: '#000000', w: 2, pts: [10, 10, .5, 50, 50, .5] }, null, { t: 'zzz' }] }); tx.oncomplete = res; }; });
  });
  await page.reload(); await page.waitForSelector('#editor:not([hidden])'); await page.waitForTimeout(800);
  console.log('corrupt: items p2 =', await page.evaluate(() => __flexnote.state.doc.items(2).length), '| toast:', await page.locator('#toast').textContent());
  console.log(logs.filter(l => /pageerror/.test(l)).join('\n'));
  await browser.close();
})();
