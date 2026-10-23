// 도구 모음 옮기기·방향: 손잡이로 끌어 가장자리에 붙이기(위·아래 가로, 왼쪽·오른쪽 세로), 띄우기, 탭으로 가로/세로, 저장·초기화
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, cdp, logs } = await h.launch();
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(400);
  await page.evaluate(() => __flexnote.settings.set('toolbar', { dock: 'bottom', vertical: false, x: 0, y: 0 }));
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(700);
  const tb = () => page.evaluate(() => { const t = document.querySelector('#toolbar'); const r = t.getBoundingClientRect(); return { cls: t.className, x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; });
  const dragGrip = async (tx, ty) => {
    const g = await page.locator('#tbGrip').boundingBox();
    const sx = g.x + g.width / 2, sy = g.y + g.height / 2;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    for (let k = 1; k <= 12; k++) await page.mouse.move(sx + (tx - sx) * k / 12, sy + (ty - sy) * k / 12);
    await page.mouse.up();
    await page.waitForTimeout(200);
  };
  const vw = 1200, vh = 860;
  let t = await tb();
  check('default: docked at bottom, horizontal', /dock-bottom/.test(t.cls) && !/vertical/.test(t.cls) && t.w > t.h);

  // 왼쪽 가장자리로 → 세로
  await dragGrip(20, vh / 2);
  t = await tb();
  check('drag to left edge → docked left, vertical', /dock-left/.test(t.cls) && /vertical/.test(t.cls) && t.h > t.w && t.x < 30, JSON.stringify(t));
  check('position saved', (await page.evaluate(() => __flexnote.settings.get('toolbar').dock)) === 'left');
  // 세로일 때 굵기 팝업은 도구 모음 오른쪽에
  await page.click('#widthDot');
  await page.waitForTimeout(150);
  const pop = await page.locator('#toolPopup').boundingBox();
  check('tool popup opens beside vertical toolbar', pop && pop.x >= t.right, JSON.stringify(pop));
  await page.click('#widthDot');
  // 세로에서도 도구 버튼 동작
  await page.click('#toolbar [data-tool=hl]');
  check('tool buttons work when vertical', (await page.evaluate(() => __flexnote.settings.get('tool'))) === 'hl');
  await page.click('#toolbar [data-tool=pen]');

  // 위쪽 가장자리 → 가로, 위쪽 바 아래
  await dragGrip(vw / 2 - 200, 52 + 30);
  t = await tb();
  const topH = await page.evaluate(() => document.querySelector('#editor > .topbar').getBoundingClientRect().bottom);
  check('drag to top → docked top, horizontal, below top bar', /dock-top/.test(t.cls) && !/vertical/.test(t.cls) && t.y >= topH, JSON.stringify(t));

  // 가운데 → 떠 있음, 놓은 자리 유지
  await dragGrip(400, 400);
  t = await tb();
  check('drop in the middle → floating there (kept inside the screen)', /float/.test(t.cls) && Math.abs(t.y - 380) < 60 && t.x >= 0 && t.right <= vw, JSON.stringify(t));
  // 손잡이 탭 → 세로로
  const g = await page.locator('#tbGrip').boundingBox();
  await page.mouse.click(g.x + g.width / 2, g.y + g.height / 2);
  await page.waitForTimeout(200);
  t = await tb();
  check('tap grip toggles horizontal ↔ vertical', /float/.test(t.cls) && /vertical/.test(t.cls) && t.h > t.w, JSON.stringify(t));
  const before = t;
  await page.reload();
  await page.waitForSelector('#editor:not([hidden])', { timeout: 10000 }).catch(() => {});
  if (!(await page.locator('#editor').isVisible())) { await page.click('.doc-card'); await page.waitForSelector('#editor:not([hidden])'); }
  await page.waitForTimeout(700);
  t = await tb();
  check('floating vertical toolbar restored after reload', /float/.test(t.cls) && /vertical/.test(t.cls) && Math.abs(t.x - before.x) < 3 && Math.abs(t.y - before.y) < 3, JSON.stringify(t));

  // 손가락으로 오른쪽 가장자리까지 끌기
  const g2 = await page.locator('#tbGrip').boundingBox();
  const fx = g2.x + g2.width / 2, fy = g2.y + g2.height / 2;
  await h.touch(cdp, 'touchStart', [[fx, fy, 1]]);
  for (let k = 1; k <= 12; k++) { await h.touch(cdp, 'touchMove', [[fx + (vw - 25 - fx) * k / 12, fy, 1]]); await page.waitForTimeout(16); }
  await h.touch(cdp, 'touchEnd', [[vw - 25, fy, 1]]);
  await page.waitForTimeout(250);
  t = await tb();
  check('finger drag to right edge → docked right, vertical', /dock-right/.test(t.cls) && /vertical/.test(t.cls) && vw - t.right < 30, JSON.stringify(t));
  // 끄는 동안 화면이 움직이거나 필기가 생기지 않음
  check('dragging the toolbar draws nothing', (await page.evaluate(() => __flexnote.state.doc.items(0).length)) === 0);

  // 설정 → 아래로 되돌리기
  await page.click('#btnSettings');
  await page.click('#btnTbReset');
  await page.evaluate(() => document.querySelector('#settingsDlg').close());
  await page.waitForTimeout(200);
  t = await tb();
  check('reset puts toolbar back at bottom', /dock-bottom/.test(t.cls) && !/vertical/.test(t.cls));

  // 화면 크기·위치마다 버튼이 서로 겹치거나(가려짐) 스크롤 밖으로 숨지 않음
  const bad = [];
  for (const vpz of [{ width: 1280, height: 800 }, { width: 800, height: 1280 }, { width: 390, height: 800 }]) {
    await page.setViewportSize(vpz);
    for (const st of [{ dock: 'bottom' }, { dock: 'top' }, { dock: 'left' }, { dock: 'right' }, { dock: 'float', vertical: true, x: 200, y: 150 }, { dock: 'float', vertical: false, x: 50, y: 300 }]) {
      await page.evaluate((x) => __flexnote.settings.set('toolbar', { dock: 'bottom', vertical: false, x: 0, y: 0, ...x }), st);
      await page.waitForTimeout(120);
      const r = await page.evaluate(() => {
        const tb = document.querySelector('#toolbar'), tr = tb.getBoundingClientRect();
        const els = [...tb.querySelectorAll('button')].filter((e) => e.offsetParent);
        const rs = els.map((e) => e.getBoundingClientRect());
        let ov = 0, out = 0;
        rs.forEach((a, i) => { if (a.left < tr.left - 1 || a.right > tr.right + 1 || a.top < tr.top - 1 || a.bottom > tr.bottom + 1) out++; for (let j = i + 1; j < rs.length; j++) { const b = rs[j]; if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) ov++; } });
        const scroll = tb.scrollWidth > tb.clientWidth + 1 || tb.scrollHeight > tb.clientHeight + 1;
        const offscreen = tr.left < -1 || tr.top < -1 || tr.right > innerWidth + 1 || tr.bottom > innerHeight + 1;
        return { ov, out, scroll, offscreen };
      });
      if (r.ov || r.out || r.scroll || r.offscreen) bad.push(`${vpz.width}x${vpz.height} ${st.dock}${st.vertical ? 'V' : ''} ${JSON.stringify(r)}`);
    }
  }
  check('no overlapping / hidden toolbar buttons at any size or position', !bad.length, bad.join(' | '));
  await page.setViewportSize({ width: 1200, height: 860 });
  await page.evaluate(() => __flexnote.settings.set('toolbar', { dock: 'bottom', vertical: false, x: 0, y: 0 }));

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
