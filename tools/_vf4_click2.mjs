import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(240000);
await page.goto('http://127.0.0.1:5332/?shot=icons-europe&alt=6000', { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
await page.waitForTimeout(3000);
await page.evaluate(() => { window.__sel = []; window.__front.ctx.bus.on('selectionChanged', (e) => window.__sel.push(e)); window.__front.ctx.app.goto?.('playing'); });
await page.waitForTimeout(2000);
const all = (await page.evaluate(() => window.__units.icons())).filter(h => h.kind === 'single' && !h.structure);
const iso = all.filter((a) => !all.some((b) => b !== a && Math.hypot(a.x - b.x, a.y - b.y) < 30));
const res = [];
for (const h of iso) {
  // Deselect through the real UI: Escape, then wait for the card to go.
  await page.evaluate(() => window.__front.ctx.bus.emit('selectionChanged', { unitIds: [], structureId: -1 })); await page.waitForTimeout(800);
  await page.evaluate(() => { window.__sel.length = 0; });
  const now = (await page.evaluate(() => window.__units.icons())).find((x) => x.id === h.id && !x.structure) ?? h;
  const top = await page.evaluate(([x,y]) => { const e = document.elementFromPoint(x,y); return e ? e.tagName + '.' + (e.className?.toString?.() || '').slice(0,40) : null; }, [now.x, now.y]);
  await page.mouse.move(now.x, now.y); await page.waitForTimeout(150); await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up(); await page.waitForTimeout(900);
  const sel = await page.evaluate(() => window.__sel.slice());
  const ok = sel.some((e) => e.unitIds.includes(h.id));
  res.push({ id: h.id, owner: h.owner, x: Math.round(now.x), y: Math.round(now.y), top, ok, sel: sel.map(e => e.unitIds) });
  console.log(JSON.stringify(res[res.length-1]));
}
const onCanvas = res.filter(r => r.top && r.top.startsWith('CANVAS'));
console.log('TOTAL', res.length, 'ok', res.filter(r=>r.ok).length, 'onCanvas', onCanvas.length, 'okOnCanvas', onCanvas.filter(r=>r.ok).length);
await browser.close();
