// 글 입력 중 펜·스크롤 고장 회귀 테스트:
// 크게 확대한 채 긴 글을 쓰면 브라우저가 커서를 따라 화면 컨테이너를 스크롤해 필기 캔버스가 어긋나고,
// 입력칸이 화면 전체를 덮어 다른 곳을 눌러도 편집이 끝나지 않던 문제
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, cdp, logs } = await h.launch({ viewport: { width: 1280, height: 800 } });
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const vp = await page.locator('#viewport').boundingBox();
  const X = (x) => vp.x + x, Y = (y) => vp.y + y;
  const scrolls = () => page.evaluate(() => ['#viewport', '#overlay', '#world'].map((q) => { const e = document.querySelector(q); return e.scrollLeft + e.scrollTop; }).reduce((a, b) => a + b, 0));
  const ter = () => page.evaluate(() => { const r = document.querySelector('#textEditor').getBoundingClientRect(), v = document.querySelector('#viewport').getBoundingClientRect(); return { l: r.left - v.left, t: r.top - v.top, r: r.right - v.left, b: r.bottom - v.top, vw: v.width, vh: v.height }; });

  await page.evaluate(() => { const v = __flexnote.viewer; v.zoomAt(200, 200, v.cam.z * 4); });
  await page.waitForTimeout(300);
  await page.click('#toolbar [data-tool=text]');
  await page.waitForTimeout(400);
  await h.pen(cdp, [[X(300), Y(300), 0.5]]);
  await page.waitForTimeout(300);
  await page.keyboard.type('확대한 상태에서 입력하는 아주 긴 문장입니다 확대한 상태에서 입력하는 아주 긴 문장입니다');
  for (let i = 0; i < 5; i++) { await page.keyboard.press('Enter'); await page.keyboard.type('다음 줄 ' + i); }
  await page.waitForTimeout(200);
  check('typing a long text does not scroll the canvas area', (await scrolls()) === 0, await scrolls());
  const r = await ter();
  check('text box stays inside the visible area', r.r <= r.vw + 1 && r.b <= r.vh + 1, JSON.stringify(r));
  // 입력칸 밖을 펜으로 누르면 편집이 끝나고 (텍스트 도구라 새 입력이 시작될 수 있음) 글이 저장됨
  await h.pen(cdp, [[X(100), Y(700), 0.5]]);
  await page.waitForTimeout(300);
  const tx = await page.evaluate(() => __flexnote.state.doc.items(0).find((i) => i.t === 'tx'));
  check('tapping outside finishes the edit and keeps the text', tx && tx.text.includes('아주 긴 문장') && tx.text.includes('다음 줄 4'));
  await page.keyboard.press('Escape');
  // 펜이 누른 자리에 정확히 써짐
  await page.click('#toolbar [data-tool=pen]');
  await page.waitForTimeout(300);
  await h.pen(cdp, h.line(X(400), Y(450), X(700), Y(480), 10));
  await page.waitForTimeout(300);
  const st = await page.evaluate(() => __flexnote.state.doc.items(0).filter((i) => i.t === 's').at(-1));
  const w = await page.evaluate(() => __flexnote.viewer.pageAtScreen(400, 450));
  check('pen still writes exactly where it touches', st && Math.abs(st.pts[0] - w.x) < 1 && Math.abs(st.pts[1] - w.y) < 1, JSON.stringify([st?.pts.slice(0, 2), w]));
  // 손가락 스크롤
  await page.waitForTimeout(700);
  const ty0 = await page.evaluate(() => __flexnote.viewer.cam.ty);
  await h.touch(cdp, 'touchStart', [[X(600), Y(600), 3]]);
  for (let k = 1; k <= 6; k++) { await h.touch(cdp, 'touchMove', [[X(600), Y(600 - k * 30), 3]]); await page.waitForTimeout(16); }
  await h.touch(cdp, 'touchEnd', [[X(600), Y(420), 3]]);
  await page.waitForTimeout(200);
  check('finger scroll still works', (await page.evaluate(() => __flexnote.viewer.cam.ty)) < ty0 - 100);
  // 포스트잇 글 편집도 확대 상태에서 화면을 넘지 않음
  await page.evaluate(() => { const v = __flexnote.viewer; const c = v.pageAtScreen(300, 250); __flexnote.state.doc.add(0, { id: 'n1', t: 'nt', x: c.x, y: c.y, w: 300, h: 260, c: '#fff59d', fs: 14, text: '' }); });
  await page.click('#toolbar [data-tool=text]');
  await page.waitForTimeout(300);
  await h.pen(cdp, [[X(550), Y(560), 0.5]]); // 띠(위쪽 손잡이) 아래 본문
  await page.waitForTimeout(300);
  check('sticky note editing started', await page.evaluate(() => __flexnote.state.editing?.kind === 'note'));
  await page.keyboard.type('포스트잇 '.repeat(40));
  const r2 = await ter();
  check('sticky note editor also stays inside the screen, no scrolling', r2.r > r2.l && r2.r <= r2.vw + 1 && r2.b <= r2.vh + 1 && (await scrolls()) === 0, JSON.stringify(r2));
  // 혹시 스크롤돼도 바로 되돌아감
  await page.evaluate(() => { document.querySelector('#viewport').scrollTop = 300; document.querySelector('#viewport').dispatchEvent(new Event('scroll')); });
  await page.waitForTimeout(50);
  check('any forced scroll is undone', (await scrolls()) === 0);

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
