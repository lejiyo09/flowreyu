// 체크리스트·표 테스트
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
  const find = (t) => page.evaluate((t) => { for (const [p, its] of __flexnote.state.doc.pages) { const it = its.find((i) => i.t === t); if (it) return { p, it }; } return null; }, t);
  const S = (p, x, y) => page.evaluate(([p, x, y]) => __flexnote.viewer.pageToScreen(p, x, y), [p, x, y]);
  const strokes = () => page.evaluate(() => { let n = 0; for (const its of __flexnote.state.doc.pages.values()) n += its.filter((i) => i.t === 's').length; return n; });

  // ── 체크리스트 ──
  await page.click('#btnChecklist');
  await page.waitForTimeout(150);
  check('checklist opens editor immediately', await page.locator('#textEditor').isVisible());
  await page.keyboard.type('우유 사기');
  await page.keyboard.press('Enter');
  await page.keyboard.type('보고서 제출');
  await page.keyboard.press('Enter');
  await page.keyboard.type('운동');
  await page.keyboard.press('Escape');
  let cl = await find('cl');
  check('checklist has 3 rows, none done', cl && cl.it.rows.length === 3 && cl.it.rows.every((r) => !r.done), JSON.stringify(cl?.it.rows));
  // 펜(펜 도구)으로 둘째 줄 상자 탭 → 완료, 점 안 찍힘
  const box = (it, i) => { const rh = it.fs * 1.7, s = it.fs * 0.95; return { x: it.x + 4 + s / 2, y: it.y + 4 + i * rh + rh / 2 }; };
  const s0 = await strokes();
  let b = box(cl.it, 1);
  let sc = await S(cl.p, b.x, b.y);
  await h.pen(cdp, [[X(sc.x), Y(sc.y), 0.5]]);
  await page.waitForTimeout(200);
  cl = await find('cl');
  check('pen tap on checkbox marks done (no dot)', cl.it.rows[1].done && !cl.it.rows[0].done && (await strokes()) === s0);
  // 손가락으로 첫 줄 상자 탭
  await page.waitForTimeout(400);
  b = box(cl.it, 0); sc = await S(cl.p, b.x, b.y);
  await h.touch(cdp, 'touchStart', [[X(sc.x), Y(sc.y), 1]]);
  await h.touch(cdp, 'touchEnd', [[X(sc.x), Y(sc.y), 1]]);
  await page.waitForTimeout(200);
  cl = await find('cl');
  check('finger tap on checkbox marks done', cl.it.rows[0].done);
  // 다시 탭하면 해제
  await h.pen(cdp, [[X(sc.x), Y(sc.y), 0.5]]);
  await page.waitForTimeout(200);
  check('tapping again unchecks', !(await find('cl')).it.rows[0].done);
  // 텍스트 도구로 편집: 순서 바꾸고 항목 추가 → 완료 표시는 글을 따라감
  await page.click('#toolbar [data-tool=text]');
  await page.waitForTimeout(400);
  const mid = await S(cl.p, cl.it.x + cl.it.w * 0.6, cl.it.y + 4 + cl.it.fs * 1.7 * 0.5);
  await h.pen(cdp, [[X(mid.x), Y(mid.y), 0.5]]);
  await page.waitForTimeout(150);
  check('text tool tap opens checklist lines', (await page.inputValue('#textEditor')) === '우유 사기\n보고서 제출\n운동');
  await page.fill('#textEditor', '보고서 제출\n우유 사기\n운동\n책 반납');
  await page.keyboard.press('Escape');
  cl = await find('cl');
  check('editing keeps done state with the text & adds rows', cl.it.rows.length === 4 && cl.it.rows[0].text === '보고서 제출' && cl.it.rows[0].done && !cl.it.rows[3].done, JSON.stringify(cl.it.rows));
  // 지우개로 안 지워짐
  await page.click('#toolbar [data-tool=eraser]');
  const c2 = await S(cl.p, cl.it.x + cl.it.w / 2, cl.it.y + 20);
  await h.pen(cdp, h.line(X(c2.x - 80), Y(c2.y), X(c2.x + 80), Y(c2.y), 8));
  check('eraser leaves checklist', !!(await find('cl')));

  // ── 표 ──
  await page.click('#toolbar [data-tool=pen]');
  await page.click('#btnTable');
  await page.fill('#tbRows', '3');
  await page.fill('#tbCols', '3');
  await page.click('#tableDlg button[value=ok]');
  await page.waitForTimeout(150);
  check('table opens editor on first cell', await page.locator('#textEditor').isVisible());
  for (const [i, v] of ['이름', '점수', '비고', '철수', '95'].entries()) { if (i) await page.keyboard.press('Tab'); await page.keyboard.type(v); }
  await page.keyboard.press('Escape');
  let tb = await find('tb');
  check('Tab moves across cells', tb && JSON.stringify(tb.it.cells) === JSON.stringify([['이름', '점수', '비고'], ['철수', '95', ''], ['', '', '']]), JSON.stringify(tb?.it.cells));
  // 텍스트 도구로 칸 탭 → 그 칸 편집
  await page.click('#toolbar [data-tool=text]');
  await page.waitForTimeout(400);
  const cell = await S(tb.p, tb.it.x + tb.it.w * (2.5 / 3), tb.it.y + tb.it.h * (1.5 / 3));
  await h.pen(cdp, [[X(cell.x), Y(cell.y), 0.5]]);
  await page.waitForTimeout(150);
  await page.keyboard.type('우수');
  await page.keyboard.press('Escape');
  tb = await find('tb');
  check('text tool tap edits that cell', tb.it.cells[1][2] === '우수');
  // 올가미 선택 → 행·열 추가/삭제
  await page.click('#toolbar [data-tool=lasso]');
  await page.waitForTimeout(400);
  const tsel = await S(tb.p, tb.it.x + 10, tb.it.y + tb.it.h - 5);
  await h.pen(cdp, [[X(tsel.x), Y(tsel.y), 0.5]]);
  await page.waitForTimeout(200);
  check('row/col buttons appear for a selected table', await page.locator('#selMenu [data-sel=tb-addRow]').isVisible());
  await page.click('#selMenu [data-sel=tb-addRow]');
  await page.click('#selMenu [data-sel=tb-addCol]');
  await page.click('#selMenu [data-sel=tb-addCol]');
  await page.click('#selMenu [data-sel=tb-delCol]');
  tb = await find('tb');
  check('add row / add col / delete col', tb.it.cells.length === 4 && tb.it.cells[0].length === 4 && tb.it.cells[1][2] === '우수');
  // 새로고침 후 유지 + 내보내기
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  check('checklist & table persist after reload', !!(await find('cl')) && (await find('tb')).it.cells[0][0] === '이름');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  await dl.saveAs(h.S + '/checktable.pdf');
  check('export with checklist & table', true);
  await page.screenshot({ path: h.S + '/checktable.png' });
  console.log(results.join('\n'));
  const errs = logs.filter((l) => /pageerror|\[error\]/.test(l));
  if (errs.length) console.log(errs.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1); });
