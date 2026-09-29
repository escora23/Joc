// Independent verifier probe (temporary, W5 final verify): T in a visible ground battle, counts per side, then Esc exit:
// debrief numbers, camera 2500 km above the unit, first frames, and the occupied stipple (texture bit vs sim) unchanged.
import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = process.argv[2] ?? 'shots/_vr5';
const BASE = process.argv[3] ?? 'http://127.0.0.1:5470/';
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await page.goto(`${BASE}?shot=front-ground-real&live=1`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 1000 });
await wait(4000);
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, timeout: 240000 }).catch((e) => log('shot fail', n, e.message.slice(0, 80)));
const mask = () => page.evaluate(() => {
  const { ctx } = window.__front; let tex = null;
  ctx.scene.traverse((o) => { const m = o.material; if (!tex && m && m.uniforms && m.uniforms.uOwner) tex = m.uniforms.uOwner.value; });
  if (!tex) return { err: 'no uOwner' };
  const d = tex.image.data, v = ctx.sim.view; let shown = 0, sim = 0, mism = 0;
  for (let t = 0; t < 1600 * 800; t++) { const a = (d[t * 4 + 1] & 32) !== 0, b = v.isOccupied(t); if (a) shown++; if (b) sim++; if (a !== b) mism++; }
  return { shown, sim, mism, tick: v.tick };
});
const m0 = await mask();
log('mask before', JSON.stringify(m0));
await shot('s0-battle');
const bh = await page.evaluate(() => { const ho = window.__front.ctx.battle.handoff?.(); return ho ? { inf: ho.infantry, divs: ho.divisions.map((d) => ({ u: d.unitId, t: d.tanks })) } : null; });
log('battle handoff', JSON.stringify(bh));
if (await page.evaluate(() => (window.__fuHud?.shared?.selection?.kind ?? 'none') !== 'none')) { await page.keyboard.press('Escape'); await wait(1500); }
await page.keyboard.press('t');
await page.waitForFunction(() => window.__cmdStats?.phase === 'play', null, { timeout: 900000, polling: 1000 }).catch(() => undefined);
await wait(5000);
const c = await page.evaluate(() => { const r = window.__cmd.world.soldiersByNation(); const s = window.__cmdStats; return { r, notice: s.notice, info: s.info, hostiles: s.hostiles, unit: window.__cmd.params?.unitId }; });
log('in command', JSON.stringify(c).slice(0, 900));
await shot('s1-command');
const unitId = c.unit;
await page.evaluate(() => { window.__vrExit = false; window.__front.ctx.bus.on('commandExit', () => { window.__vrExit = true; }); });
await page.keyboard.press('Escape');
await wait(5000);
await shot('s2-exit-dialog');
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__cmdStats?.phase === 'debrief', null, { timeout: 300000, polling: 300 }).catch(() => undefined);
const deb = await page.evaluate(() => window.__cmd.overlay.debrief?.textContent ?? '');
log('debrief', deb.replace(/\s+/g, ' ').slice(0, 400));
await shot('s3-debrief');
await page.waitForFunction(() => window.__front.app.state === 'playing' && window.__vrExit, null, { timeout: 900000, polling: 300 });
const frames = [];
for (let i = 0; i < 4; i++) { await shot(`s4-after-${i}`); frames.push(i); await wait(1500); }
await wait(15000);
const cam = await page.evaluate((id) => { const { ctx } = window.__front; const s = ctx.cameraRig.getState(); const u = ctx.sim.view.units.get(id); const ll = u ? { lat: 90 - (u.y / 800) * 180, lon: (u.x / 1600) * 360 - 180 } : null; return { cam: { lat: s.lat, lon: s.lon, alt: s.altitudeKm }, unit: ll, speed: ctx.sim.view.speed, clock: ctx.sim.view.clock?.mode }; }, unitId);
log('camera after exit', JSON.stringify(cam));
await shot('s5-settled');
const m1 = await mask();
log('mask after', JSON.stringify(m1));
// Same region at 900 km to see the stipple.
await page.evaluate((ll) => window.__front.ctx.cameraRig.setState({ lat: ll.lat, lon: ll.lon, altitudeKm: 900, tilt: 0, heading: 0 }), cam.unit ?? cam.cam);
await wait(12000);
await shot('s6-900km');
log('errors', JSON.stringify(errs.slice(0, 6)));
await browser.close();
