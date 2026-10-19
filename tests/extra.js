const h = require('./harness');
(async () => {
  const { browser, page, cdp, logs } = await h.launch();
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const n = () => page.evaluate(() => __flexnote.state.doc.totalItems());
  await page.evaluate(() => __flexnote.settings.set('fingerDraw', true));
  await h.touch(cdp, 'touchStart', [[300, 300, 1]]);
  for (let i = 1; i <= 8; i++) await h.touch(cdp, 'touchMove', [[300 + i * 20, 300, 1]]);
  await h.touch(cdp, 'touchEnd', [[460, 300, 1]]);
  console.log('fingerDraw one finger draws:', await n() === 1);
  const z0 = await page.evaluate(() => __flexnote.viewer.cam.z);
  await h.touch(cdp, 'touchStart', [[300, 400, 1]]);
  await h.touch(cdp, 'touchMove', [[305, 400, 1]]);
  await h.touch(cdp, 'touchStart', [[305, 400, 1], [500, 400, 2]]);
  for (let i = 1; i <= 8; i++) await h.touch(cdp, 'touchMove', [[305 - i * 10, 400, 1], [500 + i * 10, 400, 2]]);
  await h.touch(cdp, 'touchEnd', []);
  const z1 = await page.evaluate(() => __flexnote.viewer.cam.z);
  console.log('fingerDraw two fingers → pinch, no stray stroke:', z1 > z0 * 1.3, await n() === 1);
  await page.evaluate(() => __flexnote.settings.set('fingerDraw', false));
  // 호버 중 버튼
  await page.waitForTimeout(400);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 500, pointerType: 'pen', buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 401, y: 500, pointerType: 'pen', buttons: 2 });
  await page.waitForTimeout(100);
  console.log('hover+button menu:', await page.locator('#quickMenu').isVisible());
  // 마우스 오른쪽 클릭
  await page.keyboard.press('Escape'); await page.waitForTimeout(700);
  await page.mouse.click(500, 500, { button: 'right' });
  console.log('mouse right-click menu:', await page.locator('#quickMenu').isVisible());
  console.log(logs.filter(l => /pageerror/.test(l)).join('\n'));
  await browser.close();
})();
