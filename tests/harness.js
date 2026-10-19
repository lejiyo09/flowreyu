const { chromium } = require('playwright');
const S = __dirname + '/fixtures';
exports.launch = async (opts = {}) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1200, height: 860 }, deviceScaleFactor: opts.dpr || 2, hasTouch: true, isMobile: false });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
  page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));
  const cdp = await context.newCDPSession(page);
  return { browser, context, page, cdp, logs };
};
// 펜 획: points [[x,y,pressure], ...] (client coords)
exports.pen = async (cdp, pts, { buttons = 1, button = 'left', hover = true } = {}) => {
  const [x0, y0] = pts[0];
  if (hover) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, pointerType: 'pen', buttons: 0, force: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button, buttons, clickCount: 1, pointerType: 'pen', force: pts[0][2] ?? 0.5 });
  for (const [x, y, p] of pts.slice(1)) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button, buttons, pointerType: 'pen', force: p ?? 0.5 });
  const [x1, y1] = pts[pts.length - 1];
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button, buttons: 0, clickCount: 1, pointerType: 'pen', force: 0 });
};
exports.line = (x0, y0, x1, y1, n = 20, p = 0.6) => Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, p]);
exports.touch = (cdp, type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id, r = 5]) => ({ x, y, id, radiusX: r, radiusY: r, force: 1 })) });
exports.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
exports.S = S;
