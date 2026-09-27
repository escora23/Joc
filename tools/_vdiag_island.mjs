import { chromium } from 'playwright';
const shot = process.argv[2] || 'islands-caribbean';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(600000);
await page.goto('http://127.0.0.1:5332/?shot=' + shot, { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
await page.waitForTimeout(3000);
const st0 = await page.evaluate(() => window.__front.ctx.app.state);
await page.evaluate(() => window.__front.ctx.app.goto?.('playing'));
await page.waitForTimeout(2000);
const st1 = await page.evaluate(() => window.__front.ctx.app.state);
const ms = await page.evaluate(() => window.__islands.details().markers);
console.log('state', st0, st1, 'markers', ms.length);
let n = 0;
for (const m of ms) {
  if (n >= 6) break;
  const top = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [m.x, m.y]);
  if (top !== 'CANVAS') continue;
  n++;
  await page.mouse.move(m.x - 30, m.y - 30); await page.waitForTimeout(300);
  await page.mouse.move(m.x, m.y);
  await page.waitForTimeout(2500);
  const r = await page.evaluate(([x, y]) => { const el = document.querySelector('.fu-tt'); return { tip: el ? el.textContent : null, hidden: el?.classList.contains('fu-hidden'), pick: window.__front.ctx.globe.pickIsland?.(x, y) }; }, [m.x, m.y]);
  console.log(JSON.stringify({ x: Math.round(m.x), y: Math.round(m.y), d: m.diameterPx, ...r }));
  if (n === 1) await page.screenshot({ path: '/tmp/claude-0/-home-user-procedural-terrain-generator/40934a72-ca05-52af-9ca0-c7756eb58848/scratchpad/island-hover.png' });
}
await browser.close();
