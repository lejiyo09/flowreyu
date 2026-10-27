// 포스트잇: 글 편집 중에도 종이 색 유지, 모서리로 크기 조절, 안에 표·체크리스트 넣기(함께 이동·접힘), 실행 취소
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
  const S = (x, y) => page.evaluate(([x, y]) => __flexnote.viewer.pageToScreen(0, x, y), [x, y]);
  const items = () => page.evaluate(() => __flexnote.state.doc.items(0));
  const get = async (id) => (await items()).find((i) => i.id === id);
  const pix = async (x, y) => { const s = await S(x, y); return page.evaluate(([x, y]) => { const v = __flexnote.viewer; return [...v.inkCtx.getImageData(Math.round(x * v.dpr), Math.round(y * v.dpr), 1, 1).data]; }, [s.x, s.y]); };
  const tap = async (x, y) => { const p = await S(x, y); await h.pen(cdp, [[X(p.x), Y(p.y), 0.5]]); await page.waitForTimeout(250); };
  const drag = async (x0, y0, dx, dy) => { const p = await S(x0, y0); await h.pen(cdp, h.line(X(p.x), Y(p.y), X(p.x + dx), Y(p.y + dy), 10)); await page.waitForTimeout(250); };
  const z = await page.evaluate(() => __flexnote.viewer.cam.z);

  await page.evaluate(() => __flexnote.state.doc.add(0, { id: 'n1', t: 'nt', x: 100, y: 100, w: 200, h: 150, c: '#fff59d', fs: 14, text: '메모' }));
  await page.waitForTimeout(200);

  // 글 편집 중: 포스트잇 종이 색이 그대로 보임 (예전엔 통째로 숨겨져 투명)
  await page.click('#toolbar [data-tool=text]');
  await page.waitForTimeout(300);
  await tap(200, 170);
  check('editing note text', await page.locator('#textEditor').isVisible());
  const px = await pix(150, 220);
  check('note background stays visible while editing its text', px[3] > 200 && px[0] > 200 && px[1] > 200 && px[2] < 200, JSON.stringify(px));
  await page.keyboard.type(' 추가');

  // 글 쓰던 포스트잇에 표 넣기 (도구 모음 ▦)
  await page.click('#btnTable');
  await page.fill('#tbRows', '2');
  await page.fill('#tbCols', '2');
  await page.click('#tableDlg button[value=ok]');
  await page.waitForTimeout(300);
  let all = await items();
  const tb = all.find((i) => i.t === 'tb');
  const n1 = all.find((i) => i.id === 'n1');
  check('typed note text kept', n1.text === '메모 추가', n1.text);
  check('table goes inside the note (below its text, note width)', tb && tb.x >= n1.x && tb.x + tb.w <= n1.x + n1.w && tb.y > n1.y + 20 && tb.y + tb.h <= n1.y + n1.h, JSON.stringify({ tb: tb && [tb.x, tb.y, tb.w, tb.h], n: [n1.x, n1.y, n1.w, n1.h] }));
  check('note grew to fit the table', n1.h >= 150);
  await page.keyboard.press('Escape');
  await page.click('#toolbar [data-tool=pen]');
  await page.waitForTimeout(400);

  // 포스트잇 띠를 끌면 안의 표도 같이
  await drag(140, 105, 60, 40);
  const tb2 = await get(tb.id), n2 = await get('n1');
  check('dragging the note moves the table inside it', Math.abs(tb2.x - tb.x - 60 / z) < 1.5 && Math.abs(tb2.y - tb.y - 40 / z) < 1.5 && Math.abs(n2.x - n1.x - 60 / z) < 1.5, JSON.stringify([tb2.x - tb.x, n2.x - n1.x]));
  await page.click('#btnUndo');
  await page.waitForTimeout(150);
  // 접으면 표도 숨고 표의 ＋ 를 눌러도 반응 없음
  const fb = await page.evaluate(() => import('./js/ink.js').then((m) => m.noteFoldButton(__flexnote.state.doc.items(0).find((i) => i.id === 'n1'))));
  await page.waitForTimeout(400);
  await tap(fb.x + fb.w / 2, fb.y + fb.h / 2);
  check('folding hides the table inside', (await get('n1')).fold && (await pix(tb.x + 5, tb.y + 5))[3] < 10);
  const rows0 = (await get(tb.id)).cells.length;
  await page.waitForTimeout(400);
  await tap(tb.x + tb.w / 2, tb.y + tb.h + 3 + Math.max(10, Math.min(18, tb.fs * 1.2)) / 2);
  check('hidden table controls do not react', (await get(tb.id)).cells.length === rows0);
  await page.waitForTimeout(400);
  await tap(n1.x + 10, n1.y + 10); // 아이콘 탭 → 펼침
  check('unfold', !(await get('n1')).fold);

  // 모서리 끌어 크기 조절
  let n = await get('n1');
  const inkCount = (await items()).filter((i) => i.t === 's').length; // (접힌 동안 빈 곳 펜 탭은 점이 찍힘)
  await page.waitForTimeout(400);
  await drag(n.x + n.w - 2, n.y + n.h - 2, 80, 60);
  const nb = await get('n1');
  check('pen drag on corner resizes the note', Math.abs(nb.w - n.w - 80 / z) < 2 && Math.abs(nb.h - n.h - 60 / z) < 2 && nb.x === n.x, JSON.stringify([n.w, nb.w, n.h, nb.h]));
  check('no ink drawn by resizing', (await items()).filter((i) => i.t === 's').length === inkCount);
  // 많이 줄여도 안의 표가 빠져나가지 않는 데서 멈춤
  await page.waitForTimeout(400);
  await drag(nb.x + nb.w - 2, nb.y + nb.h - 2, -600, -600);
  const ns = await get('n1'), t3 = await get(tb.id);
  check('shrinking stops so the table stays attached', ns.w < nb.w && ns.h < nb.h && t3.x >= ns.x && t3.y <= ns.y + ns.h && t3.x <= ns.x + ns.w, JSON.stringify([ns.w, ns.h]));
  const att = await page.evaluate(() => import('./js/ink.js').then((m) => { const it = __flexnote.state.doc.items(0); return m.noteAttached(it, it.find((i) => i.id === 'n1')); }));
  check('table still counted as inside the note', att.includes(tb.id));
  await page.click('#btnUndo');
  await page.click('#btnUndo');
  await page.waitForTimeout(150);
  check('undo restores size', Math.abs((await get('n1')).w - n.w) < 0.5);

  // 올가미로 포스트잇 선택 → 체크리스트 넣기 → 그 포스트잇 안 (표 아래)
  await page.click('#toolbar [data-tool=lasso]');
  await page.waitForTimeout(400);
  n = await get('n1');
  await tap(n.x + n.w - 20, n.y + 30);
  await page.click('#btnChecklist');
  await page.waitForTimeout(300);
  await page.keyboard.type('할 일');
  await page.evaluate(() => document.activeElement.blur()); // 입력 확정
  await page.waitForTimeout(200);
  all = await items();
  const cl = all.find((i) => i.t === 'cl'), n3 = all.find((i) => i.id === 'n1'), t4 = all.find((i) => i.t === 'tb');
  check('checklist inserted into the selected note, below the table', cl && cl.x >= n3.x && cl.y > t4.y + t4.h && cl.y < n3.y + n3.h, JSON.stringify(cl && [cl.x, cl.y, n3.y, n3.h, t4.y + t4.h]));
  check('inserted objects take the note layer', (cl?.ly || 'L0') === (n3.ly || 'L0') && (t4.ly || 'L0') === (n3.ly || 'L0'));

  check('checklist text saved', cl?.rows[0].text === '할 일');
  // 실행 취소: 글 입력 → 넣기(체크리스트와 늘어난 포스트잇 높이가 한 번에) 순서로 되돌아감
  const hBefore = n.h;
  await page.click('#btnUndo');
  await page.waitForTimeout(150);
  check('first undo only clears the typed text', (await items()).some((i) => i.t === 'cl'));
  await page.click('#btnUndo');
  await page.waitForTimeout(150);
  all = await items();
  check('next undo removes the inserted checklist and the note growth', !all.some((i) => i.t === 'cl') && Math.abs(all.find((i) => i.id === 'n1').h - hBefore) < 0.5);

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnExport')]);
  await dl.saveAs(h.S + '/notebox-export.pdf');
  check('export works', true);
  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
