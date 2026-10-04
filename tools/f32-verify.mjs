// Owner item 32 browser verifier: command-mode combat at the real scale of the front, readable and physical.
// Real game in Chromium (SwiftShader) on real staged sims, entered through the real UI, measured numerically.
//   node tools/f32-verify.mjs [--url http://127.0.0.1:5463/] [--out shots/owner-32-1/verify] [--only scale,close,kill,mg,ram]
//
// scale   our offensive of the staged war (?shot=f3-missions: hundreds of thousands of troops) taken from the Guerra
//         panel's «Tomar el control aquí»: the march goes to the hottest point, and at contact the battle stands there:
//         S1 soldiers of both sides around the player (hundreds, from the sim's density), S2 vehicles, S3 visible on
//            screen from the tank (counted through the camera), S4 the fight is alive (shells, falls, fire in 20 s),
//         S5 the HUD chip says where the fighting is (direction, distance, intensity), S6 trenches stand
// close   the soldier models at 20, 50 and 150 m (shots)
// kill    an enemy soldier killed with HE (splash) and with the coaxial machine gun (counts and sim casualties)
// mg      machine gun on an enemy factory: its hp goes down a little in the sim; the HUD says it is ineffective
// ram     the tank runs over infantry and a light vehicle at war: kills by mass and speed, own damage
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5463/';
const out = args.out || 'shots/owner-32-1/verify';
const only = args.only ? new Set(args.only.split(',')) : null;
fs.mkdirSync(out, { recursive: true });
const results = [];
const row = (id, what, value, pass) => {
  results.push({ id, what, value: String(value), pass: !!pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${what} :: ${value}`);
};
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
let errors = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function open(shot, params = '') {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => { errors++; console.log(`[pageerror] ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error' || /\[command\] (march|failed|ram|mg)/.test(m.text())) console.log(`   ${m.text().slice(0, 300)}`); });
  await page.goto(`${base}?shot=${shot}${params}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__shotReady === true || window.__shotError, null, { timeout: 1_800_000 });
  await page.waitForTimeout(1500);
  return page;
}
const snap = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`), timeout: 300000 }).catch((e) => console.log(`   (screenshot ${name} failed: ${String(e?.message ?? e).split('\n')[0]})`));
async function until(page, fn, arg, ms = 30000, every = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await page.evaluate(fn, arg).catch(() => null);
    if (v) return v;
    await sleep(every);
  }
  return null;
}

/** What the camera sees now: soldiers and vehicles of each team on screen within 4 km, and the battle's numbers. */
const census = (page) => page.evaluate(() => {
  const I = window.__cmd;
  const cam = I.camera, W = innerWidth, H = innerHeight;
  const v = cam.position.clone();
  const P = I.world.player;
  const c = { soldiers: [0, 0], vehicles: [0, 0], screenSoldiers: [0, 0], screenVehicles: [0, 0], near1km: [0, 0], dead: 0 };
  for (const e of I.world.ents) {
    if (e.player) continue;
    const man = e.kind === 'soldier' || e.kind === 'at';
    const veh = ['tank', 'ifv', 'truck', 'aa'].includes(e.kind);
    if (!man && !veh) continue;
    if (!e.alive) { if (man) c.dead++; continue; }
    const t = e.team;
    if (man) c.soldiers[t]++; else c.vehicles[t]++;
    if (P && e.pos.distanceTo(P.pos) < 1000 && man) c.near1km[t]++;
    v.copy(e.pos); v.y += man ? 0.9 : 1.5;
    if (v.distanceTo(cam.position) > 4000) continue;
    v.project(cam);
    if (v.z > 1 || v.z < -1 || v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1) continue;
    if (man) c.screenSoldiers[t]++; else c.screenVehicles[t]++;
  }
  return { ...c, stats: window.__cmdStats?.battle ?? null, combat: window.__cmdStats?.combat ?? '', phase: window.__cmdStats?.phase };
});


/** Aim the controlled vehicle's gun at an entity (as the player would with the mouse) and wait for the gun to load. */
async function aim(page, entId, dy = 1) {
  const f = ([id, dy]) => {
    const I = window.__cmd, c = I.controller;
    const e = I.world.ents.find((x) => x.id === id);
    if (!e) return;
    c.aimAt(e.pos.clone().setY(e.pos.y + dy));
    c.snapTurret?.();
  };
  await page.evaluate(f, [entId, dy]);
  await until(page, () => (window.__cmd.controller?.hud?.reload ?? 0) >= 0.999, null, 120000, 500);
  await page.evaluate(f, [entId, dy]);
  await sleep(1200);
}
async function trigger(page, holdMs = 900) {
  // The pointer already rests at the centre (kill() puts it there before aiming): no look delta on the click.
  await page.mouse.down();
  await sleep(holdMs);
  await page.mouse.up();
}
async function key(page, code, ms = 1500) {
  await page.keyboard.down(code);
  await sleep(ms);
  await page.keyboard.up(code);
}

/** Kill enemy infantry with HE (key 2, trigger) and with the coaxial machine gun (Space), in the battle. */
async function kill(page) {
  // The pointer to the centre first (a move is a look input: done before aiming, not on the trigger).
  await page.mouse.move(800, 450);
  await sleep(1500);
  const pick = (maxM) => page.evaluate((maxM) => {
    const I = window.__cmd, P = I.world.player;
    let best = null, bd = Infinity;
    for (const e of I.world.ents) {
      if (!e.alive || e.team !== 1 || e.neutral || (e.kind !== 'soldier' && e.kind !== 'at') || !e.f32) continue;
      const d = e.pos.distanceTo(P.pos);
      if (d < 50 || d > maxM) continue;
      // Line of sight from the turret.
      const a = P.pos.clone().setY(P.pos.y + 3), b = e.pos.clone().setY(e.pos.y + 1);
      let ok = true;
      for (let k = 1; k < 30 && ok; k++) { const q = a.clone().lerp(b, k / 30); if (I.ground.heightAt(q.x, q.z) > q.y) ok = false; }
      if (ok && d < bd) { bd = d; best = e; }
    }
    return best ? { id: best.id, d: Math.round(bd) } : null;
  }, maxM);
  // The battle's enemies stand behind the hills of this front: a squad of the enemy's pool is put in sight 260 m
  // ahead (prone and kneeling, as the trench line), and one more at 180 m for the machine gun.
  await page.evaluate(() => {
    const I = window.__cmd, P = I.world.player, b = I.forces.battle.info();
    const foe = b.sides.find((q) => q.team === 1)?.owner ?? 0;
    const fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw);
    const put = (d, side, k) => {
      const x = P.pos.x + fx * d + fz * side, z = P.pos.z + fz * d - fx * side;
      const e = I.world.spawn('soldier', 1, x, z, P.yaw + Math.PI);
      e.nation = foe; e.src = { kind: 'pool', id: 0, owner: foe, share: 0 }; e.order = 'hold'; e.goal.set(x, 0, z); e.look.set(P.pos.x, 0, P.pos.z);
      e.state = k % 3 === 0 ? 1 : 0;
      e.f32 = true;
      return e;
    };
    // The farthest spot (≤ 280 m) the crew can see along the hull's heading: the squad stands there.
    const eye = P.pos.clone().setY(P.pos.y + 3);
    const seen = (d, side) => {
      const x = P.pos.x + fx * d + fz * side, z = P.pos.z + fz * d - fx * side, y = I.ground.heightAt(x, z) + 0.6;
      for (let k = 1; k < 40; k++) { const f = k / 40; if (I.ground.heightAt(eye.x + (x - eye.x) * f, eye.z + (z - eye.z) * f) > eye.y + (y - eye.y) * f - (f < 0.9 ? 1.5 : 0)) return false; }
      return true;
    };
    let dS = 90;
    for (let d = 280; d >= 90; d -= 10) if (seen(d, 0) && seen(d, -10) && seen(d, 10)) { dS = d; break; }
    for (let i = 0; i < 8; i++) put(dS + (i % 3) * 4, (i - 3.5) * 3.5, i);
    for (let i = 0; i < 5; i++) put(Math.max(70, dS - 60) + (i % 2) * 3, 25 + i * 4, i);
    window.__f32squad = dS;
  });
  await sleep(1500);
  const before = await page.evaluate(() => ({ kills: window.__cmd.world.stats.kills, troops: window.__cmdStats?.killsBy ?? {} }));
  let he = 0;
  const shots = [];
  await key(page, 'Digit2');
  for (let i = 0; i < 4; i++) {
    const t = await pick(300);
    if (!t) break;
    await aim(page, t.id, 0.5);
    const k0 = await page.evaluate(() => window.__cmd.world.stats.kills);
    // The controller's own trigger on the aim the crew holds (a mouse click here also feeds the pointer-lock delta
    // into the aim under SwiftShader and throws the shot off; the coax below uses the real Space key).
    await page.evaluate(() => window.__cmd.controller.fire());
    await sleep(4000);
    const k1 = await page.evaluate(() => window.__cmd.world.stats.kills);
    shots.push(`${t.d} m → ${k1 - k0}`);
    he += k1 - k0;
  }
  row('K1', 'HE shells kill infantry in a radius (key 2, trigger)', `${he} killed by ${shots.length} shells [${shots.join(', ')}] (squad staged at ${await page.evaluate(() => window.__f32squad)} m, the farthest the crew could see)`, he >= 2);
  await snap(page, 'kill-1-he');
  // A fresh squad for the machine gun, standing in the open at the farthest spot ≤ 160 m the crew can see.
  await page.evaluate(() => {
    const I = window.__cmd, P = I.world.player, b = I.forces.battle.info();
    const foe = b.sides.find((q) => q.team === 1)?.owner ?? 0;
    const fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw);
    const eye = P.pos.clone().setY(P.pos.y + 3);
    const seen = (d, side) => {
      const x = P.pos.x + fx * d + fz * side, z = P.pos.z + fz * d - fx * side, y = I.ground.heightAt(x, z) + 1;
      for (let k = 1; k < 40; k++) { const f = k / 40; if (I.ground.heightAt(eye.x + (x - eye.x) * f, eye.z + (z - eye.z) * f) > eye.y + (y - eye.y) * f - (f < 0.9 ? 1.5 : 0)) return false; }
      return true;
    };
    let dS = 60;
    for (let d = 160; d >= 60; d -= 10) if (seen(d, -8) && seen(d, 8)) { dS = d; break; }
    for (let i = 0; i < 6; i++) {
      const d = dS + (i % 2) * 3, side = -8 + i * 3.2;
      const x = P.pos.x + fx * d + fz * side, z = P.pos.z + fz * d - fx * side;
      const e = I.world.spawn('soldier', 1, x, z, P.yaw + Math.PI);
      e.nation = foe; e.src = { kind: 'pool', id: 0, owner: foe, share: 0 }; e.order = 'hold'; e.goal.set(x, 0, z); e.look.set(P.pos.x, 0, P.pos.z);
      e.f32 = true;
    }
    window.__f32mg = dS;
  });
  await sleep(1500);
  const t = await pick(200);
  let mg = 0;
  if (t) {
    const k0 = await page.evaluate(() => window.__cmd.world.stats.kills);
    for (let i = 0; i < 3; i++) {
      const t2 = (await pick(600)) ?? t;
      await page.evaluate((id) => { const I = window.__cmd, e = I.world.ents.find((x) => x.id === id); if (e) { I.controller.aimAt(e.pos.clone().setY(e.pos.y + 0.6)); I.controller.snapTurret?.(); } }, t2.id);
      await sleep(800);
      await key(page, 'Space', 3500);
    }
    await sleep(1500);
    mg = (await page.evaluate(() => window.__cmd.world.stats.kills)) - k0;
  }
  const after = await page.evaluate(() => window.__cmdStats?.killsBy ?? {});
  row('K2', 'the coaxial machine gun cuts down infantry (Space)', t ? `${mg} killed at ~${t.d} m (squad of 6 staged at ${await page.evaluate(() => window.__f32mg)} m); troops sent to the sim ${JSON.stringify(after)} (before ${JSON.stringify(before.troops)})` : 'no target in sight', mg >= 1);
  await snap(page, 'kill-2-mg');
}

/** Run over infantry and a light vehicle at war: men and a truck put 25-45 m ahead of the tank, then W. */
async function ram(page) {
  const staged = await page.evaluate(() => {
    const I = window.__cmd, P = I.world.player, b = I.forces.battle.info();
    const foe = b.sides.find((q) => q.team === 1)?.owner ?? 0;
    P.pos.y = I.ground.heightAt(P.pos.x, P.pos.z);
    const fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw);
    const ids = [];
    const put = (kind, d, side) => {
      const x = P.pos.x + fx * d + fz * side, z = P.pos.z + fz * d - fx * side;
      const e = I.world.spawn(kind, 1, x, z, P.yaw);
      e.nation = foe; e.src = { kind: 'pool', id: 0, owner: foe, share: kind === 'truck' ? 6 : 0 }; e.order = kind === 'truck' ? 'goto' : 'hold'; e.goal.set(x, 0, z); e.look.set(P.pos.x, 0, P.pos.z);
      ids.push(e.id);
      return e;
    };
    for (let i = 0; i < 4; i++) put('soldier', 13 + i * 2.5, (i - 1.5) * 1.2);
    // Our own men shoot an enemy truck in their midst: it stands close, so the tank reaches it first.
    const tr = put('truck', 30, 0);
    // Our men around would shoot it first: it stays whole for them (the ram's damage scales with its toughness).
    tr.hp = tr.maxHp = 3000;
    // Parked (its crew out): it does not drive off when the tank comes.
    tr.dormant = true;
    // Clear the lane of everything else (our own men step aside anyway).
    I.world.godMode = false;
    I.controller.aimAt(P.pos.clone().add({ x: fx * 300, y: 2, z: fz * 300 }));
    return { ids, foe, hp: P.hp };
  });
  const r0 = await page.evaluate(() => window.__cmdStats?.ram ?? null);
  const p0 = await page.evaluate(() => window.__cmd.world.player.pos.clone());
  await page.keyboard.down('KeyW');
  await until(page, (p0) => { const P = window.__cmd.world.player; return Math.hypot(P.pos.x - p0.x, P.pos.z - p0.z) > 70 || (window.__cmdStats?.ram?.vehicles ?? 0) > 0 ? true : null; }, p0, 240000, 500);
  await page.keyboard.up('KeyW');
  await sleep(2500);
  const r = await page.evaluate((ids) => ({ ram: window.__cmdStats?.ram, alive: ids.map((id) => window.__cmd.world.ents.find((e) => e.id === id)?.alive ?? false), hp: window.__cmd.world.player.hp }), staged.ids);
  row('R1', 'running over infantry kills them (mass and speed)', `${r.ram.men - (r0?.men ?? 0)} run over; staged men alive: ${r.alive.slice(0, 4).join(',')}`, r.ram.men - (r0?.men ?? 0) >= 2);
  row('R2', 'ramming a light vehicle wrecks it and damages the tank', `rams ${r.ram.vehicles}, wrecked ${r.ram.vehicleKills}, own damage ${r.ram.selfDmg.toFixed(1)} hp (hp ${staged.hp} → ${r.hp.toFixed(1)}); «${r.ram.last}»`, r.ram.vehicleKills >= 1 && r.ram.selfDmg > 0);
  await snap(page, 'ram-1');
}

/** Machine gun on an enemy factory (war): its hp in the sim goes down a little; the HUD says it is ineffective. Then the fence. */
async function mgFactory() {
  const page = await open('command-strike', '&target=factory&live=1');
  await until(page, () => window.__cmdStats?.phase === 'play' ? true : null, null, 300000, 1000);
  const sid = await page.evaluate(() => window.__strikeTarget);
  const hp0 = await page.evaluate((sid) => __front.ctx.sim.view.structures.get(sid)?.hp, sid);
  await page.evaluate((sid) => {
    const I = window.__cmd, st = I.civil.structRecs.find((r) => r.id === sid);
    I.controller.aimAt(new I.world.player.pos.constructor(st.x, st.y0 + (st.y1 - st.y0) * 0.3, st.z));
    I.controller.snapTurret?.();
  }, sid);
  await sleep(1500);
  for (let i = 0; i < 4; i++) await key(page, 'Space', 4000);
  await sleep(5000);
  const r = await page.evaluate((sid) => ({ hp: __front.ctx.sim.view.structures.get(sid)?.hp, mg: window.__cmdStats?.mgHits?.[sid] ?? 0, notice: window.__cmdStats?.notice ?? '' }), sid);
  row('M1', 'machine gun on a factory: small but real damage in the sim', `hp ${hp0?.toFixed(4)} → ${r.hp?.toFixed(4)} after ${r.mg} rounds on it`, r.hp < hp0 && hp0 - r.hp < 0.1);
  row('M2', 'the HUD says the MG is ineffective and suggests the cannon or bombers', `«${r.notice}»`, /cañón|cannon/i.test(r.notice));
  await snap(page, 'mg-1-factory');
  // Drive through the compound's fence.
  await page.evaluate((sid) => {
    const I = window.__cmd, P = I.world.player, st = I.civil.structRecs.find((r) => r.id === sid);
    const f = st.half * 0.88;
    // 30 m outside the fence on the side facing the tank, heading in.
    const dx = P.pos.x - st.x, dz = P.pos.z - st.z;
    const ax = Math.abs(dx) > Math.abs(dz);
    const x = ax ? st.x + Math.sign(dx) * (f + 30) : st.x + Math.min(f * 0.5, Math.max(-f * 0.5, dx));
    const z = ax ? st.z + Math.min(f * 0.5, Math.max(-f * 0.5, dz)) : st.z + Math.sign(dz) * (f + 30);
    P.pos.set(x, I.ground.heightAt(x, z), z);
    P.yaw = Math.atan2(-(st.x - x), -(st.z - z));
    I.controller.aimAt(new P.pos.constructor(st.x, st.y0 + 5, st.z));
  }, sid);
  await sleep(1500);
  const q0 = await page.evaluate(() => window.__cmd.world.player.pos.clone());
  await page.keyboard.down('KeyW');
  await until(page, (q0) => { const P = window.__cmd.world.player; return Math.hypot(P.pos.x - q0.x, P.pos.z - q0.z) > 70 || (window.__cmdStats?.ram?.fences ?? 0) > 0 ? true : null; }, q0, 240000, 500);
  await page.keyboard.up('KeyW');
  await sleep(2500);
  const f = await page.evaluate(() => window.__cmdStats?.ram);
  row('M3', 'driving through a compound fence knocks a section down', `fences ${f?.fences}, trees ${f?.trees}, houses ${f?.houses}; «${f?.last}»`, (f?.fences ?? 0) >= 1);
  await snap(page, 'mg-2-fence');
  await page.close();
}

async function scale() {
  const page = await open('f3-missions', '&run=10&panel=0');
  const off = await page.evaluate(() => {
    const a = __front.ctx.sim.view.attacks.find((x) => x.attacker === 1 && x.defender > 0 && !x.naval && x.contactX >= 0);
    return a ? { key: a.frontKey, id: a.id, troops: Math.round(a.troops) } : null;
  });
  row('S0', 'our offensive of the staged war', off ? `front ${off.key}, ${off.troops} troops` : 'none', !!off && off.troops >= 100000);
  if (!off) return;
  await page.evaluate((k) => __front.ctx.bus.emit('frontSelected', { key: k, fly: false }), off.key);
  const ok = await until(page, (k) => !!document.querySelector(`.fu-war-front[data-key="${k}"] .fu-war-take`), off.key, 30000);
  if (!ok) { row('S0b', 'Guerra panel «Tomar el control aquí»', 'missing', false); return; }
  await page.locator(`.fu-war-front[data-key="${off.key}"] .fu-war-take`).first().click();
  const play = await until(page, () => window.__cmdStats?.phase === 'play' && window.__cmdStats?.battle?.active ? true : null, null, 600000, 1000);
  await sleep(4000);
  let c = await census(page);
  console.log(`   census at entry: ${JSON.stringify(c)}`);
  const b = c.stats;
  const shown = b ? b.sides.map((q) => `${q.team ? 'enemy' : 'ours'} ${q.shown}/${q.target} (${q.perKm} troops/km, ${q.vehicles} vehicles, ${q.role})`).join('; ') : 'no battle';
  // Both sides at the sim's density (the enemy may really be thin on this stretch: its figures follow its troops per km).
  row('S1', 'soldiers of both sides around the player (sim density, believable cap)', `${c.soldiers[0]} ours + ${c.soldiers[1]} enemy alive in the scene, ${c.near1km[0] + c.near1km[1]} within 1 km; ${shown}`, !!play && c.soldiers[0] + c.soldiers[1] >= 300 && c.soldiers[1] >= Math.min(40, b?.sides.find((q) => q.team === 1)?.target ?? 0));
  row('S2', 'vehicles in the battle', `${c.vehicles[0]} ours, ${c.vehicles[1]} enemy`, c.vehicles[0] + c.vehicles[1] >= 4);
  await snap(page, 'scale-1-chase');
  // Look at the hottest point from the tank (the turret turned there) and count what the camera shows.
  await page.evaluate(() => {
    const I = window.__cmd, b = I.forces.battle.info();
    const P = I.world.player;
    const at = b.hot ?? b.near;
    if (at && P) {
      I.controller.aimAt(at.clone().setY(at.y + 2));
      P.yaw = Math.atan2(-(at.x - P.pos.x), -(at.z - P.pos.z));
    }
  });
  await sleep(2500);
  c = await census(page);
  row('S3', 'visible on screen from the tank toward the fighting', `${c.screenSoldiers[0]} ours + ${c.screenSoldiers[1]} enemy soldiers, ${c.screenVehicles[0] + c.screenVehicles[1]} vehicles in the view`, c.screenSoldiers[0] + c.screenSoldiers[1] >= 100);
  await snap(page, 'scale-2-toward-fight');
  // Activity over 20 s.
  const t0 = await page.evaluate(() => ({ kills: window.__cmd.world.stats.kills, t: window.__cmd.world.time, dead: window.__cmd.world.ents.filter((e) => !e.alive && (e.kind === 'soldier' || e.kind === 'at')).length }));
  // 15 s of the scene's own time (SwiftShader frames are slow: wall time says little).
  await until(page, (t) => window.__cmd.world.time - t >= 15 ? true : null, t0.t, 300000, 1000);
  c = await census(page);
  const act = c.stats;
  row('S4', 'the fight is alive (artillery, falls, fire)', act ? `heat ${act.heat}, ${act.shells10} shells and ${act.fallen10} fallen in the last 10 s, ${c.dead} bodies (was ${t0.dead})` : 'no battle', !!act && act.shells10 >= 2 && act.fallen10 >= 1);
  row('S5', 'HUD says where the fighting is (direction, distance, intensity)', `«${c.combat}»; hot point ${act?.hotM} m, line ${act?.lineM} m`, /\d/.test(c.combat) && /intens/i.test(c.combat));
  const tr = await page.evaluate(() => window.__cmd.world.group.parent?.getObjectByName('cmd-battle')?.children.filter((m) => m.isInstancedMesh).reduce((n, m) => n + m.count, 0) ?? 0);
  row('S6', 'trenches along the defended line', `${tr} parapet segments`, tr > 100);
  await snap(page, 'scale-3-after-20s');
  // An overview from 150 m up behind the tank: the line and its two sides.
  await page.evaluate(() => {
    const I = window.__cmd, b = I.forces.battle.info();
    const P = I.world.player;
    const at = b.hot ?? b.near;
    const dx = at.x - P.pos.x, dz = at.z - P.pos.z, l = Math.hypot(dx, dz) || 1;
    const pos = P.pos.clone();
    pos.x -= (dx / l) * 150; pos.z -= (dz / l) * 150; pos.y = Math.max(pos.y, I.ground.heightAt(pos.x, pos.z)) + 260;
    I.camOverride = { pos, look: at.clone().lerp(P.pos, 0.35), fov: 50 };
  });
  await sleep(3000);
  await snap(page, 'scale-4-overview');
  // What a crew sees driving up behind its own wave: 30 m up, 160 m behind the nearest of our men in the open.
  await page.evaluate(() => {
    const I = window.__cmd, P = I.world.player;
    let best = null, bd = Infinity;
    for (const e of I.world.ents) {
      if (!e.alive || e.team !== 0 || e.kind !== 'soldier' || e.order !== 'front') continue;
      const d = e.pos.distanceTo(P.pos);
      if (d > 150 && d < bd) { bd = d; best = e; }
    }
    if (!best) return;
    const dx = best.look.x - best.pos.x, dz = best.look.z - best.pos.z, l = Math.hypot(dx, dz) || 1;
    const pos = best.pos.clone();
    pos.x -= (dx / l) * 160; pos.z -= (dz / l) * 160;
    pos.y = Math.max(best.pos.y, I.ground.heightAt(pos.x, pos.z)) + 30;
    I.camOverride = { pos, look: best.pos.clone().setY(best.pos.y + 1).add({ x: dx / l * 120, y: 0, z: dz / l * 120 }), fov: 45 };
  });
  await sleep(3000);
  await snap(page, 'scale-5-behind-wave');
  await page.evaluate(() => { window.__cmd.camOverride = null; });
  await page.close();
}

/**
 * Shooting and ramming on open ground: the staged war's front near Zaragoza (?shot=command-front&live=1, the plain of
 * the Ebro), where the battle line stands on flat fields (the offensive above runs through the Pyrenees, where hills
 * hide most squads from a tank and its gun cannot depress onto a man just below a crest).
 */
async function combat() {
  const page = await open('command-front', '&live=1');
  await until(page, () => window.__cmdStats?.phase === 'play' && window.__cmdStats?.battle?.active ? true : null, null, 300000, 1000);
  await page.evaluate(() => { window.__cmd.skipIntro?.(); });
  await sleep(3000);
  const b = await page.evaluate(() => window.__cmdStats?.battle);
  console.log(`   battle on the plain: ${JSON.stringify(b)}`);
  if (!only || only.has('kill')) await kill(page).catch((e) => console.log('[kill]', e));
  if (!only || only.has('ram')) await ram(page).catch((e) => console.log('[ram]', e));
  await page.close();
}

async function close() {
  const page = await open('f3-missions', '&run=10&panel=0');
  const off = await page.evaluate(() => {
    const a = __front.ctx.sim.view.attacks.find((x) => x.attacker === 1 && x.defender > 0 && !x.naval && x.contactX >= 0);
    return a ? { key: a.frontKey, id: a.id } : null;
  });
  if (!off) return;
  await page.evaluate((k) => __front.ctx.bus.emit('frontSelected', { key: k, fly: false }), off.key);
  await until(page, (k) => !!document.querySelector(`.fu-war-front[data-key="${k}"] .fu-war-take`), off.key, 30000);
  await page.locator(`.fu-war-front[data-key="${off.key}"] .fu-war-take`).first().click();
  await until(page, () => window.__cmdStats?.phase === 'play' && window.__cmdStats?.battle?.active ? true : null, null, 600000, 1000);
  await sleep(3000);
  for (const [team, tag] of [[0, 'ours'], [1, 'enemy']]) {
    for (const d of [20, 50, 150]) {
      const ok = await page.evaluate(({ team, d }) => {
        const I = window.__cmd, P = I.world.player;
        // The nearest awake soldier of that side, seen from the side at d metres, 1.7 m up (a man's eye height).
        let best = null, bd = Infinity;
        for (const e of I.world.ents) {
          if (!e.alive || e.team !== team || (e.kind !== 'soldier' && e.kind !== 'at')) continue;
          const dd = e.pos.distanceTo(P.pos);
          if (dd < bd) { bd = dd; best = e; }
        }
        if (!best) return false;
        I.freeze = true;
        const yaw = best.yaw + 0.9;
        const pos = best.pos.clone();
        pos.x += -Math.sin(yaw) * d; pos.z += -Math.cos(yaw) * d;
        // Eye height, raised over any rise between the camera and the man (this front runs through hills).
        let top = Math.max(pos.y, I.ground.heightAt(pos.x, pos.z)) + 1.7;
        for (let k = 1; k < 20; k++) {
          const f = k / 20, x = pos.x + (best.pos.x - pos.x) * f, z = pos.z + (best.pos.z - pos.z) * f;
          const need = I.ground.heightAt(x, z) + 1.2 - (best.pos.y + 1) * f;
          if (need / (1 - f) > top) top = need / (1 - f);
        }
        pos.y = top + d * 0.02;
        I.camOverride = { pos, look: best.pos.clone().setY(best.pos.y + 0.9), fov: d <= 20 ? 40 : d <= 50 ? 30 : 20 };
        return `${best.kind} pose ${best.pose} at ${Math.round(bd)} m from the tank`;
      }, { team, d });
      await sleep(2500);
      await snap(page, `close-${tag}-${d}m`);
      row(`C${team}${d}`, `${tag} soldier close-up at ${d} m`, ok || 'no soldier', !!ok);
    }
  }
  await page.evaluate(() => { window.__cmd.camOverride = null; window.__cmd.freeze = false; });
  await page.close();
}

const sections = { scale, close, mg: mgFactory, combat };
for (const [k, fn] of Object.entries(sections)) {
  if (only && !only.has(k) && !(k === 'combat' && (only.has('kill') || only.has('ram')))) continue;
  try {
    await fn();
  } catch (e) {
    errors++;
    console.log(`[${k}] ${e?.stack ?? e}`);
  }
}
const pass = results.filter((r) => r.pass).length;
console.log(`\n${pass}/${results.length} pass, ${errors} page errors`);
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ results, errors }, null, 1));
await browser.close();
process.exit(0);
