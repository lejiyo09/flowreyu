// 한글 문서 편집 기능: 새 한글 문서 만들기, 서식 상태 표시·켜고 끄기, 커서에서 다음 글자 서식, 글꼴·크기·정렬,
// 찾기·모두 바꾸기, 표 넣기·셀 입력·행 추가, 그림 넣기, 쪽 설정, 단축키, 펜 필기(저장·실행 취소), PDF 내보내기·인쇄
const h = require('./harness');
const fs = require('fs');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, cdp, logs } = await h.launch();
  page.on('dialog', (d) => d.accept());
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  const E = (f, a) => page.evaluate(f, a);
  const fmt = () => E(() => __flexnote.hwp.session.formatting());
  const txt = async () => { // 입력 처리 중이면 잠깐 기다렸다가
    for (let i = 0; i < 20; i++) {
      const t = await E(() => { const r = __flexnote.hwp.session.surface.getPageText(0, { include: ['body', 'table'] }); return r.state === 'available' ? r.text : null; });
      if (t != null) return t;
      await page.waitForTimeout(250);
    }
    return '';
  };
  const rev = () => E(() => __flexnote.hwp.session.rev);
  const settle = () => E(() => __flexnote.hwp.session.settle());

  // ── 새 한글 문서 (.hwp) ──
  await page.click('#btnNewNote');
  await page.click('#nnType button[value=typing]');
  await page.fill('#nnName', '새 한글');
  await page.selectOption('#nnTFormat', 'hwp5');
  await page.click('#newNoteDlg button[value=ok]');
  await page.waitForFunction(() => __flexnote.hwp?.session, null, { timeout: 30000 });
  await page.waitForTimeout(1000);
  check('new 한글 document created and opened (hwp5, saved)', await E(() => __flexnote.state.doc.meta.kind === 'hwp' && __flexnote.state.doc.meta.source.format === 'hwp5' && !__flexnote.state.doc.meta.source.fresh)
    && await E(async () => (await __flexnote.store.getFile(__flexnote.state.doc.id))?.size > 0));
  const hb = await page.locator('#hwpHost').boundingBox();
  await page.mouse.click(hb.x + hb.width / 2, hb.y + 160);
  await page.waitForTimeout(300);
  await page.keyboard.type('첫째 줄 시험 문장');
  await settle();
  await page.waitForTimeout(300);
  check('typing into the new document', (await txt()).includes('첫째 줄 시험 문장'), JSON.stringify(await txt()));

  // ── 서식: 선택 → 크기·굵게(켜기/끄기)·가운데·글꼴, 버튼에 상태 표시 ──
  await page.keyboard.press('Shift+Home');
  await page.waitForTimeout(300);
  check('toolbar shows current size and font', (await page.inputValue('#hbSize')) !== '' && (await page.inputValue('#hbFont')) !== '', `${await page.inputValue('#hbSize')} ${await page.inputValue('#hbFont')}`);
  await page.selectOption('#hbSize', '20');
  await page.waitForTimeout(500);
  check('font size applied in pt (20)', (await fmt()).size === 20, JSON.stringify(await fmt()));
  await page.click('#hwpBar [data-hb=bold]');
  await page.waitForTimeout(500);
  check('bold on: text bold and button shows on', (await fmt()).bold === true && await page.locator('#hwpBar [data-hb=bold].on').count() === 1);
  await page.click('#hwpBar [data-hb=bold]');
  await page.waitForTimeout(500);
  check('pressing bold again turns it off', (await fmt()).bold === false && await page.locator('#hwpBar [data-hb=bold].on').count() === 0);
  await page.keyboard.press('Control+b'); // 한글과 같은 단축키
  await page.waitForTimeout(600);
  check('Ctrl+B shortcut toggles bold', (await fmt()).bold === true);
  await page.click('#hwpBar [data-hb=center]');
  await page.waitForTimeout(500);
  check('center alignment applied and shown', (await fmt()).align === 'center' && await page.locator('#hwpBar [data-hb=center].on').count() === 1);
  await page.selectOption('#hbFont', '맑은 고딕');
  await page.waitForTimeout(600);
  check('font name applied', (await fmt()).font === '맑은 고딕', (await fmt()).font);
  // 커서만 있을 때: 다음에 칠 글자 서식
  await page.keyboard.press('End');
  await page.waitForTimeout(200);
  await page.click('#hwpBar [data-hb=italic]');
  await page.waitForTimeout(300);
  await page.keyboard.type('XY');
  await settle();
  await page.waitForTimeout(400);
  await page.keyboard.press('Shift+ArrowLeft');
  await page.waitForTimeout(400);
  check('caret formatting applies to the next typed text', (await fmt()).italic === true && (await txt()).includes('문장XY'));

  // ── 찾기·바꾸기 ──
  await page.keyboard.press('End');
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(300);
  check('Ctrl+F opens find with replace row on 한글 documents', await page.locator('#searchBar').isVisible() && await page.locator('#replaceInput').isVisible());
  await page.fill('#searchInput', '시험');
  await page.waitForTimeout(900);
  check('match count shown', (await page.textContent('#searchCount')) === '1개', await page.textContent('#searchCount'));
  await page.press('#searchInput', 'Enter');
  await page.waitForTimeout(800);
  const sel = await E(() => { const s = __flexnote.hwp.session.selection(); return s && s.endUnit - s.startUnit; });
  check('Enter finds and selects the match', sel === 2, String(sel));
  await page.fill('#replaceInput', '테스트');
  await page.click('#replaceAll');
  await page.waitForTimeout(900);
  check('replace all', (await txt()).includes('첫째 줄 테스트 문장') && !(await txt()).includes('시험'), JSON.stringify(await txt()));
  await page.click('#searchClose');

  // ── 표: 넣기 → 칸 눌러 입력 → 행 추가 ──
  await page.mouse.click(hb.x + hb.width / 2, hb.y + 160);
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await settle();
  const r0 = await rev();
  await page.click('#hwpBar [data-hb=table]');
  await page.fill('#htRows', '2');
  await page.fill('#htCols', '2');
  await page.click('#hwpTableDlg button[value=ok]');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: h.S + '/hwp2-table.png' });
  check('table inserted (no error)', (await rev()) !== r0 && /표를 넣었습니다/.test(await page.textContent('#toast')));
  // 표는 둘째 문단에: 첫 칸 = 본문 왼쪽 근처
  let typedInCell = false;
  for (let dy = 130; dy <= 280 && !typedInCell; dy += 8) { // 첫 줄 아래로 내려가며 표 칸 찾기
    await page.mouse.click(hb.x + hb.width / 2 - 150, hb.y + dy);
    await page.waitForTimeout(200);
    // 새로 만든 표의 칸은 '생성된 칸' 선택으로 잡힘
    if (await E(() => { const sf = __flexnote.hwp.session.surface; return !!(sf.captureGeneratedTableGridSelection?.() || sf.captureSourceTableGridSelection?.()); })) { typedInCell = true; break; }
  }
  if (typedInCell) { await page.keyboard.type('셀글'); await settle(); await page.waitForTimeout(400); }
  check('tap a table cell and type', typedInCell && (await E(() => __flexnote.hwp.session.count('셀글'))) === 1);
  const r1 = await rev();
  await page.click('#hwpBar [data-hb=rowAfter]');
  await page.waitForTimeout(900);
  check('add row below', (await rev()) !== r1);

  // ── 그림 ──
  await page.mouse.click(hb.x + hb.width / 2, hb.y + 160);
  await page.keyboard.press('End');
  await page.waitForTimeout(300);
  const r2 = await rev();
  await page.setInputFiles('#hwpImageInput', h.S + '/img.png');
  await page.waitForTimeout(1500);
  check('image inserted into body paragraph', (await rev()) !== r2 && /그림을 넣었습니다/.test(await page.textContent('#toast')), await page.textContent('#toast'));

  // ── 쪽 설정 (새 개체가 있어도 적용: 저장 후 다시 열어 적용) ──
  await page.click('#hwpBar [data-hb=page]');
  await page.waitForSelector('#hwpPageDlg[open]');
  check('page setup dialog shows A4 size', (await page.inputValue('#hpW')) === '210' && (await page.inputValue('#hpH')) === '297', `${await page.inputValue('#hpW')}x${await page.inputValue('#hpH')}`);
  await page.fill('#hpL', '25');
  await page.click('#hwpPageDlg button[value=ok]');
  await page.waitForTimeout(2500);
  const left = await E(async () => (await __flexnote.hwp.session.pageSettings()).values?.margin.left);
  check('page margin changed', left === 25, String(left));
  await page.waitForFunction(() => { const r = __flexnote.hwp.session.surface.getPageText(0, { include: ['body', 'table'] }); return r.state === 'available' && r.text.includes('셀글'); }, null, { timeout: 8000 }).catch(() => {});
  check('content kept after page setup', (await txt()).includes('셀글') && (await txt()).includes('테스트'), JSON.stringify(await txt()));

  // ── 펜 필기: 쓰기 → 노트에 저장, 실행 취소, 다시 열어도 남음 ──
  await page.click('#hwpBar [data-hb=ink-pen]');
  await page.waitForTimeout(200);
  check('pen mode on', await page.locator('#hwpBar [data-hb=ink-pen].on').count() === 1 && await E(() => document.querySelector('.hwp-ink').classList.contains('active')));
  const before = await rev();
  await h.pen(cdp, h.line(hb.x + 300, hb.y + 500, hb.x + 520, hb.y + 540, 12));
  await page.waitForTimeout(400);
  check('pen stroke stored in the note, 한글 document untouched', (await E(() => __flexnote.state.doc.items(0).length)) === 1 && (await rev()) === before);
  await h.pen(cdp, h.line(hb.x + 300, hb.y + 600, hb.x + 520, hb.y + 620, 12));
  await page.waitForTimeout(300);
  await page.click('#hwpBar [data-hb=undo]');
  await page.waitForTimeout(300);
  check('undo in pen mode removes the last stroke (not document text)', (await E(() => __flexnote.state.doc.items(0).length)) === 1 && (await txt()).includes('테스트'));
  // 지우개
  await page.click('#hwpBar [data-hb=ink-eraser]');
  await h.pen(cdp, h.line(hb.x + 400, hb.y + 480, hb.x + 410, hb.y + 560, 8));
  await page.waitForTimeout(300);
  check('eraser removes the stroke', (await E(() => __flexnote.state.doc.items(0).length)) === 0);
  await page.click('#hwpBar [data-hb=undo]');
  await page.waitForTimeout(300);
  check('undo restores erased stroke', (await E(() => __flexnote.state.doc.items(0).length)) === 1);
  await page.click('#hwpBar [data-hb=ink-eraser]'); // 끄기 → 글쓰기
  check('ink layer passes input through when off', !(await E(() => document.querySelector('.hwp-ink').classList.contains('active'))));
  // 스크롤해도 필기는 문서에 붙어 있음 (화면 위치가 함께 움직임)
  const inkY = () => E(() => { const ink = document.querySelector('.hwp-ink'), ctx = ink.getContext('2d'), d = ctx.getImageData(0, 0, ink.width, ink.height).data; let minY = -1; for (let y = 0; y < ink.height && minY < 0; y += 2) for (let x = 0; x < ink.width; x += 4) if (d[(y * ink.width + x) * 4 + 3] > 0) { minY = y; break; } return minY / (window.devicePixelRatio || 1); });
  const y0 = await inkY();
  await E(() => { const sc = [...document.querySelectorAll('#hwpHost div')].find((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY)); sc.scrollTop += 100; });
  await page.waitForTimeout(300);
  const y1 = await inkY();
  check('ink moves with the document when scrolled', y0 > 0 && Math.abs((y0 - y1) - 100) < 4, `${y0} → ${y1}`);

  // ── PDF 내보내기 (필기 포함) ──
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }).catch(async () => { console.log('PDF toast:', await page.textContent('#toast')); throw new Error('no pdf'); }), page.click('#hwpBar [data-hb=pdf]')]);
  const pdfPath = h.S + '/hwp-export.pdf';
  await dl.saveAs(pdfPath);
  const pdf = fs.readFileSync(pdfPath, 'latin1');
  const { PDFDocument } = require('pdf-lib');
  const pdoc = await PDFDocument.load(fs.readFileSync(pdfPath));
  const [pw, ph] = [pdoc.getPage(0).getWidth(), pdoc.getPage(0).getHeight()];
  check('PDF export: valid A4 PDF with page images', pdf.startsWith('%PDF') && pdoc.getPageCount() >= 1 && Math.abs(pw - 595.3) < 1 && Math.abs(ph - 841.9) < 1 && /DCTDecode/.test(pdf), `${pdoc.getPageCount()}p ${pw}x${ph}`);
  // 인쇄: 쪽 그림이 인쇄용 영역에
  await E(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  await page.click('#hwpBar [data-hb=print]');
  await page.waitForFunction(() => window.__printed > 0, null, { timeout: 20000 });
  check('print prepares page images', (await E(() => document.querySelectorAll('#printRoot .print-page img').length)) >= 1);

  // ── 다시 열기: 필기와 고친 내용 유지 ──
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  check('library card for the new document says 한글 HWP', /한글 HWP/.test(await page.locator('.doc-card:has-text("새 한글")').textContent()));
  await page.locator('.doc-card:has-text("새 한글")').click();
  await page.waitForFunction(() => __flexnote.hwp?.session, null, { timeout: 30000 });
  await page.waitForTimeout(1200);
  check('re-opened: text, table text and ink kept', (await txt()).includes('테스트') && (await txt()).includes('셀글') && (await E(() => __flexnote.state.doc.items(0).length)) === 1, JSON.stringify(await txt()));
  // 다운로드한 한글 파일도 다시 열림
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#hwpBar [data-hb=save]')]);
  const out = h.S + '/hwp-new.hwp';
  await dl2.saveAs(out);
  check('saved .hwp file is HWP5', fs.readFileSync(out).readUInt32BE(0) === 0xd0cf11e0);

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
