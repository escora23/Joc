import { chromium } from 'playwright';
const shot = process.argv[2] || 'labels-world';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
if (process.argv[3]) { const p0 = await b.newPage({ viewport: { width: 1600, height: 900 } }); p0.setDefaultTimeout(400000); await p0.goto(`http://127.0.0.1:5312/?shot=${process.argv[3]}`, { timeout: 400000 }); await p0.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 }); await p0.waitForTimeout(3000); await p0.close(); }
const p = await b.newPage({ viewport: { width: 1600, height: 900 } }); p.setDefaultTimeout(400000);
await p.goto(`http://127.0.0.1:5312/?shot=${shot}`, { timeout: 400000 });
await p.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
await p.waitForTimeout(3000);
const r = await p.evaluate(() => {
  const land = window.__trails.overLand(); const view = window.__front.ctx.sim.view;
  return land.overLand.map((l) => {
    const u = view.units.get(l.unitId); const path = view.routes.get(l.unitId);
    const pts = window.__trails.points(l.unitId);
    const segs = []; const P = pts ? pts.pts : [];
    const ll = (i) => { const x = P[i], y = P[i + 1], z = P[i + 2], n = Math.hypot(x, y, z); return [+(Math.asin(y / n) * 180 / Math.PI).toFixed(2), +(Math.atan2(-z, x) * 180 / Math.PI).toFixed(2)]; };
    for (let i = 3; i < P.length; i += 3) { const d = Math.hypot(P[i] - P[i - 3], P[i + 1] - P[i - 2], P[i + 2] - P[i - 1]) * 6371; if (d > 150) segs.push({ i: i / 3, km: Math.round(d), from: ll(i - 3), to: ll(i) }); }
    const w = window.__front.ctx.world; const segLand = [];
    if (path) for (let i = 1; i < path.length; i++) { const ax = path[i-1] % w.width + 0.5, ay = Math.floor(path[i-1] / w.width) + 0.5, bx = path[i] % w.width + 0.5, by = Math.floor(path[i] / w.width) + 0.5;
      let dx = bx - ax; if (dx > w.width / 2) dx -= w.width; if (dx < -w.width / 2) dx += w.width; const n = Math.ceil(Math.hypot(dx, by - ay) * 2); let landN = 0;
      for (let j = 0; j <= n; j++) { const x = Math.floor(((ax + dx * j / n) % w.width + w.width) % w.width), y = Math.floor(ay + (by - ay) * j / n); const t = w.terrain[y * w.width + x] & 15; if (t > 1) landN++; }
      segLand.push([i, Math.round(Math.hypot(dx, by - ay)), landN]); }
    return { segLand, terrSample: [...new Set(Array.from(w.terrain.slice(0, 5000)))], ...l, n: P.length / 3, state: u ? u.state : 'gone', type: u?.type, origin: u ? [u.originX, u.originY] : null, pos: u ? [u.x, u.y] : null, target: u ? [u.targetX, u.targetY] : null, pathLen: path?.length, bigSegs: segs.length, pts: Array.from({ length: Math.min(160, P.length / 3) }, (_, k) => ll(k * 3)), pathLL: path ? Array.from(path).map((t) => [+(90 - (Math.floor(t / w.width) + 0.5) / w.height * 180).toFixed(1), +(((t % w.width) + 0.5) / w.width * 360 - 180).toFixed(1)]) : null, info: window.__trails.route(l.unitId) };
  });
});
console.log(JSON.stringify(r, null, 1));
await b.close();
