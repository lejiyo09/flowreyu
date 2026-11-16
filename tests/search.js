// 글자 찾기(Ctrl+F): PDF 에 원래 있는 글자 + 직접 쓴 글, 공백·대소문자 무시, 다음/이전, 강조, 스캔본 안내, 무한 스크롤
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, logs } = await h.launch();
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const cur = () => page.evaluate(() => __flexnote.viewer.currentPage());
  const count = () => page.textContent('#searchCount');
  const settle = async () => { await page.waitForFunction(() => !/…/.test(document.querySelector('#searchCount').textContent) && document.querySelector('#searchCount').textContent !== '', null, { timeout: 15000 }).catch(() => {}); await page.waitForTimeout(150); };
  const search = async (q) => { await page.fill('#searchInput', q); await page.waitForTimeout(350); await settle(); };

  await page.keyboard.press('Control+f');
  check('Ctrl+F opens the in-app search bar (focused)', await page.locator('#searchBar').isVisible() && await page.evaluate(() => document.activeElement.id) === 'searchInput');
  await search('test page 3');
  check('finds text that is printed in the PDF', (await count()) === '1 / 1', await count());
  check('jumps to that page', (await cur()) === 2, `cur=${await cur()}`);
  // 강조: 지금 결과는 주황
  const hl = await page.evaluate(() => {
    const v = __flexnote.viewer, s = v.search, list = s.hits.get(s.cur.page), r = list[s.cur.i].rects[0];
    const p = v.pageToScreen(s.cur.page, r.x + r.w / 2, r.y + r.h / 2);
    const d = v.hlCtx.getImageData(Math.round(p.x * v.dpr), Math.round(p.y * v.dpr), 1, 1).data;
    return { px: [...d], onScreen: p.x > 0 && p.y > 0 && p.x < v.vw && p.y < v.vh };
  });
  check('current match is highlighted on screen', hl.onScreen && hl.px[3] > 200 && hl.px[0] > 200 && hl.px[2] < 120, JSON.stringify(hl));
  await search('LOREM');
  check('case-insensitive, counts every match in all pages (5 × 23 + landscape 15)', /\/ 130$/.test(await count()), await count());
  const c0 = await count();
  await page.press('#searchInput', 'Enter');
  await page.waitForTimeout(150);
  const c1 = await count();
  await page.press('#searchInput', 'Shift+Enter');
  await page.waitForTimeout(150);
  check('Enter = next, Shift+Enter = previous', c1.startsWith(String(parseInt(c0, 10) + 1) + ' /') && (await count()) === c0, `${c0} → ${c1} → ${await count()}`);
  await page.click('#searchPrev');
  await page.waitForTimeout(150);
  check('▲ wraps / steps back', (await count()) !== c0);
  await search('elit.590');
  check('spaces are ignored ("elit.590" finds "elit. 590", not on the landscape page)', /\/ 5$/.test(await count()), await count());
  // 90° 돌아간 페이지(5쪽)에서도 강조 상자가 그 글자 위에
  await search('test page 5');
  const rot = await page.evaluate(() => {
    const v = __flexnote.viewer, s = v.search, r = s.hits.get(s.cur.page)[s.cur.i].rects[0], p = v.pages[s.cur.page];
    return { page: s.cur.page, r, pw: p.w, ph: p.h };
  });
  // 돌린 페이지: 제목이 세로로 서 있으므로 상자는 세로로 길고 페이지 오른쪽 가장자리 근처
  check('rotated page: highlight box follows the rotated text', rot.page === 4 && rot.r.h > rot.r.w && rot.r.x > rot.pw * 0.75 && rot.r.x + rot.r.w <= rot.pw && rot.r.y >= 0 && rot.r.y + rot.r.h <= rot.ph, JSON.stringify(rot));
  // 직접 쓴 글
  await page.evaluate(() => __flexnote.state.doc.add(3, { id: 't1', t: 'tx', x: 80, y: 200, c: '#111111', fs: 14, text: '회의 메모: 예산 확정' }));
  await search('예산확정');
  check('finds text written in a text box', (await count()) === '1 / 1' && (await cur()) === 3, `${await count()} cur=${await cur()}`);
  await page.evaluate(() => __flexnote.state.doc.add(4, { id: 'tb1', t: 'tb', x: 80, y: 300, w: 200, h: 60, fs: 12, cells: [['예산', ''], ['', '확정']] }));
  await page.waitForTimeout(500);
  await settle();
  check('results refresh when the note changes (table cells too)', /\/ 2$/.test(await count()), await count());
  await search('없는말xyz');
  check('no match is reported', /^없음/.test(await count()));
  await page.keyboard.press('Escape');
  check('Esc closes the bar and clears highlights', await page.locator('#searchBar').isHidden() && !(await page.evaluate(() => !!__flexnote.viewer.search)));
  // 버튼으로도 (키보드 없는 태블릿)
  await page.click('#btnSearch');
  check('toolbar 🔍 button opens it too', await page.locator('#searchBar').isVisible());
  await page.click('#searchClose');

  // 글자 정보 없는 PDF (스캔본) 안내: 글자 정보가 없는 갤러리 샘플
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  await page.click('#btnNewNote');
  await page.selectOption('#nnKind', 'scroll');
  await page.click('#nnOk');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(600);
  await page.evaluate(() => __flexnote.state.doc.add(0, { id: 'n1', t: 'nt', x: 100, y: 1500, w: 160, h: 100, c: '#fff59d', fs: 14, text: '스크롤 아래쪽 메모' }));
  await page.keyboard.press('Control+f');
  await search('아래쪽 메모');
  const y = await page.evaluate(() => __flexnote.viewer.toWorld(__flexnote.viewer.vw / 2, __flexnote.viewer.vh / 2).y);
  check('infinite scroll note: finds a sticky note and scrolls to it', (await count()) === '1 / 1' && Math.abs(y - 1550) < 120, `${await count()} y=${Math.round(y)}`);

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
