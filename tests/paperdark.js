// 타이핑형·Word 글자색 프리셋 + Ctrl+K, 흑백 반전(검은 종이·흰 글씨: 검정/흰색만 뒤집고 다른 색 그대로, 인쇄·내보내기는 원래대로)
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, cdp, logs } = await h.launch();
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  const E = (f, a) => page.evaluate(f, a);
  const json = () => E(() => document.querySelector('.typing-doc').editor.getJSON());
  const colorOf = (j, t) => { let c = null; const walk = (n) => { if (n.text?.includes(t)) c = (n.marks || []).find((m) => m.type === 'textStyle')?.attrs.color || null; (n.content || []).forEach(walk); }; walk(j); return c; };

  // ── 타이핑 노트: 프리셋 ──
  await page.click('#btnNewNote');
  await page.click('#nnType button[value=typing]');
  await page.click('#newNoteDlg button[value=ok]');
  await page.waitForSelector('.typing-doc');
  await page.waitForTimeout(500);
  check('five color presets in the format bar', (await page.locator('#fbPresets button').count()) === 5 && (await page.locator('#fbPresets button.active').count()) === 1);
  await page.click('.typing-doc');
  await page.keyboard.type('빨강 파랑 기본');
  await page.waitForTimeout(200);
  // "빨강" 선택 → Ctrl+K (첫 프리셋 = 빨강 #c62828)
  await page.keyboard.press('Home');
  for (let i = 0; i < 2; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(150);
  check('Ctrl+K colors the selection with the active preset', colorOf(await json(), '빨강') === '#c62828', String(colorOf(await json(), '빨강')));
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(150);
  check('Ctrl+K again removes that color', !colorOf(await json(), '빨강'));
  await page.keyboard.press('Control+k');
  // "파랑" 선택 → 둘째 프리셋 눌러 칠하고 Ctrl+K 색으로
  await page.keyboard.press('End');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowRight'); // "파랑 " → 공백 빼고
  await page.click('#fbPresets button[data-i="1"]');
  await page.waitForTimeout(150);
  check('clicking a preset colors the selection and makes it the Ctrl+K color', colorOf(await json(), '파랑') === '#1e63d6' && await E(() => __flexnote.settings.get('typingColorActive')) === 1);
  // 프리셋 색 바꾸기 (오른쪽 클릭 → 색 고르기)
  await page.click('#fbPresets button[data-i="4"]', { button: 'right' });
  const picker = await page.$('body > input[type=color]');
  check('right-click opens a color picker for the preset', !!picker);
  if (picker) { await picker.evaluate((el) => { el.value = '#00aa88'; el.dispatchEvent(new Event('change')); }); }
  await page.waitForTimeout(150);
  check('preset color changed and saved (selected text not recolored)', (await E(() => __flexnote.settings.get('typingColors')[4])) === '#00aa88' && await E(() => __flexnote.settings.get('typingColorActive')) === 4 && colorOf(await json(), '파랑') === '#1e63d6');

  // ── 흑백 반전 (타이핑) ──
  await page.evaluate(() => { const ed = document.querySelector('.typing-doc').editor; ed.commands.setTextSelection({ from: ed.state.doc.content.size - 3, to: ed.state.doc.content.size - 1 }); ed.commands.setColor('#000000'); });
  await page.click('#btnPaper');
  await page.waitForTimeout(300);
  const st = await E(() => {
    const pageEl = document.querySelector('.typing-page'), doc = document.querySelector('.typing-doc');
    const col = (t) => { for (const el of doc.querySelectorAll('span, p')) if (el.textContent === t || (el.tagName === 'SPAN' && el.textContent.includes(t))) return getComputedStyle(el).color; return getComputedStyle(doc.querySelector('p')).color; };
    return { on: document.querySelector('#editor').classList.contains('paper-dark'), bg: getComputedStyle(pageEl).backgroundColor, plain: getComputedStyle(doc.querySelector('p')).color, blue: col('파랑'), black: col('기본'.slice(0, 1)) };
  });
  check('dark paper: page black, default text white', st.on && st.bg === 'rgb(20, 20, 20)' && st.plain === 'rgb(236, 236, 236)', JSON.stringify(st));
  check('dark paper: other colors unchanged, explicit black shown white', st.blue === 'rgb(30, 99, 214)' && st.black === 'rgb(236, 236, 236)', JSON.stringify(st));
  check('dark paper does not change the saved colors', colorOf(await json(), '파랑') === '#1e63d6');
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');

  // ── 흑백 반전 (PDF + 필기) ──
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(900);
  check('PDF page drawing inverted (lightness only)', await E(() => getComputedStyle(document.querySelector('.page canvas')).filter.includes('invert')));
  const vp = await page.locator('#viewport').boundingBox();
  const S = async (x, y) => { const p = await E(([x, y]) => __flexnote.viewer.pageToScreen(0, x, y), [x, y]); return [vp.x + p.x, vp.y + p.y]; };
  await E(() => { __flexnote.settings.set('pen', { ...__flexnote.settings.get('pen'), color: '#111111', width: 6, mode: 'free' }); });
  let [a, b] = await S(100, 300), [c, d] = await S(300, 300);
  await h.pen(cdp, h.line(a, b, c, d, 10));
  await page.waitForTimeout(400);
  await E(() => { __flexnote.settings.set('pen', { ...__flexnote.settings.get('pen'), color: '#e53935' }); });
  [a, b] = await S(100, 230); [c, d] = await S(300, 230);
  await h.pen(cdp, h.line(a, b, c, d, 10));
  await page.waitForTimeout(400);
  const px = async (x, y) => { const [sx, sy] = await S(x, y); return E(([sx, sy, vx, vy]) => { const cv = document.querySelector('#cvInk'), r = cv.getBoundingClientRect(), k = cv.width / r.width; return [...cv.getContext('2d').getImageData(Math.round((sx - r.left) * k), Math.round((sy - r.top) * k), 1, 1).data]; }, [sx, sy]); };
  const black = await px(200, 300), red = await px(200, 230);
  check('black ink shown white on dark paper', black[0] > 220 && black[1] > 220 && black[3] > 200, JSON.stringify(black));
  check('colored ink unchanged', red[0] > 200 && red[1] < 90 && red[2] < 90, JSON.stringify(red));
  check('stored ink color unchanged', await E(() => __flexnote.state.doc.items(0).some((i) => i.c === '#111111')));
  // 내보내기는 원래 색: 인쇄용 그리기는 검정 그대로
  const exp = await E(async () => { const m = await import('./js/ink.js'); const cv = document.createElement('canvas'); cv.width = cv.height = 20; const ctx = cv.getContext('2d'); m.drawItem(ctx, { t: 'sh', kind: 'line', c: '#111111', w: 10, x1: 0, y1: 10, x2: 20, y2: 10 }, { print: true }); return [...ctx.getImageData(10, 10, 1, 1).data]; });
  check('print/export drawing keeps original black', exp[0] < 40 && exp[3] > 200, JSON.stringify(exp));
  // 새로고침해도 유지, 끄면 원래대로
  await page.reload();
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(700);
  check('dark paper setting persists', await E(() => document.querySelector('#editor').classList.contains('paper-dark')));
  await page.click('#btnPaper');
  await page.waitForTimeout(300);
  check('turning off restores white paper and black ink', !(await E(() => document.querySelector('#editor').classList.contains('paper-dark'))) && (await px(200, 300))[0] < 60);

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
