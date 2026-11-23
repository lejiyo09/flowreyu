// 한글(HWP·HWPX) 열기·편집·저장 (@ohah/hwpjs 엔진): 원래 형식 그대로 열리는지, 고치지 않고 저장하면 원본 그대로인지,
// 글을 고치고 서식을 바꾸면 자동 저장돼 다시 열어도 남는지, "한글 저장"이 같은 형식(.hwp/.hwpx)의 새 파일을 주는지,
// 그 파일을 다시 열면 고친 글이 있는지, 손가락으로 문서를 넘길 수 있는지, 필기 도구가 숨겨지는지.
// 시험 문서는 엔진으로 새로 만든다 (사용자 파일은 저장소에 넣지 않음). HWP_SAMPLE=경로 를 주면 그 파일로도 확인.
const h = require('./harness');
const fs = require('fs');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, cdp, logs } = await h.launch();
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);

  // ── 시험 문서 만들기: 빈 문서에 글을 쳐서 HWP / HWPX 로 저장 ──
  const make = async (format, text) => {
    await page.evaluate(async (format) => {
      const H = await import('./vendor/hwpjs/hwpjs.mjs');
      const box = document.createElement('div');
      box.id = 'mk'; box.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#fff';
      document.body.appendChild(box);
      const ed = H.createEditor({ runtimeFactory: H.createWorkerRuntimeFactory({ workerURL: './vendor/hwpjs/worker.js', wasmURL: './vendor/hwpjs/hwpjs.wasm' }) });
      window.__mk = { ed, sf: H.createCanvasSurface({ root: box, editor: ed }) };
      await ed.createDocument({ format, editable: true });
    }, format);
    await page.waitForTimeout(800);
    await page.mouse.click(600, 200);
    await page.evaluate(() => __mk.sf.focus());
    await page.keyboard.type(text);
    await page.waitForTimeout(500);
    const bytes = await page.evaluate(async () => {
      const r = await __mk.ed.save({ allowStaleLayout: true });
      await __mk.sf.dispose(); await __mk.ed.dispose(); document.getElementById('mk').remove();
      return Array.from(r.bytes);
    });
    return Buffer.from(bytes);
  };
  const hwpFile = h.S + '/test.hwp', hwpxFile = h.S + '/test.hwpx';
  fs.writeFileSync(hwpFile, await make('hwp5', '한글 시험 문서'));
  fs.writeFileSync(hwpxFile, await make('hwpx', 'HWPX 시험'));
  check('engine can create HWP5 / HWPX test files', fs.readFileSync(hwpFile).readUInt32BE(0) === 0xd0cf11e0 && fs.readFileSync(hwpxFile).readUInt32BE(0) === 0x504b0304);

  const pageText = () => page.evaluate(() => { const r = __flexnote.hwp?.session?.surface.getPageText(0, { include: ['body', 'table', 'textbox', 'caption'] }); return r?.state === 'available' ? r.text : `(${r?.reason})`; });
  const openFile = async (f) => {
    await page.setInputFiles('#fileInput', f);
    await page.waitForFunction(() => __flexnote.hwp?.session, null, { timeout: 30000 });
    await page.waitForTimeout(1200);
  };

  // ── 열기 ──
  await openFile(hwpFile);
  check('HWP opens as a 한글 document (kind hwp, original format kept)', await page.evaluate(() => __flexnote.state.doc.meta.kind === 'hwp' && __flexnote.state.doc.meta.source.format === 'hwp5' && __flexnote.state.doc.meta.noteType === 'typing'));
  check('document text is shown', (await pageText()).includes('한글 시험 문서'), JSON.stringify(await pageText()));
  check('hwp bar shown; pen toolbar / PDF-only buttons hidden', await page.locator('#hwpBar').isVisible() && !(await page.locator('#toolbar').isVisible()) && !(await page.locator('#btnExport').isVisible()) && await page.locator('#hwpHost canvas').count() > 0);

  // ── 고치지 않고 저장 → 원본 그대로 ──
  let [dl] = await Promise.all([page.waitForEvent('download'), page.click('#hwpBar [data-hb=save]')]);
  await dl.saveAs(h.S + '/hwp-unchanged.hwp');
  check('saving without edits gives back the original file byte-for-byte', Buffer.compare(fs.readFileSync(h.S + '/hwp-unchanged.hwp'), fs.readFileSync(hwpFile)) === 0);

  // ── 글 고치기 (펜으로 눌러 커서 → 키보드) ──
  const host = await page.locator('#hwpHost').boundingBox();
  const caretAt = await page.evaluate(() => { const sf = __flexnote.hwp.session.surface; return !!sf; });
  await page.mouse.click(host.x + host.width / 2, host.y + 150);
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' 고침');
  await page.waitForTimeout(400);
  check('typing edits the document', caretAt && (await pageText()).includes('한글 시험 문서 고침'), JSON.stringify(await pageText()));
  check('undo button enabled after edit', !(await page.locator('#hwpBar [data-hb=undo]').isDisabled()));
  check('save state shows unsaved change', ['pending', 'saving'].includes(await page.getAttribute('#saveState', 'data-state')));
  await page.waitForFunction(() => document.querySelector('#saveState').dataset.state === 'saved', null, { timeout: 10000 });
  const stored = await page.evaluate(async () => new Uint8Array(await (await __flexnote.store.getFile(__flexnote.state.doc.id)).arrayBuffer()).length);
  check('edit auto-saved to the library (as a 한글 file)', stored > 0 && await page.evaluate(() => __flexnote.state.doc.meta.source.unchanged === false));

  // 서식: 마지막 두 글자 선택 → 굵게 (오류 알림 없이)
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.waitForTimeout(300);
  const selLen = await page.evaluate(() => { const s = __flexnote.hwp.session.selection(); return s ? s.endUnit - s.startUnit : -1; });
  const rev0 = await page.evaluate(() => __flexnote.hwp.session.rev);
  await page.click('#hwpBar [data-hb=bold]');
  await page.waitForTimeout(500);
  check('bold applied to selected text (document changed, no error toast)', selLen === 2 && (await page.evaluate(() => __flexnote.hwp.session.rev)) !== rev0 && !(await page.locator('#toast.error').isVisible().catch(() => false)), `sel=${selLen}`);
  await page.click('#hwpBar [data-hb=center]');
  await page.waitForTimeout(400);
  const rev1 = await page.evaluate(() => __flexnote.hwp.session.rev);
  check('paragraph alignment applied', rev1 !== rev0);
  // 실행 취소 → 정렬 되돌림
  await page.click('#hwpBar [data-hb=undo]');
  await page.waitForTimeout(500);
  check('undo works', (await page.evaluate(() => __flexnote.hwp.session.rev)) !== rev1 && (await pageText()).includes('고침'));

  // ── 한글 저장 → 같은 형식 새 파일, 다시 열면 고친 글 ──
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#hwpBar [data-hb=save]')]);
  const out = h.S + '/hwp-edited.hwp';
  await dl.saveAs(out);
  const name = await page.evaluate(() => window.__lastDownloadName || '');
  const ob = fs.readFileSync(out);
  check('saved edited file is HWP (same format), new name', ob.readUInt32BE(0) === 0xd0cf11e0 && Buffer.compare(ob, fs.readFileSync(hwpFile)) !== 0 && (!name || /FlexNote 편집\)\.hwp$/.test(name)), name);

  // 라이브러리 → 표지·표시 → 다시 열면 자동 저장된 내용
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  check('library card says 한글 HWP, cover saved', /한글 HWP/.test(await page.locator('.doc-card').first().textContent()) && await page.locator('.doc-card').first().locator('.cover img').count() === 1);
  await page.locator('.doc-card').first().click();
  await page.waitForFunction(() => __flexnote.hwp?.session, null, { timeout: 30000 });
  await page.waitForTimeout(1000);
  check('re-opened note keeps the edit (auto-saved)', (await pageText()).includes('고침'));
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');

  // 내려받은 파일을 다시 열기
  await openFile(out);
  check('downloaded file re-opens with the edit', (await pageText()).includes('한글 시험 문서 고침'), JSON.stringify(await pageText()));

  // ── 손가락으로 넘기기: 문서가 스크롤 ──
  const scroller = () => page.evaluate(() => { let best = null; for (const el of document.querySelectorAll('#hwpHost *')) if (el.scrollHeight > el.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) { best = el; break; } return best ? best.scrollTop : -1; });
  const st0 = await scroller();
  const hb = await page.locator('#hwpHost').boundingBox();
  const cx = hb.x + hb.width / 2;
  await h.touch(cdp, 'touchStart', [[cx, hb.y + 600, 1]]);
  for (let k = 1; k <= 10; k++) { await h.touch(cdp, 'touchMove', [[cx, hb.y + 600 - k * 40, 1]]); await page.waitForTimeout(16); }
  await h.touch(cdp, 'touchEnd', [[cx, hb.y + 200, 1]]);
  await page.waitForTimeout(400);
  const st1 = await scroller();
  check('finger swipe scrolls the document', st0 >= 0 && st1 > st0, `${st0} → ${st1}`);
  // 손가락 탭 → 커서가 그 자리로 (글 선택은 바뀌고 스크롤은 그대로)
  await page.evaluate(() => { const sc = [...document.querySelectorAll('#hwpHost div')].find((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY)); sc.scrollTop = 0; });
  await page.waitForTimeout(300);
  await page.mouse.click(cx - 280, hb.y + 155); // 글 첫머리에 먼저 커서
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => JSON.stringify(__flexnote.hwp.session.selection()));
  await h.touch(cdp, 'touchStart', [[cx - 200, hb.y + 155, 2]]);
  await h.touch(cdp, 'touchEnd', [[cx - 200, hb.y + 155, 2]]);
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => JSON.stringify(__flexnote.hwp.session.selection()));
  check('finger tap places the caret', after !== before && await page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'), `${before?.slice(-60)} → ${after?.slice(-60)}`);
  // 두 손가락 벌리기 → 확대, 위쪽 % 표시도
  const z0 = await page.evaluate(() => __flexnote.hwp.session.scale);
  await h.touch(cdp, 'touchStart', [[cx - 50, hb.y + 300, 3], [cx + 50, hb.y + 300, 4]]);
  for (let k = 1; k <= 8; k++) { await h.touch(cdp, 'touchMove', [[cx - 50 - k * 10, hb.y + 300, 3], [cx + 50 + k * 10, hb.y + 300, 4]]); await page.waitForTimeout(20); }
  await h.touch(cdp, 'touchEnd', [[cx - 130, hb.y + 300, 3], [cx + 130, hb.y + 300, 4]]);
  await page.waitForTimeout(400);
  const z1 = await page.evaluate(() => __flexnote.hwp.session.scale);
  check('two-finger pinch zooms (label follows)', z1 > z0 * 1.5 && (await page.textContent('#zoomVal')) === Math.round(z1 * 100) + '%', `${z0} → ${z1} ${await page.textContent('#zoomVal')}`);
  await page.click('#btnZoomOut');
  await page.waitForTimeout(200);
  const z2 = await page.evaluate(() => __flexnote.hwp.session.scale);
  check('zoom-out button steps down one level', z2 < z1 && z2 >= z1 / 2, `${z1} → ${z2}`);
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');

  // ── HWPX ──
  await openFile(hwpxFile);
  check('HWPX opens (format hwpx)', await page.evaluate(() => __flexnote.state.doc.meta.source.format === 'hwpx') && (await pageText()).includes('HWPX 시험'));
  await page.mouse.click(hb.x + hb.width / 2, hb.y + 150);
  await page.keyboard.press('Control+End');
  await page.keyboard.type('!');
  await page.waitForTimeout(600);
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('#hwpBar [data-hb=save]')]);
  const outx = h.S + '/hwp-edited.hwpx';
  await dl.saveAs(outx);
  check('HWPX saves as HWPX (zip) with the edit', fs.readFileSync(outx).readUInt32BE(0) === 0x504b0304 && Buffer.compare(fs.readFileSync(outx), fs.readFileSync(hwpxFile)) !== 0);
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  await openFile(outx);
  check('saved HWPX re-opens with the edit', (await pageText()).includes('HWPX 시험!'), JSON.stringify(await pageText()));
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');

  // ── 손상된 파일: 알림 ──
  fs.writeFileSync(h.S + '/bad.hwp', Buffer.from('not a hwp file at all'));
  await page.setInputFiles('#fileInput', h.S + '/bad.hwp');
  await page.waitForTimeout(800);
  check('broken .hwp is refused with a clear message', /한글 파일이 아닙니다/.test(await page.textContent('#toast').catch(() => '')));

  // ── (선택) 실제 사용자 문서 ──
  if (process.env.HWP_SAMPLE && fs.existsSync(process.env.HWP_SAMPLE)) {
    await openFile(process.env.HWP_SAMPLE);
    const t = await pageText();
    check('user sample opens with text', t.length > 20, JSON.stringify(t.slice(0, 60)));
    [dl] = await Promise.all([page.waitForEvent('download'), page.click('#hwpBar [data-hb=save]')]);
    await dl.saveAs(h.S + '/user-unchanged.hwp');
    check('user sample unchanged save is byte-identical', Buffer.compare(fs.readFileSync(h.S + '/user-unchanged.hwp'), fs.readFileSync(process.env.HWP_SAMPLE)) === 0);
    await page.click('#btnBack');
  }

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
