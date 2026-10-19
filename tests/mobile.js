// 휴대폰 세로 화면 테스트: 넘침 없음, 핵심 버튼 보임, 손가락 쓰기 토글
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, cdp, logs } = await h.launch({ viewport: { width: 390, height: 844 }, dpr: 3 });
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  const lib = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, gear: document.querySelector('#btnLibSettings').getBoundingClientRect().right }));
  check('library fits 390px (settings button visible)', lib.w <= 390 && lib.gear <= 390, JSON.stringify(lib));
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const vis = (sel) => page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return r.right <= innerWidth + 0.5 && r.left >= 0 && !!e && (e === document.querySelector(sel) || document.querySelector(sel).contains(e)); }, sel);
  check('editor: no horizontal page overflow', (await page.evaluate(() => document.documentElement.scrollWidth)) <= 390);
  for (const sel of ['#btnSettings', '#btnExport', '#pageInd', '#btnUndo', '#btnRedo', '#toolbar [data-tool=pen]']) check(`visible & tappable: ${sel}`, await vis(sel));
  // 손가락 쓰기 토글 → 한 손가락으로 필기, 두 손가락 이동
  await page.click('#btnFinger');
  check('finger toggle on', await page.evaluate(() => __flexnote.settings.get('fingerDraw')));
  await page.waitForTimeout(400);
  await h.touch(cdp, 'touchStart', [[100, 300, 1]]);
  for (let i = 1; i <= 8; i++) await h.touch(cdp, 'touchMove', [[100 + i * 15, 300 + i * 5, 1]]);
  await h.touch(cdp, 'touchEnd', [[220, 340, 1]]);
  check('one finger writes on phone', (await page.evaluate(() => __flexnote.state.doc.totalItems())) === 1);
  const ty0 = await page.evaluate(() => __flexnote.viewer.cam.ty);
  await h.touch(cdp, 'touchStart', [[150, 500, 1]]);
  await h.touch(cdp, 'touchStart', [[150, 500, 1], [250, 500, 2]]);
  for (let i = 1; i <= 6; i++) await h.touch(cdp, 'touchMove', [[150, 500 - i * 20, 1], [250, 500 - i * 20, 2]]);
  await h.touch(cdp, 'touchEnd', []);
  check('two fingers pan on phone', Math.abs((await page.evaluate(() => __flexnote.viewer.cam.ty)) - ty0 + 120) < 2);
  await page.click('#btnFinger');
  // 빠른 메뉴가 화면 안에
  await page.evaluate(() => __flexnote.input.openMenu(380, 400, 'test'));
  const qm = await page.evaluate(() => { const r = document.querySelector('#quickMenu').getBoundingClientRect(); return { l: r.left, r: r.right }; });
  check('quick menu fits screen', qm.l >= 0 && qm.r <= 390, JSON.stringify(qm));
  console.log(results.join('\n'));
  const errs = logs.filter((l) => /pageerror|\[error\]/.test(l));
  if (errs.length) console.log(errs.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1); });
