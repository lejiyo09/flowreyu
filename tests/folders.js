// 홈 폴더: 만들기·들어가기·경로, 폴더 안에서 만든 노트, 노트/폴더 이동, 폴더 삭제(안의 노트는 위로)
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, logs } = await h.launch();
  const answers = [];
  page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(answers.shift() ?? d.defaultValue()) : d.accept()));
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  await page.evaluate(async () => {
    for (const d of await __flexnote.store.listDocs()) await __flexnote.store.deleteDoc(d.id);
    await __flexnote.store.kvSet('folders', []); await __flexnote.store.kvSet('libFolder', null);
  });
  await page.reload();
  await page.waitForTimeout(600);
  const folderNames = () => page.$$eval('#docGrid .folder-card .name', (els) => els.map((e) => e.textContent));
  const noteNames = () => page.$$eval('#docGrid .doc-card:not(.folder-card) .name', (els) => els.map((e) => e.textContent));
  const crumbs = () => page.$$eval('#libCrumbs button', (els) => els.map((e) => e.textContent));
  const importHere = async () => {
    await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
    await page.waitForSelector('#editor:not([hidden])');
    await page.waitForTimeout(500);
    await page.click('#btnBack');
    await page.waitForSelector('#library:not([hidden])');
    await page.waitForTimeout(400);
  };

  // 홈에 노트 1개 + 폴더 만들기
  await importHere();
  answers.push('수학');
  await page.click('#btnNewFolder');
  await page.waitForTimeout(300);
  check('new folder appears on home', JSON.stringify(await folderNames()) === '["수학"]' && (await noteNames()).length === 1);
  check('no breadcrumb on home', await page.locator('#libCrumbs').isHidden());
  // 폴더 들어가기 → 비어 있음, 경로 표시
  await page.click('.folder-card .cover');
  await page.waitForTimeout(300);
  check('opening folder shows breadcrumb 홈 › 수학', JSON.stringify(await crumbs()) === '["홈","수학"]' && (await noteNames()).length === 0);
  check('empty folder message', await page.locator('#libEmpty').isVisible() && /이 폴더는 비어/.test(await page.textContent('#libEmpty')));
  // 폴더 안에서 PDF 열기 → 그 폴더에 들어감
  await importHere();
  check('note imported inside folder stays in folder', (await noteNames()).length === 1 && JSON.stringify(await crumbs()) === '["홈","수학"]');
  // 하위 폴더
  answers.push('기출');
  await page.click('#btnNewFolder');
  await page.waitForTimeout(300);
  check('subfolder inside folder', JSON.stringify(await folderNames()) === '["기출"]');
  // 홈으로: 폴더 카드에 노트 수
  await page.click('#libCrumbs button:first-child');
  await page.waitForTimeout(300);
  check('home shows folder with count, not the folder note', (await noteNames()).length === 1 && /노트 1개 · 폴더 1개/.test(await page.textContent('.folder-card .meta')), await page.textContent('.folder-card .meta'));

  // 홈의 노트를 카드 메뉴(우클릭) → 폴더로 이동 → 기출
  await page.click('#docGrid .doc-card:not(.folder-card)', { button: 'right' });
  await page.click('.card-menu [data-a=move]');
  await page.waitForSelector('#moveDlg[open]');
  const opts = await page.$$eval('#moveList .move-item span', (els) => els.map((e) => e.textContent));
  check('move dialog lists folder tree', JSON.stringify(opts) === '["홈 (맨 위)","수학","기출"]', JSON.stringify(opts));
  await page.click('#moveList .move-item:nth-child(3)');
  await page.waitForTimeout(400);
  check('note moved out of home', (await noteNames()).length === 0);
  // 편집 모드 → 폴더 이동: 기출을 홈으로 (자기 자신·하위는 목록에 없음)
  await page.click('.folder-card .cover');
  await page.waitForTimeout(300);
  await page.click('#btnLibEdit');
  await page.click('.folder-card .card-actions [data-a=move]');
  await page.waitForSelector('#moveDlg[open]');
  const opts2 = await page.$$eval('#moveList .move-item span', (els) => els.map((e) => e.textContent));
  check('folder cannot be moved into itself', !opts2.includes('기출'), JSON.stringify(opts2));
  await page.click('#moveList .move-item:nth-child(1)');
  await page.waitForTimeout(400);
  await page.click('#btnLibEdit');
  await page.click('#libCrumbs button:first-child');
  await page.waitForTimeout(300);
  check('folder moved to home', JSON.stringify((await folderNames()).sort()) === JSON.stringify(['기출', '수학'].sort()));

  // 새로고침해도 보던 폴더 유지
  await page.click('.folder-card:has-text("수학") .cover');
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForTimeout(800);
  if (await page.locator('#editor').isVisible()) { await page.click('#btnBack'); await page.waitForSelector('#library:not([hidden])'); await page.waitForTimeout(300); }
  check('current folder remembered after reload', JSON.stringify(await crumbs()) === '["홈","수학"]', JSON.stringify(await crumbs()));

  // 폴더 삭제: 안의 노트는 지우지 않고 홈으로
  await page.click('#libCrumbs button:first-child');
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => __flexnote.store.listDocs().then((l) => l.length));
  await page.click('.folder-card:has-text("수학") .more');
  await page.click('.card-menu [data-a=del]');
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => __flexnote.store.listDocs().then((l) => l.length));
  check('deleting folder keeps its notes (moved up to home)', JSON.stringify(await folderNames()) === '["기출"]' && before === after && (await noteNames()).length === 1, `${before}→${after} ${JSON.stringify(await noteNames())}`);
  // 폴더 이름 바꾸기
  answers.push('기출문제');
  await page.click('.folder-card .more');
  await page.click('.card-menu [data-a=rename]');
  await page.waitForTimeout(300);
  check('rename folder', JSON.stringify(await folderNames()) === '["기출문제"]');

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
