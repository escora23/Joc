import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(240000);
await page.goto('http://127.0.0.1:5332/?shot=islands-aegean&freeze=1', { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
await page.waitForTimeout(3000);
const d = await page.evaluate(() => window.__islands.details());
console.log('state before', await page.evaluate(() => window.__front.ctx.app.state ?? window.__front.ctx.app.getState?.()));
await page.evaluate(() => window.__front.ctx.app.goto?.('playing'));
await page.waitForTimeout(1500);
console.log('state after', await page.evaluate(() => window.__front.ctx.app.state ?? window.__front.ctx.app.getState?.()));
const ms = d.markers.filter((x) => x.x > 340 && x.y > 120 && x.x < 1250 && x.y < 700).slice(0, 6);
let n = 0;
for (const m of ms) {
  await page.mouse.move(m.x - 30, m.y - 30); await page.waitForTimeout(300);
  await page.mouse.move(m.x, m.y); await page.waitForTimeout(2500);
  const r = await page.evaluate(([x, y]) => {
    const el = document.querySelector('.fu-tt');
    const isl = window.__front.ctx.globe.pickIsland?.(x, y);
    return { tip: el && !el.classList.contains('fu-hidden') ? el.textContent : null, cls: el?.className, pickIsland: isl, top: document.elementFromPoint(x, y)?.tagName };
  }, [m.x, m.y]);
  if (r.tip) n++;
  console.log(JSON.stringify({ m: { x: Math.round(m.x), y: Math.round(m.y), d: m.diameterPx }, ...r }));
}
await page.screenshot({ path: '/home/user/joc/shots/W2-map-readability-verify/it4/diag-island-hover.png' });
console.log('tips', n, '/', ms.length);
await browser.close();
