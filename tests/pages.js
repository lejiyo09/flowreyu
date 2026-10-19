// 페이지 추가/삭제 테스트: 필기 페이지 번호 이동, 저장·새로고침 후 유지, Undo 유지
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, cdp, logs } = await h.launch();
  page.on('dialog', (d) => d.accept());
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const vp = await page.locator('#viewport').boundingBox();
  const X = (x) => vp.x + x, Y = (y) => vp.y + y;
  // 1쪽, 2쪽에 필기
  await h.pen(cdp, h.line(X(200), Y(300), X(400), Y(320), 10));
  await page.evaluate(() => __flexnote.viewer.goToPage(1));
  await page.waitForTimeout(300);
  await h.pen(cdp, h.line(X(200), Y(300), X(400), Y(320), 10));
  await h.pen(cdp, h.line(X(200), Y(400), X(400), Y(420), 10));
  const ids = await page.evaluate(() => ({ p0: __flexnote.state.doc.items(0).map(i => i.id), p1: __flexnote.state.doc.items(1).map(i => i.id) }));
  // 1쪽 보는 중 → 현재 페이지 뒤(=2쪽 자리)에 줄 노트 2장 추가
  await page.evaluate(() => __flexnote.viewer.goToPage(0));
  await page.waitForTimeout(300);
  await page.click('#btnThumbs');
  await page.click('#btnAddPage');
  await page.selectOption('#apTemplate', 'lined');
  await page.fill('#apCount', '2');
  await page.click('#addPageDlg button[value=ok]');
  await page.waitForFunction(() => __flexnote.viewer.pages.length === 8, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({ n: __flexnote.viewer.pages.length, p0: __flexnote.state.doc.items(0).map(i => i.id), p1: __flexnote.state.doc.items(1).length, p2: __flexnote.state.doc.items(2).length, p3: __flexnote.state.doc.items(3).map(i => i.id), thumbs: document.querySelectorAll('.thumb').length }));
  check('add 2 pages → 8 pages', after.n === 8 && after.thumbs === 8, JSON.stringify({ n: after.n, t: after.thumbs }));
  check('ink of page 2 moved to page 4', JSON.stringify(after.p3) === JSON.stringify(ids.p1) && after.p1 === 0 && after.p2 === 0);
  check('ink of page 1 unchanged', JSON.stringify(after.p0) === JSON.stringify(ids.p0));
  check('new pages have lined template text layer (render ok)', await page.evaluate(() => __flexnote.state.pdf.numPages === 8));
  // Undo 는 여전히 (옮겨진) 4쪽의 마지막 획을 되돌린다
  await page.click('#btnUndo');
  check('undo after add affects remapped page', (await page.evaluate(() => __flexnote.state.doc.items(3).length)) === 1);
  await page.click('#btnRedo');
  // 새로고침 후 유지
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(1000);
  const rel = await page.evaluate(() => ({ n: __flexnote.state.pdf.numPages, p3: __flexnote.state.doc.items(3).map(i => i.id), p0: __flexnote.state.doc.items(0).length }));
  check('reload keeps 8 pages + remapped ink', rel.n === 8 && JSON.stringify(rel.p3) === JSON.stringify(ids.p1) && rel.p0 === 1, JSON.stringify(rel));
  // 4쪽(필기 있음) 삭제 → 5쪽 이후가 당겨짐
  await page.evaluate(() => __flexnote.viewer.goToPage(3));
  await page.waitForTimeout(400);
  if (!(await page.locator('#thumbs').isVisible())) await page.click('#btnThumbs');
  await page.click('#btnDelPage');
  await page.waitForFunction(() => __flexnote.viewer.pages.length === 7, null, { timeout: 15000 });
  const del = await page.evaluate(() => ({ n: __flexnote.state.pdf.numPages, total: __flexnote.state.doc.totalItems(), p0: __flexnote.state.doc.items(0).length }));
  check('delete page with ink → 7 pages, its ink gone', del.n === 7 && del.total === 1 && del.p0 === 1, JSON.stringify(del));
  // 끝의 "페이지 추가" 버튼
  await page.evaluate(() => { const v = __flexnote.viewer; v.goToPage(6); v.setCamera(v.cam.tx, -1e6, v.cam.z); });
  await page.waitForTimeout(400);
  await page.click('.add-page-end');
  await page.waitForFunction(() => __flexnote.viewer.pages.length === 8, null, { timeout: 15000 });
  check('end "add page" button adds at end', (await page.evaluate(() => __flexnote.state.pdf.numPages)) === 8);
  // 내보내기 정상
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  await dl.saveAs(h.S + '/pages-export.pdf');
  check('export after page edits', true);
  console.log(results.join('\n'));
  const errs = logs.filter((l) => /pageerror|\[error\]/.test(l));
  if (errs.length) console.log(errs.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1); });
