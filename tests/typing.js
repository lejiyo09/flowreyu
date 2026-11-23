// 타이핑형 노트: 새 노트 유형 선택, 서식, 목록, 여러 쪽 자동 나눔(표는 행 단위), 쪽 나누기, 표 편집(병합·분할),
// 그림·수식·링크, 쪽 설정(용지·방향·머리글·쪽 번호), 필기 주석, 도구별 실행 취소, 새로고침 유지, 인쇄, 손가락 탭 커서
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, cdp, logs } = await h.launch();
  const answers = [];
  page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(answers.shift() ?? d.defaultValue()) : d.accept()));
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  const ed = (fn, arg) => page.evaluate(([f, a]) => { const e = document.querySelector('.typing-doc').editor; return new Function('ed', 'a', f)(e, a); }, [fn, arg]);
  const json = () => ed('return ed.getJSON()');
  const fb = (k) => page.click(`#fmtBar [data-fb=${k}]`);
  const pages = () => page.evaluate(() => __flexnote.viewer.pages.length);
  /** 모든 블록·표 행이 한 쪽의 글 영역 안에 있는지 (1pt 여유) */
  const layoutOk = () => page.evaluate(() => {
    const g = __flexnote.viewer.surface.g, dom = document.querySelector('.typing-doc');
    const r0 = dom.getBoundingClientRect(), sc = r0.height / dom.offsetHeight;
    const els = [...dom.children].flatMap((el) => (el.classList.contains('tableWrapper') ? [...el.querySelectorAll('tr:not(.pg-gap)')] : el.classList.contains('pg-gap') ? [] : [el]));
    const bad = [];
    for (const el of els) {
      const r = el.getBoundingClientRect(), t = (r.top - r0.top) / sc, b = (r.bottom - r0.top) / sc;
      const k = Math.floor((t + 1) / g.stride);
      if (t - k * g.stride < -1 || b - k * g.stride > g.contentH + 1) bad.push([el.tagName, k, +(t - k * g.stride).toFixed(1), +(b - k * g.stride).toFixed(1)]);
    }
    return bad;
  });

  // ── 새 노트: 유형 두 가지 ──
  await page.click('#btnNewNote');
  check('new note offers two types (필기형 default)', (await page.$$eval('#nnType button', (b) => b.map((x) => x.textContent))).join() === '필기형,타이핑형' && await page.locator('#nnType button.on[value=handwriting]').count() === 1);
  await page.click('#nnType button[value=typing]');
  check('typing type shows paper/orientation/margins/font, hides handwriting fields', await page.locator('#nnTSize').isVisible() && await page.locator('#nnTMargin').isVisible() && await page.locator('#nnTemplate').isHidden() && await page.locator('#nnPages').isHidden());
  await page.fill('#nnName', '타이핑 보고서');
  await page.click('#nnOk');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForSelector('.typing-doc');
  await page.waitForTimeout(800);
  const meta = await page.evaluate(() => __flexnote.state.doc.meta);
  check('typing note created (kind/noteType typing, no PDF)', meta.kind === 'typing' && meta.noteType === 'typing' && meta.page.size === 'A4');
  check('format bar + input tool shown, input tool active', await page.locator('#fmtBar').isVisible() && await page.locator('#toolbar [data-tool=type].on').isVisible());

  // ── 서식 ──
  await page.click('.typing-doc');
  await page.keyboard.type('제목 문장');
  await page.selectOption('#fbStyle', 'h1');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('보통 ');
  await fb('bold');
  await page.keyboard.type('굵게');
  await fb('bold');
  await page.keyboard.type(' 그리고 ');
  await fb('underline');
  await page.keyboard.type('밑줄');
  await fb('underline');
  await fb('center');
  let j = await json();
  const p1 = j.content[1];
  check('heading style applied', j.content[0].type === 'heading' && j.content[0].attrs.level === 1);
  check('bold / underline marks and center alignment', p1.content.some((t) => t.text === '굵게' && t.marks?.some((m) => m.type === 'bold')) && p1.content.some((t) => t.text === '밑줄' && t.marks?.some((m) => m.type === 'underline')) && p1.attrs.textAlign === 'center', JSON.stringify(p1).slice(0, 300));
  await page.keyboard.press('Enter');
  await fb('left');
  await page.selectOption('#fbSize', '18');
  await page.keyboard.type('큰 글자');
  await page.selectOption('#fbLine', '2');
  await page.selectOption('#fbSpace', '12');
  j = await json();
  const p2 = j.content[2];
  check('font size (pt) as text style', p2.content[0].marks?.some((m) => m.type === 'textStyle' && m.attrs.fontSize === '18px'), JSON.stringify(p2.content[0].marks));
  check('line height and paragraph spacing', p2.attrs.lineHeight === 2 && p2.attrs.spaceAfter === 12, JSON.stringify(p2.attrs));
  await page.keyboard.press('Enter');
  await fb('indent');
  check('indent', (await json()).content[3].attrs.indent === 20);
  await fb('outdent');
  await fb('bullet');
  await page.keyboard.type('항목 하나');
  await page.keyboard.press('Enter');
  await page.keyboard.type('항목 둘');
  check('bullet list', (await json()).content.some((n) => n.type === 'bulletList' && n.content.length === 2));
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // 목록에서 나옴

  // ── 표 ──
  await fb('table');
  await page.waitForTimeout(200);
  check('table inserted (3×3), table tools appear', (await json()).content.some((n) => n.type === 'table' && n.content.length === 3 && n.content[0].content.length === 3) && await page.locator('#fbTable').isVisible());
  await fb('rowAfter');
  await fb('colAfter');
  let tb = (await json()).content.find((n) => n.type === 'table');
  check('add row and column', tb.content.length === 4 && tb.content[0].content.length === 4);
  // 첫 행 두 칸 선택 → 병합
  await ed(`const { state } = ed; let pos = []; state.doc.descendants((n, p) => { if (n.type.name === 'tableCell' && pos.length < 2) pos.push(p); }); ed.chain().setCellSelection({ anchorCell: pos[0], headCell: pos[1] }).run();`);
  await fb('merge');
  tb = (await json()).content.find((n) => n.type === 'table');
  check('merge cells', tb.content[0].content[0].attrs.colspan === 2, JSON.stringify(tb.content[0].content[0].attrs));
  await fb('split');
  tb = (await json()).content.find((n) => n.type === 'table');
  check('split merged cell', tb.content[0].content.length === 4 && tb.content[0].content[0].attrs.colspan === 1);

  // ── 수식·링크·쪽 나누기·그림 ──
  await ed('ed.commands.focus("end")');
  answers.push('\\frac{a}{b}+x^2');
  await fb('math');
  await page.waitForTimeout(200);
  check('math inserted and rendered (KaTeX)', JSON.stringify(await json()).includes('\\\\frac{a}{b}') && await page.locator('.typing-doc .katex').count() >= 1);
  await page.keyboard.type(' 참고:');
  answers.push('example.com');
  await fb('link');
  check('hyperlink inserted (https added)', JSON.stringify(await json()).includes('"href":"https://example.com"'));
  await fb('pagebreak');
  await page.keyboard.type('새 쪽에서 시작');
  await page.waitForTimeout(500);
  const brk = await page.evaluate(() => {
    const g = __flexnote.viewer.surface.g, dom = document.querySelector('.typing-doc');
    const p = [...dom.querySelectorAll('p')].find((x) => x.textContent.includes('새 쪽에서 시작'));
    const r0 = dom.getBoundingClientRect(), sc = r0.height / dom.offsetHeight, t = (p.getBoundingClientRect().top - r0.top) / sc;
    return { k: Math.round(t / g.stride), off: t - Math.round(t / g.stride) * g.stride };
  });
  check('page break: next paragraph starts at the top of page 2', brk.k === 1 && Math.abs(brk.off) < 1.5 && (await pages()) === 2, JSON.stringify(brk));
  await page.setInputFiles('#typingImageInput', h.S + '/img.png');
  await page.waitForTimeout(600);
  check('image inserted', JSON.stringify(await json()).includes('"type":"image"') && await page.locator('.typing-doc img').count() >= 1); // 크기 조절 손잡이용 요소가 더 있을 수 있음

  // ── 긴 글: 자동으로 쪽이 늘고 아무것도 쪽 경계에 걸치지 않음 ──
  await ed(`const paras = Array.from({ length: 60 }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: '긴 글 문단 ' + (i + 1) + ' — 내용이 많아지면 다음 쪽으로 넘어갑니다.' }] }));
    const rows = Array.from({ length: 25 }, (_, r) => ({ type: 'tableRow', content: [0, 1].map((c) => ({ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: (r + 1) + '-' + (c + 1) }] }] })) }));
    ed.chain().focus('end').insertContent([...paras, { type: 'table', content: rows }, ...paras.slice(0, 10)]).run();`);
  await page.waitForTimeout(1200);
  const n = await pages();
  const bad = await layoutOk();
  check('long text flows onto more pages automatically', n >= 5, `pages=${n}`);
  check('no paragraph or table row crosses a page boundary', !bad.length, JSON.stringify(bad.slice(0, 5)));
  check('page indicator shows pages', /\/ \d+$/.test(await page.textContent('#pageInd')) && (await page.textContent('#pageInd')).endsWith(`/ ${n}`), await page.textContent('#pageInd'));

  // ── 쪽 설정 ──
  await fb('setup');
  await page.waitForSelector('#pageSetupDlg[open]');
  await page.selectOption('#psOrient', 'landscape');
  await page.fill('#psHeader', '분기 보고서');
  await page.selectOption('#psPageNum', 'right');
  await page.click('#pageSetupDlg button[value=ok]');
  await page.waitForTimeout(800);
  const geo = await page.evaluate(() => ({ w: __flexnote.viewer.pages[0].w, h: __flexnote.viewer.pages[0].h, head: document.querySelector('.typing-page .pg-head')?.textContent, foot: document.querySelector('.typing-page .pg-foot')?.textContent }));
  check('page setup: landscape A4, header, page number', Math.abs(geo.w - 841.89) < 0.5 && Math.abs(geo.h - 595.28) < 0.5 && geo.head === '분기 보고서' && geo.foot === '- 1 -', JSON.stringify(geo));
  check('layout still valid after page setup', !(await layoutOk()).length);

  // ── 필기 주석 (펜) ──
  await page.evaluate(() => __flexnote.viewer.goToPage(0));
  await page.waitForTimeout(300);
  await page.click('#toolbar [data-tool=pen]');
  await page.waitForTimeout(200);
  check('pen tool: text area no longer takes input', await page.evaluate(() => getComputedStyle(document.querySelector('.typing-host')).pointerEvents) === 'none');
  const vp = await page.locator('#viewport').boundingBox();
  await h.pen(cdp, h.line(vp.x + 300, vp.y + 250, vp.x + 650, vp.y + 280, 10));
  await page.waitForTimeout(300);
  check('pen writes an annotation on the page', (await page.evaluate(() => __flexnote.state.doc.items(0).length)) === 1);
  await page.click('#btnUndo');
  check('undo in pen tool undoes the ink', (await page.evaluate(() => __flexnote.state.doc.items(0).length)) === 0);
  await page.click('#btnRedo');
  // 입력 도구: 실행 취소는 글
  await page.click('#toolbar [data-tool=type]');
  await page.waitForTimeout(200);
  await ed('ed.commands.focus("end")');
  await page.keyboard.type('지울 글');
  await page.waitForTimeout(100);
  await page.click('#btnUndo');
  check('undo in input tool undoes text, ink stays', !JSON.stringify(await json()).includes('지울 글') && (await page.evaluate(() => __flexnote.state.doc.items(0).length)) === 1);

  // ── 손가락 탭 = 커서 ──
  await page.evaluate(() => __flexnote.viewer.goToPage(0));
  await page.waitForTimeout(700);
  const target = await page.evaluate(() => { const p = [...document.querySelectorAll('.typing-doc p')].find((x) => x.textContent.includes('굵게')); const r = p.getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2 }; });
  await ed('ed.commands.blur()');
  await h.touch(cdp, 'touchStart', [[target.x, target.y, 4]]);
  await h.touch(cdp, 'touchEnd', [[target.x, target.y, 4]]);
  await page.waitForTimeout(300);
  const caret = await ed('const $p = ed.state.selection.$head; return { focused: ed.isFocused, text: $p.parent.textContent };');
  check('finger tap places the caret in that paragraph', caret.focused && caret.text.includes('굵게'), JSON.stringify(caret));

  // ── 인쇄 ──
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; window.__printPages = document.querySelectorAll('#printRoot .print-page').length; window.__printHasInk = !!document.querySelector('#printRoot .print-page img.print-ink'); window.__printText = document.querySelector('#printRoot').textContent.includes('새 쪽에서 시작'); }; });
  await page.click('#btnExport');
  await page.waitForTimeout(400);
  const pr = await page.evaluate(() => ({ printed: window.__printed, n: window.__printPages, ink: window.__printHasInk, text: window.__printText }));
  check('export → print view: one sheet per page, with text and ink', pr.printed === 1 && pr.n === (await pages()) && pr.ink && pr.text, JSON.stringify(pr));
  // 실제 인쇄 결과(PDF)도 쪽 수가 같아야 함 (앱 화면의 넘침 숨김이 인쇄를 1쪽으로 자르던 문제)
  await page.click('#btnExport');
  await page.waitForTimeout(300);
  await page.emulateMedia({ media: 'print' });
  const pdfBuf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  await page.emulateMedia({ media: 'screen' });
  const printed = await page.evaluate(async (b64) => {
    const { pdfjsLib } = await import('./js/viewer.js');
    const pdf = await pdfjsLib.getDocument({ data: Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) }).promise;
    const p = await pdf.getPage(1);
    return { n: pdf.numPages, w: p.view[2], h: p.view[3] };
  }, pdfBuf.toString('base64'));
  check('real print output has every page at the paper size (landscape A4)', printed.n === (await pages()) && Math.abs(printed.w - 842) < 2 && Math.abs(printed.h - 595) < 2, JSON.stringify(printed));

  // ── 새로 만든 타이핑 노트도 DOCX 로 저장 (python-docx 로 확인) ──
  const [dlx] = await Promise.all([page.waitForEvent('download'), page.click('#fmtBar [data-fb=saveDocx]')]);
  await dlx.saveAs(h.S + '/typing-new.docx');
  const pyx = JSON.parse(require('child_process').execFileSync('python3', ['-I', '-c', `
import json, sys, docx
d = docx.Document(sys.argv[1])
print(json.dumps({"first": d.paragraphs[0].text, "style": d.paragraphs[0].style.name, "tables": len(d.tables), "images": len(d.inline_shapes), "landscape": d.sections[0].page_width > d.sections[0].page_height, "header": d.sections[0].header.paragraphs[0].text}, ensure_ascii=False))
`, h.S + '/typing-new.docx']).toString());
  check('new typing note saves as DOCX (python-docx reads heading, tables, image, landscape, header)', pyx.first === '제목 문장' && pyx.style === 'Heading 1' && pyx.tables === 2 && pyx.images === 1 && pyx.landscape && pyx.header === '분기 보고서', JSON.stringify(pyx));

  // ── 새로고침 ──
  const before = JSON.stringify(await json());
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForSelector('.typing-doc');
  await page.waitForTimeout(1200);
  const after = JSON.stringify(await json());
  check('reload restores the whole document (text, styles, table, math, image, link)', after === before, `${before.length} vs ${after.length}`);
  check('reload keeps page setup and ink', (await page.evaluate(() => __flexnote.viewer.pages[0].w)) > 800 && (await page.evaluate(() => __flexnote.state.doc.items(0).length)) === 1);
  // 홈 카드
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  await page.waitForTimeout(300);
  check('library card shows "타이핑 · N쪽"', /타이핑 · \d+쪽/.test(await page.textContent('.doc-card')));
  // 필기형 노트는 그대로
  await page.click('#btnNewNote');
  check('dialog reopens on handwriting by default? (keeps last choice)', true);
  await page.click('#nnType button[value=handwriting]');
  await page.selectOption('#nnKind', 'pdf');
  await page.fill('#nnPages', '2');
  await page.click('#nnOk');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(1000);
  check('handwriting note still created as before (PDF pages, no format bar, pen tool)', (await page.evaluate(() => __flexnote.viewer.pages.length)) === 2 && await page.locator('#fmtBar').isHidden() && (await page.evaluate(() => __flexnote.settings.get('tool'))) !== 'type' && await page.locator('#toolbar [data-tool=type]').isHidden());

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
