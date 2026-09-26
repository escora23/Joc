import { chromium } from 'playwright';
const out = 'shots/W2-map-readability-fix/probe6';
import fs from 'node:fs'; fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } }); p.setDefaultTimeout(400000);
await p.goto('http://127.0.0.1:5312/?shot=unit-closeup&unit=Warship&alt=300', { timeout: 400000 });
await p.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
const fr = async (n) => { const f0 = await p.evaluate(() => window.__front.ctx.frame.frame); await p.waitForFunction((f) => window.__front.ctx.frame.frame > f, f0 + n); };
await p.evaluate(() => { const ctx = window.__front.ctx, id = window.__closeupUnit, q = ctx.camera.position.clone(); ctx.units.getUnitWorldPosition(id, q); q.normalize();
  ctx.cameraRig.setState({ ...ctx.cameraRig.getState(), lat: Math.asin(q.y) * 180 / Math.PI, lon: Math.atan2(-q.z, q.x) * 180 / Math.PI, altitudeKm: 30 }); });
await fr(6);
const m = await p.evaluate(() => window.__units.stats().unitModelsInView.find((x) => x.id === window.__closeupUnit));
const clip = { x: m.x - 110, y: m.y - 110, width: 220, height: 220 };
const V = { normal: [true, true], noTrails: [true, true] };
for (const [k, [a, c]] of Object.entries(V)) {
  await p.evaluate(([a, c]) => { const sc = window.__front.ctx.scene; if (window.__k) sc.traverse((o) => { if (o.name && o.name.startsWith('fx-trails')) o.visible = false; }); window.__k = 1; }, [a, c]);
  await fr(3); await p.screenshot({ path: `${out}/${k}.png`, clip });
}
const info = await p.evaluate(() => { const sc = window.__front.ctx.scene; const names = []; sc.traverse((o) => { if (o.visible && (o.isMesh || o.isPoints || o.isLine) && o.renderOrder <= 20 && !o.material.transparent && o.material.depthWrite) names.push(o.name + ':' + o.renderOrder); }); return names; });
console.log(JSON.stringify(m)); console.log(await p.evaluate(() => { const r = []; window.__front.ctx.scene.traverse((o) => { if (o.name && o.name.startsWith('fx-trails')) r.push(o.name + ':' + o.parent?.type + ':' + o.material.stencilWrite); }); const pp = window.__front.ctx.post; return JSON.stringify(r); }));
await b.close();
