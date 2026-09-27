import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
for (const shot of ['islands-caribbean','islands-aegean']) {
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(600000);
await page.goto(`http://127.0.0.1:5332/?shot=${shot}&freeze=1`, { timeout: 300000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
await page.waitForTimeout(2500);
const st = await page.evaluate(() => { const a = window.__front.ctx.app; const s0 = a.state; a.goto?.('playing'); return [s0, a.state]; });
console.log(shot, 'state', st);
const d = await page.evaluate(() => window.__islands.details());
const ms = d.markers.filter(m => m.x > 340 && m.y > 120 && m.x < 1280 && m.y < 760).slice(0, 4);
for (const m of ms) {
  let tip = null;
  await page.mouse.move(m.x - 20, m.y - 20); await page.waitForTimeout(300);
  await page.mouse.move(m.x, m.y, { steps: 4 });
  for (let k = 0; k < 16 && !tip; k++) { await page.waitForTimeout(500); tip = await page.evaluate(() => { const el = document.querySelector('.fu-tt'); return el ? (el.classList.contains('fu-hidden') ? 'HIDDEN' : el.textContent) : 'NOEL'; }); if (tip === 'HIDDEN') tip = null; }
  const pick = await page.evaluate(([x,y]) => window.__front.ctx.globe.pickIsland?.(x,y) ?? null, [m.x, m.y]);
  console.log(' marker', Math.round(m.x), Math.round(m.y), m.diameterPx, m.components, 'tip:', tip, 'pick:', JSON.stringify(pick));
}
await page.screenshot({ path: `shots/W2-map-readability-verify/hover-${shot}.png` });
await page.close();
}
await browser.close();
