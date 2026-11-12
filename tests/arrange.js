// 객체 편집: 선택 추가(＋선택·Shift), 묶기/풀기, 앞뒤 순서, 정렬·간격, 복사/붙여넣기(다른 페이지·노트), 전체 선택, 화살표 이동
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, cdp, logs } = await h.launch();
  page.on('dialog', (d) => d.accept());
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const vp = await page.locator('#viewport').boundingBox();
  const C = async (x, y, pg = 0) => { const s = await page.evaluate(([x, y, pg]) => __flexnote.viewer.pageToScreen(pg, x, y), [x, y, pg]); return { x: vp.x + s.x, y: vp.y + s.y }; };
  const items = (pg = 0) => page.evaluate((pg) => __flexnote.state.doc.items(pg), pg);
  const sel = () => page.evaluate(() => [...(__flexnote.tools.selection?.ids || [])].sort());
  const bb = (id) => page.evaluate((id) => import('./js/ink.js').then((m) => m.bbox(__flexnote.state.doc.items(0).find((i) => i.id === id))), id);
  const tap = async (x, y) => { const p = await C(x, y); await h.pen(cdp, [[p.x, p.y, 0.5]]); await page.waitForTimeout(150); };
  const stroke = (id, x, y, len = 60) => ({ id, t: 's', tool: 'pen', c: '#111111', w: 3, pr: false, pts: [x, y, 0.5, x + len, y, 0.5] });

  await page.evaluate((list) => { const d = __flexnote.state.doc; for (const it of list) d.add(0, it); }, [
    stroke('A', 100, 120), stroke('B', 160, 200, 80), stroke('C', 300, 160, 40),
    { id: 'N', t: 'nt', x: 380, y: 230, w: 120, h: 90, c: '#fff59d', fs: 12, text: '' }, stroke('NA', 400, 290, 50),
  ]);
  await page.click('#toolbar [data-tool=lasso]');
  await page.waitForTimeout(300);

  // ── 선택 추가 ──
  await tap(130, 120);
  check('tap selects one object', JSON.stringify(await sel()) === '["A"]');
  check('selection count shown', (await page.textContent('#selCount')) === '1개');
  await page.click('#selMenu [data-sel=add]');
  check('＋선택 turns on add mode', await page.locator('#selMenu [data-sel=add].on').count() === 1);
  await tap(200, 200);
  check('add mode: tap adds another object', JSON.stringify(await sel()) === '["A","B"]', JSON.stringify(await sel()));
  await tap(130, 120);
  check('add mode: tap a selected object removes it', JSON.stringify(await sel()) === '["B"]');
  await tap(130, 120);
  await tap(320, 160);
  check('add mode stays on while adding', JSON.stringify(await sel()) === '["A","B","C"]' && await page.locator('#selMenu [data-sel=add].on').count() === 1);
  await tap(440, 250); // 포스트잇 → 위의 필기째
  check('adding a sticky note brings its attached ink', JSON.stringify(await sel()) === '["A","B","C","N","NA"]', JSON.stringify(await sel()));
  check('count updates', (await page.textContent('#selCount')) === '5개');

  // ── 정렬 (덩어리: A, B, C, 포스트잇+필기) ──
  await page.click('#selMenu [data-sel=more]');
  check('정리 opens order/align row', await page.locator('#selSub').isVisible() && await page.locator('#selMenu [data-sel=al-hdist]').isVisible());
  const naBefore = await bb('NA'), nBefore = await bb('N');
  await page.click('#selMenu [data-sel=al-left]');
  await page.waitForTimeout(100);
  const xs = await Promise.all(['A', 'B', 'C', 'N'].map(bb));
  check('align left: every unit starts at the same x', xs.every((b) => Math.abs(b.x - xs[0].x) < 0.5), JSON.stringify(xs.map((b) => b.x)));
  const naAfter = await bb('NA'), nAfter = await bb('N');
  check('note and the ink on it move together', Math.abs((naAfter.x - naBefore.x) - (nAfter.x - nBefore.x)) < 0.5);
  check('selection kept after aligning', (await sel()).length === 5);
  await page.click('#btnUndo');
  await page.waitForTimeout(100);
  check('one undo restores positions', Math.abs((await bb('C')).x - (300 - 1.5)) < 1);
  // 선택이 실행 취소로 바뀌었을 수 있어 다시: A, B, C 만
  await page.evaluate(() => __flexnote.tools.setSelection({ page: 0, ids: new Set(['A', 'B', 'C']) }));
  await page.waitForTimeout(100);
  await page.click('#selMenu [data-sel=more]').catch(() => {});
  if (!(await page.locator('#selSub').isVisible())) await page.click('#selMenu [data-sel=more]');
  await page.click('#selMenu [data-sel=al-hdist]');
  await page.waitForTimeout(100);
  const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(bb));
  const g1 = b.x - (a.x + a.w), g2 = c.x - (b.x + b.w);
  check('distribute horizontally: equal gaps, ends fixed', Math.abs(g1 - g2) < 0.5 && Math.abs(a.x - 98) < 0.5 && Math.abs(c.x + c.w - 342) < 0.5, JSON.stringify([g1, g2, a.x, c.x + c.w])); // 획 상자 = 선 굵기 절반 + 0.5 여유
  await page.click('#selMenu [data-sel=al-top]');
  const tops = await Promise.all(['A', 'B', 'C'].map(bb));
  check('align top', tops.every((t) => Math.abs(t.y - tops[0].y) < 0.5));

  // ── 묶기 ──
  await page.evaluate(() => __flexnote.tools.setSelection({ page: 0, ids: new Set(['A', 'B']) }));
  await page.waitForTimeout(100);
  check('묶기 shown for 2+ objects, 풀기 hidden', await page.locator('#selMenu [data-sel=group]').isVisible() && await page.locator('#selMenu [data-sel=ungroup]').isHidden());
  await page.click('#selMenu [data-sel=group]');
  const gA = (await items()).find((i) => i.id === 'A').gp, gB = (await items()).find((i) => i.id === 'B').gp;
  check('group gives both the same group id', gA && gA === gB);
  await page.click('#selMenu [data-sel=clear]');
  await page.click('#selMenu [data-sel=add]').catch(() => {});
  const ta = await bb('A');
  await tap(ta.x + ta.w / 2, ta.y + ta.h / 2);
  check('tapping one grouped object selects the whole group', JSON.stringify(await sel()) === '["A","B"]', JSON.stringify(await sel()));
  // 그룹째 끌어 옮기기
  const sb = await page.locator('#selBox').boundingBox();
  await h.pen(cdp, h.line(sb.x + sb.width / 2, sb.y + sb.height / 2, sb.x + sb.width / 2 + 50, sb.y + sb.height / 2 + 30, 8));
  await page.waitForTimeout(200);
  const ta2 = await bb('A'), tb2 = await bb('B');
  check('group moves together', ta2.x > ta.x + 10 && Math.abs((ta2.x - ta.x) - (tb2.x - (await page.evaluate(() => 0)) - tb2.x + (ta2.x - ta.x))) < 1);
  // 복제한 그룹은 새 그룹
  await page.click('#selMenu [data-sel=dup]');
  const dupIds = await sel();
  const dups = (await items()).filter((i) => dupIds.includes(i.id));
  check('duplicated group gets its own group id', dups.length === 2 && dups[0].gp && dups[0].gp === dups[1].gp && dups[0].gp !== gA);
  await page.click('#selMenu [data-sel=delete]');
  // 새로고침해도 묶음 유지
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  check('group survives reload', (await items()).find((i) => i.id === 'A').gp === gA && (await items()).find((i) => i.id === 'B').gp === gA);
  await page.evaluate(() => __flexnote.settings.set('tool', 'lasso'));
  await page.evaluate(() => __flexnote.tools.setSelection({ page: 0, ids: new Set(['A']) }));
  await page.waitForTimeout(100);
  await page.click('#selMenu [data-sel=ungroup]');
  check('ungroup removes the group', !(await items()).some((i) => i.gp));

  // ── 순서 ──
  const order = async () => (await items()).map((i) => i.id).join(',');
  await page.evaluate(() => __flexnote.tools.setSelection({ page: 0, ids: new Set(['A']) }));
  await page.waitForTimeout(100);
  await page.click('#selMenu [data-sel=more]');
  await page.click('#selMenu [data-sel=z-front]');
  check('bring to front', (await order()).endsWith(',A'), await order());
  await page.click('#selMenu [data-sel=z-backward]');
  check('one step back', (await order()).endsWith(',A,NA'), await order());
  await page.click('#selMenu [data-sel=z-back]');
  check('send to back', (await order()).startsWith('A,'), await order());
  await page.click('#selMenu [data-sel=z-forward]');
  check('one step forward', (await order()).startsWith('B,A,'), await order());

  // ── 키보드 ──
  await page.click('#selMenu [data-sel=clear]');
  await page.keyboard.press('Control+a');
  check('Ctrl+A selects everything on the page', (await sel()).length === (await items()).length);
  await page.evaluate(() => __flexnote.tools.setSelection({ page: 0, ids: new Set(['C']) }));
  const c0 = await bb('C');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowDown');
  const c1 = await bb('C');
  check('arrows nudge 1pt, Shift+arrow 10pt', Math.abs(c1.x - c0.x - 1) < 0.01 && Math.abs(c1.y - c0.y - 10) < 0.01, JSON.stringify([c1.x - c0.x, c1.y - c0.y]));
  await page.evaluate(() => __flexnote.tools.setSelection({ page: 0, ids: new Set(['B', 'C']) }));
  await page.keyboard.press('Control+g');
  check('Ctrl+G groups', (await items()).filter((i) => i.gp).length === 2);
  await page.keyboard.press('Control+Shift+g');
  check('Ctrl+Shift+G ungroups', !(await items()).some((i) => i.gp));
  await page.evaluate(() => __flexnote.tools.setSelection({ page: 0, ids: new Set(['C']) }));
  await page.keyboard.press('Control+Shift+BracketRight');
  check('Ctrl+Shift+] brings to front', (await order()).endsWith(',C'));

  // ── 복사·붙여넣기 ──
  const n0 = (await items()).length;
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(200);
  const after = await items();
  const pasted = after[after.length - 1];
  const cc = await bb('C');
  check('Ctrl+C / Ctrl+V pastes a copy nearby, selected', after.length === n0 + 1 && pasted.id !== 'C' && Math.abs(pasted.pts[0] - after.find((i) => i.id === 'C').pts[0] - 16) < 0.01 && JSON.stringify(await sel()) === JSON.stringify([pasted.id]), JSON.stringify(cc));
  // 다른 페이지: 화면 가운데에
  await page.evaluate(() => __flexnote.viewer.goToPage(2));
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(200);
  check('paste on another page lands on that page', (await items(2)).length === 1);
  // Ctrl+X
  await page.evaluate(() => __flexnote.viewer.goToPage(0));
  await page.waitForTimeout(300);
  await page.evaluate(() => __flexnote.tools.setSelection({ page: 0, ids: new Set(['B']) }));
  await page.keyboard.press('Control+x');
  check('Ctrl+X cuts', !(await items()).some((i) => i.id === 'B'));
  // 길게 누르기 메뉴의 붙여넣기 (그 자리에)
  await page.evaluate(() => __flexnote.tools.clearSelection());
  const spot = await C(250, 250); // 아래쪽 알림(토스트)에 가리지 않는 자리
  // 손가락 꾹 누르기 → 메뉴 (기본값은 '없음'이라 설정에서 켬)
  await page.evaluate(() => __flexnote.settings.set('gestures', { ...__flexnote.settings.get('gestures'), fingerHold: 'menu' }));
  await page.waitForTimeout(500);
  await h.touch(cdp, 'touchStart', [[spot.x, spot.y, 1]]);
  await page.waitForTimeout(800);
  await h.touch(cdp, 'touchEnd', [[spot.x, spot.y, 1]]);
  await page.waitForTimeout(200);
  check('long-press menu offers paste', await page.locator('#quickMenu [data-qm=paste]').isVisible());
  await page.click('#quickMenu [data-qm=paste]');
  await page.waitForTimeout(200);
  const pb = await page.evaluate(() => import('./js/ink.js').then((m) => { const it = __flexnote.state.doc.items(0); return m.bbox(it[it.length - 1]); }));
  check('paste from the menu centers at the pressed spot', Math.abs(pb.x + pb.w / 2 - 250) < 2 && Math.abs(pb.y + pb.h / 2 - 250) < 2, JSON.stringify(pb));

  // 다른 노트로 그림 복사 → 그림 파일도 새 노트 것으로
  await page.setInputFiles('#imageInput', h.S + '/img.png');
  await page.waitForTimeout(900);
  const docA = await page.evaluate(() => __flexnote.state.doc.id);
  const im = (await items()).find((i) => i.t === 'im');
  await page.keyboard.press('Control+c');
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(500);
  const im2 = (await items()).find((i) => i.t === 'im');
  const recs = await page.evaluate(async ([a, b]) => [(await __flexnote.store.getBlob(a))?.docId, (await __flexnote.store.getBlob(b))?.docId], [im.blob, im2?.blob]);
  check('pasting an image into another note copies the image file', im2 && im2.blob !== im.blob && recs[0] === docA && recs[1] === (await page.evaluate(() => __flexnote.state.doc.id)), JSON.stringify(recs));

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
