// 타이핑 노트 키보드: Shift+방향키로 여러 글자 선택(→ 한 번에 지우기·서식), 줄 중간 Tab = 그 자리에 탭(다음 탭 위치로),
// 여러 문단 선택 Tab = 들여쓰기, Shift+Tab = 바로 앞 탭 지우기, 목록 맨 앞 Tab = 한 단계 안으로
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, logs } = await h.launch();
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  await page.click('#btnNewNote');
  await page.click('#nnType button[value=typing]');
  await page.click('#newNoteDlg button[value=ok]');
  await page.waitForSelector('.typing-doc');
  await page.waitForTimeout(600);
  const E = (f, a) => page.evaluate(f, a);
  const sel = () => E(() => { const s = document.querySelector('.typing-doc').editor.state.selection; return [s.from, s.to]; });
  const json = () => E(() => document.querySelector('.typing-doc').editor.getJSON());
  const text = (n) => (n.content || []).map((x) => (x.type === 'tab' ? '\t' : x.text || '')).join('');

  await page.click('.typing-doc');
  await page.keyboard.type('가나다라마바사');
  await page.waitForTimeout(300);
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft');
  check('Shift+ArrowLeft selects several characters', JSON.stringify(await sel()) === '[5,8]', JSON.stringify(await sel()));
  await page.keyboard.press('Shift+Home');
  check('Shift+Home extends to line start', JSON.stringify(await sel()) === '[1,8]', JSON.stringify(await sel()));
  // 여러 번 빠르게 눌러도 그대로 (편집기가 직접 계산)
  await page.keyboard.press('End');
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
  check('fast repeated Shift+ArrowLeft keeps every press', JSON.stringify(await sel()) === '[3,8]', JSON.stringify(await sel()));
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Backspace');
  check('selected characters deleted at once', text((await json()).content[0]) === '가나다라마', text((await json()).content[0]));
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Control+b');
  const marks = (await json()).content[0].content.find((x) => x.text === '마')?.marks || [];
  check('format applied to keyboard selection (Ctrl+B)', marks.some((m) => m.type === 'bold'));

  // Tab: 줄 중간 → 그 자리에 탭, 문단 들여쓰기는 그대로
  await page.keyboard.press('End');
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Tab');
  let j = await json();
  check('Tab mid-line inserts a tab at the caret (not at line start)', text(j.content[0]) === '가나다\t라마' && !j.content[0].attrs.indent, JSON.stringify(text(j.content[0])));
  // 탭 뒤 글자는 다음 탭 위치(36px 간격)에 맞춰 놓임
  const stop = await E(() => { // 탭 다음 글자의 시작 위치 (문단 내용 왼쪽 기준, 배율 1)
    const tab = document.querySelector('.typing-doc .doc-tab'), p = tab.closest('p');
    let n = tab.nextSibling; while (n && n.nodeType !== 3) n = n.firstChild || n.nextSibling;
    const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 1);
    const cs = getComputedStyle(p), z = __flexnote.viewer.cam.z;
    return Math.round((r.getBoundingClientRect().left - p.getBoundingClientRect().left) / z - parseFloat(cs.paddingLeft || 0));
  });
  check('text after the tab starts at the next tab stop', stop % 36 <= 1 || stop % 36 >= 35, String(stop));
  await page.keyboard.press('Shift+Tab');
  check('Shift+Tab right after a tab removes it', text((await json()).content[0]) === '가나다라마');
  // 맨 앞 Tab 도 탭 글자 (Word 와 같음)
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  check('Tab at line start inserts a tab', text((await json()).content[0]) === '\t가나다라마');
  // 여러 문단 선택 → 들여쓰기
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('둘째 줄');
  await page.keyboard.press('Shift+ArrowUp');
  const su = await sel();
  check('Shift+ArrowUp extends the selection to the line above', su[0] < 8 && su[1] > su[0], JSON.stringify(su));
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Tab');
  j = await json();
  check('Tab with several paragraphs selected indents them', j.content[0].attrs.indent === 20 && j.content[1].attrs.indent === 20, JSON.stringify(j.content.map((c) => c.attrs.indent)));
  await page.keyboard.press('Shift+Tab');
  check('Shift+Tab outdents', !(await json()).content[0].attrs.indent);
  // 목록 맨 앞 Tab → 한 단계 안으로
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- 항목');
  await page.keyboard.press('Enter');
  await page.keyboard.type('하위');
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  j = await json();
  const list = j.content.find((c) => c.type === 'bulletList');
  check('Tab at start of a list item nests it', !!list && list.content[0].content.some((c) => c.type === 'bulletList'), JSON.stringify(list).slice(0, 120));

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
