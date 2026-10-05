// Gauntlet round 1 (units fixer): numeric check of vehicle grounding. On the command-tank terrain, for 400 random
// spots and headings, the tank's track lines (5 points each, ±1.42 m, ±3.3 m) are placed by the old rule (height at
// the centre, attitude from the normal) and by Ground.footprint (mean under the tracks, plane fit); reports how far
// the track ends hang in the air (worst and 95th percentile) and sink in.  node tools/_probe-footprint.mjs [url]
import { chromium } from 'playwright';
const base = process.argv[2] || 'http://127.0.0.1:5482/';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
await page.goto(`${base}?shot=command-tank`, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__shotReady === true || window.__shotError, null, { timeout: 900000 });
const r = await page.evaluate(() => {
  const I = window.__cmd, g = I.ground, P = I.world.player;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const res = { old: [], neu: [], sinkOld: [], sinkNew: [] };
  const N = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }, normalize() { const l = Math.hypot(this.x, this.y, this.z); this.x /= l; this.y /= l; this.z /= l; return this; } };
  const out = { y: 0, tiltP: 0, tiltR: 0 };
  const evalPose = (x, z, yaw, y, tP, tR) => {
    // Track bottom points in the body frame, then rotated: body.rotation (tP about X, tR about Z, order YXZ) and yaw.
    let air = 0, sink = 0;
    for (const sx of [-1.42, 1.42]) for (const sz of [-3.3, -1.65, 0, 1.65, 3.3]) {
      // pitch about X: y' = -sz*sin(tP) (front is -Z), roll about Z: y'' += sx*sin(tR)
      const dy = -sz * Math.sin(tP) + sx * Math.sin(tR);
      const cy = Math.cos(yaw), syw = Math.sin(yaw);
      const wx = x + sx * cy + sz * syw, wz = z - sx * syw + sz * cy;
      const gap = y + dy - g.heightAt(wx, wz);
      if (sz === -3.3 || sz === 3.3) air = Math.max(air, gap);
      sink = Math.max(sink, -gap);
    }
    return [air, sink];
  };
  for (let i = 0; i < 400; i++) {
    const x = P.pos.x + (rnd() - 0.5) * 3000, z = P.pos.z + (rnd() - 0.5) * 3000, yaw = rnd() * Math.PI * 2;
    if (!g.nearReady(x, z) || g.heightAt(x, z) < 1) continue;
    const n = g.normalAt(x, z, new P.pos.constructor(), 2.5);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const tpO = -Math.atan2(n.x * -sy + n.z * -cy, n.y), trO = -Math.atan2(n.x * cy + n.z * -sy, n.y);
    const [a0, s0] = evalPose(x, z, yaw, g.heightAt(x, z), tpO, trO);
    g.footprint(x, z, yaw, 6.6, 2.84, out);
    const [a1, s1] = evalPose(x, z, yaw, out.y, out.tiltP, out.tiltR);
    res.old.push(a0); res.neu.push(a1); res.sinkOld.push(s0); res.sinkNew.push(s1);
  }
  const st = (a) => { const s = [...a].sort((p, q) => p - q); return { n: s.length, p95: +s[Math.floor(s.length * 0.95)].toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
  return { airOld: st(res.old), airNew: st(res.neu), sinkOld: st(res.sinkOld), sinkNew: st(res.sinkNew) };
});
console.log(JSON.stringify(r));
await browser.close();
