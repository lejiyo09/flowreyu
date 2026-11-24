// 한글 문서 고급 편집: 각주·미주(HWPX), 수식 넣기(LaTeX 변환)·기존 수식 고치기(HWP5), F5 칸 블록 → 셀 합치기(HWPX),
// 행·열을 연달아 바꾸기(칸 다시 누르지 않아도), 새 개체가 있을 때 쪽 설정은 확인 후 적용
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, logs } = await h.launch();
  let confirmText = '';
  page.on('dialog', (d) => { if (d.type() === 'confirm') confirmText = d.message(); d.accept(); });
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  const E = (f, a) => page.evaluate(f, a);
  const toastT = () => page.textContent('#toast').catch(() => '');
  const open = async (f) => {
    await page.setInputFiles('#fileInput', h.S + '/' + f);
    await page.waitForFunction(() => __flexnote.hwp?.session, null, { timeout: 30000 });
    await page.waitForTimeout(1000);
  };
  const back = async () => { await page.click('#btnBack'); await page.waitForSelector('#library:not([hidden])'); };
  const inCell = () => E(() => { const sf = __flexnote.hwp.session.surface; return !!(sf.captureGeneratedTableGridSelection?.() || sf.captureSourceTableGridSelection?.()); });
  const findCell = async (hb, x) => {
    for (let dy = 120; dy <= 560; dy += 6) { await page.mouse.click(x, hb.y + dy); await page.waitForTimeout(120); if (await inCell()) return true; }
    return false;
  };

  // ── HWPX: 수식 (LaTeX 입력) → 각주 ──
  await open('test.hwpx');
  let hb = await page.locator('#hwpHost').boundingBox();
  let r0;
  await page.mouse.click(hb.x + hb.width / 2, hb.y + 155);
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  r0 = await E(() => __flexnote.hwp.session.rev);
  await page.click('#hwpBar [data-hb=equation]');
  check('equation dialog: no existing-equation chooser on HWPX', await page.locator('#heWhichRow').isHidden());
  await page.fill('#heScript', '\\frac{1}{2} + \\alpha');
  await page.click('#hwpEqDlg button[value=ok]');
  await page.waitForFunction(() => /수식/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
  check('equation inserted (HWPX, LaTeX converted)', (await E(() => __flexnote.hwp.session.rev)) !== r0 && /수식을 넣었습니다/.test(await toastT()), await toastT());
  check('LaTeX → 한글 수식 conversion', await E(async () => (await import('./js/hwp.js')).latexToHwpEq('\\frac{a}{b}+\\sqrt{x}\\le\\pi')) === '{a} over {b}+sqrt {x}<= pi');

  // ── HWPX: 표 → 저장·다시 열기(원본 표가 되게) → F5 칸 블록 → 합치기 ──
  await page.mouse.click(hb.x + hb.width / 2, hb.y + 155);
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  const tq = await E(() => __flexnote.hwp.session.insertTable(2, 3));
  check('table inserted for merge test', tq === null, String(tq));
  await page.waitForTimeout(600);
  await E(() => __flexnote.hwp.session.reload());
  await page.waitForTimeout(1200);
  hb = await page.locator('#hwpHost').boundingBox();
  const got = await findCell(hb, hb.x + 260);
  await page.click('#hwpBar [data-hb=blockRight]'); // 태블릿용 버튼 (= F5 두 번 → →)
  await page.waitForTimeout(400);
  const blk = await E(() => __flexnote.hwp.session.surface.hasCellBlock?.());
  r0 = await E(() => __flexnote.hwp.session.rev);
  await page.click('#hwpBar [data-hb=merge]');
  await page.waitForTimeout(1000);
  check('cell block button + merge cells (HWPX)', got && blk && (await E(() => __flexnote.hwp.session.rev)) !== r0 && /셀을 합쳤습니다/.test(await toastT()), `cell=${got} block=${blk} ${await toastT()}`);
  // ── 행·열을 연달아 (칸을 다시 누르지 않고) ──
  const got2 = await findCell(hb, hb.x + 560);
  r0 = await E(() => __flexnote.hwp.session.rev);
  await page.click('#hwpBar [data-hb=rowAfter]');
  await page.waitForTimeout(900);
  const r1 = await E(() => __flexnote.hwp.session.rev);
  await page.click('#hwpBar [data-hb=colAfter]');
  await page.waitForTimeout(900);
  check('add row then column without re-tapping the cell', got2 && r1 !== r0 && (await E(() => __flexnote.hwp.session.rev)) !== r1, await toastT());
  // ── HWPX: 각주 ──
  await page.mouse.click(hb.x + hb.width / 2, hb.y + 155);
  await page.keyboard.press('End');
  await page.waitForTimeout(300);
  r0 = await E(() => __flexnote.hwp.session.rev);
  await page.click('#hwpBar [data-hb=footnote]');
  await page.fill('#hnBody', '각주 내용');
  await page.click('#hwpNoteDlg button[value=ok]');
  await page.waitForTimeout(1000);
  check('footnote inserted (HWPX)', (await E(() => __flexnote.hwp.session.rev)) !== r0 && /각주를 넣었습니다/.test(await toastT()), await toastT());
  await back();

  // ── HWP5: 수식 넣기 → 기존 수식 고치기 ──
  await open('test.hwp');
  hb = await page.locator('#hwpHost').boundingBox();
  await page.mouse.click(hb.x + hb.width / 2, hb.y + 155);
  await page.keyboard.press('End');
  await page.waitForTimeout(300);
  await page.click('#hwpBar [data-hb=equation]');
  await page.fill('#heScript', '{a} over {b}');
  await page.click('#hwpEqDlg button[value=ok]');
  await page.waitForTimeout(1000);
  check('equation inserted (HWP5)', /수식을 넣었습니다/.test(await toastT()) && (await E(() => __flexnote.hwp.session.equations().length)) === 1, await toastT());
  await page.click('#hwpBar [data-hb=equation]');
  check('existing equation listed for editing', await page.locator('#heWhichRow').isVisible() && (await page.$$eval('#heWhich option', (o) => o.length)) === 2);
  await page.selectOption('#heWhich', '0');
  await page.waitForFunction(() => document.querySelector('#heScript').value.includes('over'), null, { timeout: 5000 }).catch(() => {});
  check('existing equation script loaded', (await page.inputValue('#heScript')) === '{a} over {b}', await page.inputValue('#heScript'));
  await page.fill('#heScript', 'x^2 + y^2');
  await page.click('#hwpEqDlg button[value=ok]');
  await page.waitForTimeout(1000);
  const sc = await E(async () => { const s = __flexnote.hwp.session; const cap = await s.readEquation(s.equations()[0].row); s.releaseEquation(cap); return cap.script; });
  check('equation edited', /수식을 고쳤습니다/.test(await toastT()) && sc === 'x^2 + y^2', sc);
  // 키보드: F5 두 번 → 방향키 도 블록 (HWP5 는 합치기 미지원 안내)
  check('footnote on HWP5 explains engine limit', await (async () => { await page.click('#hwpBar [data-hb=footnote]'); await page.fill('#hnBody', 'x'); await page.click('#hwpNoteDlg button[value=ok]'); await page.waitForTimeout(800); return /지원하지 않습니다/.test(await toastT()); })());

  // ── 새 개체가 있을 때 쪽 설정: 확인 창 → 적용 ──
  await page.mouse.click(hb.x + hb.width / 2, hb.y + 155);
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await E(() => __flexnote.hwp.session.insertTable(1, 2));
  await page.waitForTimeout(600);
  await page.click('#hwpBar [data-hb=page]');
  await page.waitForSelector('#hwpPageDlg[open]');
  await page.fill('#hpR', '22');
  await page.click('#hwpPageDlg button[value=ok]');
  await page.waitForTimeout(2500);
  const right = await E(async () => (await __flexnote.hwp.session.pageSettings()).values?.margin.right);
  check('page setup with a new table applies (asks first only when the engine needs a reopen)', right === 22 && (!confirmText || /실행 취소 기록/.test(confirmText)), `${right} ${confirmText.slice(0, 30)}`);

  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
