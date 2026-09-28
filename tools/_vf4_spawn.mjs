import { chromium } from 'playwright';
const O = '/home/user/joc/shots/W2-map-readability-verify/it4';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(240000);
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const waitState = (s, timeout = 180000) => page.waitForFunction((want) => window.__front?.app.state === want, s, { timeout, polling: 250 });
await page.goto('http://127.0.0.1:5332/', { waitUntil: 'load', timeout: 300000 });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000, polling: 250 });
await page.keyboard.press('Enter'); await waitState('menu'); await page.waitForTimeout(2500);
await page.locator('.fu-menu-item.is-primary:not(.fu-menu-continue)').first().click();
await waitState('setup'); await page.waitForTimeout(1500);
await page.locator('.fu-diff--easy').click({ noWaitAfter: true, timeout: 90000 });
await page.locator('.fu-setup-start').click({ noWaitAfter: true, timeout: 90000 });
await waitState('spawn');
for (let i=0;i<8;i++){ await page.waitForTimeout(5000); console.log('t',(i+1)*5, JSON.stringify(await page.evaluate(()=>{const c=window.__front.ctx.cameraRig.getState(); const s=new window.__front.ctx.camera.position.constructor(); window.__front.ctx.globe.getSunDirection(s); const la=c.lat*Math.PI/180, lo=c.lon*Math.PI/180; return {lat:c.lat.toFixed(1),lon:c.lon.toFixed(1),alt:Math.round(c.altitudeKm), sunDot:(Math.cos(la)*Math.cos(lo)*s.x+Math.sin(la)*s.y-Math.cos(la)*Math.sin(lo)*s.z).toFixed(2), labels:(window.__labels?.placed?.()??[]).length, state: window.__front.app.state};}))); }
const r = await page.evaluate(() => {
  const ctx = window.__front.ctx;
  const cam = ctx.cameraRig.getState();
  const sun = ctx.globe.getSunDirection ? null : null;
  const la = cam.lat * Math.PI / 180, lo = cam.lon * Math.PI / 180;
  const c = [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)];
  const s = new ctx.camera.position.constructor();
  let sd = null;
  try { (ctx.globe.sunDirection ?? ctx.globe.getSunDir)?.call(ctx.globe, s); sd = [s.x, s.y, s.z]; } catch (e) { sd = String(e); }
  const labels = window.__labels?.placed?.() ?? [];
  const spawned = ctx.sim.view.playerList.filter(p => p.spawned && p.kind === 'nation').length;
  return { cam, camVec: c, sd, dot: Array.isArray(sd) ? c[0]*sd[0]+c[1]*sd[1]+c[2]*sd[2] : null, labels: labels.map(l => l.name), spawned, worldTime: ctx.frame.worldTime, globeKeys: Object.keys(ctx.globe).filter(k => /sun/i.test(k)) };
});
console.log(JSON.stringify(r, null, 1));
await page.screenshot({ path: `${O}/spawn-real-40s.png` });
// Minimap pixels: count distinct non-dark colours
const mm = await page.evaluate(() => { const c = document.querySelector('.fu-mm canvas'); if (!c) return null; const g = c.getContext('2d'); if (!g) return 'no2d'; const d = g.getImageData(0,0,c.width,c.height).data; const set = new Set(); for (let i=0;i<d.length;i+=16){ const r=d[i],gg=d[i+1],b=d[i+2]; if (Math.max(r,gg,b)-Math.min(r,gg,b)>60) set.add((r>>4)<<8|(gg>>4)<<4|(b>>4)); } return { w: c.width, h: c.height, saturatedColours: set.size }; });
console.log('minimap', JSON.stringify(mm));
await browser.close();
