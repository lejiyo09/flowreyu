// 링크 테스트: PDF 내부/웹 링크(손가락 탭), 사용자 링크 도구, 돌아가기, 내보내기 주석, 페이지 추가 시 대상 이동
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, context, page, cdp, logs } = await h.launch();
  page.on('dialog', (d) => d.accept());
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  await page.setInputFiles('#fileInput', h.S + '/links.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const cur = () => page.evaluate(() => __flexnote.viewer.currentPage());
  const tapPage = async (pg, x, y) => {
    const s = await page.evaluate(([pg, x, y]) => { const v = __flexnote.viewer; const r = v.el.getBoundingClientRect(); const p = v.pageToScreen(pg, x, y); return { x: p.x + r.left, y: p.y + r.top }; }, [pg, x, y]);
    await h.touch(cdp, 'touchStart', [[s.x, s.y, 1]]);
    await h.touch(cdp, 'touchEnd', [[s.x, s.y, 1]]);
    await page.waitForTimeout(400);
    return s;
  };
  // PDF 좌표 (60,700) 근처 → 페이지 좌표 y = 842 - 705
  await tapPage(0, 120, 842 - 705);
  check('finger tap on PDF internal link → page 3', (await cur()) === 2, `cur=${await cur()}`);
  check('back chip shown', await page.locator('#backChip').isVisible());
  await page.click('#backChip');
  await page.waitForTimeout(300);
  check('back chip returns to page 1', (await cur()) === 0 && !(await page.locator('#backChip').isVisible()));
  // 웹 링크
  await page.evaluate(() => { window.open = (u) => { window.__opened = u; return null; }; });
  await tapPage(0, 120, 842 - 645);
  const opened = await page.evaluate(() => window.__opened);
  check('finger tap on PDF web link → opens URL (after confirm)', opened === 'https://example.com/', opened);
  // 펜 탭은 링크를 따라가지 않음 (필기)
  const vp = await page.locator('#viewport').boundingBox();
  const s1 = await page.evaluate(() => { const v = __flexnote.viewer; return v.pageToScreen(0, 120, 842 - 705); });
  await h.pen(cdp, [[vp.x + s1.x, vp.y + s1.y, 0.5]]);
  await page.waitForTimeout(400);
  check('pen tap on link draws, does not navigate', (await cur()) === 0 && (await page.evaluate(() => __flexnote.state.doc.totalItems())) === 1);
  // 사용자 링크 만들기: 링크 도구로 사각형 → 4쪽
  await page.evaluate(() => __flexnote.settings.set('tool', 'link'));
  const a = await page.evaluate(() => __flexnote.viewer.pageToScreen(0, 300, 230)), b = await page.evaluate(() => __flexnote.viewer.pageToScreen(0, 450, 290));
  await h.pen(cdp, h.line(vp.x + a.x, vp.y + a.y, vp.x + b.x, vp.y + b.y, 8));
  await page.waitForSelector('#linkDlg[open]');
  await page.click('#lnKind button[value=page]');
  await page.fill('#lnPage', '4');
  await page.click('#linkDlg button[value=ok]');
  await page.waitForTimeout(400); // 펜을 뗀 직후 터치 무시(팜 리젝션) 시간 이후
  const ln = await page.evaluate(() => __flexnote.state.doc.items(0).find((i) => i.t === 'ln'));
  check('link tool creates link item → page 4', ln && ln.to.page === 3, JSON.stringify(ln?.to));
  await page.evaluate(() => { window.__tr = []; __flexnote.input.onTrace = (m) => __tr.push(m); window.__tapLog = []; const orig = __flexnote.input.app.tap; __flexnote.input.app.tap = (x, y) => { __tapLog.push([x, y]); return orig(x, y); }; });
  await tapPage(0, 370, 260);
  if ((await cur()) !== 3) console.log('DEBUG', JSON.stringify(await page.evaluate(() => ({ tr: __tr, taps: __tapLog, st: __flexnote.input.stateText(), dlgOpen: document.querySelector('#linkDlg').open, active: document.activeElement?.id, el: (() => { const v = __flexnote.viewer; const r = v.el.getBoundingClientRect(); const p = v.pageToScreen(0, 370, 430); const e = document.elementFromPoint(p.x + r.left, p.y + r.top); return e && (e.id || e.className || e.tagName) + ' ui=' + !!e.closest('[data-ui]'); })() }))));
  check('finger tap on user link → page 4', (await cur()) === 3);
  await page.click('#backChip');
  await page.waitForTimeout(300);
  // 링크 도구로 탭 → 편집 → URL 로 변경
  await h.pen(cdp, [[vp.x + (a.x + b.x) / 2, vp.y + (a.y + b.y) / 2, 0.5]]);
  await page.waitForSelector('#linkDlg[open]');
  check('pen tap with link tool opens existing link', (await page.inputValue('#lnPage')) === '4');
  await page.click('#lnKind button[value=url]');
  await page.fill('#lnUrl', 'example.org/docs');
  await page.click('#linkDlg button[value=ok]');
  await page.waitForTimeout(300);
  check('edit link to URL (https added)', (await page.evaluate(() => __flexnote.state.doc.items(0).find((i) => i.t === 'ln').to.url)) === 'https://example.org/docs');
  // 다시 페이지 링크로 바꾸고, 앞에 페이지를 추가하면 대상이 밀림
  await h.pen(cdp, [[vp.x + (a.x + b.x) / 2, vp.y + (a.y + b.y) / 2, 0.5]]);
  await page.waitForSelector('#linkDlg[open]');
  await page.click('#lnKind button[value=page]');
  await page.fill('#lnPage', '4');
  await page.click('#linkDlg button[value=ok]');
  await page.evaluate(() => __flexnote.viewer.goToPage(1));
  await page.waitForTimeout(300);
  await page.click('#btnThumbs');
  await page.click('#btnAddPage');
  await page.selectOption('#apWhere', 'before');
  await page.click('#addPageDlg button[value=ok]');
  await page.waitForFunction(() => __flexnote.viewer.pages.length === 6, null, { timeout: 15000 });
  check('page insert shifts link target 4→5', (await page.evaluate(() => __flexnote.state.doc.items(0).find((i) => i.t === 'ln').to.page)) === 4);
  // 내보내기에 링크 주석 포함
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  await dl.saveAs(h.S + '/links-export.pdf');
  const { PDFDocument, PDFName } = require('pdf-lib');
  const out = await PDFDocument.load(require('fs').readFileSync(h.S + '/links-export.pdf'));
  const annots = out.getPage(0).node.lookup(PDFName.of('Annots'));
  const n = annots ? annots.size() : 0;
  check('export keeps PDF links + adds user link annotation', n === 3, `annots=${n}`);
  console.log(results.join('\n'));
  const errs = logs.filter((l) => /pageerror|\[error\]/.test(l));
  if (errs.length) console.log(errs.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1); });
