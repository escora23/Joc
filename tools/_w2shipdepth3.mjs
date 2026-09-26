import { chromium } from 'playwright';
const out = 'shots/W2-map-readability-fix/probe7';
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
const V = { normal: [true, true], sphereNoDW: [false, true], patchNoDW: [true, false], bothNoDW: [false, false], sphereHidden: [2, true], patchHidden: [true, 2] };
for (const [k, [a, c]] of Object.entries(V)) {
  await p.evaluate(([a, c]) => { const sc = window.__front.ctx.scene; const e = sc.getObjectByName('earth'), pt = sc.getObjectByName('earth-near-patch'); e.visible = a !== 2; pt.visible = c !== 2; e.material.depthWrite = a === true; pt.material.depthWrite = c === true; if (a === 2) e.material.depthWrite = true; if (c === 2) pt.material.depthWrite = true; }, [a, c]);
  await fr(3); await p.screenshot({ path: `${out}/${k}.png`, clip });
}
const info = await p.evaluate(() => { const sc = window.__front.ctx.scene; const names = []; sc.traverse((o) => { if (o.visible && (o.isMesh || o.isPoints || o.isLine) && o.renderOrder <= 20 && !o.material.transparent && o.material.depthWrite) names.push(o.name + ':' + o.renderOrder); }); return names; });
console.log(JSON.stringify(m)); console.log(JSON.stringify(await p.evaluate(() => { const ctx = window.__front.ctx; const e = ctx.scene.getObjectByName('earth'); const u = e.material.uniforms; return { cut: u.uPatchCut.value.toArray(), patch: u.uPatch.value.toArray(), cam: ctx.cameraRig.getState(), sameMat: e.material === ctx.scene.getObjectByName('earth-near-patch').material }; })));
await b.close();
