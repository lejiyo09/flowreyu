// 펜 필기 방식: 자유 / 직선(시작~끝, 수평·수직·45° 맞춤, 떼기 전까지 끝점 조절) / 도형(원·삼각형·사각형·화살표 등으로 정돈)
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
  const S = async (x, y) => { const p = await page.evaluate(([x, y]) => __flexnote.viewer.pageToScreen(0, x, y), [x, y]); return [vp.x + p.x, vp.y + p.y]; };
  const items = () => page.evaluate(() => __flexnote.state.doc.items(0));
  const last = async () => (await items()).slice(-1)[0];
  // 페이지 좌표 점들 → 화면 펜 획 (손떨림 섞어서)
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  const draw = async (pagePts) => { const scr = []; for (const [x, y] of pagePts) { const [sx, sy] = await S(x + rnd() * 1.5, y + rnd() * 1.5); scr.push([sx, sy, 0.6]); } await h.pen(cdp, scr); await page.waitForTimeout(250); };
  const along = (V, n = 16, closed = false) => { const W = closed ? V.concat([V[0]]) : V, out = []; for (let i = 1; i < W.length; i++) for (let k = 0; k < n; k++) { const t = k / n; out.push([W[i - 1][0] + (W[i][0] - W[i - 1][0]) * t, W[i - 1][1] + (W[i][1] - W[i - 1][1]) * t]); } out.push(W[W.length - 1]); return out; };

  // ── 펜 설정 창에서 방식 고르기 ──
  await page.click('#toolbar [data-tool=pen]'); // 이미 펜이면 설정 창
  await page.waitForTimeout(200);
  if (await page.locator('#toolPopup').isHidden()) { await page.click('#toolbar [data-tool=pen]'); await page.waitForTimeout(200); }
  check('pen popup offers 자유 / 직선 / 도형', JSON.stringify(await page.$$eval('#toolPopup .pen-mode button', (b) => b.map((x) => x.textContent))) === '["자유","직선","도형"]');
  await page.click('#toolPopup .pen-mode button[value=line]');
  await page.waitForTimeout(150);
  check('line mode saved and shown on the pen button', await page.evaluate(() => __flexnote.settings.get('pen').mode) === 'line' && (await page.getAttribute('#toolbar [data-tool=pen]', 'data-mode')) === 'line');
  await page.mouse.click(vp.x + 5, vp.y + vp.height - 5); // 창 닫기
  await page.keyboard.press('Escape');

  // ── 직선: 흔들리게 그어도 곧은 선, 거의 수평이면 수평으로 ──
  const n0 = (await items()).length;
  await draw([[100, 200], [140, 206], [180, 196], [220, 207], [260, 199], [300, 205]]);
  let it = await last();
  check('line mode: wobbly stroke becomes one straight shape', (await items()).length === n0 + 1 && it.t === 'sh' && it.kind === 'line', JSON.stringify(it).slice(0, 120));
  check('near-horizontal line snapped to horizontal, start/end kept', Math.abs(it.y1 - it.y2) < 0.01 && Math.abs(it.x1 - 100) < 3 && Math.abs(Math.hypot(it.x2 - it.x1, it.y2 - it.y1) - 200) < 4, `${it.x1},${it.y1} → ${it.x2},${it.y2}`);
  // 사선은 각도 유지
  await draw(along([[100, 300], [250, 380]], 10));
  it = await last();
  check('diagonal line keeps its angle', it.kind === 'line' && Math.abs(Math.atan2(it.y2 - it.y1, it.x2 - it.x1) - Math.atan2(80, 150)) < 0.05);
  // 길이 조절: 멀리 갔다가 돌아와서 떼면 마지막 위치까지
  await draw([[100, 450], [200, 450], [400, 452], [300, 451], [250, 450]]);
  it = await last();
  check('line end follows the pen until lift (length adjustable)', Math.abs(it.x2 - 250) < 4, String(it.x2));
  // 형광펜 직선: 겹쳐 칠하는 획
  await page.evaluate(() => { __flexnote.settings.set('hl', { ...__flexnote.settings.get('hl'), mode: 'line' }); });
  await page.click('#toolbar [data-tool=hl]');
  await page.keyboard.press('Escape');
  await page.evaluate(() => __flexnote.state.doc.setItems(0, []));
  await draw(along([[100, 250], [300, 254]], 8));
  it = await last();
  check('highlighter line mode: straight highlighter stroke', it.t === 's' && it.tool === 'hl' && it.pts.length === 6 && it.pts[1] === it.pts[4]);

  // ── 도형 ──
  await page.evaluate(() => { __flexnote.settings.set('pen', { ...__flexnote.settings.get('pen'), mode: 'shape' }); });
  await page.click('#toolbar [data-tool=pen]');
  await page.keyboard.press('Escape');
  const circle = []; for (let i = 0; i <= 44; i++) { const t = (i / 40) * Math.PI * 2; circle.push([200 + Math.cos(t) * 60 * (1 + rnd() * 0.05), 250 + Math.sin(t) * 58 * (1 + rnd() * 0.05)]); }
  await draw(circle);
  it = await last();
  check('shape mode: rough circle → circle shape', it.t === 'sh' && it.kind === 'ellipse' && Math.abs((it.x2 - it.x1) - (it.y2 - it.y1)) < 0.5 && Math.abs((it.x1 + it.x2) / 2 - 200) < 6, JSON.stringify(it).slice(0, 120));
  await draw(along([[380, 180], [450, 220], [442, 320], [375, 310]], 12, true));
  it = await last();
  check('rough quadrilateral → clean polygon or rectangle', (it.t === 'sh' && it.kind === 'rect') || (it.t === 's' && it.pts.length === 15), JSON.stringify(it).slice(0, 100));
  await page.evaluate(() => __flexnote.state.doc.setItems(0, []));
  await draw(along([[120, 160], [380, 162], [378, 260], [122, 258]], 14, true));
  it = await last();
  check('rough rectangle → rectangle shape', it.t === 'sh' && it.kind === 'rect' && Math.abs(it.x1 - 121) < 3 && Math.abs(it.y2 - 259) < 3, JSON.stringify(it).slice(0, 100));
  await draw(along([[480, 160], [540, 260], [420, 260]], 14, true));
  it = await last();
  check('rough triangle → clean triangle (closed, 3 corners)', it.t === 's' && it.pts.length === 12 && it.pts[0] === it.pts[9], JSON.stringify(it.pts));
  await draw(along([[60, 350], [300, 350], [275, 330], [300, 350], [275, 370]], 12));
  it = await last();
  check('one-stroke arrow → arrow shape', it.t === 'sh' && it.kind === 'arrow');
  await page.evaluate(() => __flexnote.state.doc.setItems(0, []));
  const scribble = []; for (let i = 0; i < 40; i++) scribble.push([60 + i * 6, 200 + Math.sin(i * 0.35) * 30]);
  await draw(scribble);
  it = await last();
  check('unrecognized handwriting stays as written', it.t === 's' && it.pts.length > 20, JSON.stringify(it).slice(0, 150));
  // 실행 취소 → 도형 사라짐
  const before = (await items()).length;
  await page.click('#btnUndo');
  await page.waitForTimeout(150);
  check('undo removes the last result', (await items()).length === before - 1);

  // ── 자유 모드는 그대로 ──
  await page.evaluate(() => { __flexnote.settings.set('pen', { ...__flexnote.settings.get('pen'), mode: 'free' }); });
  await draw(along([[100, 300], [300, 305]], 10));
  it = await last();
  check('free mode keeps the freehand stroke', it.t === 's' && it.pts.length >= 6);
  // 저장 후 새로고침해도 도형·설정 유지
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  check('drawings persist after reload', (await items()).length >= 1);

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
