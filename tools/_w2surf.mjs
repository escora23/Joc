import { chromium } from 'playwright'; import { PNG } from 'pngjs';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } }); p.setDefaultTimeout(400000);
await p.goto('http://127.0.0.1:5312/?shot=unit-closeup&unit=Warship&alt=300&mask=owner', { timeout: 400000 });
await p.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
const fr = async (n) => { const f0 = await p.evaluate(() => window.__front.ctx.frame.frame); await p.waitForFunction((f) => window.__front.ctx.frame.frame > f, f0 + n); };
await p.evaluate(() => { const ctx = window.__front.ctx, id = window.__closeupUnit, q = ctx.camera.position.clone(); ctx.units.getUnitWorldPosition(id, q); q.normalize();
  ctx.cameraRig.setState({ ...ctx.cameraRig.getState(), lat: Math.asin(q.y) * 180 / Math.PI, lon: Math.atan2(-q.z, q.x) * 180 / Math.PI, altitudeKm: 30 }); });
await fr(6);
await p.evaluate(() => { const sc = window.__front.ctx.scene; sc.traverse((o) => { if (o.name && (o.name.startsWith('unit-') || o.name.startsWith('fx-'))) o.visible = false; }); });
await fr(3);
if (process.argv[2]) { await p.evaluate(() => { const t = window.__front.ctx.scene.getObjectByName('earth').material.uniforms.uRelief.value; t.anisotropy = 1; t.minFilter = 1006; t.generateMipmaps = false; t.needsUpdate = true; }); await fr(4); }
const png = PNG.sync.read(await p.screenshot({ path: '/tmp/claude-0/surf.png' }));
const row = []; for (let x = 700; x <= 900; x += 20) { const o = (448 * png.width + x) * 4; row.push(x + ':' + png.data[o] * 4 + 'm/' + png.data[o + 1] * 4 + 'm'); } console.log(row.join(' '));
const col = []; for (let y = 350; y <= 550; y += 20) { const o = (y * png.width + 800) * 4; col.push(y + ':' + png.data[o] * 4 + 'm'); } console.log(col.join(' '));
await b.close();
