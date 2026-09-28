import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(240000);
await page.goto('http://127.0.0.1:5332/?shot=icons-europe&alt=6000', { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
await page.waitForTimeout(3000);
await page.evaluate(() => { window.__sel = []; window.__ev = []; window.__front.ctx.bus.on('selectionChanged', (e) => window.__sel.push(e)); window.__front.ctx.app.goto?.('playing');
  const c = window.__front.ctx.canvas; for (const t of ['pointerdown','pointerup']) c.addEventListener(t, (e) => window.__ev.push({ t, ts: Math.round(e.timeStamp), now: Math.round(performance.now()), x: e.clientX, y: e.clientY }), true); });
await page.waitForTimeout(2000);
const all = (await page.evaluate(() => window.__units.icons())).filter(h => h.kind === 'single' && !h.structure);
const iso = all.filter((a) => !all.some((b) => b !== a && Math.hypot(a.x - b.x, a.y - b.y) < 30));
const cands = [];
for (const h of iso) { const top = await page.evaluate(([x,y]) => document.elementFromPoint(x,y)?.tagName, [h.x, h.y]); if (top === 'CANVAS' && h.x < 1250) cands.push(h); }
let ok = 0, n = 0;
for (let rep = 0; rep < 2; rep++) for (const h of cands) {
  await page.evaluate(() => { window.__sel.length = 0; window.__ev.length = 0; window.__front.ctx.bus.emit('selectionChanged', { unitIds: [], structureId: -1 }); });
  await page.waitForTimeout(300);
  const now = (await page.evaluate(() => window.__units.icons())).find((x) => x.id === h.id && !x.structure) ?? h;
  await page.evaluate(async ([x, y]) => { const c = window.__front.ctx.canvas; const o = { clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', bubbles: true, isPrimary: true }; c.dispatchEvent(new PointerEvent('pointermove', { ...o, buttons: 0 })); c.dispatchEvent(new PointerEvent('pointerdown', o)); await new Promise(r => setTimeout(r, 60)); c.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 })); }, [now.x, now.y]); await page.waitForTimeout(900);
  const r = await page.evaluate(() => ({ sel: window.__sel.slice(), ev: window.__ev.slice() }));
  const good = r.sel.some((e) => e.unitIds.includes(h.id));
  n++; if (good) ok++; else console.log('MISS', h.id, JSON.stringify(r.ev), JSON.stringify(r.sel));
}
console.log('TOTAL', n, 'ok', ok);
await browser.close();
