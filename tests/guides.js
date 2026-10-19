// 자 / 각도기 테스트
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
  const G = () => page.evaluate(() => { const g = __flexnote.input.app.guides; return { r: g.ruler && { ...g.ruler }, p: g.prot && { ...g.prot } }; });
  const lastStrokeScreen = () => page.evaluate(() => {
    const v = __flexnote.viewer, d = __flexnote.state.doc;
    for (const p of v.pages) { const it = d.items(p.index).at(-1); if (it && it.t === 's') { const out = []; for (let i = 0; i < it.pts.length; i += 3) out.push(v.pageToScreen(p.index, it.pts[i], it.pts[i + 1])); return out; } }
    return [];
  });

  // 자 켜기
  await page.click('#btnRuler');
  await page.waitForTimeout(200);
  let g = (await G()).r;
  check('ruler toggles on', !!g && (await page.locator('#btnRuler.on').count()) === 1);
  // 위 모서리 근처(10px 위)에서 흔들리며 긋기 → 모서리 위 직선
  const edgeY = g.cy - g.th / 2;
  const wob = []; for (let i = 0; i <= 30; i++) wob.push([X(g.cx - 200 + i * 13), Y(edgeY - 10 + Math.sin(i) * 8), 0.6]);
  await h.pen(cdp, wob);
  await page.waitForTimeout(300);
  let pts = await lastStrokeScreen();
  const ys = pts.map((p) => p.y);
  check('pen near ruler edge → straight along edge', Math.max(...ys) - Math.min(...ys) < 0.6 && Math.abs(ys[0] - edgeY) < 0.6, `spread=${(Math.max(...ys) - Math.min(...ys)).toFixed(2)} y=${ys[0].toFixed(1)} edge=${edgeY}`);
  // 자에서 먼 곳은 자유 곡선
  await h.pen(cdp, Array.from({ length: 20 }, (_, i) => [X(200 + i * 10), Y(150 + Math.sin(i) * 10), 0.6]));
  pts = await lastStrokeScreen();
  check('pen far from ruler stays freehand', Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y)) > 5);
  // 손가락 한 개로 자 이동 (화면은 그대로)
  await page.waitForTimeout(400);
  const cam0 = await page.evaluate(() => ({ ...__flexnote.viewer.cam }));
  await h.touch(cdp, 'touchStart', [[X(g.cx), Y(g.cy), 1]]);
  for (let i = 1; i <= 5; i++) await h.touch(cdp, 'touchMove', [[X(g.cx + i * 10), Y(g.cy + i * 8), 1]]);
  await h.touch(cdp, 'touchEnd', [[X(g.cx + 50), Y(g.cy + 40), 1]]);
  const g2 = (await G()).r, cam1 = await page.evaluate(() => ({ ...__flexnote.viewer.cam }));
  check('one finger drags ruler, page does not pan', Math.abs(g2.cx - g.cx - 50) < 1 && Math.abs(g2.cy - g.cy - 40) < 1 && cam0.ty === cam1.ty);
  // 두 손가락 회전 (약 31° → 30° 로 달라붙음)
  const c = { x: g2.cx, y: g2.cy };
  const rot = (a, rr) => [c.x + Math.cos(a) * rr, c.y + Math.sin(a) * rr];
  await h.touch(cdp, 'touchStart', [[X(c.x - 150), Y(c.y), 1]]);
  await h.touch(cdp, 'touchStart', [[X(c.x - 150), Y(c.y), 1], [X(c.x + 150), Y(c.y), 2]]);
  for (let i = 1; i <= 10; i++) {
    const a = (31 * Math.PI / 180) * i / 10;
    const [ax, ay] = rot(Math.PI + a, 150), [bx, by] = rot(a, 150);
    await h.touch(cdp, 'touchMove', [[X(ax), Y(ay), 1], [X(bx), Y(by), 2]]);
  }
  await h.touch(cdp, 'touchEnd', []);
  const g3 = (await G()).r;
  check('two fingers rotate ruler, snaps to 30°', Math.abs(g3.a * 180 / Math.PI - 30) < 0.01, `${(g3.a * 180 / Math.PI).toFixed(2)}°`);
  // 회전한 자를 따라 긋기 → 30° 직선
  await page.waitForTimeout(400);
  const lp = (lx, ly) => [g3.cx + lx * Math.cos(g3.a) - ly * Math.sin(g3.a), g3.cy + lx * Math.sin(g3.a) + ly * Math.cos(g3.a)];
  const line = []; for (let i = 0; i <= 20; i++) { const [x, y] = lp(-150 + i * 15, -g3.th / 2 - 8 + (i % 3) * 3); line.push([X(x), Y(y), 0.6]); }
  await h.pen(cdp, line);
  pts = await lastStrokeScreen();
  const ang = Math.atan2(pts.at(-1).y - pts[0].y, pts.at(-1).x - pts[0].x) * 180 / Math.PI;
  check('stroke along rotated ruler is a 30° line', Math.abs(ang - 30) < 0.3, `${ang.toFixed(2)}°`);
  await page.click('#btnRuler');
  check('ruler toggles off', !(await G()).r);

  // 각도기
  await page.click('#btnProt');
  const P = (await G()).p;
  // 호 근처에서 시작해 흔들리며 → 호 위
  const arc = []; for (let i = 0; i <= 30; i++) { const t = -Math.PI * (0.2 + i * 0.02); const rr = P.r + 12 + Math.sin(i) * 7; arc.push([X(P.cx + Math.cos(t) * rr), Y(P.cy + Math.sin(t) * rr), 0.6]); }
  await h.pen(cdp, arc);
  pts = await lastStrokeScreen();
  const dev = Math.max(...pts.map((p) => Math.abs(Math.hypot(p.x - P.cx, p.y - P.cy) - P.r)));
  check('pen near protractor arc follows the arc', dev < 0.8, `maxDev=${dev.toFixed(2)}px`);
  // 각도 표시: 45° 위치에 펜
  await page.waitForTimeout(300);
  const a45 = -Math.PI / 4;
  const px = P.cx + Math.cos(a45) * P.r * 0.6, py = P.cy + Math.sin(a45) * P.r * 0.6;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: X(px), y: Y(py), button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5 });
  const shown = await page.evaluate(([x, y]) => { const g = __flexnote.input.app.guides; return { pen: !!g.pen, deg: g.angleOf(x, y) }; }, [px, py]);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: X(px), y: Y(py), button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
  check('protractor shows pen angle (45°)', shown.pen && Math.abs(shown.deg - 45) < 0.5, `${shown.deg.toFixed(1)}°`);
  await page.waitForTimeout(150);
  check('angle readout hidden after pen up', !(await page.evaluate(() => !!__flexnote.input.app.guides.pen)));
  // 각도기 밖 손가락은 화면 이동
  await page.waitForTimeout(400);
  const c0 = await page.evaluate(() => __flexnote.viewer.cam.ty);
  await h.touch(cdp, 'touchStart', [[X(100), Y(150), 3]]);
  for (let i = 1; i <= 4; i++) await h.touch(cdp, 'touchMove', [[X(100), Y(150 - i * 20), 3]]);
  await h.touch(cdp, 'touchEnd', [[X(100), Y(70), 3]]);
  check('finger outside guides still pans', Math.abs((await page.evaluate(() => __flexnote.viewer.cam.ty)) - c0) > 50);
  await page.screenshot({ path: h.S + '/guides.png' });
  console.log(results.join('\n'));
  const errs = logs.filter((l) => /pageerror|\[error\]/.test(l));
  if (errs.length) console.log(errs.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error(e); process.exit(1); });
