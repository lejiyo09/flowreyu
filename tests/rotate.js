// 올가미 선택 회전: 위 가운데 ↻ 손잡이를 펜으로 끌어 돌리기 (15° 맞춤, 도형·개체 처리, 실행 취소)
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
  const items = () => page.evaluate(() => __flexnote.state.doc.items(0));
  const byId = async (id) => (await items()).find((i) => i.id === id);
  const S = (x, y) => page.evaluate(([x, y]) => __flexnote.viewer.pageToScreen(0, x, y), [x, y]);
  const vp = await page.locator('#viewport').boundingBox();
  const X = (x) => vp.x + x, Y = (y) => vp.y + y;
  const ext = (pts, step = 3) => { const xs = [], ys = []; for (let i = 0; i < pts.length; i += step) { xs.push(pts[i]); ys.push(pts[i + 1]); } return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2 }; };

  // 가로 획 하나 (100px)
  await page.evaluate(() => {
    const pts = []; for (let x = 200; x <= 300; x += 10) pts.push(x, 300, 0.5);
    __flexnote.state.doc.add(0, { id: 's1', t: 's', tool: 'pen', c: '#111111', w: 3, pr: false, pts });
  });
  await page.click('#toolbar [data-tool=lasso]');
  await page.waitForTimeout(400);
  const tap = async (x, y) => { const p = await S(x, y); await h.pen(cdp, [[X(p.x), Y(p.y), 0.5]]); await page.waitForTimeout(200); };
  await tap(250, 300);
  check('stroke selected, rotate handle shown', await page.locator('#selBox').isVisible() && await page.locator('#selBox .sel-rot').isVisible());

  // 손잡이(상자 위 가운데) → 상자 중심의 오른쪽으로: +90°
  const rotateTo = async (deg) => {
    const r = await page.locator('#selBox').boundingBox();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const hx = cx, hy = r.y - 26;
    const rad = Math.hypot(hx - cx, hy - cy);
    const pts = [[hx, hy, 0.5]];
    for (let k = 1; k <= 12; k++) { const a = -Math.PI / 2 + (deg * Math.PI / 180) * (k / 12); pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, 0.5]); }
    await h.pen(cdp, pts);
    await page.waitForTimeout(250);
  };
  const s0 = ext((await byId('s1')).pts);
  await rotateTo(90);
  const s1 = await byId('s1');
  const e1 = ext(s1.pts);
  check('rotate 90°: horizontal stroke becomes vertical', e1.w < 2 && Math.abs(e1.h - 100) < 2, JSON.stringify(e1));
  check('rotates around the center', Math.abs(e1.cx - s0.cx) < 2 && Math.abs(e1.cy - s0.cy) < 2, JSON.stringify([s0, e1]));
  check('stroke width & pressure kept', s1.w === 3 && s1.pts[2] === 0.5);
  check('selection stays after rotating', await page.locator('#selBox').isVisible());
  await page.click('#btnUndo');
  await page.waitForTimeout(200);
  check('undo restores original angle', ext((await byId('s1')).pts).h < 2);

  // 15° 맞춤: 47° 쯤 끌면 45°
  await tap(250, 300);
  await rotateTo(47);
  const p = (await byId('s1')).pts;
  const ang = Math.atan2(p[p.length - 2] - p[1], p[p.length - 3] - p[0]) * 180 / Math.PI;
  check('snaps to 15° steps (47° → 45°)', Math.abs(ang - 45) < 0.5, ang.toFixed(2));
  await page.click('#btnUndo');
  await page.waitForTimeout(200);

  // 사각형 도형 + 포스트잇을 함께 선택해 돌리기
  await page.evaluate(() => {
    const d = __flexnote.state.doc;
    d.add(0, { id: 'r1', t: 'sh', kind: 'rect', c: '#e53935', w: 2, x1: 150, y1: 100, x2: 250, y2: 150 });
    d.add(0, { id: 'n1', t: 'nt', x: 300, y: 100, w: 80, h: 60, c: '#fff59d', fs: 12, text: '메모' });
    d.add(0, { id: 'l1', t: 'sh', kind: 'line', c: '#1e63d6', w: 2, x1: 150, y1: 180, x2: 250, y2: 180 });
  });
  await page.waitForTimeout(150);
  // 올가미로 셋을 둘러싸기
  const loop = [];
  for (const [x, y] of [[130, 80], [400, 80], [400, 200], [130, 200], [130, 80]]) { const q = await S(x, y); loop.push([X(q.x), Y(q.y), 0.5]); }
  const dense = [];
  for (let i = 1; i < loop.length; i++) for (let k = 0; k < 8; k++) dense.push([loop[i - 1][0] + (loop[i][0] - loop[i - 1][0]) * k / 8, loop[i - 1][1] + (loop[i][1] - loop[i - 1][1]) * k / 8, 0.5]);
  await h.pen(cdp, dense);
  await page.waitForTimeout(250);
  const selIds = await page.evaluate(() => [...(__flexnote.tools.selection?.ids || [])].sort());
  check('lasso selects rect, note, line', JSON.stringify(selIds) === JSON.stringify(['l1', 'n1', 'r1']), JSON.stringify(selIds));
  const n0 = await byId('n1');
  await rotateTo(30);
  const it = await items();
  const r1 = it.find((i) => i.id === 'r1'), n1 = it.find((i) => i.id === 'n1'), l1 = it.find((i) => i.id === 'l1');
  check('rotated rectangle becomes an equivalent pen stroke', r1.t === 's' && r1.c === '#e53935' && r1.w === 2 && r1.pts.length >= 15, JSON.stringify({ t: r1.t, n: r1.pts?.length }));
  check('line stays a line, endpoints rotated', l1.t === 'sh' && l1.kind === 'line' && Math.abs(Math.atan2(l1.y2 - l1.y1, l1.x2 - l1.x1) * 180 / Math.PI - 30) < 0.5);
  check('sticky note stays upright (same size) but moves with rotation', n1.w === n0.w && n1.h === n0.h && (Math.abs(n1.x - n0.x) > 1 || Math.abs(n1.y - n0.y) > 1));
  await page.click('#btnUndo');
  await page.waitForTimeout(200);
  const rb = await byId('r1');
  check('undo brings back the rectangle shape', rb.t === 'sh' && rb.kind === 'rect');

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
