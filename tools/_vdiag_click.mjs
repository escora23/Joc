import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(600000);
await page.goto('http://127.0.0.1:5332/?shot=icons-europe&alt=6000', { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
await page.waitForTimeout(3000);
await page.evaluate(() => window.__front.ctx.app.goto?.('playing'));
await page.waitForTimeout(3000);
const r = [];
await page.evaluate(() => { window.__ev = []; const b = window.__front.ctx.bus; b.on('worldClick', (e) => window.__ev.push(['wc', e.unitId, e.structureId, e.tile])); const c=document.querySelector('canvas'); c.addEventListener('pointerdown',(e)=>window.__ev.push(['pd',Math.round(e.timeStamp),e.clientX,e.clientY,Math.round(performance.now())]),true); window.addEventListener('pointerup',(e)=>window.__ev.push(['pu',Math.round(e.timeStamp),e.clientX,e.clientY,Math.round(performance.now()),e.target.tagName]),true); b.on('selectionChanged', (e) => window.__ev.push(['sel', JSON.stringify(e)])); });
for (const id of [535, 533, 497, 460, 426, 574, 657]) {
  const h = (await page.evaluate(() => window.__units.icons())).find((x) => x.id === id && !x.structure);
  if (!h) { r.push({ id, missing: true }); continue; }
  await page.evaluate(() => { window.__ev.length = 0; });
  await page.mouse.move(h.x, h.y); await page.waitForTimeout(150); await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up(); await page.waitForTimeout(900);
  const info = await page.evaluate((id) => { const v = window.__front.ctx.sim.view; const u = v.units.get(id); const p = v.players[u.owner]; return { ev: window.__ev.slice(), owner: u.owner, pname: p?.name, pkind: p?.kind, alive: p?.alive, state: window.__front.ctx.app.state }; }, id);
  r.push({ id, x: h.x, y: h.y, ...info });
}
for (const x of r) console.log(JSON.stringify(x));
await browser.close();
