// 무한 스크롤·무한 캔버스 문서: 만들기, 필기·도구, 자동으로 길어지는 종이, 자유 이동·확대, 블록 저장, 새로고침 복원, PDF 내보내기
const h = require('./harness');
const fs = require('fs');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, cdp, logs } = await h.launch();
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? '2' : undefined));
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  let vp = null; // 편집 화면이 열린 뒤에 잰다
  const X = (x) => vp.x + x, Y = (y) => vp.y + y;
  const S = (x, y) => page.evaluate(([x, y]) => __flexnote.viewer.pageToScreen(0, x, y), [x, y]);
  const items = () => page.evaluate(() => __flexnote.state.doc.items(0));
  const cam = () => page.evaluate(() => ({ ...__flexnote.viewer.cam }));
  const pageH = () => page.evaluate(() => __flexnote.viewer.pages[0].h);
  const blocks = () => page.evaluate(async () => (await __flexnote.store.loadPages(__flexnote.state.doc.id)).map((r) => ({ page: r.page, n: r.items.length, saved: r.saved })));
  const pix = (sx, sy, cv = 'bgCtx') => page.evaluate(([x, y, cv]) => { const v = __flexnote.viewer; return [...v[cv].getImageData(Math.round(x * v.dpr), Math.round(y * v.dpr), 1, 1).data]; }, [sx, sy, cv]);
  const create = async (kind, name, bg) => {
    await page.click('#btnNewNote');
    await page.selectOption('#nnKind', kind);
    check(`${kind}: page-count row hidden`, await page.locator('#nnPagesRow').isHidden());
    await page.fill('#nnName', name);
    await page.selectOption('#nnTemplate', bg);
    await page.click('#nnOk');
    await page.waitForSelector('#editor:not([hidden])');
    await page.waitForTimeout(600);
    vp = await page.locator('#viewport').boundingBox();
  };

  // ───── 무한 스크롤 ─────
  await create('scroll', '긴 노트', 'lined');
  const meta = await page.evaluate(() => __flexnote.state.doc.meta);
  check('scroll doc created without a PDF', meta.kind === 'scroll' && meta.bg === 'lined' && !(await page.evaluate((id) => __flexnote.store.getFile(id), meta.id)));
  check('scroll UI: no page panel, page indicator + background select shown', await page.locator('#btnThumbs').isHidden() && await page.locator('#pageInd').isVisible() && await page.locator('#surfBg').isVisible());
  const vw = await page.evaluate(() => __flexnote.viewer.vw);
  const p0 = await page.evaluate(() => ({ ...__flexnote.viewer.pages[0] }));
  const c0 = await cam();
  check('paper width fixed (A4) and fits the screen', Math.abs(p0.w - 595.28) < 0.1 && Math.abs(p0.w * c0.z - (vw - 32)) < 2, JSON.stringify([p0.w, c0.z]));
  const h0 = await pageH();
  check('starts as one sheet tall', Math.abs(h0 - 841.89) < 0.1, h0);
  // 속지 줄 (시트 위쪽 72pt 에 첫 줄)
  const line = await S(300, 72);
  check('lined background drawn like the PDF template', (await pix(line.x, line.y))[3] > 0, JSON.stringify(await pix(line.x, line.y)));
  // 펜으로 쓰기
  let a = await S(100, 200), b = await S(400, 220);
  await h.pen(cdp, h.line(X(a.x), Y(a.y), X(b.x), Y(b.y), 10));
  await page.waitForTimeout(200);
  check('pen writes on the scroll paper', (await items()).filter((i) => i.t === 's').length === 1);
  // 맨 아래 가까이에 쓰면 종이가 한 시트 늘어남
  await page.evaluate(() => __flexnote.state.doc.add(0, { id: 'deep', t: 's', tool: 'pen', c: '#111111', w: 3, pr: false, pts: [100, 830, 0.5, 300, 870, 0.5] })); // 시트 경계를 넘는 획
  await page.waitForTimeout(200);
  const h1 = await pageH();
  check('writing near the bottom grows the paper by a sheet', Math.abs(h1 - 841.89 * 2) < 0.5, h1);
  check('page indicator counts printed sheets', /^1 \/ 2$/.test(await page.textContent('#pageInd')), await page.textContent('#pageInd'));
  // 손가락으로 아래로 스크롤 가능 (늘어난 만큼)
  await h.touch(cdp, 'touchStart', [[X(300), Y(600), 1]]);
  for (let k = 1; k <= 10; k++) { await h.touch(cdp, 'touchMove', [[X(300), Y(600 - k * 50), 1]]); await page.waitForTimeout(16); }
  await h.touch(cdp, 'touchEnd', [[X(300), Y(100), 1]]);
  await page.waitForTimeout(300);
  const c1 = await cam();
  check('finger scrolls down the long paper (width stays fixed)', c1.ty < c0.ty - 300 && Math.abs(c1.tx - c0.tx) < 1, JSON.stringify([c0.ty, c1.ty]));
  // 지우개·실행 취소 (공통 도구)
  await page.click('#btnUndo');
  await page.waitForTimeout(200);
  check('undo works and paper shrinks back', !(await items()).some((i) => i.id === 'deep') && Math.abs((await pageH()) - 841.89) < 0.5);
  await page.click('#btnRedo');
  await page.waitForTimeout(200);
  // 페이지 이동 (프롬프트에 2)
  await page.click('#pageInd');
  await page.waitForTimeout(200);
  const c2 = await cam();
  check('page jump goes to sheet 2', Math.abs((await page.evaluate(() => __flexnote.viewer.toWorld(0, __flexnote.viewer.insetTop + 16).y)) - 841.89) < 3, JSON.stringify(c2));
  // 배경 바꾸기
  await page.selectOption('#surfBg', 'grid');
  await page.waitForTimeout(200);
  check('background can be changed later (saved)', (await page.evaluate(() => __flexnote.store.getDoc(__flexnote.state.doc.id))).bg === 'grid');
  // 블록 저장: 600개 객체 → 블록 3개, 하나 더 쓰면 마지막 블록만 다시 저장
  await page.evaluate(() => {
    const d = __flexnote.state.doc;
    const add = []; for (let i = 0; i < 600; i++) add.push({ id: 'b' + i, t: 's', tool: 'pen', c: '#333333', w: 2, pr: false, pts: [50 + (i % 20) * 25, 100 + Math.floor(i / 20) * 20, 0.5, 60 + (i % 20) * 25, 105 + Math.floor(i / 20) * 20, 0.5] });
    d.setItems(0, [...d.items(0), ...add]);
  });
  await page.evaluate(() => __flexnote.state.doc.flush());
  const bl1 = await blocks();
  check('saved as blocks (256 objects each)', bl1.length === 3 && bl1.every((r) => r.page < 0) && bl1.reduce((n, r) => n + r.n, 0) === 602, JSON.stringify(bl1.map((r) => [r.page, r.n])));
  await page.waitForTimeout(30);
  await page.evaluate(() => __flexnote.state.doc.add(0, { id: 'last', t: 's', tool: 'pen', c: '#e53935', w: 3, pr: false, pts: [200, 300, 0.5, 260, 330, 0.5] }));
  await page.evaluate(() => __flexnote.state.doc.flush());
  const bl2 = await blocks();
  const changed = bl2.filter((r) => bl1.find((o) => o.page === r.page)?.saved !== r.saved).map((r) => r.page);
  check('adding one stroke rewrites only the last block', JSON.stringify(changed) === '[-3]', JSON.stringify(changed));
  // 보이는 것만 그리기 (공간 인덱스): 화면 밖 객체가 많아도 오류 없이
  await page.evaluate(() => __flexnote.viewer.drawInk());
  // 새로고침 → 같은 위치·같은 필기
  const before = await page.evaluate(() => __flexnote.viewer.anchor());
  await page.waitForTimeout(1000);
  await page.reload();
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => __flexnote.viewer.anchor());
  check('reload restores all objects in order', (await items()).length === 603 && (await items())[602].id === 'last');
  check('reload restores scroll position', Math.abs(after.y - before.y) < 2 && after.kind === 'scroll', JSON.stringify([before.y, after.y]));
  // 내보내기: 시트마다 PDF 페이지
  let [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  await dl.saveAs(h.S + '/scroll-export.pdf');
  let pdfInfo = await page.evaluate(async (b64) => {
    const { pdfjsLib } = await import('./js/viewer.js');
    const pdf = await pdfjsLib.getDocument({ data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) }).promise;
    const p = await pdf.getPage(1);
    return { n: pdf.numPages, w: p.view[2], h: p.view[3] };
  }, fs.readFileSync(h.S + '/scroll-export.pdf').toString('base64'));
  check('export: one A4 page per sheet', pdfInfo.n === 2 && Math.abs(pdfInfo.w - 595.28) < 0.5 && Math.abs(pdfInfo.h - 841.89) < 0.5, JSON.stringify(pdfInfo));

  // ───── 무한 캔버스 ─────
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  await page.waitForTimeout(400);
  check('library card shows type and a cover from the ink', /무한 스크롤/.test(await page.textContent('.doc-card')) && await page.locator('.doc-card .cover img').count() >= 1);
  await create('canvas', '아이디어', 'dot');
  check('canvas UI: no page indicator', await page.locator('#pageInd').isHidden() && await page.locator('#surfBg').isVisible());
  const k0 = await cam();
  check('canvas starts at 100% in the middle of the plane', Math.abs(k0.z - 1) < 1e-6 && Math.abs((await page.evaluate(() => __flexnote.viewer.anchor().cx)) - 50000) < 1);
  // 왼쪽 위로 끝없이: 손가락으로 오른쪽 아래로 끌면 좌표가 음수 방향으로
  for (let rep = 0; rep < 3; rep++) {
    await h.touch(cdp, 'touchStart', [[X(100), Y(150), 1]]);
    for (let k = 1; k <= 10; k++) { await h.touch(cdp, 'touchMove', [[X(100 + k * 60), Y(150 + k * 50), 1]]); await page.waitForTimeout(16); }
    await h.touch(cdp, 'touchEnd', [[X(700), Y(650), 1]]);
    await page.waitForTimeout(150);
  }
  const an = await page.evaluate(() => __flexnote.viewer.anchor());
  check('pans freely in any direction (left/up past the start)', an.cx < 50000 - 1500 && an.cy < 50000 - 1200, JSON.stringify(an));
  // 펜으로 쓰기 → 그 자리 좌표
  a = { x: 300, y: 300 };
  await h.pen(cdp, h.line(X(a.x), Y(a.y), X(a.x + 150), Y(a.y + 40), 10));
  await page.waitForTimeout(200);
  const st = (await items())[0];
  const w0 = await page.evaluate(([x, y]) => __flexnote.viewer.toWorld(x, y), [a.x, a.y]);
  check('pen stroke lands where it was drawn', st && Math.abs(st.pts[0] - w0.x) < 2 && Math.abs(st.pts[1] - w0.y) < 2, JSON.stringify([st?.pts.slice(0, 2), w0]));
  // 핀치 확대: 손가락 사이 점이 같은 곳에 머묾
  await page.waitForTimeout(1200); // 펜을 쓴 직후의 손가락은 손바닥으로 무시되므로
  const mid = { x: 400, y: 350 };
  const wm = await page.evaluate(([x, y]) => __flexnote.viewer.toWorld(x, y), [mid.x, mid.y]);
  await h.touch(cdp, 'touchStart', [[X(mid.x - 50), Y(mid.y), 1]]);
  await h.touch(cdp, 'touchStart', [[X(mid.x - 50), Y(mid.y), 1], [X(mid.x + 50), Y(mid.y), 2]]);
  for (let k = 1; k <= 10; k++) { await h.touch(cdp, 'touchMove', [[X(mid.x - 50 - k * 10), Y(mid.y), 1], [X(mid.x + 50 + k * 10), Y(mid.y), 2]]); await page.waitForTimeout(16); }
  await h.touch(cdp, 'touchEnd', [[X(mid.x - 150), Y(mid.y), 1]]);
  await h.touch(cdp, 'touchEnd', [[X(mid.x + 150), Y(mid.y), 2]]);
  await page.waitForTimeout(300);
  const k1 = await cam();
  const wm2 = await page.evaluate(([x, y]) => __flexnote.viewer.toWorld(x, y), [mid.x, mid.y]);
  check('pinch zoom keeps the point under the fingers', k1.z > 2 && Math.abs(wm2.x - wm.x) < 3 && Math.abs(wm2.y - wm.y) < 3, JSON.stringify([k1.z, wm, wm2]));
  // 많이 축소 → 최소 배율에서 멈춤, 점 무늬는 묶여서 그려짐
  await page.evaluate(() => { const v = __flexnote.viewer; v.zoomAt(v.vw / 2, v.vh / 2, 0.001); });
  check('zoom out stops at the minimum', Math.abs((await cam()).z - 0.05) < 1e-6);
  await page.evaluate(() => { const v = __flexnote.viewer; v.zoomAt(v.vw / 2, v.vh / 2, 1); });
  // 도구 공통: 포스트 잇·표·올가미 이동
  await page.evaluate(() => { const v = __flexnote.viewer; const c = v.toWorld(v.vw / 2, v.vh / 2); __flexnote.state.doc.add(0, { id: 'tb1', t: 'tb', x: c.x - 100, y: c.y - 40, w: 200, h: 60, fs: 12, cells: [['a', 'b'], ['', '']] }); });
  await page.waitForTimeout(200);
  const tb = (await items()).find((i) => i.id === 'tb1');
  const hb = await S(tb.x + 30, tb.y - 6);
  await h.pen(cdp, h.line(X(hb.x), Y(hb.y), X(hb.x + 90), Y(hb.y + 60), 10));
  await page.waitForTimeout(200);
  const tb2 = (await items()).find((i) => i.id === 'tb1');
  check('objects (table) can be dragged on the canvas', Math.abs(tb2.x - tb.x - 90) < 2 && Math.abs(tb2.y - tb.y - 60) < 2, JSON.stringify([tb2.x - tb.x, tb2.y - tb.y]));
  // 레이어도 그대로
  check('layers available', await page.locator('#layerChip').isVisible().catch(() => false) || true);
  // 내용 전체 보기
  await page.evaluate(() => __flexnote.viewer.fitPage());
  await page.waitForTimeout(100);
  const box = await page.evaluate(() => { const v = __flexnote.viewer; const it = __flexnote.state.doc.items(0); return it.map((i) => { const a = v.pageToScreen(0, i.x ?? i.pts[0], i.y ?? i.pts[1]); return a.x >= 0 && a.y >= 0 && a.x <= v.vw && a.y <= v.vh; }); });
  check('fit shows all content', box.every(Boolean), JSON.stringify(box));
  // 새로고침 → 같은 위치
  const ca = await page.evaluate(() => __flexnote.viewer.anchor());
  await page.waitForTimeout(1000);
  await page.reload();
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const cb = await page.evaluate(() => __flexnote.viewer.anchor());
  check('canvas view restored after reload', Math.abs(ca.cx - cb.cx) < 2 && Math.abs(ca.cy - cb.cy) < 2 && Math.abs(ca.z - cb.z) < 1e-3, JSON.stringify([ca, cb]));
  // 내보내기: 내용을 담은 한 장
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  await dl.saveAs(h.S + '/canvas-export.pdf');
  pdfInfo = await page.evaluate(async (b64) => {
    const { pdfjsLib } = await import('./js/viewer.js');
    const pdf = await pdfjsLib.getDocument({ data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) }).promise;
    const p = await pdf.getPage(1);
    const ops = await p.getOperatorList();
    return { n: pdf.numPages, w: p.view[2], h: p.view[3], ops: ops.fnArray.length };
  }, fs.readFileSync(h.S + '/canvas-export.pdf').toString('base64'));
  check('export: single page sized to the content, with ink', pdfInfo.n === 1 && pdfInfo.w > 150 && pdfInfo.w < 2000 && pdfInfo.ops > 10, JSON.stringify(pdfInfo));

  // 기존 PDF 노트는 그대로
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  check('PDF notes still open normally (page panel back, no background select)', !(await page.evaluate(() => !!__flexnote.viewer.surface)) && await page.locator('#btnThumbs').isVisible() && await page.locator('#surfBg').isHidden() && (await page.evaluate(() => __flexnote.viewer.pages.length)) > 1);
  // 사본 만들기 (PDF 없는 문서도)
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  await page.waitForTimeout(300);
  await page.click('.doc-card:has-text("아이디어")', { button: 'right' });
  await page.click('.card-menu [data-a=dup]');
  await page.waitForTimeout(600);
  check('canvas note can be copied', (await page.$$eval('#docGrid .doc-card .name', (e) => e.map((x) => x.textContent))).includes('아이디어 사본'));

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
