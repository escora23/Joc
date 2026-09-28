import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(240000);
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:5332/?shot=icons-europe&alt=6000', { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
await page.waitForTimeout(3000);
await page.evaluate(() => { window.__sel = []; window.__wc=[]; window.__front.ctx.bus.on('selectionChanged', (e) => window.__sel.push(e)); window.__front.ctx.bus.on('worldClick', (e) => window.__wc.push({unitId:e.unitId, structureId:e.structureId, tile:e.tile})); window.__front.ctx.app.goto?.('playing'); });
await page.waitForTimeout(2000);
const info = await page.evaluate(() => {
  const v = window.__front.ctx.sim.view;
  const icons = window.__units.icons().filter(h => h.owner === 12 && h.kind==='single' && !h.structure);
  return { speed: v.speed ?? null, tick: v.tick, icons: icons.map(h => { const u = v.units.get(h.id); return { id: h.id, x: h.x, y: h.y, half: h.half, type: u?.type, cat: h.cat, rel: h.rel, extra: Object.keys(h) }; }), p12: v.players[12] ? { name: v.players[12].name, kind: v.players[12].kind } : null };
});
console.log(JSON.stringify(info, null, 1));
for (const h of info.icons.slice(0, 4)) {
  await page.evaluate(() => { window.__sel.length = 0; window.__wc.length = 0; });
  const now = (await page.evaluate(() => window.__units.icons())).find((x) => x.id === h.id && !x.structure) ?? h;
  const pk = await page.evaluate(([x,y]) => ({ icon: window.__front.ctx.units.pickIcon(x,y), el: document.elementFromPoint(x,y)?.className?.toString?.().slice(0,80), tag: document.elementFromPoint(x,y)?.tagName }), [now.x, now.y]);
  await page.mouse.move(now.x, now.y); await page.waitForTimeout(150); await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up(); await page.waitForTimeout(900);
  const r = await page.evaluate(() => ({ sel: window.__sel.slice(), wc: window.__wc.slice() }));
  console.log(h.id, JSON.stringify(now && {x:now.x,y:now.y}), JSON.stringify(pk), JSON.stringify(r));
}
await page.screenshot({ path: '/home/user/joc/shots/W2-map-readability-verify/it4/diag-click.png' });
await browser.close();
