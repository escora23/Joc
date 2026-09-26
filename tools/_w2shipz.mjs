import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } }); p.setDefaultTimeout(400000);
await p.goto('http://127.0.0.1:5312/?shot=unit-closeup&unit=Warship&alt=300', { timeout: 400000 });
await p.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
const fr = async (n) => { const f0 = await p.evaluate(() => window.__front.ctx.frame.frame); await p.waitForFunction((f) => window.__front.ctx.frame.frame > f, f0 + n); };
await p.evaluate(() => { const ctx = window.__front.ctx, id = window.__closeupUnit, q = ctx.camera.position.clone(); ctx.units.getUnitWorldPosition(id, q); q.normalize();
  ctx.cameraRig.setState({ ...ctx.cameraRig.getState(), lat: Math.asin(q.y) * 180 / Math.PI, lon: Math.atan2(-q.z, q.x) * 180 / Math.PI, altitudeKm: 30 }); });
await fr(6);
const r = await p.evaluate(() => {
  const ctx = window.__front.ctx, out = [];
  const q = ctx.camera.position.clone(); ctx.units.getUnitWorldPosition(window.__closeupUnit, q);
  ctx.scene.traverse((o) => {
    if (!o.isInstancedMesh || !o.visible || o.count === 0) return;
    const M = new o.matrixWorld.constructor(), V = q.clone(); o.geometry.computeBoundingBox(); const bb = o.geometry.boundingBox;
    for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, M); const pos = V.clone().setFromMatrixPosition(M).applyMatrix4(o.matrixWorld);
      if (pos.distanceTo(q) * 6371 > 3) continue;
      let rmin = 1e9, rmax = -1e9;
      for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z]) { const c = V.clone().set(x, y, z).applyMatrix4(M).applyMatrix4(o.matrixWorld); const rr = (c.length() - 1) * 6371000; rmin = Math.min(rmin, rr); rmax = Math.max(rmax, rr); }
      out.push({ name: o.name, i, posR: (pos.length() - 1) * 6371000, rmin, rmax, mat: o.material.name, ro: o.renderOrder, dt: o.material.depthTest, transparent: o.material.transparent });
    } });
  const e = ctx.scene.getObjectByName('earth'), pt = ctx.scene.getObjectByName('earth-near-patch');
  const q2 = q.clone().normalize(); const lat = Math.asin(q2.y) * 180 / Math.PI, lon = Math.atan2(-q2.z, q2.x) * 180 / Math.PI;
  return { unitR: (q.length() - 1) * 6371000, meshR: (ctx.globe.meshRadiusAt(lat, lon) - 1) * 6371000, surfR: (ctx.globe.surfaceRadiusAt(lat, lon) - 1) * 6371000, lat, lon, out, near: ctx.camera.near * 6371, earth: { ro: e.renderOrder, transp: e.material.transparent }, patch: { ro: pt.renderOrder, vis: pt.visible, transp: pt.material.transparent }, gl: ctx.renderer?.capabilities?.logarithmicDepthBuffer };
});
console.log(JSON.stringify(r, null, 1));
await b.close();
