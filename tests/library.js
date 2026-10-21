// 홈(라이브러리): 편집 모드(이름·사본·삭제), 길게 누르기/우클릭 메뉴, 편집기 제목으로 이름 바꾸기
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, cdp, logs } = await h.launch();
  const answers = [];
  page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(answers.shift() ?? d.defaultValue()) : d.accept()));
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  // 깨끗한 상태에서 시작
  await page.evaluate(async () => { for (const d of await __flexnote.store.listDocs()) await __flexnote.store.deleteDoc(d.id); });
  await page.reload();
  await page.waitForTimeout(500);
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const vp = await page.locator('#viewport').boundingBox();
  await h.pen(cdp, h.line(vp.x + 200, vp.y + 300, vp.x + 400, vp.y + 320, 10));
  await page.setInputFiles('#imageInput', h.S + '/img.png');
  await page.waitForTimeout(900);

  // 편집기 제목 탭 → 이름 바꾸기
  answers.push('회의 노트');
  await page.click('#docTitle');
  await page.waitForTimeout(300);
  check('tapping editor title renames the note', (await page.textContent('#docTitle')) === '회의 노트');
  check('window title is FlexNote-<note name>', (await page.title()) === 'FlexNote-회의 노트', await page.title());
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  await page.waitForTimeout(500);
  check('window title back to FlexNote on home', (await page.title()) === 'FlexNote', await page.title());
  const names = () => page.$$eval('#docGrid .doc-card .name', (els) => els.map((e) => e.textContent));
  check('library shows renamed note', (await names()).includes('회의 노트'), JSON.stringify(await names()));

  // 편집 모드
  check('card actions hidden normally', await page.locator('.doc-card .card-actions').first().isHidden());
  await page.click('#btnLibEdit');
  check('편집 shows rename/copy/delete on cards', await page.locator('.doc-card .card-actions').first().isVisible() && (await page.textContent('#btnLibEdit')).trim() === '완료');
  answers.push('주간 회의');
  await page.click('.doc-card .card-actions [data-a=rename]');
  await page.waitForTimeout(400);
  check('rename from edit mode', (await names()).includes('주간 회의'), JSON.stringify(await names()));
  await page.click('.doc-card .card-actions [data-a=dup]');
  await page.waitForTimeout(800);
  check('copy creates "… 사본"', (await names()).includes('주간 회의 사본') && (await names()).length === 2, JSON.stringify(await names()));
  // 편집 중에 카드를 눌러도 열리지 않음
  await page.click('.doc-card .cover', { position: { x: 8, y: 8 } }); // 가운데는 편집 버튼이 덮고 있음
  await page.waitForTimeout(400);
  check('tapping a card in edit mode does not open it', await page.locator('#library').isVisible());
  await page.click('#btnLibEdit');

  // 사본: 필기·그림이 따로 복사됨 → 원본을 지워도 사본은 멀쩡
  const docs = await page.evaluate(() => __flexnote.store.listDocs().then((l) => l.map((d) => ({ id: d.id, name: d.name }))));
  const orig = docs.find((d) => d.name === '주간 회의'), copy = docs.find((d) => d.name === '주간 회의 사본');
  const info = await page.evaluate(async ([o, c]) => {
    const pg = async (id) => (await __flexnote.store.loadPages(id)).flatMap((p) => p.items);
    const io = await pg(o), ic = await pg(c);
    const imO = io.find((i) => i.t === 'im'), imC = ic.find((i) => i.t === 'im');
    return { n: [io.length, ic.length], blobs: [imO?.blob, imC?.blob], copyBlob: !!(imC && await __flexnote.store.getBlob(imC.blob)) };
  }, [orig.id, copy.id]);
  check('copy has the same ink & image with its own image file', info.n[0] === info.n[1] && info.n[1] >= 2 && info.blobs[0] !== info.blobs[1] && info.copyBlob, JSON.stringify(info));
  // 우클릭 메뉴 → 원본 삭제
  const cardOrig = page.locator(`.doc-card[data-id="${orig.id}"]`);
  await cardOrig.click({ button: 'right' });
  await page.waitForTimeout(200);
  check('right-click opens card menu', await page.locator('.card-menu').isVisible() && (await page.locator('.card-menu button').count()) === 5);
  await page.click('.card-menu [data-a=del]');
  await page.waitForTimeout(600);
  check('delete original', (await names()).length === 1);
  check('copy keeps its image after original deleted', await page.evaluate(async (c) => { const it = (await __flexnote.store.loadPages(c)).flatMap((p) => p.items).find((i) => i.t === 'im'); return !!(await __flexnote.store.getBlob(it.blob)); }, copy.id));

  // 손가락으로 길게 누르기 → 메뉴 (열리지 않음)
  const b = await page.locator(`.doc-card[data-id="${copy.id}"] .cover`).boundingBox();
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  await h.touch(cdp, 'touchStart', [[cx, cy, 1]]);
  await page.waitForTimeout(700);
  await h.touch(cdp, 'touchEnd', [[cx, cy, 1]]);
  await page.waitForTimeout(300);
  check('long-press opens card menu without opening note', await page.locator('.card-menu').isVisible() && await page.locator('#library').isVisible());
  await page.click('.card-menu [data-a=open]');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(600);
  check('copy opens with its ink', (await page.evaluate(() => [...__flexnote.state.doc.pages.values()].flat().length)) >= 2 && (await page.textContent('#docTitle')) === '주간 회의 사본');

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
