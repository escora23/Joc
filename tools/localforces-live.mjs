// FRONT ULTRA — live check of window.__localForces: stages a war next to the human, then prints the local forces at
// Madrid (peace) and on the front, with the call cost. Usage: node tools/localforces-live.mjs [--url http://127.0.0.1:5430/]
import { chromium } from 'playwright';
import fs from 'node:fs';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const ai = process.argv.indexOf('--url');
await page.goto(ai > 0 ? process.argv[ai + 1] : 'http://127.0.0.1:5430/', { timeout: 120000 });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__front?.app.state === 'menu', null, { timeout: 60000 });
await page.evaluate(() => window.__front.app.startScriptedGame({ ticks: 0, speed: 0, autopilot: false, worldEvents: false }));
await page.waitForFunction(() => window.__front.app.state === 'playing', null, { timeout: 120000 });
// Stage a war next to the human (same as probes.ts): land for both, a war, an offensive.
const res = await page.evaluate(async () => {
  const { ctx } = window.__front;
  const view = ctx.sim.view;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const peace = window.__localForces(40.42, -3.7, 30);
  const t = (lat, lon) => { const x = Math.floor((lon + 180) / 360 * 1600), y = Math.floor((90 - lat) / 180 * 800); return y * 1600 + x; };
  let enemy = 0;
  for (const p of view.playerList) if (p.alive && p.kind === 'nation' && p.id > enemy) enemy = p.id;
  ctx.sim.debug({ type: 'conquer', playerId: 1, centerTile: t(54.5, 72.0), radius: 10 });
  ctx.sim.debug({ type: 'conquer', playerId: enemy, centerTile: t(54.5, 76.5), radius: 10 });
  ctx.sim.debug({ type: 'war', a: 1, b: enemy, mobilizeTicks: 0 });
  ctx.sim.debug({ type: 'addTroops', playerId: 1, amount: 1_500_000 });
  await wait(1500);
  ctx.sim.send({ type: 'attack', target: enemy, ratio: 0.6, tile: t(54.5, 78.5) });
  window.__front.app.setSpeed(1);
  for (let i = 0; i < 240 && !view.fronts.some((f) => (f.a === 1 || f.b === 1) && f.offensiveA + f.offensiveB > 0); i++) await wait(500);
  await wait(8000);
  window.__front.app.setSpeed(0);
  await wait(1000);
  const f = view.fronts.find((f) => f.a === 1 || f.b === 1);
  if (!f) return { peace, err: 'no front', fronts: view.fronts.length };
  const mid = Math.floor(f.samples.length / 4) * 2;
  const lf = window.__localForces.at(f.samples[mid], f.samples[mid + 1], 30);
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) window.__localForces.at(f.samples[mid], f.samples[mid + 1], 50);
  const ms = (performance.now() - t0) / 20;
  const brief = (r) => ({
    point: r.point, owners: r.owners, frontKey: r.frontKey, peaceful: r.peaceful, pairs: r.pairs,
    fronts: r.fronts.map((q) => ({ key: q.key, a: q.a, b: q.b, distKm: +q.nearest.distKm.toFixed(2), windowKm: +q.windowKm.toFixed(1), lengthKm: Math.round(q.lengthKm), adv: +q.advanceBearing.toFixed(2), sub: q.subTile, anchorSide: q.anchorSide, gA: q.garrisonA, gB: q.garrisonB })),
    sides: r.sides.map((s) => ({ owner: s.owner, rel: s.relation, inf: s.infantry, pools: s.pools, troops: s.troops, div: s.divisions.length, air: s.aircraft.length, ships: s.ships.length, sams: s.sams.length, posts: s.posts.length, text: window.__localForces.text(s) })),
    units: r.units.length, structures: r.structures.map((s) => [s.type, s.owner, Math.round(s.distKm)]),
    split: window.__localForces.split(r, 60),
  });
  return { peace: brief(peace), front: brief(lf), ms, frontView: { key: f.key, gA: f.garrisonA, gB: f.garrisonB, len: f.length, prog: !!f.progress } };
});
console.log(JSON.stringify(res, null, 1));
console.log('errors', errs.slice(0, 5));
await browser.close();
