// 타이핑형 노트·Word(.docx) 문서 본문 찾기 (Ctrl+F): 개수, 표시(노랑/주황), Enter·▲▼ 이동과 화면 따라가기,
// 공백·대소문자 무시, 표 안 글, 글을 고치면 결과 갱신, 닫으면 표시 지움
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, logs } = await h.launch();
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  const E = (f, a) => page.evaluate(f, a);
  const hits = () => E(() => [...document.querySelectorAll('.typing-doc .find-hit')].map((x) => x.textContent));

  // ── Word 문서 ──
  await page.setInputFiles('#fileInput', h.S + '/sample.docx');
  await page.waitForSelector('.typing-doc', { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.click('#docReportDlg button[value=ok]').catch(() => {});
  await page.click('.typing-doc');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(200);
  check('Ctrl+F opens find in a Word document', await page.locator('#searchBar').isVisible());
  await page.fill('#searchInput', '병합');
  await page.waitForTimeout(600);
  const c1 = await page.textContent('#searchCount');
  check('finds body and table text (count shown)', /^1 \/ [2-9]/.test(c1) && (await hits()).every((t) => t.includes('병')), `${c1} ${JSON.stringify(await hits())}`);
  check('current hit marked', (await E(() => document.querySelectorAll('.typing-doc .find-hit.cur').length)) >= 1);
  const pos0 = await E(() => __flexnote.viewer.cam.ty);
  await page.fill('#searchInput', '각주 내용');
  await page.waitForTimeout(600);
  const pos1 = await E(() => __flexnote.viewer.cam.ty);
  check('jumps to the match further down (screen follows)', pos1 < pos0 - 50, `${pos0} → ${pos1}`);
  await page.fill('#searchInput', '병 합'); // 공백 무시
  await page.waitForTimeout(600);
  const n = Number((await page.textContent('#searchCount')).split('/')[1]);
  check('spaces ignored like PDF search', n >= 2, String(n));
  await page.press('#searchInput', 'Enter');
  check('Enter moves to the next match', (await page.textContent('#searchCount')).startsWith('2 /'));
  await page.press('#searchInput', 'Shift+Enter');
  check('Shift+Enter moves back', (await page.textContent('#searchCount')).startsWith('1 /'));
  await page.click('#searchClose');
  check('closing find clears highlights', (await hits()).length === 0);
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');

  // ── 새 타이핑 노트: 대소문자 무시, 고치면 갱신 ──
  await page.click('#btnNewNote');
  await page.click('#nnType button[value=typing]');
  await page.click('#newNoteDlg button[value=ok]');
  await page.waitForSelector('.typing-doc');
  await page.waitForTimeout(500);
  await page.click('.typing-doc');
  await page.keyboard.type('FlexNote 노트 앱. flexnote 찾기 시험');
  await page.keyboard.press('Control+f');
  await page.fill('#searchInput', 'FLEXNOTE');
  await page.waitForTimeout(500);
  check('case-insensitive in typing notes', (await page.textContent('#searchCount')) === '1 / 2', await page.textContent('#searchCount'));
  await page.click('.typing-doc');
  await page.keyboard.press('End');
  await page.keyboard.type(' FlexNote');
  await page.waitForTimeout(800);
  check('editing while find is open updates the count', /\/ 3$/.test(await page.textContent('#searchCount')), await page.textContent('#searchCount'));
  await page.fill('#searchInput', '없는말');
  await page.waitForTimeout(400);
  check('no match shows 없음', (await page.textContent('#searchCount')) === '없음' && (await hits()).length === 0);

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
