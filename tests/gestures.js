// 제스처 → 동작 설정 테스트
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, cdp, logs } = await h.launch();
  const url = process.env.APP_URL || 'http://localhost:8080/';
  // 1) 예전 설정(켜기/끄기)에서 옮겨 오기
  await page.goto(url);
  await page.evaluate(() => localStorage.setItem('flexnote.settings.v1', JSON.stringify({ sv: 2, holdEnabled: false, penDoubleTap: false, twoFingerUndo: false, penButtonAction: 'eraser' })));
  await page.reload();
  await page.waitForTimeout(400);
  const g = await page.evaluate(() => __flexnote.settings.get('gestures'));
  check('migrates old on/off settings', g.penHold === 'none' && g.penDoubleTap === 'none' && g.twoFingerTap === 'none' && g.penButton === 'eraserHold' && g.threeFingerTap === 'redo' && g.fingerHold === 'none', JSON.stringify(g));
  await page.evaluate(() => localStorage.removeItem('flexnote.settings.v1'));
  await page.reload();
  await page.waitForTimeout(300);
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const vp = await page.locator('#viewport').boundingBox();
  const X = (x) => vp.x + x, Y = (y) => vp.y + y;
  const tool = () => page.evaluate(() => __flexnote.settings.get('tool'));
  const items = () => page.evaluate(() => __flexnote.state.doc.totalItems());
  const menu = () => page.locator('#quickMenu').isVisible();
  const set = (k, v) => page.evaluate(([k, v]) => __flexnote.settings.set(`gestures.${k}`, v), [k, v]);
  const twoTap = async (n) => {
    const pts = [[X(500), Y(500), 1], [X(600), Y(500), 2], [X(700), Y(500), 3]].slice(0, n);
    for (let i = 1; i <= n; i++) await h.touch(cdp, 'touchStart', pts.slice(0, i));
    await h.touch(cdp, 'touchEnd', []);
  };

  // 2) 설정 창: 제스처마다 선택 칸
  await page.click('#btnSettings');
  check('settings dialog shows 6 gesture selectors', (await page.locator('[data-gesture]').count()) === 6);
  check('pen button has extra "누르는 동안 지우개" option', (await page.locator('[data-gesture=penButton] option[value=eraserHold]').count()) === 1);
  await page.selectOption('[data-gesture=penDoubleTap]', 'tool:hl');
  check('select changes the setting', (await page.evaluate(() => __flexnote.settings.get('gestures').penDoubleTap)) === 'tool:hl');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // 3) 펜 두 번 탭 → 형광펜 (점은 남지 않음)
  await h.pen(cdp, [[X(400), Y(300), 0.5]]);
  await page.waitForTimeout(80);
  await h.pen(cdp, [[X(402), Y(301), 0.5]]);
  check('pen double-tap → highlighter (no dots, no menu)', (await tool()) === 'hl' && (await items()) === 0 && !(await menu()), await tool());

  // 4) 펜 꾹 누르기 → 실행 취소
  await page.evaluate(() => __flexnote.settings.set('holdMs', 400));
  await set('penHold', 'undo');
  await page.click('#toolbar [data-tool=pen]');
  await h.pen(cdp, h.line(X(150), Y(200), X(450), Y(220), 10));
  const before = await items();
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: X(500), y: Y(450), button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5 });
  await page.waitForTimeout(600);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: X(500), y: Y(450), button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
  check('pen hold → undo (stroke removed, no dot)', (await items()) === before - 1 && !(await menu()), `${before}→${await items()}`);
  // 꾹 누르기 '사용 안 함' → 아무 일 없고 점만 남음
  await set('penHold', 'none');
  await page.waitForTimeout(400);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: X(500), y: Y(450), button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5 });
  await page.waitForTimeout(700);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: X(500), y: Y(450), button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
  check('pen hold "none" → no action, just a dot', !(await menu()) && (await items()) === before, `${await items()}`);

  // 5) 두 손가락 탭 → 지우개 ↔ 이전 도구
  await set('twoFingerTap', 'toggleEraser');
  await page.waitForTimeout(400);
  await twoTap(2);
  const t1 = await tool();
  await page.waitForTimeout(200);
  await twoTap(2);
  check('two-finger tap toggles eraser ↔ previous tool', t1 === 'eraser' && (await tool()) === 'pen', `${t1} → ${await tool()}`);

  // 6) 세 손가락 탭 → 직전 도구
  await set('threeFingerTap', 'prevTool');
  await page.click('#toolbar [data-tool=lasso]');
  await page.click('#toolbar [data-tool=text]');
  await twoTap(3);
  check('three-finger tap → previous tool', (await tool()) === 'lasso', await tool());

  // 7) 손가락 꾹 누르기 → 도구 메뉴, 이후 그 손가락은 화면을 움직이지 않음
  await set('fingerHold', 'menu');
  const ty0 = await page.evaluate(() => __flexnote.viewer.cam.ty);
  await h.touch(cdp, 'touchStart', [[X(300), Y(400), 5]]);
  await page.waitForTimeout(750);
  const holdMenu = await menu();
  for (let i = 1; i <= 4; i++) await h.touch(cdp, 'touchMove', [[X(300), Y(400 - i * 20), 5]]);
  await h.touch(cdp, 'touchEnd', [[X(300), Y(320), 5]]);
  check('finger hold → menu, finger no longer pans', holdMenu && (await page.evaluate(() => __flexnote.viewer.cam.ty)) === ty0);
  await page.keyboard.press('Escape');
  // 움직이면 꾹 누르기 아님 (일반 이동)
  await page.waitForTimeout(300);
  await h.touch(cdp, 'touchStart', [[X(300), Y(500), 6]]);
  for (let i = 1; i <= 4; i++) await h.touch(cdp, 'touchMove', [[X(300), Y(500 - i * 20), 6]]);
  await page.waitForTimeout(750);
  await h.touch(cdp, 'touchEnd', [[X(300), Y(420), 6]]);
  check('moving finger pans, no hold action', !(await menu()) && (await page.evaluate(() => __flexnote.viewer.cam.ty)) !== ty0);
  await page.waitForTimeout(600);

  // 8) S Pen 버튼 → 올가미 / 마우스 오른쪽은 항상 메뉴
  await set('penButton', 'tool:lasso');
  await page.click('#toolbar [data-tool=pen]');
  await h.pen(cdp, h.line(X(400), Y(300), X(402), Y(300), 2), { buttons: 2, button: 'right' });
  check('pen button → lasso tool', (await tool()) === 'lasso' && !(await menu()), await tool());
  await set('penButton', 'none');
  await page.waitForTimeout(700);
  await page.mouse.click(X(500), Y(500), { button: 'right' });
  check('mouse right-click still opens menu when pen button is "none"', await menu());

  console.log(results.join('\n'));
  const errs = logs.filter((l) => /pageerror|\[error\]/.test(l));
  if (errs.length) console.log(errs.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1); });
