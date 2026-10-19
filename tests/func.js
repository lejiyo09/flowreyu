const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); };
(async () => {
  const { browser, page, cdp, logs } = await h.launch();
  const ev = (f, a) => page.evaluate(f, a);
  const items = (p = 0) => page.evaluate((p) => __flexnote.state.doc.items(p).length, p);
  await page.goto('http://localhost:8080/');
  await page.waitForTimeout(600);
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(1200);
  const vp = await page.locator('#viewport').boundingBox();
  const X = (x) => vp.x + x, Y = (y) => vp.y + y;

  // 1. 펜 필기
  await h.pen(cdp, h.line(X(200), Y(300), X(500), Y(380), 30, 0.7));
  check('pen stroke adds item', (await items()) === 1);
  const st = await ev(() => { const it = __flexnote.state.doc.items(0)[0]; return { t: it.t, pr: it.pr, n: it.pts.length / 3, x: it.pts[0], y: it.pts[1] }; });
  // 좌표 대응: 화면(200,300) → 페이지 좌표
  const exp = await ev(() => { const v = __flexnote.viewer; const w = v.toWorld(200, 300); return { x: w.x - v.pages[0].x, y: w.y - v.pages[0].y }; });
  check('stroke coords map to page', Math.abs(st.x - exp.x) < 1 && Math.abs(st.y - exp.y) < 1, JSON.stringify({ st, exp }));
  check('pen pressure recorded', st.pr === true);

  // 2. 손가락 한 개 → 필기 안 됨, 화면 이동
  await page.waitForTimeout(400); // pen guard
  const cam0 = await ev(() => ({ ...__flexnote.viewer.cam }));
  await h.touch(cdp, 'touchStart', [[X(600), Y(600), 1]]);
  for (let i = 1; i <= 10; i++) await h.touch(cdp, 'touchMove', [[X(600), Y(600 - i * 20), 1]]);
  await h.touch(cdp, 'touchEnd', []);
  const cam1 = await ev(() => ({ ...__flexnote.viewer.cam }));
  check('one-finger pan moves view', Math.abs((cam1.ty - cam0.ty) + 200) < 2, `dy=${cam1.ty - cam0.ty}`);
  check('finger did not draw', (await items()) === 1);
  await page.waitForTimeout(800); // inertia 정지

  // 3. 두 손가락 핀치
  const c2 = await ev(() => ({ ...__flexnote.viewer.cam }));
  const anchorW = await ev(() => __flexnote.viewer.toWorld(500, 400));
  await h.touch(cdp, 'touchStart', [[X(400), Y(400), 1]]);
  await h.touch(cdp, 'touchStart', [[X(400), Y(400), 1], [X(600), Y(400), 2]]);
  for (let i = 1; i <= 10; i++) await h.touch(cdp, 'touchMove', [[X(400 - i * 10), Y(400 + i * 3), 1], [X(600 + i * 10), Y(400 + i * 3), 2]]);
  const mid = await ev(() => ({ ...__flexnote.viewer.cam }));
  const anchorS = await ev((w) => __flexnote.viewer.toScreen(w.x, w.y), anchorW);
  check('pinch zooms', Math.abs(mid.z / c2.z - 2) < 0.02, `ratio=${(mid.z / c2.z).toFixed(3)}`);
  check('pinch anchor follows midpoint (zoom+pan)', Math.abs(anchorS.x - 500) < 1.5 && Math.abs(anchorS.y - 430) < 1.5, JSON.stringify(anchorS));
  // 한 손가락 떼기 → 튀지 않아야 함
  await h.touch(cdp, 'touchEnd', [[X(300), Y(430), 1]]);
  const afterLift = await ev(() => ({ ...__flexnote.viewer.cam }));
  check('lifting one finger does not jump', Math.abs(afterLift.tx - mid.tx) < 0.5 && Math.abs(afterLift.ty - mid.ty) < 0.5);
  await h.touch(cdp, 'touchMove', [[X(720), Y(450), 2]]);
  const afterMove = await ev(() => ({ ...__flexnote.viewer.cam }));
  check('remaining finger continues pan smoothly', Math.abs(afterMove.tx - afterLift.tx - 20) < 1 && Math.abs(afterMove.ty - afterLift.ty - 20) < 1, JSON.stringify({afterLift, afterMove}));
  await h.touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(800);

  // 4. 확대 상태 필기 좌표
  await h.pen(cdp, h.line(X(300), Y(500), X(400), Y(520), 10));
  const zst = await ev(() => { const v = __flexnote.viewer; const its = __flexnote.state.doc; let found = null; for (const p of v.pages) { const a = its.items(p.index); if (a.length && a[a.length - 1].pts.length < 200 && p.index >= 0) found = { page: p.index, it: a[a.length - 1] }; } const s = v.pageToScreen(found.page, found.it.pts[0], found.it.pts[1]); return s; });
  check('zoomed stroke screen position matches pen', Math.abs(zst.x - 300) < 1 && Math.abs(zst.y - 500) < 1, JSON.stringify(zst));

  // 5. 팜 리젝션: 펜이 닿은 상태에서 손가락 → 이동 안 됨
  const totalBefore = await ev(() => __flexnote.state.doc.totalItems());
  const pc = await ev(() => ({ ...__flexnote.viewer.cam }));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: X(200), y: Y(200), button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5 });
  await h.touch(cdp, 'touchStart', [[X(700), Y(600), 9]]);
  for (let i = 1; i <= 5; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X(200 + i * 20), y: Y(200), button: 'left', buttons: 1, pointerType: 'pen', force: 0.5 });
    await h.touch(cdp, 'touchMove', [[X(700 + i * 15), Y(600 - i * 15), 9]]);
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: X(300), y: Y(200), button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
  await h.touch(cdp, 'touchMove', [[X(800), Y(500), 9]]);
  await h.touch(cdp, 'touchEnd', []);
  const pc2 = await ev(() => ({ ...__flexnote.viewer.cam }));
  check('touch during pen does not pan', pc.tx === pc2.tx && pc.ty === pc2.ty);
  check('pen stroke still recorded with palm', (await ev(() => __flexnote.state.doc.totalItems())) === totalBefore + 1);
  // 큰 접촉면
  await page.waitForTimeout(500);
  await h.touch(cdp, 'touchStart', [[X(700), Y(600), 3, 40]]);
  for (let i = 1; i <= 5; i++) await h.touch(cdp, 'touchMove', [[X(700), Y(600 - i * 20), 3, 40]]);
  await h.touch(cdp, 'touchEnd', []);
  const pc3 = await ev(() => ({ ...__flexnote.viewer.cam }));
  check('large contact (palm) ignored', pc3.ty === pc2.ty);
  // 펜 직전 손바닥 이동 되돌리기
  await page.waitForTimeout(500);
  await h.touch(cdp, 'touchStart', [[X(700), Y(600), 4]]);
  for (let i = 1; i <= 3; i++) await h.touch(cdp, 'touchMove', [[X(700), Y(600 - i * 10), 4]]);
  await h.pen(cdp, h.line(X(250), Y(250), X(300), Y(260), 5), { hover: false });
  await h.touch(cdp, 'touchMove', [[X(700), Y(500), 4]]);
  await h.touch(cdp, 'touchEnd', []);
  const pc4 = await ev(() => ({ ...__flexnote.viewer.cam }));
  check('palm-before-pen pan restored', pc4.ty === pc3.ty, `${pc4.ty} vs ${pc3.ty}`);

  // 6. S Pen 버튼(buttons=2) 접촉 → 메뉴, 필기 안 됨
  await page.waitForTimeout(400);
  const n0 = await ev(() => __flexnote.state.doc.totalItems());
  await h.pen(cdp, h.line(X(400), Y(300), X(420), Y(300), 3), { buttons: 2, button: 'right' });
  const menuOpen = await page.locator('#quickMenu').isVisible();
  check('pen barrel (buttons=2) opens tool menu', menuOpen);
  check('barrel press does not draw', (await ev(() => __flexnote.state.doc.totalItems())) === n0);
  // 메뉴에서 형광펜 선택
  await page.locator('#quickMenu [data-tool=hl]').click();
  check('menu selects tool', (await ev(() => __flexnote.settings.get('tool'))) === 'hl' && !(await page.locator('#quickMenu').isVisible()));
  // 필기 도중 버튼 누름
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: X(300), y: Y(400), button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X(302), y: Y(400), button: 'left', buttons: 1, pointerType: 'pen', force: 0.5 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X(303), y: Y(400), button: 'right', buttons: 3, pointerType: 'pen', force: 0.5 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: X(303), y: Y(400), button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
  check('barrel pressed mid-contact opens menu, discards dot', (await page.locator('#quickMenu').isVisible()) && (await ev(() => __flexnote.state.doc.totalItems())) === n0);
  await page.keyboard.press('Escape');
  // contextmenu 경로 (pointerType 없는 경우 최근 펜으로 추정)
  await page.waitForTimeout(700);
  await ev(() => { document.querySelector('#viewport').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 })); });
  check('contextmenu after pen opens menu', await page.locator('#quickMenu').isVisible());
  await page.keyboard.press('Escape');
  // 손가락 길게 누르기 contextmenu → 무시
  await page.waitForTimeout(700);
  await ev(() => { document.querySelector('#viewport').dispatchEvent(new PointerEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300, pointerType: 'touch' })); });
  check('finger long-press contextmenu ignored', !(await page.locator('#quickMenu').isVisible()));

  // 7. 정지 감지
  await ev(() => __flexnote.settings.set('holdMs', 400));
  const n1 = await ev(() => __flexnote.state.doc.totalItems());
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: X(500), y: Y(450), button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X(502), y: Y(451), button: 'left', buttons: 1, pointerType: 'pen', force: 0.5 });
  await page.waitForTimeout(550);
  const holdOpen = await page.locator('#quickMenu').isVisible();
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X(560), y: Y(451), button: 'left', buttons: 1, pointerType: 'pen', force: 0.5 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: X(560), y: Y(451), button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
  check('hold opens menu', holdOpen);
  check('hold: no stroke after menu (pointer consumed)', (await ev(() => __flexnote.state.doc.totalItems())) === n1);
  await page.keyboard.press('Escape');
  // 움직이면 열리지 않음
  await page.waitForTimeout(400);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: X(500), y: Y(450), button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X(540), y: Y(450), button: 'left', buttons: 1, pointerType: 'pen', force: 0.5 });
  await page.waitForTimeout(600);
  const noHold = !(await page.locator('#quickMenu').isVisible());
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: X(540), y: Y(450), button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
  check('moving pen cancels hold (start mode)', noHold);
  check('highlighter stroke saved as hl', (await ev(() => { const a = []; for (const v of __flexnote.state.doc.pages.values()) a.push(...v); return a[a.length - 1].tool; })) === 'hl');
  await ev(() => __flexnote.settings.set('holdMs', 700));

  // 8. Undo / Redo
  const u0 = await ev(() => __flexnote.state.doc.totalItems());
  await page.click('#btnUndo');
  const u1 = await ev(() => __flexnote.state.doc.totalItems());
  await page.click('#btnRedo');
  const u2 = await ev(() => __flexnote.state.doc.totalItems());
  check('undo/redo', u1 === u0 - 1 && u2 === u0, `${u0} ${u1} ${u2}`);
  // 두 손가락 탭
  await page.waitForTimeout(400);
  await h.touch(cdp, 'touchStart', [[X(500), Y(500), 1]]);
  await h.touch(cdp, 'touchStart', [[X(500), Y(500), 1], [X(600), Y(500), 2]]);
  await h.touch(cdp, 'touchEnd', []);
  check('two-finger tap undo', (await ev(() => __flexnote.state.doc.totalItems())) === u0 - 1);
  await h.touch(cdp, 'touchStart', [[X(500), Y(500), 1]]);
  await h.touch(cdp, 'touchStart', [[X(500), Y(500), 1], [X(600), Y(500), 2]]);
  await h.touch(cdp, 'touchStart', [[X(500), Y(500), 1], [X(600), Y(500), 2], [X(700), Y(500), 3]]);
  await h.touch(cdp, 'touchEnd', []);
  check('three-finger tap redo', (await ev(() => __flexnote.state.doc.totalItems())) === u0);

  // 9. 지우개 (획)
  await page.waitForTimeout(400);
  await ev(() => { __flexnote.settings.set('tool', 'pen'); __flexnote.viewer.fitWidth(); __flexnote.viewer.goToPage(0); __flexnote.state.doc.setItems(0, []); });
  await page.waitForTimeout(300);
  await h.pen(cdp, h.line(X(100), Y(150), X(400), Y(150), 20));
  const e0 = await ev(() => __flexnote.state.doc.totalItems());
  await ev(() => __flexnote.settings.set('tool', 'eraser'));
  await h.pen(cdp, h.line(X(250), Y(120), X(250), Y(180), 6));
  const e1 = await ev(() => __flexnote.state.doc.totalItems());
  check('stroke eraser removes stroke', e1 === e0 - 1, `${e0}->${e1}`);
  await page.click('#btnUndo');
  // 부분 지우개
  await ev(() => __flexnote.settings.set('eraser', { mode: 'area', size: 16 }));
  await h.pen(cdp, h.line(X(250), Y(120), X(250), Y(180), 6));
  const e2 = await ev(() => __flexnote.state.doc.totalItems());
  check('area eraser splits stroke in two', e2 === e0 + 1, `${e0}->${e2}`);
  await ev(() => __flexnote.settings.set('eraser', { mode: 'stroke', size: 16 }));

  // 10. 올가미 이동
  await ev(() => __flexnote.settings.set('tool', 'lasso'));
  const before = await ev(() => __flexnote.state.doc.items(0).map(i => i.id));
  await h.pen(cdp, [[X(80), Y(120)], [X(450), Y(120)], [X(450), Y(190)], [X(80), Y(190)], [X(80), Y(125)]].map(p => [...p, 0.5]));
  const selN = await ev(() => __flexnote.tools.selection?.ids.size || 0);
  check('lasso selects the two pieces', selN === 2, `sel=${selN}`);
  const bb0 = await ev(() => __flexnote.tools.selectionBBox());
  await h.pen(cdp, h.line(X(150), Y(150), X(250), Y(250), 10));
  const bb1 = await ev(() => __flexnote.tools.selectionBBox());
  const z = await ev(() => __flexnote.viewer.cam.z);
  check('lasso drag moves selection', Math.abs((bb1.y - bb0.y) * z - 100) < 2, `${(bb1.y - bb0.y) * z}`);
  check('selection menu visible', await page.locator('#selMenu').isVisible());
  await page.click('#selMenu [data-sel=delete]');
  check('selection delete', (await ev(() => __flexnote.state.doc.totalItems())) === e2 - 2);

  // 11. 텍스트
  await ev(() => __flexnote.settings.set('tool', 'text'));
  await h.pen(cdp, [[X(150), Y(600), 0.5]]);
  await page.waitForTimeout(100);
  await page.keyboard.type('안녕 FlexNote');
  await h.pen(cdp, [[X(600), Y(700), 0.5]]); // 다른 곳 탭 → 확정 후 새 상자
  await page.keyboard.press('Escape');
  const tx = await ev(() => __flexnote.state.doc.items(0).filter(i => i.t === 'tx').map(i => i.text));
  check('text item created', tx.length === 1 && tx[0] === '안녕 FlexNote', JSON.stringify(tx));

  // 12. 도형
  await ev(() => __flexnote.settings.set('tool', 'shape'));
  await h.pen(cdp, h.line(X(300), Y(300), X(450), Y(400), 10));
  check('shape created', (await ev(() => __flexnote.state.doc.items(0).filter(i => i.t === 'sh').length)) === 1);
  await ev(() => __flexnote.settings.set('tool', 'pen'));
  await page.waitForTimeout(400);
  await page.screenshot({ path: h.S + '/s2.png' });

  // 13. 자동 저장 → 새로고침 복구
  await page.waitForTimeout(1200);
  const saveState = await page.locator('#saveState').getAttribute('data-state');
  check('autosave state saved', saveState === 'saved', saveState);
  const snap = await ev(() => JSON.stringify([...__flexnote.state.doc.pages.entries()].filter(([, v]) => v.length)));
  const camBefore = await ev(() => __flexnote.viewer.anchor());
  await page.reload();
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(1000);
  const snap2 = await ev(() => JSON.stringify([...__flexnote.state.doc.pages.entries()].filter(([, v]) => v.length)));
  check('reload restores last doc + all ink', snap === snap2, `${snap.length} vs ${snap2.length}`);
  const camAfter = await ev(() => __flexnote.viewer.anchor());
  check('reload restores view position', camAfter.page === camBefore.page && Math.abs(camAfter.zr - camBefore.zr) < 0.01, JSON.stringify({camBefore, camAfter}));

  // 14. 내보내기
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  await dl.saveAs(h.S + '/exported.pdf');
  check('export downloads pdf', true, dl.suggestedFilename());

  await page.screenshot({ path: h.S + '/s3.png' });
  console.log(results.join('\n'));
  const errs = logs.filter(l => /error|reqfail|warn/i.test(l));
  console.log('--- console issues ---\n' + errs.join('\n'));
  await browser.close();
})().catch(e => { console.log(results.join('\n')); console.error(e); process.exit(1); });
