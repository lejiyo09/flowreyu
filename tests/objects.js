// 그림 첨부·포스트잇·지우개 보호 테스트
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
  const items = (t) => page.evaluate((t) => __flexnote.state.doc.items(0).filter((i) => !t || i.t === t), t);
  const pix = (sx, sy) => page.evaluate(([x, y]) => { const v = __flexnote.viewer; const d = v.dpr; return [...v.inkCtx.getImageData(Math.round(x * d), Math.round(y * d), 1, 1).data]; }, [sx, sy]);
  const toScreen = (x, y) => page.evaluate(([x, y]) => __flexnote.viewer.pageToScreen(0, x, y), [x, y]);

  // 1) 링크는 지우개로 지워지지 않음
  await page.evaluate(() => __flexnote.state.doc.add(0, { id: 'ln1', t: 'ln', x: 100, y: 100, w: 120, h: 40, to: { page: 2 } }));
  const l = await toScreen(160, 120);
  await page.click('#toolbar [data-tool=eraser]');
  await h.pen(cdp, h.line(X(l.x - 80), Y(l.y), X(l.x + 80), Y(l.y), 8));
  check('eraser does not erase links', (await items('ln')).length === 1);

  // 2) 그림 넣기 (파일 선택)
  await page.setInputFiles('#imageInput', h.S + '/img.png');
  await page.waitForFunction(() => __flexnote.state.doc.items(0).some((i) => i.t === 'im') || __flexnote.state.doc.items(__flexnote.viewer.currentPage()).some((i) => i.t === 'im'), null, { timeout: 10000 });
  const pg = await page.evaluate(() => { for (const [p, it] of __flexnote.state.doc.pages) if (it.some((i) => i.t === 'im')) return p; });
  const im = (await page.evaluate((pg) => __flexnote.state.doc.items(pg).find((i) => i.t === 'im'), pg));
  check('image inserted with 2:1 aspect', im && Math.abs(im.w / im.h - 2) < 0.01, JSON.stringify(im && { w: im.w, h: im.h }));
  check('inserted image is selected with lasso', (await page.evaluate(() => __flexnote.settings.get('tool'))) === 'lasso' && (await page.locator('#selBox').isVisible()));
  const blobRec = await page.evaluate((id) => new Promise((res) => { const r = indexedDB.open('flexnote'); r.onsuccess = () => { const q = r.result.transaction('blobs').objectStore('blobs').get(id); q.onsuccess = () => res(q.result ? { w: q.result.w, type: q.result.data.type } : null); }; }), im.blob);
  check('image stored separately in blobs store', blobRec && blobRec.w === 400 && blobRec.type === 'image/png', JSON.stringify(blobRec));
  await page.waitForTimeout(300);
  let c = await page.evaluate(([pg, x, y]) => __flexnote.viewer.pageToScreen(pg, x, y), [pg, im.x + im.w * 0.25, im.y + im.h / 2]);
  let px = await pix(c.x, c.y);
  check('image renders (red half visible)', px[0] > 200 && px[1] < 80 && px[3] > 200, JSON.stringify(px));
  // 올가미로 옮기기
  const mid = await page.evaluate(([pg, x, y]) => __flexnote.viewer.pageToScreen(pg, x, y), [pg, im.x + im.w / 2, im.y + im.h / 2]);
  await h.pen(cdp, h.line(X(mid.x), Y(mid.y), X(mid.x + 60), Y(mid.y + 40), 8));
  const im2 = await page.evaluate((pg) => __flexnote.state.doc.items(pg).find((i) => i.t === 'im'), pg);
  const z = await page.evaluate(() => __flexnote.viewer.cam.z);
  check('lasso drag moves image', Math.abs((im2.x - im.x) * z - 60) < 2 && Math.abs((im2.y - im.y) * z - 40) < 2);
  // 지우개로 안 지워짐
  await page.click('#toolbar [data-tool=eraser]');
  c = await page.evaluate(([pg, x, y]) => __flexnote.viewer.pageToScreen(pg, x, y), [pg, im2.x + im2.w / 2, im2.y + im2.h / 2]);
  await h.pen(cdp, h.line(X(c.x - 100), Y(c.y), X(c.x + 100), Y(c.y), 10));
  check('eraser does not erase images', (await page.evaluate((pg) => __flexnote.state.doc.items(pg).filter((i) => i.t === 'im').length, pg)) === 1);

  // 3) 새로고침 후 그림 다시 그려짐 (blobs 에서 읽기)
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(1500);
  c = await page.evaluate(([pg, x, y]) => __flexnote.viewer.pageToScreen(pg, x, y), [pg, im2.x + im2.w * 0.75, im2.y + im2.h / 2]);
  px = await pix(c.x, c.y);
  check('after reload image loads from storage (blue half)', px[2] > 180 && px[0] < 80, JSON.stringify(px));

  // 4) 붙여넣기로 그림 넣기
  const n0 = await page.evaluate(() => { let n = 0; for (const it of __flexnote.state.doc.pages.values()) n += it.filter((i) => i.t === 'im').length; return n; });
  const b64 = require('fs').readFileSync(h.S + '/img.png').toString('base64');
  await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'p.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, b64);
  await page.waitForTimeout(800);
  const n1 = await page.evaluate(() => { let n = 0; for (const it of __flexnote.state.doc.pages.values()) n += it.filter((i) => i.t === 'im').length; return n; });
  check('paste (Ctrl+V) inserts image', n1 === n0 + 1, `${n0}→${n1}`);

  // 5) 포스트잇
  await page.evaluate(() => { __flexnote.tools.clearSelection(); __flexnote.viewer.goToPage(0); });
  await page.click('#toolbar [data-tool=pen]');
  await page.click('#btnNote');
  await page.waitForTimeout(150);
  check('sticky note opens editor immediately', await page.locator('#textEditor.note-editor').isVisible());
  await page.keyboard.type('회의 메모: 다음주까지 3장 정리하기');
  await page.keyboard.press('Escape');
  const nt = (await items('nt'))[0];
  check('sticky note saved with text', nt && nt.text.startsWith('회의 메모') && nt.c === '#fff59d', JSON.stringify(nt && { text: nt.text, c: nt.c }));
  // 노트 위에 펜 필기 (노트 위에 그려짐)
  const ns = await toScreen(nt.x + nt.w / 2, nt.y + nt.h * 0.75);
  const sBefore = (await items('s')).length;
  await h.pen(cdp, h.line(X(ns.x - 30), Y(ns.y), X(ns.x + 30), Y(ns.y), 10));
  check('pen writes on top of sticky note', (await items('s')).length === sBefore + 1);
  // 텍스트 도구로 탭하면 편집
  await page.click('#toolbar [data-tool=text]');
  const nt2 = await toScreen(nt.x + nt.w / 2, nt.y + 20);
  await h.pen(cdp, [[X(nt2.x), Y(nt2.y), 0.5]]);
  await page.waitForTimeout(150);
  check('text tool tap on note edits its text', (await page.locator('#textEditor.note-editor').isVisible()) && (await page.inputValue('#textEditor')).startsWith('회의 메모'));
  await page.keyboard.press('Escape');
  // 올가미로 선택 → 포스트잇 색 바꾸기
  await page.click('#toolbar [data-tool=lasso]');
  await page.waitForTimeout(400); // 직전 텍스트 도구 탭과 겹쳐 "펜 두 번 탭"으로 인식되지 않도록
  await h.pen(cdp, [[X(nt2.x), Y(nt2.y), 0.5]]);
  await page.waitForTimeout(150);
  if (!(await page.locator('#selMenu [data-sel=edit]').isVisible())) console.log('DEBUG', JSON.stringify(await page.evaluate(() => ({ sel: __flexnote.tools.selection && [...__flexnote.tools.selection.ids], tool: __flexnote.settings.get('tool'), menuHidden: document.querySelector('#selMenu').hidden, editHidden: document.querySelector('[data-sel=edit]').hidden, items: __flexnote.state.doc.items(0).map((i) => i.t + ':' + i.id), editing: !document.querySelector('#textEditor').hidden }))));
  check('selection menu shows "edit" for single note', await page.locator('#selMenu [data-sel=edit]').isVisible());
  await page.locator('#selMenu .sel-colors .swatch').nth(2).click();
  const inkColor0 = (await items('s')).at(-1).c;
  check('note recolored with note palette', (await items('nt'))[0].c === '#f8bbd0', (await items('nt'))[0].c);
  check('ink written on the note keeps its pen color', (await items('s')).at(-1).c === inkColor0);
  // 지우개로 안 지워짐 (노트 위 필기는 지워짐)
  await page.keyboard.press('Escape');
  await page.click('#toolbar [data-tool=eraser]');
  await h.pen(cdp, h.line(X(ns.x), Y(ns.y - 40), X(ns.x), Y(ns.y + 20), 8));
  check('eraser removes ink on note but keeps the note', (await items('nt')).length === 1 && (await items('s')).length === sBefore);

  // 6) 내보내기: 그림·포스트잇이 PDF 이미지로 들어감
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  await dl.saveAs(h.S + '/objects-export.pdf');
  const { PDFDocument, PDFName, PDFDict } = require('pdf-lib');
  const out = await PDFDocument.load(require('fs').readFileSync(h.S + '/objects-export.pdf'));
  let xobjs = 0;
  for (const p of out.getPages()) { const res = p.node.Resources(); const xo = res && res.lookup(PDFName.of('XObject'), PDFDict); if (xo) xobjs += xo.keys().length; }
  check('export embeds images + note', xobjs >= 3, `xobjects=${xobjs}`);

  // 7) 백업에 그림 포함
  await page.click('#btnSettings');
  const [bk] = await Promise.all([page.waitForEvent('download'), page.click('#btnBackupExport')]);
  await bk.saveAs(h.S + '/backup.json');
  const bj = JSON.parse(require('fs').readFileSync(h.S + '/backup.json', 'utf8'));
  check('backup includes image data', Object.values(bj.images || {}).length >= 2 && Object.values(bj.images)[0].data.startsWith('data:image/png'));
  await page.keyboard.press('Escape');

  // 8) 문서 삭제 시 그림도 삭제
  const docId = await page.evaluate(() => __flexnote.state.doc.id);
  await page.click('#btnBack');
  await page.waitForTimeout(500);
  await page.click('.doc-card .more');
  await page.click('.card-menu [data-a=del]');
  await page.waitForTimeout(800);
  const left = await page.evaluate((id) => new Promise((res) => { const r = indexedDB.open('flexnote'); r.onsuccess = () => { const q = r.result.transaction('blobs').objectStore('blobs').index('byDoc').count(IDBKeyRange.only(id)); q.onsuccess = () => res(q.result); }; }), docId);
  check('deleting the document deletes its images', left === 0, `left=${left}`);

  console.log(results.join('\n'));
  const errs = logs.filter((l) => /pageerror|\[error\]/.test(l));
  if (errs.length) console.log(errs.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1); });
