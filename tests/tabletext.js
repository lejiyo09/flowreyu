// 표: 모서리 손잡이로 크기 조절, 가장자리 ＋ 로 행·열 하나씩 추가 / 글: 선택 후 글자 크기·굵게·기울임·색 바꾸기
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
  const get = (id) => page.evaluate((id) => __flexnote.state.doc.items(0).find((i) => i.id === id), id);
  const strokes = () => page.evaluate(() => __flexnote.state.doc.items(0).filter((i) => i.t === 's').length);
  const z = await page.evaluate(() => __flexnote.viewer.cam.z);
  const ctl = (it) => Math.max(10, Math.min(18, it.fs * 1.2));

  await page.evaluate(() => __flexnote.state.doc.add(0, { id: 't1', t: 'tb', x: 150, y: 150, w: 240, h: 90, fs: 12, cells: [['이름', '점수', '비고'], ['철수', '95', ''], ['', '', '']] }));
  await page.waitForTimeout(200);
  let t = await get('t1');
  // 아래 ＋ (펜 탭) → 행 추가, 점 안 찍힘
  const s0 = await strokes();
  let p = await S(t.x + t.w / 2, t.y + t.h + 3 + ctl(t) / 2);
  await h.pen(cdp, [[X(p.x), Y(p.y), 0.5]]);
  await page.waitForTimeout(250);
  t = await get('t1');
  check('pen tap on bottom ＋ adds one row (cells kept, no dot)', t.cells.length === 4 && t.cells[1][1] === '95' && Math.abs(t.h - 120) < 0.5 && (await strokes()) === s0, JSON.stringify([t.cells.length, t.h]));
  // 오른쪽 ＋ (손가락 탭) → 열 추가
  await page.waitForTimeout(400);
  p = await S(t.x + t.w + 3 + ctl(t) / 2, t.y + t.h / 2);
  await h.touch(cdp, 'touchStart', [[X(p.x), Y(p.y), 1]]);
  await h.touch(cdp, 'touchEnd', [[X(p.x), Y(p.y), 1]]);
  await page.waitForTimeout(250);
  t = await get('t1');
  check('finger tap on right ＋ adds one column', t.cells[0].length === 4 && Math.abs(t.w - 320) < 0.5, JSON.stringify([t.cells[0].length, t.w]));
  await page.click('#btnUndo');
  await page.waitForTimeout(150);
  check('undo removes the added column', (await get('t1')).cells[0].length === 3);
  t = await get('t1');

  // 모서리 손잡이 (펜) → 가로·세로 따로 크기 조절, 글자 크기는 그대로
  await page.waitForTimeout(400);
  p = await S(t.x + t.w, t.y + t.h);
  await h.pen(cdp, h.line(X(p.x - 2), Y(p.y - 2), X(p.x - 2 + 80), Y(p.y - 2 + 30), 10));
  await page.waitForTimeout(250);
  let t2 = await get('t1');
  check('pen drag on corner resizes width & height independently', Math.abs(t2.w - t.w - 80 / z) < 2 && Math.abs(t2.h - t.h - 30 / z) < 2 && t2.fs === t.fs && t2.x === t.x && (await strokes()) === s0, JSON.stringify([t.w, t2.w, t.h, t2.h]));
  // 손가락으로 크게 줄이면 최소 크기에서 멈춤
  await page.waitForTimeout(400);
  p = await S(t2.x + t2.w, t2.y + t2.h);
  await h.touch(cdp, 'touchStart', [[X(p.x - 2), Y(p.y - 2), 1]]);
  for (let k = 1; k <= 10; k++) { await h.touch(cdp, 'touchMove', [[X(p.x - 2 - k * 60), Y(p.y - 2 - k * 40), 1]]); await page.waitForTimeout(16); }
  await h.touch(cdp, 'touchEnd', [[X(p.x - 602), Y(p.y - 402), 1]]);
  await page.waitForTimeout(250);
  const t3 = await get('t1');
  check('finger drag shrinks to a minimum (text still fits)', Math.abs(t3.w - 3 * 12 * 1.6) < 0.5 && Math.abs(t3.h - 4 * 12 * 1.5) < 0.5, JSON.stringify([t3.w, t3.h]));
  await page.click('#btnUndo');
  await page.waitForTimeout(150);
  check('undo restores size', Math.abs((await get('t1')).w - t2.w) < 0.5);

  // 글상자 꾸미기
  await page.evaluate(() => __flexnote.state.doc.add(0, { id: 'x1', t: 'tx', x: 150, y: 330, c: '#111111', fs: 16, text: '꾸밀 글' }));
  await page.click('#toolbar [data-tool=lasso]');
  await page.waitForTimeout(400);
  p = await S(170, 340);
  await h.pen(cdp, [[X(p.x), Y(p.y), 0.5]]);
  await page.waitForTimeout(250);
  check('text style buttons shown for selected text', await page.locator('#selMenu [data-sel=bold]').isVisible() && await page.locator('#selMenu [data-sel=fs-up]').isVisible());
  const w0 = await page.evaluate(() => import('./js/ink.js').then((m) => m.textLayout(__flexnote.state.doc.items(0).find((i) => i.id === 'x1')).w));
  await page.click('#selMenu [data-sel=bold]');
  await page.click('#selMenu [data-sel=ital]');
  await page.click('#selMenu [data-sel=fs-up]');
  await page.click('#selMenu .sel-colors .swatch:nth-child(2)');
  await page.waitForTimeout(200);
  const x1 = await get('x1');
  const w1 = await page.evaluate(() => import('./js/ink.js').then((m) => m.textLayout(__flexnote.state.doc.items(0).find((i) => i.id === 'x1')).w));
  check('bold + italic + bigger + color applied', x1.b === true && x1.i === true && Math.abs(x1.fs - 16 * 1.15) < 0.05 && x1.c !== '#111111' && w1 > w0, JSON.stringify({ b: x1.b, i: x1.i, fs: x1.fs, c: x1.c, w0, w1 }));
  check('bold button shows as on', await page.locator('#selMenu [data-sel=bold].on').isVisible());
  await page.click('#selMenu [data-sel=bold]');
  await page.waitForTimeout(100);
  check('tap B again removes bold', !(await get('x1')).b);
  await page.click('#selMenu [data-sel=bold]');
  // 표·체크리스트도 같이: 표 선택 → 글자 크게
  await page.click('#selMenu [data-sel=clear]');
  await page.waitForTimeout(300);
  const tb = await get('t1');
  p = await S(tb.x + 10, tb.y + tb.h - 5);
  await h.pen(cdp, [[X(p.x), Y(p.y), 0.5]]);
  await page.waitForTimeout(250);
  await page.click('#selMenu [data-sel=fs-dn]');
  await page.click('#selMenu [data-sel=bold]');
  await page.waitForTimeout(150);
  const tb2 = await get('t1');
  check('table text size & bold can be changed after inserting', tb2.b === true && Math.abs(tb2.fs - 12 / 1.15) < 0.05, JSON.stringify({ b: tb2.b, fs: tb2.fs }));
  // 새로고침 후 유지 + 내보내기
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const x2 = await get('x1');
  check('styles persist after reload', x2.b === true && x2.i === true && (await get('t1')).b === true);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  await dl.saveAs(h.S + '/tabletext-export.pdf');
  check('export works', true);

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
