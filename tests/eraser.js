// 지우개 "한 번 지우면 이전 도구로" 옵션 테스트
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
  const tool = () => page.evaluate(() => __flexnote.settings.get('tool'));
  const items = () => page.evaluate(() => __flexnote.state.doc.totalItems());
  const draw = (y) => h.pen(cdp, h.line(X(150), Y(y), X(450), Y(y), 12));
  const erase = (y) => h.pen(cdp, h.line(X(300), Y(y - 30), X(300), Y(y + 30), 6));

  // 기본값: 꺼짐 → 지운 뒤에도 지우개 유지
  await draw(200);
  await page.click('#toolbar [data-tool=eraser]');
  await erase(200);
  check('default off: stays eraser after erasing', (await tool()) === 'eraser' && (await items()) === 0, await tool());
  // 지우개 팝업에서 켜기
  await page.click('#toolbar [data-tool=eraser]'); // 선택된 도구를 다시 누르면 팝업
  await page.waitForSelector('#toolPopup:not([hidden])');
  await page.locator('#toolPopup .row', { hasText: '이전 도구로' }).locator('input').check();
  check('toggle in eraser popup turns option on', await page.evaluate(() => __flexnote.settings.get('eraser').autoReturn === true));
  await page.keyboard.press('Escape');
  // 펜 → 지우개 → 한 번 지우면 펜
  await page.click('#toolbar [data-tool=pen]');
  await draw(260);
  await page.click('#toolbar [data-tool=eraser]');
  await erase(260);
  check('on: one erase stroke → back to pen', (await tool()) === 'pen' && (await items()) === 0, await tool());
  check('toolbar highlights pen again', (await page.locator('#toolbar [data-tool=pen].on').count()) === 1);
  // 형광펜 → 지우개 → 형광펜
  await page.click('#toolbar [data-tool=hl]');
  await draw(320);
  await page.click('#toolbar [data-tool=eraser]');
  await erase(320);
  check('on: returns to the tool used before (highlighter)', (await tool()) === 'hl', await tool());
  // 빠른 메뉴로 지우개를 골라도 동일
  await page.click('#toolbar [data-tool=pen]');
  await draw(380);
  await page.evaluate(() => __flexnote.input.openMenu(400, 300, 'test'));
  await page.click('#quickMenu [data-tool=eraser]');
  await erase(380);
  check('eraser picked from quick menu also returns to pen', (await tool()) === 'pen', await tool());
  // 펜 버튼을 "누르는 동안 지우개"로 쓴 경우는 도구 변경 없음
  await page.evaluate(() => __flexnote.settings.set('penButtonAction', 'eraser'));
  await page.click('#toolbar [data-tool=hl]');
  await draw(440);
  await h.pen(cdp, h.line(X(300), Y(410), X(300), Y(470), 6), { buttons: 2, button: 'right' });
  check('temporary eraser (pen button) keeps current tool', (await tool()) === 'hl' && (await items()) === 0, `${await tool()} items=${await items()}`);
  // 설정 유지 + 설정 창 반영
  await page.reload();
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(600);
  await page.click('#btnSettings');
  check('option persists and shows in settings dialog', await page.locator('#setEraserReturn').isChecked());
  await page.locator('#setEraserReturn').uncheck();
  check('settings dialog can turn it off', await page.evaluate(() => __flexnote.settings.get('eraser').autoReturn === false));
  console.log(results.join('\n'));
  const errs = logs.filter((l) => /pageerror|\[error\]/.test(l));
  if (errs.length) console.log(errs.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1); });
