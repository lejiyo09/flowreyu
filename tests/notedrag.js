// 포스트잇 어두운 띠(손잡이)로 옮기기 테스트
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
  const ink = () => page.evaluate(() => __flexnote.state.doc.items(0).find((i) => i.t === 's'));
  const strokes = () => page.evaluate(() => __flexnote.state.doc.items(0).filter((i) => i.t === 's').length);
  const z = await page.evaluate(() => __flexnote.viewer.cam.z);
  await page.evaluate(() => __flexnote.state.doc.add(0, { id: 'n1', t: 'nt', x: 100, y: 200, w: 200, h: 160, c: '#fff59d', fs: 14, text: '옮길 메모' }));
  const a = await S(130, 300), b = await S(270, 300);
  await h.pen(cdp, h.line(X(a.x), Y(a.y), X(b.x), Y(b.y), 10)); // 메모 위 필기
  await page.waitForTimeout(300);
  const ink0 = (await ink()).pts[0];
  // 펜(펜 도구 상태)으로 어두운 띠를 잡고 끌기 → 메모+필기 이동, 새 획 없음
  const s0 = await strokes();
  const head = await S(150, 207);
  await h.pen(cdp, h.line(X(head.x), Y(head.y), X(head.x + 80), Y(head.y + 60), 12));
  let n = await note();
  check('pen drag on dark header moves note (pen tool active)', Math.abs((n.x - 100) * z - 80) < 2 && Math.abs((n.y - 200) * z - 60) < 2, JSON.stringify({ x: n.x, y: n.y }));
  check('pen drag on header draws no stroke', (await strokes()) === s0);
  check('ink on the note moves with it', Math.abs((await ink()).pts[0] - ink0 - (n.x - 100)) < 0.05);
  // 실행 취소로 원위치
  await page.click('#btnUndo');
  check('note move is undoable', (await note()).x === 100);
  await page.click('#btnRedo');
  // 손가락으로 띠 끌기 → 메모 이동, 화면은 그대로
  await page.waitForTimeout(400);
  n = await note();
  const ty0 = await page.evaluate(() => __flexnote.viewer.cam.ty);
  const h2 = await S(n.x + 50, n.y + 7);
  await h.touch(cdp, 'touchStart', [[X(h2.x), Y(h2.y), 1]]);
  for (let i = 1; i <= 5; i++) await h.touch(cdp, 'touchMove', [[X(h2.x - i * 10), Y(h2.y + i * 8), 1]]);
  await h.touch(cdp, 'touchEnd', [[X(h2.x - 50), Y(h2.y + 40), 1]]);
  const n2 = await note();
  check('finger drag on header moves note, page does not pan', Math.abs((n2.x - n.x) * z + 50) < 2 && Math.abs((n2.y - n.y) * z - 40) < 2 && (await page.evaluate(() => __flexnote.viewer.cam.ty)) === ty0);
  // 메모 본문(띠 아래)을 펜으로 그으면 필기 (옮겨지지 않음)
  const body = await S(n2.x + 40, n2.y + 100);
  await h.pen(cdp, h.line(X(body.x), Y(body.y), X(body.x + 60), Y(body.y), 8));
  check('pen on note body writes (does not move)', (await strokes()) === s0 + 1 && (await note()).x === n2.x);
  // 접기 → 접힌 아이콘을 손가락으로 끌어 이동, 탭하면 펼침
  const fb = await S(n2.x + n2.w - 6, n2.y + 6);
  await h.pen(cdp, [[X(fb.x), Y(fb.y), 0.5]]);
  await page.waitForTimeout(250);
  check('fold button still folds', (await note()).fold === true);
  await page.waitForTimeout(400);
  const ic = await S(n2.x + 10, n2.y + 10);
  await h.touch(cdp, 'touchStart', [[X(ic.x), Y(ic.y), 2]]);
  for (let i = 1; i <= 5; i++) await h.touch(cdp, 'touchMove', [[X(ic.x + i * 12), Y(ic.y), 2]]);
  await h.touch(cdp, 'touchEnd', [[X(ic.x + 60), Y(ic.y), 2]]);
  const n3 = await note();
  check('folded icon can be dragged by finger', Math.abs((n3.x - n2.x) * z - 60) < 2 && n3.fold === true);
  const ic2 = await S(n3.x + 10, n3.y + 10);
  await h.touch(cdp, 'touchStart', [[X(ic2.x), Y(ic2.y), 3]]);
  await h.touch(cdp, 'touchEnd', [[X(ic2.x), Y(ic2.y), 3]]);
  await page.waitForTimeout(250);
  check('finger tap on folded icon expands it', !(await note()).fold);
  // 펜으로 접힌 아이콘 끌기
  await h.pen(cdp, [[X(fb.x + 60), Y(fb.y), 0.5]]); // 다시 접기 (버튼은 60px 이동한 위치)
  await page.waitForTimeout(400);
  const n4 = await note();
  const ic3 = await S(n4.x + 10, n4.y + 10);
  await h.pen(cdp, h.line(X(ic3.x), Y(ic3.y), X(ic3.x), Y(ic3.y + 50), 8));
  const n5 = await note();
  check('pen can drag folded icon too', n4.fold && n5.fold && Math.abs((n5.y - n4.y) * z - 50) < 2, JSON.stringify({ f: n4.fold, dy: (n5.y - n4.y) * z }));
  console.log(results.join('\n'));
  const errs = logs.filter((l) => /pageerror|\[error\]/.test(l));
  if (errs.length) console.log(errs.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1); });
