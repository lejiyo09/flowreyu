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

  // ── 항목 추가: Enter / Shift+Enter / Ctrl+Enter 모두 새 항목, 입력 중에도 상자가 바로 보임 ──
  await page.click('#btnChecklist');
  await page.waitForTimeout(150);
  await page.keyboard.type('하나');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('둘');
  await page.keyboard.press('Control+Enter');
  await page.keyboard.type('셋');
  await page.keyboard.press('Enter');
  await page.keyboard.type('넷');
  check('boxes appear while typing (live preview)', (await page.evaluate(() => __flexnote.viewer.preview?.rows.length)) === 4, String(await page.evaluate(() => __flexnote.viewer.preview?.rows.length)));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const clNew = await page.evaluate(() => { for (const its of __flexnote.state.doc.pages.values()) { const c = its.filter((i) => i.t === 'cl').at(-1); if (c && c.rows[0].text === '하나') return c.rows.map((r) => r.text); } return null; });
  check('Shift+Enter / Ctrl+Enter / Enter add items', JSON.stringify(clNew) === JSON.stringify(['하나', '둘', '셋', '넷']), JSON.stringify(clNew));
  check('preview cleared after editing', !(await page.evaluate(() => __flexnote.viewer.preview)));
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);

  // ── 체크리스트 손잡이 띠: 끌어 옮기기, × 탭으로 삭제 ──
  await page.click('#toolbar [data-tool=pen]');
  await page.waitForTimeout(400);
  cl = await find('cl');
  const clBar = (it) => Math.max(12, Math.min(22, it.fs * 1.6));
  const zz = await page.evaluate(() => __flexnote.viewer.cam.z);
  let hb = await S(cl.p, cl.it.x + cl.it.w * 0.3, cl.it.y - clBar(cl.it) / 2);
  const sc0 = await strokes();
  await h.pen(cdp, h.line(X(hb.x), Y(hb.y), X(hb.x + 50), Y(hb.y + 30), 10));
  await page.waitForTimeout(200);
  let cl2 = await find('cl');
  check('pen drag on checklist bar moves it (no stroke)', Math.abs(cl2.it.x - cl.it.x - 50 / zz) < 2 && Math.abs(cl2.it.y - cl.it.y - 30 / zz) < 2 && (await strokes()) === sc0, `${cl.it.x}->${cl2.it.x}`);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  const clDel = async (it) => { const bh = clBar(it), sz = Math.min(bh * 1.3, it.w * 0.3); return S(cl.p, it.x + it.w - sz / 2, it.y - bh / 2); };
  let cdp1 = await clDel(cl.it);
  await h.pen(cdp, [[X(cdp1.x), Y(cdp1.y), 0.5]]);
  await page.waitForTimeout(200);
  check('pen tap on checklist × deletes it (no dot)', !(await find('cl')) && (await strokes()) === sc0);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  check('undo restores checklist with its rows', (await find('cl'))?.it.rows.length === 4);
  await h.touch(cdp, 'touchStart', [[X(cdp1.x), Y(cdp1.y), 1]]);
  await h.touch(cdp, 'touchEnd', [[X(cdp1.x), Y(cdp1.y), 1]]);
  await page.waitForTimeout(200);
  check('finger tap on checklist × deletes it', !(await find('cl')));
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);

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

  // ── 표 손잡이 띠: 끌어 옮기기(펜·손가락), × 탭으로 삭제 ──
  await page.click('#toolbar [data-tool=pen]');
  await page.waitForTimeout(400);
  tb = await find('tb');
  const barH = (it) => Math.max(12, Math.min(22, it.fs * 1.6));
  // 표 위에 펜으로 한 획 (같이 움직여야 함)
  const a0 = await S(tb.p, tb.it.x + tb.it.w * 0.3, tb.it.y + tb.it.h * 0.6), a1 = await S(tb.p, tb.it.x + tb.it.w * 0.6, tb.it.y + tb.it.h * 0.6);
  await h.pen(cdp, h.line(X(a0.x), Y(a0.y), X(a1.x), Y(a1.y), 8));
  await page.waitForTimeout(150);
  const inkOn = () => page.evaluate(([p]) => __flexnote.state.doc.items(p).filter((i) => i.t === 's').at(-1), [tb.p]);
  const ink0 = await inkOn();
  const s0n = await strokes();
  const bar = async (it, fx) => S(tb.p, it.x + it.w * fx, it.y - barH(it) / 2);
  let g0 = await bar(tb.it, 0.3);
  await h.pen(cdp, h.line(X(g0.x), Y(g0.y), X(g0.x + 60), Y(g0.y + 40), 10));
  await page.waitForTimeout(200);
  let tb2 = await find('tb');
  const z = await page.evaluate(() => __flexnote.viewer.cam.z);
  const ink1 = await page.evaluate(([p, id]) => __flexnote.state.doc.items(p).find((i) => i.id === id), [tb.p, ink0.id]);
  check('pen drag on table bar moves table (no stroke drawn)', Math.abs(tb2.it.x - tb.it.x - 60 / z) < 2 && Math.abs(tb2.it.y - tb.it.y - 40 / z) < 2 && (await strokes()) === s0n, `${tb.it.x}->${tb2.it.x}`);
  check('ink written on table moves with it', ink1 && Math.abs(ink1.pts[0] - ink0.pts[0] - 60 / z) < 2);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  check('undo restores table position', Math.abs((await find('tb')).it.x - tb.it.x) < 0.01);
  // 손가락으로 끌기
  await page.waitForTimeout(400);
  g0 = await bar(tb.it, 0.4);
  await h.touch(cdp, 'touchStart', [[X(g0.x), Y(g0.y), 1]]);
  for (let i = 1; i <= 8; i++) { await h.touch(cdp, 'touchMove', [[X(g0.x - i * 5), Y(g0.y + i * 4), 1]]); await page.waitForTimeout(16); }
  await h.touch(cdp, 'touchEnd', [[X(g0.x - 40), Y(g0.y + 32), 1]]);
  await page.waitForTimeout(200);
  tb2 = await find('tb');
  check('finger drag on table bar moves table (no pan)', Math.abs(tb2.it.x - tb.it.x + 40 / z) < 2 && Math.abs(tb2.it.y - tb.it.y - 32 / z) < 2, `${tb2.it.x - tb.it.x}`);
  // × 펜 탭 → 삭제 (점 안 찍힘), 실행 취소로 복구
  await page.waitForTimeout(400);
  const delPt = async (it) => { const bh = barH(it), s = Math.min(bh * 1.3, it.w * 0.3); return S(tb.p, it.x + it.w - s / 2, it.y - bh / 2); };
  let dp = await delPt(tb2.it);
  const s1n = await strokes();
  await h.pen(cdp, [[X(dp.x), Y(dp.y), 0.5]]);
  await page.waitForTimeout(200);
  check('pen tap on × deletes table + its ink, no dot', !(await find('tb')) && (await strokes()) === s1n - 1, String(await strokes()));
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  check('undo brings table back', !!(await find('tb')) && (await strokes()) === s1n);
  // 손가락 탭으로도 삭제
  await page.waitForTimeout(400);
  dp = await delPt((await find('tb')).it);
  await h.touch(cdp, 'touchStart', [[X(dp.x), Y(dp.y), 1]]);
  await h.touch(cdp, 'touchEnd', [[X(dp.x), Y(dp.y), 1]]);
  await page.waitForTimeout(200);
  check('finger tap on × deletes table', !(await find('tb')));
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  await page.screenshot({ path: h.S + '/checktable.png' });
  console.log(results.join('\n'));
  const errs = logs.filter((l) => /pageerror|\[error\]/.test(l));
  if (errs.length) console.log(errs.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1); });
