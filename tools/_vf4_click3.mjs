import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(240000);
await page.goto('http://127.0.0.1:5332/?shot=icons-europe&alt=6000', { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
await page.waitForTimeout(3000);
await page.evaluate(() => { window.__sel = []; window.__wc=[]; window.__front.ctx.bus.on('selectionChanged', (e) => window.__sel.push(e)); window.__front.ctx.bus.on('worldClick', (e) => window.__wc.push({u:e.unitId,s:e.structureId,t:e.tile})); window.__front.ctx.app.goto?.('playing'); });
await page.waitForTimeout(2000);
for (const id of [346, 266, 300, 395]) {
  const r = await page.evaluate((id) => {
    const icons = window.__units.icons();
    const h = icons.find(x => x.id === id && !x.structure);
    if (!h) return { missing: true };
    const near = icons.filter(x => Math.hypot(x.x - h.x, x.y - h.y) < 40).map(x => ({ id: x.id, kind: x.kind, s: x.structure, d: +Math.hypot(x.x - h.x, x.y - h.y).toFixed(1), half: x.half, owner: x.owner }));
    const u = window.__front.ctx.sim.view.units.get(id);
    return { h: { x: h.x, y: h.y, half: h.half }, type: u?.type, owner: u?.owner, pickIcon: window.__front.ctx.units.pickIcon(h.x, h.y), pickUnit: window.__front.ctx.units.pickUnit(h.x, h.y), pickStruct: window.__front.ctx.units.pickStructure(h.x, h.y), near };
  }, id);
  console.log(id, JSON.stringify(r));
  if (r.h) {
    await page.evaluate(() => { window.__sel.length = 0; window.__wc.length = 0; window.__front.ctx.bus.emit('selectionChanged', { unitIds: [], structureId: -1 }); });
    await page.mouse.move(r.h.x, r.h.y); await page.waitForTimeout(150); await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up(); await page.waitForTimeout(900);
    console.log('  after click', JSON.stringify(await page.evaluate(() => ({ sel: window.__sel, wc: window.__wc }))));
  }
}
await browser.close();
