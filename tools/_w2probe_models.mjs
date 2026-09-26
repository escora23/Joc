import { chromium } from 'playwright';
import fs from 'node:fs';
const unit = process.argv[2] || 'Warship';
const out = process.argv[3] || 'shots/W2-map-readability-fix/probe3';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(400000);
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:5312/?shot=unit-closeup&unit=${unit}&alt=300`, { timeout: 400000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
const nextFrames = async (n) => { const f0 = await page.evaluate(() => window.__front.ctx.frame.frame); await page.waitForFunction((f) => window.__front.ctx.frame.frame > f, f0 + n); };
let m = null;
for (let pass = 0; pass < 3; pass++) {
  await page.evaluate(() => {
    const ctx = window.__front.ctx, id = window.__closeupUnit, p = ctx.camera.position.clone();
    if (!ctx.units.getUnitWorldPosition(id, p)) return;
    const c = ctx.camera.position, dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
    const A = dx * dx + dy * dy + dz * dz, B = 2 * (c.x * dx + c.y * dy + c.z * dz), C = c.x * c.x + c.y * c.y + c.z * c.z - 1;
    const disc = B * B - 4 * A * C; if (disc > 0) { const t = (-B - Math.sqrt(disc)) / (2 * A); if (t > 0) p.set(c.x + dx * t, c.y + dy * t, c.z + dz * t); }
    p.normalize();
    ctx.cameraRig.setState({ ...ctx.cameraRig.getState(), lat: Math.asin(p.y) * 180 / Math.PI, lon: Math.atan2(-p.z, p.x) * 180 / Math.PI, altitudeKm: 30 });
  });
  await nextFrames(5);
  m = await page.evaluate(() => window.__units.stats().unitModelsInView.find((x) => x.id === window.__closeupUnit));
  if (m && Math.abs(m.x - 800) < 300 && Math.abs(m.y - 450) < 250) break;
}
const info = await page.evaluate(() => { const ctx = window.__front.ctx; const p = ctx.camera.position.clone(); ctx.units.getUnitWorldPosition(window.__closeupUnit, p);
  return { near: ctx.camera.near * 6371, far: ctx.camera.far * 6371, dist: ctx.camera.position.distanceTo(p) * 6371, shipR: (p.length() - 1) * 6371000, cam: (ctx.camera.position.length() - 1) * 6371 }; });
console.log(JSON.stringify({ m, info }));
const clip = { x: Math.max(0, Math.min(1380, m.x - 110)), y: Math.max(0, Math.min(680, m.y - 110)), width: 220, height: 220 };
const V = [['normal', true, true, true, true], ['noSphere', true, false, true, true], ['noPatch', true, true, false, true], ['noEarth', true, false, false, true], ['noGlobe', false, true, true, true], ['noTrails', true, true, true, false]];
for (const [nm, g, sv, pv, tv] of V) {
  await page.evaluate(([g, sv, pv, tv]) => { const sc = window.__front.ctx.scene; sc.getObjectByName('globe').visible = g; sc.getObjectByName('earth').visible = sv; sc.getObjectByName('earth-near-patch').visible = pv;
    sc.traverse((o) => { if (o.name && o.name.startsWith('fx-trails')) o.visible = tv; }); }, [g, sv, pv, tv]);
  await nextFrames(3);
  await page.screenshot({ path: `${out}/${unit}-${nm}.png`, clip });
}
await browser.close();
