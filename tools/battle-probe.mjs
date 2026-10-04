// Owner item 32 (pass 2) probe: stage ?shot=command-battle on a small viewport (SwiftShader draws small frames
// quickly), print the staging's progress and the census of what the camera sees, then take the picture at 1600×900.
//   node tools/battle-probe.mjs [--url http://127.0.0.1:5464/] [--out shots/owner-32-2/probe] [--params "&view=sight"]
//        [--name chase]
// Use a no-HMR server (tools/vite.nowatch.config.mjs): an edit mid-run would reload the page.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const url = args.url || 'http://127.0.0.1:5464/';
const out = args.out || 'shots/owner-32-2/probe';
const name = args.name || 'chase';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const t0 = Date.now();
const ts = () => `${Math.round((Date.now() - t0) / 1000)}s`;
page.on('console', (m) => {
  const x = m.text();
  if (m.type() === 'error' || /battle-shot|\[shots\]/.test(x)) console.log(ts(), m.type(), x.slice(0, 900));
});
page.on('pageerror', (e) => console.log(ts(), 'pageerror', e.message));
await page.goto(`${url}?shot=command-battle${args.params && args.params !== 'true' ? args.params : ''}`, { waitUntil: 'load', timeout: 180000 });
let last = '';
for (;;) {
  const st = await page.evaluate(() => {
    const b = window.__cmdStats?.battle;
    return {
      ready: window.__shotReady === true, err: window.__shotError ?? null, phase: window.__cmdStats?.phase ?? null,
      battle: b ? `${b.active} ${(b.sides ?? []).map((s) => `${s.team}:${s.shown}/${s.target}`).join(' ')}` : null,
      chip: String(window.__cmdStats?.combat ?? '').slice(0, 140),
    };
  }).catch((e) => ({ err: String(e) }));
  const s = JSON.stringify(st);
  if (s !== last) {
    console.log(ts(), s);
    last = s;
  }
  if (st.ready || st.err) break;
  if (Date.now() - t0 > 2_400_000) {
    console.log('timeout');
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
const bs = await page.evaluate(() => window.__battleShot ?? null).catch(() => null);
console.log(ts(), 'census', JSON.stringify(bs));
// Where the figures are: per side, by distance band from the tank, how many, how many the camera's eye sees (no
// ground between), poses (0 idle 1 walk 2 run 3 kneel 4 prone 5 dead 6 aim 7 rush) and how many are awake.
const diag = await page.evaluate(() => {
  const I = window.__cmd, P = I.world.player, cp = I.camera.position;
  const out = {};
  for (const e of I.world.ents) {
    if (!e.alive || e.player || (e.kind !== 'soldier' && e.kind !== 'at')) continue;
    const d = e.pos.distanceTo(P.pos);
    if (d > 1500) continue;
    const band = `${e.team ? 'enemy' : 'ours'} ${Math.min(14, Math.floor(d / 100)) * 100}`;
    const o = (out[band] ??= { n: 0, seen: 0, awake: 0, poses: {} });
    o.n++;
    if (!e.dormant) o.awake++;
    o.poses[e.pose] = (o.poses[e.pose] ?? 0) + 1;
    let ok = true;
    const ty = e.pos.y + (e.pose === 4 ? 0.35 : 0.9);
    for (let k = 1; k < 40 && ok; k++) { const f = k / 40; if (f > 0.97) break; if (I.ground.heightAt(cp.x + (e.pos.x - cp.x) * f, cp.z + (e.pos.z - cp.z) * f) > cp.y + (ty - cp.y) * f) ok = false; }
    if (ok) o.seen++;
  }
  return out;
}).catch((e) => String(e));
for (const [k, v] of Object.entries(diag)) console.log(ts(), 'diag', k.padEnd(12), JSON.stringify(v));
await page.setViewportSize({ width: 1600, height: 900 });
await new Promise((r) => setTimeout(r, 8000));
const file = path.join(out, `battle-${name}.png`);
await page.screenshot({ path: file, timeout: 300000 });
console.log(ts(), 'saved', file);
// More views of the same frozen moment: --extra sight,overview,close20,close50,close150,closeE20,...
for (const v of (args.extra && args.extra !== 'true' ? args.extra.split(',') : [])) {
  // Out of the sight first (its camera moves only while the scene runs), then freeze for the view.
  await page.evaluate(() => { const I = window.__cmd; I.camOverride = null; I.controller.setZoom?.(false); I.freeze = false; });
  await new Promise((r) => setTimeout(r, 2500));
  const info = await page.evaluate((v) => {
    const I = window.__cmd, P = I.world.player, c = I.controller, b = I.forces.battle.info();
    const V = P.pos.constructor;
    I.freeze = true;
    const h = b.hot ?? b.near ?? P.pos;
    if (v === 'sight') {
      const foe = I.world.ents.filter((e) => e.alive && e.team === 1 && (e.kind === 'soldier' || e.kind === 'at')).sort((p, q) => p.pos.distanceTo(h) - q.pos.distanceTo(h))[0];
      c.aimAt(foe ? foe.pos.clone().setY(foe.pos.y + 1) : h.clone().setY(h.y + 2));
      c.snapTurret?.();
      c.setZoom?.(true);
      // The sight's camera moves only while the scene runs.
      I.freeze = false;
      return foe ? `aim at enemy ${Math.round(foe.pos.distanceTo(P.pos))} m` : 'no enemy';
    }
    if (v === 'overview') {
      const back = new V().subVectors(P.pos, h).setY(0).normalize();
      const pos = P.pos.clone().addScaledVector(back, 140);
      pos.y = I.ground.heightAt(pos.x, pos.z) + 110;
      I.camOverride = { pos, look: h.clone().setY(h.y + 5).lerp(P.pos, 0.3), fov: 55 };
      return 'overview';
    }
    const m = /^close(E?)(\d+)$/.exec(v);
    if (m) {
      const team = m[1] ? 1 : 0, d = Number(m[2]);
      const man = I.world.ents.filter((e) => e.alive && e.team === team && (e.kind === 'soldier' || e.kind === 'at') && e.pos.distanceTo(P.pos) > 20)
        .sort((p, q) => p.pos.distanceTo(P.pos) - q.pos.distanceTo(P.pos))[0];
      if (!man) return 'no man';
      I.world.setDormant(man, false);
      window.__probeMan = man.id;
      const target = man.pos.clone().setY(man.pos.y + 0.9);
      let pos = null, alt = null, lowest = Infinity;
      for (let i = 0; i < 12 && !pos; i++) {
        const yaw = man.yaw + 0.6 + (i % 2 ? -1 : 1) * Math.ceil(i / 2) * (Math.PI / 6);
        const c = man.pos.clone();
        c.x += -Math.sin(yaw) * d; c.z += -Math.cos(yaw) * d;
        c.y = I.ground.heightAt(c.x, c.z) + 1.7 + d * 0.02;
        let raise = 0;
        for (let k = 1; k < 20; k++) {
          const f = k / 20, x = c.x + (target.x - c.x) * f, z = c.z + (target.z - c.z) * f;
          const over = I.ground.heightAt(x, z) + 0.3 - (c.y + (target.y - c.y) * f);
          if (over > 0) raise = Math.max(raise, over / (1 - f));
        }
        if (raise === 0) pos = c;
        else if (raise < lowest) { lowest = raise; alt = c.setY(c.y + raise); }
      }
      pos ??= alt;
      I.camOverride = { pos, look: man.pos.clone().setY(man.pos.y + 0.9), fov: d <= 20 ? 40 : d <= 50 ? 30 : 20 };
      return `${man.kind} pose ${man.pose} ${Math.round(man.pos.distanceTo(P.pos))} m from the tank, nation ${man.nation} colour #${I.world.nationColor(man.nation).toString(16)}, dormant ${man.dormant}, instance colour ${(() => { const W = I.world; const im = man.dormant ? W.crowdMeshes[man.team] : null; const i = man.dormant ? man.cinst : -1; return im && im.instanceColor ? [im.instanceColor.getX(i), im.instanceColor.getY(i), im.instanceColor.getZ(i)].map((v) => v.toFixed(3)).join(',') : 'active'; })()}, fill ${I.world.soldierMats.fill.value.toArray().map((v) => v.toFixed(3)).join(',')}`;
    }
    return 'chase';
  }, v);
  await new Promise((r) => setTimeout(r, 7000));
  if (/^close/.test(v)) console.log(ts(), 'after', await page.evaluate(() => { const I = window.__cmd; const W = I.world; const c = I.camera; const man = W.ents.find((e) => e.id === window.__probeMan); const col = man && man.dormant && W.crowdMeshes[man.team].instanceColor ? [0, 1, 2].map((k) => W.crowdMeshes[man.team].instanceColor.array[man.cinst * 3 + k].toFixed(3)).join(',') : 'active'; return `camera fov ${c.fov.toFixed(1)} at ${c.position.toArray().map((x) => x.toFixed(0)).join(',')}, man ${man ? Math.round(man.pos.distanceTo(c.position)) : '-'} m from it, crowd colour ${col}, drawScale ${man?.drawScale?.toFixed(2)}, dormant ${man?.dormant}, px ${man ? W.pixelsTall(man.pos).toFixed(1) : '-'}, ppm1 ${W.ppm1.toFixed(0)}, viewPos ${W.viewPos.toArray().map((x) => x.toFixed(0)).join(',')}, cam ${c.position.toArray().map((x) => x.toFixed(0)).join(',')}, uni ${man && W.uniCache.get(man) ? W.uniCache.get(man).toArray().map((x) => x.toFixed(3)).join(',') : '-'}`; }));
  const f2 = path.join(out, `battle-${name}-${v}.png`);
  await page.screenshot({ path: f2, timeout: 300000 });
  console.log(ts(), 'saved', f2, info);
}
await browser.close();
