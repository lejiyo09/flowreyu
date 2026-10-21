// 스톱워치 · 타이머 · 글래스 디자인 테스트
const h = require('./harness');
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`);
(async () => {
  const { browser, page, logs } = await h.launch();
  await page.goto(process.env.APP_URL || 'http://localhost:8080/');
  await page.waitForTimeout(500);
  await page.evaluate(() => localStorage.removeItem('flexnote.clock.v1'));
  await page.reload();
  await page.waitForTimeout(500);
  await page.setInputFiles('#fileInput', h.S + '/sample.pdf');
  await page.waitForSelector('#editor:not([hidden])');
  await page.waitForTimeout(800);
  const txt = (sel) => page.textContent(sel);
  const secs = (s) => { const p = s.split(/[:.]/).map(Number); return p.length === 3 ? p[0] * 60 + p[1] + p[2] / 100 : p[0] * 60 + p[1]; };

  // ── 스톱워치 ──
  await page.click('#btnClock');
  await page.waitForTimeout(150);
  check('clock panel opens on stopwatch tab', await page.locator('#clockPanel').isVisible() && await page.locator('#ckSw').isVisible());
  check('chip hidden while idle', await page.locator('#clockChip').isHidden());
  await page.click('#swStart');
  await page.waitForTimeout(1300);
  const t1 = secs(await txt('#swTime'));
  check('stopwatch runs (shows ~1.3s, updates while open)', t1 >= 1.1 && t1 < 2.5, await txt('#swTime'));
  await page.click('#swLap');
  await page.waitForTimeout(600);
  await page.click('#swLap');
  check('laps recorded (newest first)', (await page.locator('#swLaps li').count()) === 2);
  await page.click('#ckClose');
  await page.waitForTimeout(1100);
  check('chip shows running stopwatch when panel closed', await page.locator('#clockChip').isVisible() && /\d\d:\d\d/.test(await txt('#clockChip')), await txt('#clockChip'));
  await page.click('#clockChip');
  await page.click('#swStart'); // 일시정지
  const p1 = await txt('#swTime');
  await page.waitForTimeout(500);
  check('pause stops the stopwatch', (await txt('#swTime')) === p1 && (await txt('#swStart')) === '계속');
  await page.click('#swReset');
  check('reset clears time and laps', (await txt('#swTime')) === '00:00.00' && (await page.locator('#swLaps li').count()) === 0);

  // ── 타이머 ──
  await page.click('#ckTabs button[value=tm]');
  await page.click('#tmPresets button:nth-child(3)'); // 5분
  check('preset sets 05:00', (await txt('#tmTime')) === '05:00');
  await page.fill('#tmMin', '0');
  await page.fill('#tmSec', '2');
  await page.click('#tmApply');
  check('custom time 00:02', (await txt('#tmTime')) === '00:02');
  await page.click('#tmStart');
  await page.waitForTimeout(800);
  check('timer counts down', secs(await txt('#tmTime')) <= 2 && (await txt('#tmStart')) === '일시정지');
  await page.click('#ckClose');
  await page.waitForTimeout(2200);
  check('timer end: toast + chip shows done', /타이머가 끝났습니다/.test(await txt('#toast')) && /타이머 끝/.test(await txt('#clockChip')), (await txt('#toast')) + ' | ' + (await txt('#clockChip')));
  await page.click('#clockChip');
  check('panel opens on timer tab showing 끝!', await page.locator('#ckTm').isVisible() && (await txt('#tmTime')) === '끝!');
  await page.click('#ckClose');
  await page.waitForTimeout(150);
  check('closing panel acknowledges the end (chip hidden)', await page.locator('#clockChip').isHidden());
  // +1분 / 새로고침해도 계속
  await page.click('#btnClock');
  await page.click('#tmReset');
  await page.click('#tmPlus');
  check('+1분 adds a minute', (await txt('#tmTime')) === '00:03' || (await txt('#tmTime')) === '01:02', await txt('#tmTime'));
  await page.click('#tmPresets button:nth-child(1)'); // 1분
  await page.click('#tmStart');
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForSelector('#editor:not([hidden])', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('flexnote.clock.v1')).tm);
  check('timer keeps running after reload', st.running && st.end - Date.now() > 50000 && st.end - Date.now() <= 60000);
  if (await page.locator('#editor').isVisible()) check('chip visible after reload', await page.locator('#clockChip').isVisible() && /00:5\d/.test(await txt('#clockChip')), await txt('#clockChip'));

  // ── 글래스 디자인 ──
  const glassOn = () => page.evaluate(() => document.documentElement.classList.contains('glass'));
  check('glass off by default', !(await glassOn()));
  await page.evaluate(() => __flexnote.settings.set('glass', true));
  const bf = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('#toolbar')); return s.backdropFilter || s.webkitBackdropFilter || ''; });
  check('glass setting turns on blurred translucent toolbar', (await glassOn()) && /blur/.test(bf), bf);
  // 위쪽 바도 유리: 페이지 위에 떠 있고(absolute) 뷰어는 바 높이만큼 아래에서 시작
  const tb = await page.evaluate(() => { const t = document.querySelector('#editor > .topbar'); const s = getComputedStyle(t); return { pos: s.position, bf: s.backdropFilter || s.webkitBackdropFilter, h: t.offsetHeight, inset: __flexnote.viewer.insetTop }; });
  check('glass top bar floats over pages with blur', tb.pos === 'absolute' && /blur/.test(tb.bf) && tb.inset === tb.h && tb.h > 0, JSON.stringify(tb));
  await page.evaluate(() => __flexnote.viewer.goToPage(0));
  const firstTop = await page.evaluate(() => __flexnote.viewer.pageToScreen(0, 0, 0).y);
  check('first page starts below the glass bar', firstTop >= tb.h, String(firstTop));
  await page.reload();
  await page.waitForTimeout(800);
  check('glass setting persists', await glassOn());
  await page.evaluate(() => __flexnote.settings.set('glass', false));
  check('glass can be turned off', !(await glassOn()));
  check('inset removed when glass off', (await page.evaluate(() => __flexnote.viewer.insetTop)) === 0);

  await page.evaluate(() => localStorage.removeItem('flexnote.clock.v1'));
  const errs = logs.filter((l) => l.startsWith('[pageerror]'));
  check('no page errors', !errs.length, errs.join('\n'));
  console.log(results.join('\n'));
  await browser.close();
  process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
})().catch((e) => { console.log(results.join('\n')); console.error('Error', e); process.exit(1); });
