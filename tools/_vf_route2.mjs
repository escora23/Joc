import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(600000);
await page.goto('http://127.0.0.1:5332/?shot=routes-atlantic&ff=0&speed=0', { timeout: 300000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
const id = await page.evaluate(() => { const v = window.__front.ctx.sim.view; const s=[...v.units.values()].filter(u=>u.owner===1&&u.type===0); s.sort((a,b)=>Math.hypot(a.targetX-473,a.targetY-220)-Math.hypot(b.targetX-473,b.targetY-220)); const u = s[0]; return u ? { id: u.id, x: u.x, y: u.y, tx: u.targetX, ty: u.targetY, tick: v.tick } : null; });
console.log('convoy', JSON.stringify(id));
await page.evaluate(() => window.__front.ctx.sim.setSpeed(4));
const t0 = Date.now(); let ended = null, last = null;
for (let i = 0; i < 900; i++) {
  const s = await page.evaluate((uid) => { const v = window.__front.ctx.sim.view; const u = v.units.get(uid); const st = window.__trails.stats(); return { tick: v.tick, u: u ? { x: +u.x.toFixed(1), y: +u.y.toFixed(1) } : null, r: window.__trails.route(uid), hs: st.humanSuppressed, ev: st.evicted.human, n: v.units.size }; }, id.id);
  const t = (Date.now() - t0) / 1000;
  if (s.u) last = s.u;
  if (i % 10 === 0 || s.r.state !== 'live') console.log(t.toFixed(1), JSON.stringify(s));
  if (s.r.state === 'live' && !s.r.drawn) console.log('UNDRAWN at', t);
  if (s.hs || s.ev) console.log('EVICT', t, s.hs, s.ev);
  if (s.r.state !== 'live' && ended === null) ended = t;
  if (ended !== null && t - ended > 23) break;
  await page.waitForTimeout(500);
}
console.log('last', JSON.stringify(last), 'target', id.tx, id.ty, 'ended', ended);
await browser.close();
