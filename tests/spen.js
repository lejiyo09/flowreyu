// S Pen 버튼 / 상태 꼬임 회귀 테스트 (실기기에서 의심되는 이벤트 순서를 재현)
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
  const items = () => page.evaluate(() => __flexnote.state.doc.totalItems());
  const menu = () => page.locator('#quickMenu').isVisible();
  const closeMenu = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(750); };
  // 합성 포인터 이벤트 (실기기의 특이한 순서를 그대로 만들기 위해)
  const fire = (type, o) => page.evaluate(([type, o]) => {
    const el = document.querySelector('#viewport');
    const target = document.elementFromPoint(o.clientX, o.clientY) || el;
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, pressure: 0.5, ...o }));
  }, [type, o]);
  const panWorks = async (tag) => {
    const c0 = await page.evaluate(() => __flexnote.viewer.cam.ty);
    await h.touch(cdp, 'touchStart', [[X(600), Y(600), 7]]);
    for (let i = 1; i <= 5; i++) await h.touch(cdp, 'touchMove', [[X(600), Y(600 - i * 20), 7]]);
    await h.touch(cdp, 'touchEnd', [[X(600), Y(500), 7]]);
    const c1 = await page.evaluate(() => __flexnote.viewer.cam.ty);
    await page.waitForTimeout(700);
    const ok = Math.abs(c1 - c0 + 100) < 2;
    if (!ok) console.log(tag, await page.evaluate(() => __flexnote.input.stateText()));
    return ok;
  };
  const pinchWorks = async () => {
    const z0 = await page.evaluate(() => __flexnote.viewer.cam.z);
    await h.touch(cdp, 'touchStart', [[X(400), Y(400), 1]]);
    await h.touch(cdp, 'touchStart', [[X(400), Y(400), 1], [X(600), Y(400), 2]]);
    for (let i = 1; i <= 5; i++) await h.touch(cdp, 'touchMove', [[X(400 - i * 10), Y(400), 1], [X(600 + i * 10), Y(400), 2]]);
    await h.touch(cdp, 'touchEnd', []);
    const z1 = await page.evaluate(() => __flexnote.viewer.cam.z);
    await page.waitForTimeout(400);
    await page.evaluate(() => __flexnote.viewer.fitWidth());
    return z1 / z0 > 1.3;
  };

  // A. 정상: 펜 필기 후 손가락 이동/핀치
  await h.pen(cdp, h.line(X(200), Y(300), X(400), Y(320), 10));
  await page.waitForTimeout(400);
  check('A pen then finger pan', await panWorks('A'));
  check('A pen then pinch', await pinchWorks());

  // B. pointerup 누락: 펜 down/move 후 up 이 오지 않음 → 펜 호버 이벤트가 오면 복구
  await fire('pointerdown', { pointerType: 'pen', pointerId: 11, clientX: X(200), clientY: Y(400), button: 0, buttons: 1 });
  await fire('pointermove', { pointerType: 'pen', pointerId: 11, clientX: X(260), clientY: Y(410), button: -1, buttons: 1 });
  await fire('pointermove', { pointerType: 'pen', pointerId: 11, clientX: X(300), clientY: Y(380), button: -1, buttons: 0, pressure: 0 });
  await page.waitForTimeout(400);
  check('B missing pointerup + hover → stroke kept', (await items()) === 2);
  check('B missing pointerup + hover → finger pan works', await panWorks('B'));

  // C. pointerup 누락 + 호버도 없음 → 손가락이 닿으면 오래된 펜 상태 정리
  await fire('pointerdown', { pointerType: 'pen', pointerId: 12, clientX: X(200), clientY: Y(450), button: 0, buttons: 1 });
  await fire('pointermove', { pointerType: 'pen', pointerId: 12, clientX: X(260), clientY: Y(460), button: -1, buttons: 1 });
  await page.waitForTimeout(700);
  check('C stale pen (no events) → finger pan works', await panWorks('C'));
  check('C stale pen → pinch works', await pinchWorks());

  // D. 펜 버튼 + 터치가 "펜으로 닿은 뒤 마우스 우클릭"으로 바뀌어 오는 경우 (펜 pointerup 없음)
  const nD = await items();
  await fire('pointerdown', { pointerType: 'pen', pointerId: 13, clientX: X(500), clientY: Y(500), button: 0, buttons: 1 });
  await fire('pointerdown', { pointerType: 'mouse', pointerId: 1, clientX: X(500), clientY: Y(500), button: 2, buttons: 2 });
  await page.evaluate(([x, y]) => document.querySelector('#viewport').dispatchEvent(new PointerEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: 'mouse', button: 2 })), [X(500), Y(500)]);
  await fire('pointerup', { pointerType: 'mouse', pointerId: 1, clientX: X(500), clientY: Y(500), button: 2, buttons: 0 });
  check('D pen→mouse right-click opens menu', await menu());
  check('D no stray dot', (await items()) === nD);
  await closeMenu();
  check('D afterwards finger pan works', await panWorks('D'));

  // E. contextmenu 만 오는 경우 (pointerType 이 touch 로 보고됨, 펜 호버 직후)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X(450), y: Y(450), pointerType: 'pen', buttons: 0 });
  await page.evaluate(([x, y]) => document.querySelector('#viewport').dispatchEvent(new PointerEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: 'touch' })), [X(450), Y(450)]);
  check('E contextmenu(touch) right after pen → menu', await menu());
  await closeMenu();
  await page.waitForTimeout(1600);

  // F. 진짜 손가락 길게 누르기 contextmenu 는 무시
  await h.touch(cdp, 'touchStart', [[X(300), Y(300), 5]]);
  await page.evaluate(([x, y]) => document.querySelector('#viewport').dispatchEvent(new PointerEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: 'touch' })), [X(300), Y(300)]);
  await h.touch(cdp, 'touchEnd', []);
  check('F finger long-press ignored', !(await menu()));

  // G. CDP 실제 펜: 버튼 누른 채 닿기 / 필기 중 버튼 → 메뉴, 이후 손가락 정상
  await page.waitForTimeout(400);
  const nG = await items();
  await h.pen(cdp, h.line(X(400), Y(300), X(420), Y(300), 3), { buttons: 2, button: 'right' });
  check('G pen buttons=2 contact → menu', await menu());
  await closeMenu();
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: X(300), y: Y(400), button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X(303), y: Y(400), button: 'right', buttons: 3, pointerType: 'pen', force: 0.5 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: X(303), y: Y(400), button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
  check('G barrel mid-contact → menu, no dot', (await menu()) && (await items()) === nG);
  await closeMenu();
  check('G afterwards finger pan works', await panWorks('G'));
  check('G afterwards pen still writes', (await (async () => { await h.pen(cdp, h.line(X(200), Y(600), X(400), Y(620), 10)); return (await items()) === nG + 1; })()));

  // H. 손가락 기록만 남는 경우 (pointerup 누락) → touchend(0개) 로 정리
  await page.evaluate(() => { __flexnote.input.touch.touches.set(999, { x: 0, y: 0, x0: 0, y0: 0, rejected: true, reason: 'ghost' }); });
  await page.waitForTimeout(400);
  check('H ghost touch cleared, pan works', await panWorks('H'));

  console.log(results.join('\n'));
  const errs = logs.filter((l) => /pageerror|\[error\]/.test(l));
  if (errs.length) console.log(errs.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1); });
