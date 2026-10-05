// Probe: take control from the Guerra panel at 1x and log tick + command console lines over time.
import { chromium } from 'playwright';
const base = process.argv[2] || 'http://127.0.0.1:5486/';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1);
page.on('console', (m) => { const s = m.text(); if (/\[command\]|\[app\]|error/i.test(s)) console.log(ts(), 'CONSOLE', s.slice(0, 260)); });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`${base}?shot=f3-missions&run=10&panel=0`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__shotReady === true || window.__shotError, null, { timeout: 1_800_000 });
const off = await page.evaluate(() => { const a = __front.ctx.sim.view.attacks.find((x) => x.attacker === 1 && x.defender > 0 && !x.naval && x.contactX >= 0); return a ? { key: a.frontKey, id: a.id } : null; });
console.log(ts(), 'offensive', JSON.stringify(off));
await page.evaluate((k) => __front.ctx.bus.emit('frontSelected', { key: k, fly: false }), off.key);
await page.waitForSelector(`.fu-war-front[data-key="${off.key}"] .fu-war-take`, { timeout: 60000 });
await page.locator('.fu-time-seg button').nth(2).click({ force: true });
await page.waitForFunction(() => window.__front.ctx.sim.view.speed === 1, null, { timeout: 20000 });
await page.waitForTimeout(3000);
const tick0 = await page.evaluate(() => window.__front.ctx.sim.view.tick);
console.log(ts(), 'tick0', tick0);
await page.locator(`.fu-war-front[data-key="${off.key}"] .fu-war-take`).first().click();
console.log(ts(), 'clicked');
await page.setViewportSize({ width: 640, height: 360 });
for (let i = 0; i < Number(process.argv[3] || 200); i++) {
  await page.waitForTimeout(1500);
  const s = await page.evaluate(() => { const c = window.__cmdStats; const v = window.__front.ctx.sim.view; return { tick: v.tick, clock: v.clock?.mode + '/' + v.clock?.rate, phase: c?.phase, host: c?.nearestHostileM, battle: c?.battle?.active ?? null, notice: c?.notice?.slice(0, 160) }; }).catch((e) => ({ err: String(e).slice(0, 100) }));
  console.log(ts(), JSON.stringify(s));
}
await browser.close();
