// 업데이트 흐름: 서버 파일이 바뀌면 "업데이트" 표시 → 누르면 새 버전으로 새로고침
const h = require('./harness');
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const root = path.join(__dirname, '..');
(async () => {
  const { browser, page } = await h.launch();
  const url = process.env.APP_URL || 'http://localhost:8080/';
  await page.goto(url);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000 }).catch(async () => { await page.reload(); });
  await page.waitForTimeout(800);
  const v1 = await page.evaluate(async () => (await caches.keys()).find((k) => k.startsWith('flexnote-')));
  const css = path.join(root, 'css/app.css');
  const orig = fs.readFileSync(css, 'utf8');
  let ok = false;
  try {
    fs.writeFileSync(css, orig + '\n/* update-test */\n');
    execSync('node tools/gen-sw.js', { cwd: root });
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await page.waitForSelector('#updateBar:not([hidden])', { timeout: 20000 });
    const nav = page.waitForNavigation({ timeout: 20000 });
    await page.click('#updateBar button');
    await nav;
    await page.waitForTimeout(800);
    const v2 = await page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('flexnote-')));
    const hasNew = await page.evaluate(async () => (await (await fetch('css/app.css')).text()).includes('update-test'));
    ok = v2.length === 1 && v2[0] !== v1 && hasNew;
    console.log(`${ok ? 'PASS' : 'FAIL'}  update bar → reload to new version (old cache removed) ${v1} → ${v2}`);
  } finally {
    fs.writeFileSync(css, orig);
    execSync('node tools/gen-sw.js', { cwd: root });
  }
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
