import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(600000);
await page.goto('http://127.0.0.1:5332/?shot=icons-europe&alt=6000', { timeout: 300000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
await page.waitForTimeout(2500);
await page.evaluate(() => { window.__sel = []; window.__front.ctx.bus.on('selectionChanged', (e) => window.__sel.push(e)); window.__front.ctx.app.goto?.('playing'); });
await page.waitForTimeout(3000);
const info = await page.evaluate(() => {
  const v = window.__front.ctx.sim.view;
  const icons = window.__units.icons().filter(h => h.kind==='single' && !h.structure);
  return { speed: v.speed ?? null, paused: v.paused ?? null, icons: icons.map(h => { const u = v.units.get(h.id); const el = document.elementFromPoint(h.x, h.y); return { id: h.id, owner: h.owner, x: Math.round(h.x), y: Math.round(h.y), type: u?.type, el: el ? (el.tagName + '.' + el.className).slice(0,80) : null, pick: window.__front.ctx.units.pickIcon?.(h.x, h.y) ?? null, p12: v.players[h.owner]?.name }; }) };
});
console.log(JSON.stringify(info.speed), info.paused);
for (const i of info.icons) console.log(JSON.stringify(i).slice(0,300));
// Click every non-structure single icon
let ok = 0, n = 0;
for (const i of info.icons) {
  await page.evaluate(() => { window.__sel.length = 0; });
  const now = (await page.evaluate(() => window.__units.icons())).find(x => x.id === i.id && !x.structure);
  if (!now) { console.log('gone', i.id); continue; }
  await page.mouse.move(now.x, now.y); await page.waitForTimeout(150);
  await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up(); await page.waitForTimeout(700);
  const sel = await page.evaluate(() => window.__sel.slice());
  const good = sel.some(e => e.unitIds.includes(i.id)); n++; if (good) ok++;
  console.log('click', i.id, i.owner, Math.round(now.x), Math.round(now.y), good, JSON.stringify(sel.map(e=>e.unitIds)));
}
console.log('TOTAL', ok, '/', n);
await page.screenshot({ path: 'shots/W2-map-readability-verify/click-after.png' });
await browser.close();
