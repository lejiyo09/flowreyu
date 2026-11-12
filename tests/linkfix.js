// 코드 리뷰 수정 확인: 마우스로 링크 클릭(끌기와 구분, 그리기 모드 포함), 이름표도 누르는 영역, 링크 입력 검증(창 유지),
// 백업 가져오기의 그림 id 충돌 방지, 저장 실패 시 노트를 닫지 않음
const h = require('./harness');
const fs = require('fs');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, cdp, logs } = await h.launch();
  let confirmAnswer = true;
  page.on('dialog', (d) => (d.type() === 'confirm' ? (confirmAnswer ? d.accept() : d.dismiss()) : d.accept()));
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  await page.evaluate(async () => { for (const d of await __flexnote.store.listDocs()) await __flexnote.store.deleteDoc(d.id); });
  await page.reload();
  await page.waitForTimeout(500);
  await page.setInputFiles('#fileInput', h.S + '/links.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const vp = await page.locator('#viewport').boundingBox();
  const cur = () => page.evaluate(() => __flexnote.viewer.currentPage());
  const C = async (x, y) => { const s = await page.evaluate(([x, y]) => __flexnote.viewer.pageToScreen(0, x, y), [x, y]); return { x: vp.x + s.x, y: vp.y + s.y }; };
  const items = () => page.evaluate(() => __flexnote.state.doc.items(0));

  // ── 1. 마우스로 링크 클릭 (먼저 "마우스로 쓰기" 끈 상태: 끌면 화면 이동) ──
  await page.evaluate(() => __flexnote.settings.set('mouseDraw', false));
  await page.evaluate(() => __flexnote.state.doc.add(0, { id: 'L1', t: 'ln', x: 300, y: 300, w: 120, h: 40, to: { page: 3 } }));
  await page.waitForTimeout(200);
  let p = await C(360, 320);
  await page.mouse.move(p.x, p.y);
  await page.waitForTimeout(50);
  check('mouse over a link shows a pointer cursor', await page.evaluate(() => getComputedStyle(document.querySelector('#viewport')).cursor) === 'pointer');
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(400);
  check('mouse click on a user link → goes to page 4', (await cur()) === 3, `cur=${await cur()}`);
  await page.click('#backChip');
  await page.waitForTimeout(300);
  check('back chip returns', (await cur()) === 0);
  // 끌기는 이동이지 링크가 아님
  p = await C(360, 320);
  const cam0 = await page.evaluate(() => __flexnote.viewer.cam.ty);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(p.x, p.y - k * 10);
  await page.mouse.up();
  await page.waitForTimeout(300);
  check('mouse drag starting on a link pans instead of navigating', (await cur()) === 0 && (await page.evaluate(() => __flexnote.viewer.cam.ty)) !== cam0);
  await page.evaluate(() => __flexnote.viewer.goToPage(0));
  await page.waitForTimeout(200);
  // PDF 안의 링크도 마우스로 (PDF 좌표 (60,700) 근처 = 3쪽으로)
  p = await C(120, 842 - 705);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(500);
  check('mouse click on a PDF internal link → page 3', (await cur()) === 2, `cur=${await cur()}`);
  await page.click('#backChip');
  await page.waitForTimeout(300);

  // ── 3. 이름표 = 누르는 영역, 폭은 링크 폭 이하 ──
  const lab = await page.evaluate(() => import('./js/ink.js').then((m) => { const it = __flexnote.state.doc.items(0).find((i) => i.id === 'L1'); const L = m.linkLabelRect(it); const b = m.bbox(it); return { L, b }; }));
  check('label sits above and is included in the link bounds', lab.L.y < 300 && lab.b.y <= lab.L.y && lab.L.w <= 120, JSON.stringify(lab));
  p = await C(305, lab.L.y + lab.L.h / 2);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(400);
  check('clicking the blue label follows the link', (await cur()) === 3);
  await page.click('#backChip');
  await page.waitForTimeout(300);
  // 좁은 링크: 긴 주소 이름표는 … 로 줄어 링크 폭을 넘지 않음
  await page.evaluate(() => __flexnote.state.doc.add(0, { id: 'L2', t: 'ln', x: 100, y: 450, w: 40, h: 14, to: { url: 'https://very-long-hostname.example.com/path' } }));
  const lab2 = await page.evaluate(() => import('./js/ink.js').then((m) => m.linkLabelRect(__flexnote.state.doc.items(0).find((i) => i.id === 'L2'))));
  check('long label is shortened to the link width', lab2.w <= 40 && lab2.text.endsWith('…'), JSON.stringify(lab2));

  // ── 마우스로 쓰기 모드(기본값): 링크 클릭은 점 대신 이동, 끌면 필기 ──
  await page.evaluate(() => __flexnote.settings.set('mouseDraw', true));
  await page.evaluate(() => __flexnote.viewer.goToPage(0));
  await page.waitForTimeout(600);
  const n0 = (await items()).length;
  p = await C(120, 842 - 705);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(500);
  check('mouse-draw mode: first click on a PDF link navigates (links preloaded)', (await cur()) === 2 && (await items()).length === n0, `cur=${await cur()}`);
  await page.click('#backChip');
  await page.waitForTimeout(300);
  p = await C(360, 320);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(400);
  check('mouse-draw mode: click on a link navigates, no dot drawn', (await cur()) === 3 && (await items()).length === n0);
  await page.click('#backChip');
  await page.waitForTimeout(300);
  p = await C(330, 315);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(p.x + k * 8, p.y + k * 2);
  await page.mouse.up();
  await page.waitForTimeout(300);
  check('mouse-draw mode: dragging across a link writes a stroke', (await cur()) === 0 && (await items()).length === n0 + 1);

  // ── 2. 링크 입력 검증: 틀리면 창 유지 ──
  await page.evaluate(() => __flexnote.settings.set('tool', 'link'));
  p = await C(360, 320);
  await h.pen(cdp, [[p.x, p.y, 0.5]]); // 링크 도구로 탭 → 기존 링크 편집
  await page.waitForSelector('#linkDlg[open]');
  await page.fill('#lnPage', '99');
  await page.click('#linkDlg button[value=ok]');
  await page.waitForTimeout(200);
  check('invalid page number keeps the dialog open with an error', await page.locator('#linkDlg[open]').count() === 1 && await page.locator('#lnErr').isVisible() && /1~/.test(await page.textContent('#lnErr')) && (await page.inputValue('#lnPage')) === '99');
  check('the wrong field is marked', await page.locator('#lnPage.err').count() === 1);
  check('existing link unchanged while the input is wrong', (await items()).find((i) => i.id === 'L1').to.page === 3);
  await page.click('#lnKind button[value=url]');
  await page.fill('#lnUrl', 'ftp://x.example.com');
  await page.press('#lnUrl', 'Enter');
  await page.waitForTimeout(200);
  check('Enter in the field = save; bad scheme rejected, dialog stays', await page.locator('#linkDlg[open]').count() === 1 && /http/.test(await page.textContent('#lnErr')));
  await page.fill('#lnUrl', 'notaurl');
  await page.press('#lnUrl', 'Enter');
  await page.waitForTimeout(200);
  check('host without a dot rejected', await page.locator('#linkDlg[open]').count() === 1);
  await page.fill('#lnUrl', 'example.org/a');
  check('typing clears the error', await page.locator('#lnErr').isHidden());
  await page.press('#lnUrl', 'Enter');
  await page.waitForTimeout(200);
  check('valid input saves and closes', await page.locator('#linkDlg[open]').count() === 0 && (await items()).find((i) => i.id === 'L1').to.url === 'https://example.org/a');
  // 취소하면 아무것도 안 바뀜
  await h.pen(cdp, [[p.x, p.y, 0.5]]);
  await page.waitForSelector('#linkDlg[open]');
  await page.fill('#lnUrl', 'other.com');
  await page.click('#linkDlg button[value=cancel] >> nth=-1');
  await page.waitForTimeout(200);
  check('cancel keeps the old link', (await items()).find((i) => i.id === 'L1').to.url === 'https://example.org/a');
  await page.evaluate(() => __flexnote.settings.set('tool', 'pen'));

  // ── 4. 백업 가져오기: 그림 id 충돌 방지 ──
  await page.setInputFiles('#imageInput', h.S + '/img.png');
  await page.waitForTimeout(900);
  const docA = await page.evaluate(() => __flexnote.state.doc.id);
  const imA = (await items()).find((i) => i.t === 'im');
  await page.click('#btnSettings');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnBackupExport')]);
  const bpath = h.S + '/linkfix-backup.json';
  await dl.saveAs(bpath);
  await page.evaluate(() => document.querySelector('#settingsDlg').close());
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])');
  await page.setInputFiles('#fileInput', h.S + '/links.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const docB = await page.evaluate(() => __flexnote.state.doc.id);
  await page.click('#btnSettings');
  await page.setInputFiles('#backupInput', bpath);
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.querySelector('#settingsDlg').close());
  const imB = (await items()).find((i) => i.t === 'im');
  const recs = await page.evaluate(async ([a, b]) => { const x = await __flexnote.store.getBlob(a); const y = await __flexnote.store.getBlob(b); return { a: x && x.docId, b: y && y.docId }; }, [imA.blob, imB?.blob]);
  check('backup import gives the image a new id in this note', imB && imB.blob !== imA.blob && recs.b === docB, JSON.stringify({ a: imA.blob, b: imB?.blob, recs }));
  check('original note keeps its own image record', recs.a === docA, JSON.stringify(recs));

  // ── 5. 저장 실패: 노트를 닫지 않음 ──
  await page.evaluate(() => {
    window.__put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (v, k) { if (this.name === 'pages') throw new DOMException('디스크 가득 참', 'QuotaExceededError'); return window.__put.call(this, v, k); };
  });
  await page.evaluate(() => __flexnote.settings.set('tool', 'pen')); // 그림을 넣으면 올가미로 바뀌어 있음
  p = await C(80, 200);
  await h.pen(cdp, h.line(p.x, p.y, p.x + 120, p.y + 20, 10));
  await page.waitForTimeout(300);
  await page.click('#btnBack');
  await page.waitForSelector('#saveFailDlg[open]', { timeout: 5000 }).catch(() => {});
  check('save failure on Back: warning shown, note stays open', await page.locator('#saveFailDlg[open]').count() === 1 && await page.locator('#editor').isVisible() && /저장 공간/.test(await page.textContent('#sfReason')), await page.textContent('#sfReason').catch(() => ''));
  await page.click('#saveFailDlg button[value=retry]');
  await page.waitForTimeout(400);
  check('retry while still failing asks again', await page.locator('#saveFailDlg[open]').count() === 1);
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#saveFailDlg button[value=backup]')]);
  await dl2.saveAs(h.S + '/linkfix-rescue.json');
  const rescue = JSON.parse(fs.readFileSync(h.S + '/linkfix-rescue.json', 'utf8'));
  check('backup can be downloaded from the warning (includes the unsaved stroke)', Object.values(rescue.pages).flat().some((i) => i.t === 's'));
  await page.waitForSelector('#saveFailDlg[open]');
  confirmAnswer = false;
  await page.click('#saveFailDlg button[value=discard]'); // 확인 창에서 취소 → 다시 경고
  await page.waitForTimeout(300);
  check('discard needs confirmation (cancel keeps it open)', await page.locator('#saveFailDlg[open]').count() === 1);
  confirmAnswer = true;
  await page.click('#saveFailDlg button[value=stay]');
  await page.waitForTimeout(300);
  check('"keep editing" returns to the note', await page.locator('#editor').isVisible() && await page.locator('#saveFailDlg[open]').count() === 0);
  // 저장소가 돌아오면 정상 닫기 + 필기 보존
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.__put; });
  await page.click('#btnBack');
  await page.waitForSelector('#library:not([hidden])', { timeout: 5000 }).catch(() => {});
  check('after storage recovers, Back closes normally', await page.locator('#library').isVisible());
  const saved = await page.evaluate(async (id) => (await __flexnote.store.loadPages(id)).flatMap((r) => r.items).filter((i) => i.t === 's').length, docB);
  check('the stroke written during the failure was saved', saved === 2, saved); // 백업에서 온 획 1 + 실패 중에 쓴 획 1

  // ── 무한 스크롤 문서 안의 링크: 페이지(시트) 번호 ──
  await page.click('#btnNewNote');
  await page.selectOption('#nnKind', 'scroll');
  await page.click('#nnOk');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(600);
  await page.evaluate(() => __flexnote.state.doc.add(0, { id: 'far', t: 's', tool: 'pen', c: '#111111', w: 3, pr: false, pts: [100, 1700, 0.5, 200, 1710, 0.5] }));
  await page.evaluate(() => __flexnote.settings.set('tool', 'link'));
  await page.waitForTimeout(200);
  const vp2 = await page.locator('#viewport').boundingBox();
  const C2 = async (x, y) => { const s = await page.evaluate(([x, y]) => __flexnote.viewer.pageToScreen(0, x, y), [x, y]); return { x: vp2.x + s.x, y: vp2.y + s.y }; };
  const a = await C2(100, 200), b = await C2(250, 240);
  await h.pen(cdp, h.line(a.x, a.y, b.x, b.y, 8));
  await page.waitForSelector('#linkDlg[open]');
  await page.click('#lnKind button[value=page]');
  await page.fill('#lnPage', '3');
  await page.click('#linkDlg button[value=ok]');
  await page.waitForTimeout(300);
  const sl = (await items()).find((i) => i.t === 'ln');
  check('scroll note: link to printed page 3', sl?.to.sheet === 2 && Math.abs(sl.to.y - 841.89 * 2) < 0.1, JSON.stringify(sl?.to));
  await page.evaluate(() => __flexnote.settings.set('tool', 'pen'));
  await page.waitForTimeout(500);
  const m = await C2(170, 220);
  await page.mouse.click(m.x, m.y);
  await page.waitForTimeout(400);
  const topY = await page.evaluate(() => __flexnote.viewer.toWorld(0, __flexnote.viewer.insetTop + 16).y);
  check('following it scrolls to that sheet; back returns', Math.abs(topY - 841.89 * 2) < 3 && /1쪽/.test(await page.textContent('#backChip')), topY);
  await page.click('#backChip');
  await page.waitForTimeout(300);
  check('back chip restores the scroll position', (await page.evaluate(() => __flexnote.viewer.toWorld(0, __flexnote.viewer.insetTop + 16).y)) < 50);

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
