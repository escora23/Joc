import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(600000);
await page.goto('http://127.0.0.1:5332/?shot=icons-europe&alt=6000', { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
await page.waitForTimeout(3000);
await page.evaluate(() => { window.__front.ctx.app.goto?.('playing'); window.__sel = []; window.__front.ctx.bus.on('selectionChanged', (e) => window.__sel.push(e.unitIds)); });
await page.waitForTimeout(3000);
const all = (await page.evaluate(() => window.__units.icons())).filter((h) => h.kind === 'single' && !h.structure);
const iso = all.filter((a) => !all.some((b) => b !== a && Math.hypot(a.x - b.x, a.y - b.y) < 30));
const trials = [];
for (const h0 of iso) {
  if (trials.length >= 20) break;
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  const h = (await page.evaluate(() => window.__units.icons())).find((x) => x.id === h0.id && !x.structure);
  if (!h) continue;
  // skip icons under any DOM element (HUD) at click time
  const top = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [h.x, h.y]);
  if (top !== 'CANVAS') continue;
  await page.evaluate(() => { window.__sel.length = 0; });
  await page.mouse.move(h.x, h.y); await page.waitForTimeout(150); await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up(); await page.waitForTimeout(800);
  const sel = await page.evaluate(() => window.__sel.slice());
  trials.push({ id: h.id, owner: h.owner, x: Math.round(h.x), y: Math.round(h.y), ok: sel.some((s) => s.includes(h.id)), sel });
}
for (const t of trials) console.log(JSON.stringify(t));
console.log('RESULT', trials.filter((t) => t.ok).length, '/', trials.length);
await browser.close();
