// PDF 여러 개 한 번에 열기(탭), 탭 전환·닫기·새로고침 유지, 다른 PDF 페이지 끼워 넣기, 위쪽 + 로 페이지 추가
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, cdp, logs } = await h.launch();
  page.on('dialog', (d) => d.accept());
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  await page.evaluate(async () => { for (const d of await __flexnote.store.listDocs()) await __flexnote.store.deleteDoc(d.id); await __flexnote.store.kvSet('tabs', []); });
  await page.reload();
  await page.waitForTimeout(500);
  const pages = () => page.evaluate(() => __flexnote.viewer.pages.length);
  const tabNames = () => page.$$eval('#tabBar .tab .tab-name', (e) => e.map((x) => x.textContent));
  const current = () => page.evaluate(() => __flexnote.state.doc?.meta.name);

  // 여러 개 한 번에
  await page.setInputFiles('#fileInput', [h.S + '/sample.pdf', h.S + '/links.pdf']);
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(1000);
  check('picking two PDFs opens both as tabs, shows the first', JSON.stringify(await tabNames()) === '["sample","links"]' && (await current()) === 'sample' && (await pages()) === 6, JSON.stringify(await tabNames()));
  check('tab bar visible with the current tab marked', await page.locator('#tabBar').isVisible() && (await page.textContent('#tabBar .tab.on .tab-name')) === 'sample');
  // 필기 → 다른 탭 → 돌아오기
  const vp = await page.locator('#viewport').boundingBox();
  await h.pen(cdp, h.line(vp.x + 200, vp.y + 300, vp.x + 400, vp.y + 320, 10));
  await page.waitForTimeout(200);
  await page.click('#tabBar .tab:nth-child(2)');
  await page.waitForTimeout(800);
  check('switching tab opens the other PDF', (await current()) === 'links' && (await pages()) === 5);
  await page.click('#tabBar .tab:nth-child(1)');
  await page.waitForTimeout(600);
  check('back to the first tab: ink was saved', (await current()) === 'sample' && (await page.evaluate(() => __flexnote.state.doc.items(0).length)) === 1);
  // 새로고침해도 탭 유지
  await page.waitForTimeout(800);
  await page.reload();
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  check('tabs survive reload', JSON.stringify(await tabNames()) === '["sample","links"]' && (await current()) === 'sample');

  // 위쪽 + → 빈 페이지 1장
  await page.click('#btnAddPageTop');
  await page.waitForSelector('#addPageDlg[open]');
  check('top-bar + opens the add-page dialog', true);
  await page.selectOption('#apWhere', 'end');
  await page.click('#apOk');
  await page.waitForTimeout(1500);
  check('blank page added at the end', (await pages()) === 7);
  // 다른 PDF 페이지 끼워 넣기: 1쪽 뒤에 links.pdf(5쪽)
  await page.evaluate(() => { __flexnote.viewer.goToPage(0); __flexnote.state.doc.add(3, { id: 'p4', t: 's', tool: 'pen', c: '#111111', w: 3, pr: false, pts: [100, 100, 0.5, 200, 120, 0.5] }); });
  await page.waitForTimeout(400);
  await page.click('#btnAddPageTop');
  await page.waitForSelector('#addPageDlg[open]');
  await page.selectOption('#apSource', 'pdf');
  check('PDF option hides blank-page fields', await page.locator('#apTemplateRow').isHidden() && await page.locator('#apCountRow').isHidden() && (await page.textContent('#apOk')).includes('PDF'));
  await page.selectOption('#apWhere', 'after');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#apOk')]);
  await chooser.setFiles(h.S + '/links.pdf');
  await page.waitForFunction(() => __flexnote.viewer.pages.length === 12, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  check('inserting links.pdf adds its 5 pages after page 1', (await pages()) === 12, await pages());
  const ink = await page.evaluate(() => ({ p0: __flexnote.state.doc.items(0).length, p3: __flexnote.state.doc.items(3).length, p8: __flexnote.state.doc.items(8).some((i) => i.id === 'p4') }));
  check('existing ink stays on its own page (page 4 → 9)', ink.p0 === 1 && ink.p3 === 0 && ink.p8, JSON.stringify(ink));
  // 끼워 넣은 페이지에 원본 글자가 있음 (검색으로 확인)
  await page.keyboard.press('Control+f');
  await page.fill('#searchInput', 'Link Page 1');
  await page.waitForTimeout(1500);
  check('inserted pages keep their real text (searchable)', /\/ 1$/.test(await page.textContent('#searchCount')) && (await page.evaluate(() => __flexnote.viewer.currentPage())) === 1, await page.textContent('#searchCount'));
  await page.keyboard.press('Escape');

  // 탭 닫기 → 옆 탭, 하나만 남으면 탭 줄 숨김
  await page.click('#tabBar .tab.on .tab-x');
  await page.waitForTimeout(800);
  check('closing the current tab switches to the next one', (await current()) === 'links' && await page.locator('#tabBar').isHidden());
  // 홈에서 다른 노트 열면 탭 추가, 노트 삭제하면 탭도 빠짐
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  await page.click('.doc-card:has-text("sample") .cover');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  check('opening another note from home adds a tab', JSON.stringify(await tabNames()) === '["links","sample"]', JSON.stringify(await tabNames()));
  // 글라스 모드: 탭 줄도 흐린 유리 (페이지 글자가 탭 뒤로 비쳐 읽히지 않게), 페이지는 탭 줄 아래에서 시작
  await page.evaluate(() => __flexnote.settings.set('glass', true));
  await page.waitForTimeout(400);
  const gl = await page.evaluate(() => { const b = document.querySelector('#tabBar'), cs = getComputedStyle(b); return { blur: (cs.backdropFilter || cs.webkitBackdropFilter || '').includes('blur'), bottom: b.getBoundingClientRect().bottom, inset: __flexnote.viewer.insetTop, vpTop: document.querySelector('#viewport').getBoundingClientRect().top }; });
  check('glass mode: tab bar is frosted and pages start below it', gl.blur && Math.abs(gl.vpTop + gl.inset - gl.bottom) < 2, JSON.stringify(gl));
  await page.evaluate(() => __flexnote.settings.set('glass', false));
  await page.waitForTimeout(300);
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  await page.click('.doc-card:has-text("links")', { button: 'right' });
  await page.click('.card-menu [data-a=del]');
  await page.waitForTimeout(500);
  check('deleting a note removes its tab', JSON.stringify(await page.evaluate(() => __flexnote.store.kvGet('tabs').then((t) => t.map((x) => x.name)))) === '["sample"]');
  // 홈에 여러 개 끌어 놓기
  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
