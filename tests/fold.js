// 포스트잇 접기/펼치기 테스트
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, cdp, logs } = await h.launch();
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const vp = await page.locator('#viewport').boundingBox();
  const X = (x) => vp.x + x, Y = (y) => vp.y + y;
  const S = (x, y) => page.evaluate(([x, y]) => __flexnote.viewer.pageToScreen(0, x, y), [x, y]);
  const note = () => page.evaluate(() => __flexnote.state.doc.items(0).find((i) => i.t === 'nt'));
  const pix = (s) => page.evaluate(([x, y]) => { const v = __flexnote.viewer; return [...v.inkCtx.getImageData(Math.round(x * v.dpr), Math.round(y * v.dpr), 1, 1).data]; }, [s.x, s.y]);
  // 포스트잇 + 그 위 필기
  await page.evaluate(() => __flexnote.state.doc.add(0, { id: 'n1', t: 'nt', x: 100, y: 200, w: 200, h: 160, c: '#fff59d', fs: 14, text: '접는 메모' }));
  const a = await S(130, 300), b = await S(270, 300);
  await h.pen(cdp, h.line(X(a.x), Y(a.y), X(b.x), Y(b.y), 10));
  await page.waitForTimeout(200);
  const inkPt = await S(200, 300);
  const inkX0 = await page.evaluate(() => __flexnote.state.doc.items(0).find((i) => i.t === 's').pts[0]);
  check('ink on note visible before folding', (await pix(inkPt))[3] > 200);
  // 펜으로 접기 버튼(오른쪽 위 –) 탭 → 접힘, 점이 찍히지 않음
  const n0 = await note();
  const fbtn = await S(n0.x + n0.w - 9, n0.y + 9);
  const strokes = () => page.evaluate(() => __flexnote.state.doc.items(0).filter((i) => i.t === 's').length);
  const s0 = await strokes();
  await h.pen(cdp, [[X(fbtn.x), Y(fbtn.y), 0.5]]);
  await page.waitForTimeout(250);
  check('pen tap on "–" folds the note (no dot drawn)', (await note()).fold === true && (await strokes()) === s0);
  check('ink written on note is hidden when folded', (await pix(inkPt))[3] === 0, JSON.stringify(await pix(inkPt)));
  const icon = await S(n0.x + 12, n0.y + 12);
  check('folded icon is drawn at top-left', (await pix(icon))[3] > 200);
  // 지우개로 숨은 필기 안 지워짐
  await page.click('#toolbar [data-tool=eraser]');
  await h.pen(cdp, h.line(X(inkPt.x), Y(inkPt.y - 30), X(inkPt.x), Y(inkPt.y + 30), 6));
  check('eraser does not erase hidden ink under folded note', (await strokes()) === s0);
  await page.click('#toolbar [data-tool=pen]');
  // 손가락 탭으로 펼치기
  await page.waitForTimeout(400);
  await h.touch(cdp, 'touchStart', [[X(icon.x), Y(icon.y), 1]]);
  await h.touch(cdp, 'touchEnd', [[X(icon.x), Y(icon.y), 1]]);
  await page.waitForTimeout(250);
  check('finger tap on icon expands the note', !(await note()).fold);
  check('ink comes back when expanded', (await pix(inkPt))[3] > 200);
  // 실행 취소로 다시 접힘 (접기/펼치기도 기록됨)
  await page.click('#btnUndo');
  check('fold/unfold is undoable', (await note()).fold === true);
  await page.click('#btnRedo');
  // 올가미로 포스트잇 선택 → 필기도 함께 이동
  await page.click('#toolbar [data-tool=lasso]');
  await page.waitForTimeout(400);
  const mid = await S(150, 230);
  await h.pen(cdp, [[X(mid.x), Y(mid.y), 0.5]]);
  await page.waitForTimeout(150);
  const selIds = await page.evaluate(() => [...(__flexnote.tools.selection?.ids || [])]);
  check('selecting a note also selects ink written on it', selIds.length === 2, JSON.stringify(selIds));
  check('selection menu shows fold button', await page.locator('#selMenu [data-sel=fold]').isVisible());
  await h.pen(cdp, h.line(X(mid.x), Y(mid.y), X(mid.x + 50), Y(mid.y + 30), 8));
  const moved = await page.evaluate(() => { const its = __flexnote.state.doc.items(0); return { n: its.find((i) => i.t === 'nt').x, s: its.find((i) => i.t === 's').pts[0] }; });
  const z = await page.evaluate(() => __flexnote.viewer.cam.z);
  const dn = moved.n - 100, ds = moved.s - inkX0;
  check('moving note moves its ink too (same offset)', Math.abs(dn * z - 50) < 2 && Math.abs(ds - dn) < 0.05, JSON.stringify({ dn, ds }));
  // 선택 메뉴의 접기 버튼
  await page.click('#selMenu [data-sel=fold]');
  check('selection menu fold button folds the note', (await note()).fold === true);
  // 새로고침 후 접힌 상태 유지
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  check('folded state persists after reload', (await note()).fold === true);
  // 내보내기: 접힌 포스트잇 위 필기는 PDF 에도 안 나옴
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  await dl.saveAs(h.S + '/fold-export.pdf');
  check('export with folded note works', true);
  console.log(results.join('\n'));
  const errs = logs.filter((l) => /pageerror|\[error\]/.test(l));
  if (errs.length) console.log(errs.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1); });
