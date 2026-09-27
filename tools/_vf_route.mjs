import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(600000);
await page.goto('http://127.0.0.1:5332/?shot=routes-atlantic&ff=0&speed=4', { timeout: 300000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
const id = await page.evaluate(() => { const s=[...window.__front.ctx.sim.view.units.values()].filter(u=>u.owner===1&&u.type===0); s.sort((a,b)=>Math.hypot(a.targetX-473,a.targetY-220)-Math.hypot(b.targetX-473,b.targetY-220)); return s[0]?.id ?? -1; });
const t0 = Date.now(); let ended = null; let last = null;
for (let i = 0; i < 400; i++) {
  const s = await page.evaluate((uid) => { const v = window.__front.ctx.sim.view; const u = v.units.get(uid); return { tick: v.tick, u: u ? { x: +u.x.toFixed(1), y: +u.y.toFixed(1), tx: u.targetX, ty: u.targetY, ox: u.originX, oy: u.originY } : null, r: window.__trails.route(uid), st: { human: window.__trails.stats().human, hs: window.__trails.stats().humanSuppressed, ev: window.__trails.stats().evicted.human } }; }, id);
  const t = (Date.now() - t0) / 1000;
  if (i % 5 === 0 || s.r.state !== 'live') console.log(t.toFixed(1), JSON.stringify(s));
  if (s.u) last = s.u;
  if (s.r.state !== 'live' && ended === null) ended = t;
  if (ended !== null && t - ended > 24) break;
  if (i === 3) {
    // show the dashed path ahead
    await page.screenshot({ path: 'shots/W2-map-readability-verify/route-early.png' });
  }
  await page.waitForTimeout(1000);
}
console.log('last pos', JSON.stringify(last), 'ended', ended);
await browser.close();
