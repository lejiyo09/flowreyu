// 크롬북 갤러리 필기 상호 편집 테스트
//  - 가져오기: 갤러리 표시(/GOOG:INKIsInker) 안의 획 → 편집 가능한 'fp' 객체, 저장된 PDF 에서는 지워짐, 기존 필기 보존
//  - 내보내기(갤러리 호환): 우리 필기를 같은 모양으로 써서 다시 가져올 수 있음 (왕복)
const h = require('./harness');
const fs = require('fs');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, cdp, logs } = await h.launch();
  const dialogs = [];
  let answer = true;
  page.on('dialog', (d) => { dialogs.push(d.message()); (d.type() === 'confirm' && !answer) ? d.dismiss() : d.accept(); });
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  await page.evaluate(async () => { for (const d of await __flexnote.store.listDocs()) await __flexnote.store.deleteDoc(d.id); });
  await page.reload();
  await page.waitForTimeout(500);
  const items = () => page.evaluate(() => __flexnote.state.doc.items(0));
  const fps = async () => (await items()).filter((i) => i.t === 'fp');
  const S = (x, y) => page.evaluate(([x, y]) => __flexnote.viewer.pageToScreen(0, x, y), [x, y]);
  let vp = null;
  const X = (x) => vp.x + x, Y = (y) => vp.y + y;
  const galleryLeft = () => page.evaluate(async () => {
    const blob = await __flexnote.store.getFile(__flexnote.state.doc.id);
    const bytes = await blob.arrayBuffer();
    const g = await import('./js/gallery.js');
    const { pdfjsLib } = await import('./js/viewer.js');
    const pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    const r = await g.extractGalleryInk(bytes, async (i) => (await pdf.getPage(i + 1)).getViewport({ scale: 1 }).transform);
    return r ? r.count : 0;
  });

  // ── 1) 가져오기 (수락) ──
  await page.setInputFiles('#fileInput', h.S + '/gallery.pdf');
  await page.waitForSelector('#editor:not([hidden])', { timeout: 15000 });
  await page.waitForTimeout(900);
  vp = await page.locator('#viewport').boundingBox();
  check('asks to import gallery ink (2 strokes)', dialogs.length === 1 && /갤러리에서 쓴 필기 2개/.test(dialogs[0]), JSON.stringify(dialogs));
  let F = await fps();
  check('imported as 2 editable filled-ink objects', F.length === 2, JSON.stringify(F.map((f) => ({ c: f.c, op: f.op, n: f.pts.length / 2 }))));
  check('colors & highlighter opacity kept', F.some((f) => f.c === '#000000' && !f.op) && F.some((f) => f.c === '#f28b82' && f.op === 0.4));
  const pen = F.find((f) => f.c === '#000000');
  check('coordinates converted to page space (pen at y≈342)', Math.abs(Math.min(...pen.pts.filter((_, i) => i % 2)) - 339) < 1.5 && Math.abs(pen.pts[0] - 100) < 0.5, JSON.stringify(pen.pts.slice(0, 4)));
  check('stored PDF no longer contains gallery ink (no double drawing)', (await galleryLeft()) === 0);
  const ip = await S(200, 342);
  const px = await page.evaluate(([x, y]) => { const v = __flexnote.viewer; return [...v.inkCtx.getImageData(Math.round(x * v.dpr), Math.round(y * v.dpr), 1, 1).data]; }, [ip.x, ip.y]);
  check('imported pen ink is drawn by the app', px[3] > 200, JSON.stringify(px));

  // 지우개로 지우기 → 실행 취소
  await page.click('#toolbar [data-tool=eraser]');
  await page.waitForTimeout(300);
  const e0 = await S(200, 320), e1 = await S(200, 365);
  await h.pen(cdp, h.line(X(e0.x), Y(e0.y), X(e1.x), Y(e1.y), 10));
  await page.waitForTimeout(250);
  check('eraser removes imported gallery stroke', (await fps()).length === 1 && !(await fps()).some((f) => f.c === '#000000'));
  await page.click('#btnUndo');
  await page.waitForTimeout(200);
  check('undo restores it', (await fps()).length === 2);
  // 올가미로 옮기기
  await page.click('#toolbar [data-tool=lasso]');
  await page.waitForTimeout(400);
  const t = await S(200, 342);
  await h.pen(cdp, [[X(t.x), Y(t.y), 0.5]]);
  await page.waitForTimeout(200);
  const selN = await page.evaluate(() => __flexnote.tools.selection?.ids.size || 0);
  check('lasso tap selects gallery stroke', selN === 1, String(selN));
  // 다시 열어도 다시 묻지 않음
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  await page.click('.doc-card');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(700);
  check('reopening does not ask again, objects persist', dialogs.length === 1 && (await fps()).length === 2);

  // ── 2) 기존 필기가 있는 노트를 처음 열 때 가져오기 → 기존 필기 그대로 ──
  const gb64 = fs.readFileSync(h.S + '/gallery.pdf').toString('base64');
  const oldId = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const id = 'dold' + Date.now();
    await __flexnote.store.addDocWithFile({ id, name: '예전 노트', size: bytes.length, pageCount: 1, created: Date.now(), updated: Date.now(), opened: 0, thumb: null, view: null }, new Blob([bytes], { type: 'application/pdf' }));
    await __flexnote.store.savePages(id, [{ page: 0, rev: 1, items: [{ id: 'sold', t: 's', tool: 'pen', c: '#1e63d6', w: 3, pr: false, pts: [50, 50, 0.5, 150, 60, 0.5] }] }]);
    return id;
  }, gb64);
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  await page.waitForTimeout(300);
  await page.click(`.doc-card[data-id="${oldId}"]`);
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(900);
  const it2 = await items();
  check('existing ink kept + gallery ink added on first open', dialogs.length === 2 && it2.some((i) => i.id === 'sold') && it2.filter((i) => i.t === 'fp').length === 2, JSON.stringify(it2.map((i) => i.t)));

  // ── 3) 거절하면 그대로 (배경으로 남음), 다시 묻지 않음 ──
  answer = false;
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  await page.setInputFiles('#fileInput', h.S + '/gallery.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(900);
  check('declining keeps PDF as is (no objects)', dialogs.length === 3 && (await fps()).length === 0 && (await galleryLeft()) === 2);
  answer = true;

  // ── 4) 갤러리 호환 내보내기 → 다시 가져오기 (왕복) ──
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  await page.click('#toolbar [data-tool=pen]');
  await page.waitForTimeout(300);
  const a = await S(120, 200), b = await S(320, 260);
  await h.pen(cdp, h.line(X(a.x), Y(a.y), X(b.x), Y(b.y), 16, 0.7));
  await page.waitForTimeout(200);
  await page.click('#toolbar [data-tool=hl]');
  await page.waitForTimeout(300);
  const c1 = await S(120, 320), c2 = await S(360, 320);
  await h.pen(cdp, h.line(X(c1.x), Y(c1.y), X(c2.x), Y(c2.y), 12, 0.5));
  await page.waitForTimeout(300);
  check('two strokes drawn', (await items()).filter((i) => i.t === 's').length === 2);
  await page.evaluate(() => __flexnote.settings.set('exportGallery', true));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  const out = h.S + '/gallery-export.pdf';
  await dl.saveAs(out);
  await page.evaluate(() => __flexnote.settings.set('exportGallery', false));
  const raw = fs.readFileSync(out);
  check('exported PDF is valid', raw.slice(0, 5).toString() === '%PDF-');
  // 내보낸 파일을 다시 가져오면 갤러리 필기 2개로 인식 → 갤러리와 같은 모양으로 저장됐다는 뜻
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  const nd = dialogs.length;
  await page.setInputFiles('#fileInput', out);
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(900);
  const F2 = await fps();
  check('gallery-compatible export round-trips (2 strokes in gallery format)', dialogs.length === nd + 1 && F2.length === 2, JSON.stringify(dialogs.slice(-1)));
  check('pen exported opaque, highlighter at 40%', F2.some((f) => !f.op) && F2.some((f) => f.op === 0.4));
  const pb = F2.find((f) => !f.op);
  const xs = pb.pts.filter((_, i) => i % 2 === 0), ys = pb.pts.filter((_, i) => i % 2);
  check('exported stroke lands where it was drawn', Math.min(...xs) > 110 && Math.max(...xs) < 335 && Math.min(...ys) > 185 && Math.max(...ys) < 275, JSON.stringify([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]));

  // 일반 내보내기에도 채운 도형 필기가 들어감
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  await dl2.saveAs(h.S + '/gallery-export-normal.pdf');
  check('normal export with filled ink works', fs.readFileSync(h.S + '/gallery-export-normal.pdf').slice(0, 5).toString() === '%PDF-');

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
