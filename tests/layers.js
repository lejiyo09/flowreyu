// 레이어 + 그림 손잡이(이동·삭제) 테스트
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
  const S = (x, y) => page.evaluate(([x, y]) => __flexnote.viewer.pageToScreen(0, x, y), [x, y]);
  const items = () => page.evaluate(() => __flexnote.state.doc.items(0));
  const strokes = async () => (await items()).filter((i) => i.t === 's');
  const pix = (s) => page.evaluate(([x, y]) => { const v = __flexnote.viewer; return [...v.inkCtx.getImageData(Math.round(x * v.dpr), Math.round(y * v.dpr), 1, 1).data]; }, [s.x, s.y]);
  const setColor = (c) => page.evaluate((c) => __flexnote.settings.set('pen', { ...__flexnote.settings.get('pen'), color: c, width: 6 }), c);
  const draw = async (x0, y0, x1, y1) => { const a = await S(x0, y0), b = await S(x1, y1); await h.pen(cdp, h.line(X(a.x), Y(a.y), X(b.x), Y(b.y), 12)); await page.waitForTimeout(250); };
  const rows = () => page.evaluate(() => [...document.querySelectorAll('#lyList .ly-row')].map((r) => ({ id: r.dataset.id, on: r.classList.contains('on'), name: r.querySelector('.ly-name').textContent })));
  const rowBtn = (id, a) => page.click(`#lyList .ly-row[data-id="${id}"] button[data-a="${a}"]`);

  // 레이어 1 에 검은 가로선 A
  await setColor('#111111');
  await draw(120, 300, 320, 300);
  const A = (await strokes())[0];
  check('stroke on default layer has no ly field', A && !A.ly);
  await page.click('#btnLayers');
  await page.waitForTimeout(150);
  check('layer panel opens with one layer', (await rows()).length === 1 && await page.locator('#layerPanel').isVisible());

  // 레이어 추가 → 현재 레이어, 빨간 세로선 B (A 와 교차)
  await page.click('#lyAdd');
  await page.waitForTimeout(150);
  let R = await rows();
  check('add layer: 2 rows, new one on top & active', R.length === 2 && R[0].on && /레이어 2/.test(R[0].name), JSON.stringify(R));
  const L2 = R[0].id, L1 = R[1].id;
  await page.click('#lyClose');
  await setColor('#e53935');
  await draw(220, 220, 220, 380);
  const B = (await strokes()).find((s) => s.c === '#e53935');
  check('new stroke goes to active layer', B?.ly === L2, JSON.stringify(B?.ly));
  const cross = await S(220, 300), bOnly = await S(220, 350);
  check('upper layer drawn on top (red at crossing)', (await pix(cross))[0] > 180 && (await pix(cross))[1] < 120, JSON.stringify(await pix(cross)));

  // 지우개는 현재 레이어만: 레이어 2 가 현재일 때 레이어 1 의 A 를 문질러도 안 지워짐
  await page.click('#toolbar [data-tool=eraser]');
  await page.waitForTimeout(300);
  const ea = await S(150, 280), eb = await S(150, 320);
  await h.pen(cdp, h.line(X(ea.x), Y(ea.y), X(eb.x), Y(eb.y), 10));
  await page.waitForTimeout(250);
  check('eraser does not erase other (non-current) layer', (await strokes()).some((s) => s.id === A.id));
  await page.click('#toolbar [data-tool=pen]');
  await page.waitForTimeout(300);
  // 순서 바꾸기: 레이어 2 를 아래로 → 교차점은 검정
  await page.click('#btnLayers');
  await rowBtn(L2, 'down');
  await page.waitForTimeout(250);
  check('move layer down: lower layer now under (black at crossing)', (await pix(cross))[0] < 80, JSON.stringify(await pix(cross)));
  await rowBtn(L2, 'up');
  await page.waitForTimeout(200);

  // 숨기기 → 안 보이고, 지우개·올가미가 건드리지 않음, 현재 레이어는 다른 레이어로
  await rowBtn(L2, 'vis');
  await page.waitForTimeout(250);
  check('hidden layer is not drawn', (await pix(bOnly))[3] === 0, JSON.stringify(await pix(bOnly)));
  R = await rows();
  check('hiding active layer switches active to a usable layer', R.find((r) => r.id === L1).on);
  await page.click('#lyClose');
  await page.click('#toolbar [data-tool=eraser]');
  await page.waitForTimeout(300);
  const e0 = await S(180, 350), e1 = await S(260, 350);
  await h.pen(cdp, h.line(X(e0.x), Y(e0.y), X(e1.x), Y(e1.y), 10));
  await page.waitForTimeout(250);
  check('eraser does not erase hidden layer', (await strokes()).some((s) => s.id === B.id));
  // 보이기 + 잠그기 → 지우개로 안 지워짐
  await page.click('#btnLayers');
  await rowBtn(L2, 'vis');
  await rowBtn(L2, 'lock');
  await page.waitForTimeout(200);
  check('shown again', (await pix(bOnly))[3] > 200);
  await page.click('#lyClose');
  await h.pen(cdp, h.line(X(e0.x), Y(e0.y), X(e1.x), Y(e1.y), 10));
  await page.waitForTimeout(250);
  check('eraser does not erase locked layer', (await strokes()).some((s) => s.id === B.id));
  // 잠금 풀고 이름 바꾸기 (prompt 는 기본값 그대로 수락) → 새로고침 후 유지
  await page.click('#btnLayers');
  await rowBtn(L2, 'lock');
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(900);
  await page.click('#btnLayers');
  await page.waitForTimeout(150);
  R = await rows();
  check('layers persist after reload', R.length === 2 && R[0].id === L2, JSON.stringify(R));
  check('stroke layer persists after reload', (await strokes()).find((s) => s.c === '#e53935')?.ly === L2);

  // 선택한 객체를 현재 레이어로 옮기기
  await rowBtn(L2, 'pick');
  await page.click('#lyClose');
  await page.click('#toolbar [data-tool=lasso]');
  await page.waitForTimeout(400);
  const la = await S(130, 300);
  await h.pen(cdp, [[X(la.x), Y(la.y), 0.5]]);
  await page.waitForTimeout(200);
  await page.click('#btnLayers');
  await page.waitForTimeout(150);
  check('"move selection to layer" shown with a selection', await page.locator('#lyMoveSel').isVisible());
  await page.click('#lyMoveSel');
  await page.waitForTimeout(150);
  check('selected stroke moved to current layer', (await strokes()).find((s) => s.id === A.id)?.ly === L2);

  // 레이어 삭제 → 그 안의 객체도 삭제, 실행 취소로 객체 복구
  await rowBtn(L2, 'del');
  await page.waitForTimeout(200);
  check('delete layer removes its objects', (await rows()).length === 1 && (await strokes()).length === 0);
  await page.click('#btnUndo');
  await page.waitForTimeout(200);
  check('undo brings objects back (bottom layer)', (await strokes()).length === 2 && (await pix(cross))[3] > 200);
  await page.click('#lyClose');

  // ── 그림 손잡이: 끌어 옮기기, × 로 삭제 ──
  await page.click('#toolbar [data-tool=pen]');
  await page.setInputFiles('#imageInput', h.S + '/img.png');
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  await page.click('#toolbar [data-tool=pen]');
  await page.waitForTimeout(400);
  let im = (await items()).find((i) => i.t === 'im');
  check('image inserted', !!im);
  const bh = 18, z = await page.evaluate(() => __flexnote.viewer.cam.z);
  const g = await S(im.x + im.w * 0.3, im.y - bh / 2);
  const n0 = (await strokes()).length;
  await h.pen(cdp, h.line(X(g.x), Y(g.y), X(g.x + 40), Y(g.y + 30), 10));
  await page.waitForTimeout(250);
  let im2 = (await items()).find((i) => i.t === 'im');
  check('pen drag on image bar moves image (no stroke)', Math.abs(im2.x - im.x - 40 / z) < 2 && Math.abs(im2.y - im.y - 30 / z) < 2 && (await strokes()).length === n0, `${im.x}->${im2.x}`);
  await page.waitForTimeout(400);
  const del = await S(im2.x + im2.w - Math.min(bh * 1.3, im2.w * 0.3) / 2, im2.y - bh / 2);
  await h.pen(cdp, [[X(del.x), Y(del.y), 0.5]]);
  await page.waitForTimeout(250);
  check('pen tap on image × deletes it (no dot)', !(await items()).some((i) => i.t === 'im') && (await strokes()).length === n0);
  await page.click('#btnUndo');
  await page.waitForTimeout(200);
  check('undo restores image', (await items()).some((i) => i.t === 'im'));
  await page.waitForTimeout(400);
  await h.touch(cdp, 'touchStart', [[X(del.x), Y(del.y), 1]]);
  await h.touch(cdp, 'touchEnd', [[X(del.x), Y(del.y), 1]]);
  await page.waitForTimeout(250);
  check('finger tap on image × deletes it', !(await items()).some((i) => i.t === 'im'));
  await page.click('#btnUndo');

  // 숨긴 레이어가 있어도 내보내기 정상
  await page.click('#btnLayers');
  await page.click('#lyAdd');
  const L3 = (await rows())[0].id;
  await rowBtn(L3, 'vis');
  await page.click('#lyClose');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  await dl.saveAs(h.S + '/layers-export.pdf');
  check('export with hidden layer works', true);

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
