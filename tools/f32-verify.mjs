// Owner item 32 browser verifier: command-mode combat at the real scale of the front, readable and physical.
// Real game in Chromium (SwiftShader) on real staged sims, entered through the real UI, measured numerically.
//   node tools/f32-verify.mjs [--url http://127.0.0.1:5463/] [--out shots/owner-32-1/verify] [--only scale,close,kill,mg,ram,entry1x]
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
// entry1x the same take-control clicked with the clock RUNNING at 1x: the world waits from the click, the march reaches
//         contact without «Pulsa G», the first view faces the fight, the tank drives to the hot stretch (S7b); map (M)
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
/** SwiftShader draws a frame in about a second at 1600×900: long waits run on a small viewport (the scene's time then
 *  moves ~4× faster in real time), and the view is restored before a shot. */
async function small(page, on) {
  await page.setViewportSize(on ? { width: 640, height: 360 } : { width: 1600, height: 900 });
  await sleep(on ? 500 : 2500);
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
  const c = { soldiers: [0, 0], vehicles: [0, 0], screenSoldiers: [0, 0], screenVehicles: [0, 0], seenSoldiers: [0, 0], seenVehicles: [0, 0], around: [0, 0], near1km: [0, 0], near600: [0, 0], dead: 0, big6: [0, 0], line: { pts: 0, seen: 0, nearest: -1, far: -1 }, camUp: 0 };
  const cp = cam.position;
  // Gauntlet round 1: how tall each man is drawn (his pose's height × the readable scale), and the enemy's line in view.
  const ppm1 = H / (2 * Math.tan((cam.fov * Math.PI) / 360));
  const poseH = [1.8, 1.8, 1.7, 1.2, 0.6, 0.3, 1.8, 1.45];
  c.camUp = Math.round(cp.y - I.ground.heightAt(cp.x, cp.z));
  // In the line of sight of the camera (the ground between does not hide it): what a player really sees.
  const sees = (x, y, z) => {
    const n = Math.max(8, Math.min(48, Math.round(Math.hypot(x - cp.x, z - cp.z) / 25)));
    for (let k = 1; k < n; k++) {
      const f = k / n;
      if (f > 0.97) break;
      const qx = cp.x + (x - cp.x) * f, qz = cp.z + (z - cp.z) * f, qy = cp.y + (y - cp.y) * f;
      if (I.ground.heightAt(qx, qz) > qy) return false;
    }
    return true;
  };
  for (const e of I.world.ents) {
    if (e.player) continue;
    const man = e.kind === 'soldier' || e.kind === 'at';
    const veh = ['tank', 'ifv', 'truck', 'aa'].includes(e.kind);
    if (!man && !veh) continue;
    if (!e.alive) { if (man) c.dead++; continue; }
    const t = e.team;
    if (man) c.soldiers[t]++; else c.vehicles[t]++;
    if (P && e.pos.distanceTo(P.pos) < 1000 && man) c.near1km[t]++;
    if (P && e.pos.distanceTo(P.pos) < 600 && man) c.near600[t]++;
    v.copy(e.pos); v.y += man ? 0.9 : 1.5;
    if (v.distanceTo(cam.position) > 4000) continue;
    // Around the player: in the camera's line of sight within 2.5 km, whichever way it looks (turning the turret).
    if (man && v.distanceTo(cam.position) < 2500 && sees(e.pos.x, e.pos.y + (e.pose === 4 ? 0.35 : 0.9), e.pos.z)) c.around[t]++;
    v.project(cam);
    if (v.z > 1 || v.z < -1 || v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1) continue;
    if (man) c.screenSoldiers[t]++; else c.screenVehicles[t]++;
    if (sees(e.pos.x, e.pos.y + (man ? (e.pose === 4 ? 0.35 : 0.9) : 1.5), e.pos.z)) {
      if (man) c.seenSoldiers[t]++; else c.seenVehicles[t]++;
      if (man && ((poseH[e.pose] ?? 1.8) * (e.drawScale || 1) * ppm1) / Math.max(1, cp.distanceTo(e.pos)) >= 6) c.big6[t]++;
    }
  }
  for (const q of I.forces?.battle?.foeLine?.(25) ?? []) {
    const p = q.clone().project(cam);
    if (p.z > 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) continue;
    c.line.pts++;
    if (!sees(q.x, q.y, q.z)) continue;
    c.line.seen++;
    const d = P ? Math.round(Math.hypot(q.x - P.pos.x, q.z - P.pos.z)) : 0;
    c.line.nearest = c.line.nearest < 0 ? d : Math.min(c.line.nearest, d);
    c.line.far = Math.max(c.line.far, d);
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
  // A still tank (no drive running), then the pointer to the centre (a move is a look input: done before aiming).
  await page.evaluate(() => { const c = window.__cmd.controller; if (c.driveTo) c.driveTo = null; c.ent.speed = 0; });
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
  const menKilled = () => page.evaluate(() => ['soldier', 'at'].reduce((n, k) => n + (window.__cmd.world.stats.killsByKind.get(k) ?? 0), 0));
  const m0 = await menKilled();
  const shots = [];
  await key(page, 'Digit2');
  for (let i = 0; i < 4; i++) {
    const t = await pick(300);
    if (!t) break;
    await aim(page, t.id, 0.5);
    const k0 = await menKilled();
    // The controller's own trigger on the aim the crew holds (a mouse click here also feeds the pointer-lock delta
    // into the aim under SwiftShader and throws the shot off; the coax below uses the real Space key).
    await page.evaluate(() => window.__cmd.controller.fire());
    // Until the shell has burst (SwiftShader frames are a second or more apart).
    await until(page, () => (window.__cmd.world.projs.some((p) => p.alive && p.player && p.kind === 'shell') ? null : true), null, 30000, 500);
    await sleep(2000);
    shots.push(`${t.d} m → ${(await menKilled()) - k0}`);
  }
  await sleep(3000);
  const he = (await menKilled()) - m0;
  row('K1', 'HE shells kill infantry in a radius (key 2, trigger)', `${he} men killed by the player's ${shots.length} shells [${shots.join(', ')}] (squad staged at ${await page.evaluate(() => window.__f32squad)} m, the farthest the crew could see)`, he >= 2);
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
  // At peace it is an incident (item 31's rule): a truck of a nation at peace with us parked 30 m ahead; the tank stops
  // against it and the question opens; Enter (the safe default) = «Frenar»: no war, the truck unharmed.
  const pz = await page.evaluate(() => {
    const I = window.__cmd, P = I.world.player, v = __front.ctx.sim.view;
    const atWar = (o) => v.wars.some((w) => (w.aggressor === 1 && w.target === o) || (w.target === 1 && w.aggressor === o));
    let nation = 0;
    for (let o = 2; o < v.players.length; o++) if (v.players[o] && !atWar(o) && v.pairState(1, o) !== 'war') { nation = o; break; }
    if (!nation) return null;
    P.speed = 0;
    const fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw);
    const x = P.pos.x + fx * 30, z = P.pos.z + fz * 30;
    const e = I.world.spawn('truck', 1, x, z, P.yaw);
    e.nation = nation; e.neutral = true; e.src = { kind: 'pool', id: 0, owner: nation, share: 0 }; e.order = 'hold'; e.goal.set(x, 0, z); e.dormant = true;
    return { id: e.id, nation, hp: e.hp, asked: window.__cmdStats?.ram?.asked ?? 0 };
  });
  if (pz) {
    await sleep(1500);
    await page.keyboard.down('KeyW');
    const asked = await until(page, () => (window.__cmd.overlay.dialogOpen ? window.__cmd.fire().dialog : null), null, 240000, 500);
    await page.keyboard.up('KeyW');
    await snap(page, 'ram-2-peace-question');
    await page.keyboard.down('Enter');
    await sleep(1500);
    await page.keyboard.up('Enter');
    // (SwiftShader frames at 1600×900 with the battle around take a second or two: the answer is read on the next one.)
    const closed = await until(page, () => (window.__cmd.overlay.dialogOpen ? null : true), null, 20000, 500);
    if (!closed) console.log(`   dialog still open after Enter: ${await page.evaluate(() => JSON.stringify({ phase: window.__cmdStats?.phase, text: window.__cmd.overlay.dialogText.slice(-80), active: document.activeElement?.tagName }))}`);
    await sleep(3000);
    const after = await page.evaluate((pz) => {
      const I = window.__cmd, e = I.world.ents.find((x) => x.id === pz.id);
      return { war: __front.ctx.sim.view.pairState(1, pz.nation) === 'war', alive: !!e?.alive, hp: e?.hp ?? 0, dialog: I.overlay.dialogOpen, dialogText: I.overlay.dialogText.slice(0, 120), asked: window.__cmdStats?.ram?.asked ?? 0, answers: I.fire().answers };
    }, pz);
    row('R3', 'running into a vehicle of a nation at peace: the tank stops and asks first (item 31); Enter = «Frenar»', `«${(asked ?? 'no dialog').slice(0, 200)}»; after Enter: war ${after.war}, truck alive ${after.alive} hp ${pz.hp} → ${after.hp}, asked ${pz.asked} → ${after.asked}, answers ${after.answers.join('/')}, dialog open ${after.dialog}${after.dialog ? ` («${after.dialogText}»)` : ''}`, !!asked && /frenar/i.test(asked) && !after.war && after.alive && after.hp >= pz.hp && !after.dialog);
  } else row('R3', 'a nation at peace for the ramming incident', 'none', false);
}

/** Machine gun on an enemy factory (war): its hp in the sim goes down a little; the HUD says it is ineffective. Then the fence. */
async function mgFactory() {
  const page = await open('command-strike', '&target=factory&live=1');
  await until(page, () => window.__cmdStats?.phase === 'play' ? true : null, null, 300000, 1000);
  await page.evaluate(() => window.__cmd.skipIntro?.());
  await sleep(3000);
  const sid = await page.evaluate(() => window.__strikeTarget);
  const hp0 = await page.evaluate((sid) => __front.ctx.sim.view.structures.get(sid)?.hp, sid);
  await page.evaluate((sid) => {
    const I = window.__cmd, st = I.civil.structRecs.find((r) => r.id === sid);
    I.controller.aimAt(new I.world.player.pos.constructor(st.x, st.y0 + (st.y1 - st.y0) * 0.3, st.z));
    I.controller.snapTurret?.();
  }, sid);
  await sleep(1500);
  // Bursts until a few rounds have struck it (SwiftShader frames are a second or more apart).
  for (let i = 0; i < 8; i++) {
    await key(page, 'Space', 5000);
    if ((await page.evaluate((sid) => window.__cmdStats?.mgHits?.[sid] ?? 0, sid)) >= 6) break;
  }
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
  // Pass 2: a battle's density near the player (the figures are the picture of the sim's troops there).
  row('S1', 'soldiers of both sides around the player (a battle\'s density, the sim\'s troops)', `${c.soldiers[0]} ours + ${c.soldiers[1]} enemy alive in the scene, ${c.near600[0]} + ${c.near600[1]} within 600 m, ${c.near1km[0] + c.near1km[1]} within 1 km; ${shown}`, !!play && c.soldiers[0] + c.soldiers[1] >= 900 && c.soldiers[1] >= 300 && c.near600[0] + c.near600[1] >= 300);
  row('S2', 'vehicles in the battle', `${c.vehicles[0]} ours, ${c.vehicles[1]} enemy`, c.vehicles[0] + c.vehicles[1] >= 4);
  await snap(page, 'scale-1-chase');
  // Taken here to fight: the tank drives on by itself to the battle's hottest stretch (220 m behind the line).
  await until(page, () => (window.__cmdStats?.battle?.driving ? true : null), null, 60000, 1000);
  const d0 = await page.evaluate(() => ({ ...window.__cmdStats.battle, t: window.__cmd.world.time }));
  await small(page, true);
  await until(page, () => (window.__cmdStats?.battle && !window.__cmdStats.battle.driving ? true : null), null, 1_800_000, 2000);
  await small(page, false);
  const d1 = await page.evaluate(() => ({ ...window.__cmdStats.battle, t: window.__cmd.world.time }));
  const pace = await page.evaluate(() => window.__cmdStats?.pace);
  row('S7', 'arrival: the tank drives on to the hottest stretch by itself', `at entry: line ${d0.lineM} m, hot point ${d0.hotM} m, stand-off ${d0.standM} m (driving ${d0.driving}); the drive ended «${d1.lastDrive}» after ${Math.round(d1.t - d0.t)} s of scene time: line ${d1.lineM} m, hot point ${d1.hotM} m, stand-off ${d1.standM} m (scene pace ${pace}× real time, the sim's clock follows it)`, d0.driving && d1.lastDrive === 'arrived' && d1.lineM >= 0 && d1.lineM < 450);
  c = await census(page);
  await snap(page, 'scale-1b-arrived');
  row('S3a', 'soldiers in sight around the player after arriving (any direction, ≤ 2.5 km, not behind the ground)', `${c.around[0]} ours + ${c.around[1]} enemy (in this view: ${c.seenSoldiers[0]} + ${c.seenSoldiers[1]})`, c.around[0] + c.around[1] >= 300 && c.around[1] >= 40);
  // Gauntlet round 1 (critic acceptance): the default chase camera as the drive left it (looking along the line) shows
  // an army, not specks: ≥ 150 figures drawn ≥ 6 px tall, and the enemy's line in sight 250-350 m off.
  const flat = await page.evaluate(() => { const I = window.__cmd, P = I.world.player; return I.ground.normalAt(P.pos.x, P.pos.z, P.pos.clone(), 10).y.toFixed(3); });
  row('S8', 'arrival view (default chase camera): an army at scale, the enemy line in sight', `${c.big6[0]} ours + ${c.big6[1]} enemy drawn ≥ 6 px (of ${c.seenSoldiers[0]} + ${c.seenSoldiers[1]} in sight); enemy line ${c.line.seen} of ${c.line.pts} points in the frame in sight, ${c.line.nearest}-${c.line.far} m from the tank; ground under the tank n.y ${flat}`, c.big6[0] + c.big6[1] >= 150 && c.line.seen >= 5 && c.line.nearest >= 200 && c.line.nearest <= 380);
  // The overview key (V): the camera rises over the whole line for a few seconds.
  await page.keyboard.press('v');
  await sleep(4500);
  const cv = await census(page);
  await snap(page, 'scale-1c-overview-V');
  row('S9', 'V: overview over the line (60-80 m up, the enemy line and the men in view)', `camera ${cv.camUp} m over the ground; ${cv.seenSoldiers[0]} ours + ${cv.seenSoldiers[1]} enemy in view, enemy line ${cv.line.seen} points in sight (${cv.line.nearest}-${cv.line.far} m)`, cv.camUp >= 55 && cv.camUp <= 95 && cv.line.seen >= 10 && cv.seenSoldiers[0] + cv.seenSoldiers[1] >= 150);
  await page.keyboard.press('v');
  await sleep(2500);
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
  row('S3', 'visible on screen from the tank toward the fighting (in the frame and not behind the ground)', `${c.seenSoldiers[0]} ours + ${c.seenSoldiers[1]} enemy soldiers and ${c.seenVehicles[0] + c.seenVehicles[1]} vehicles in sight (${c.screenSoldiers[0] + c.screenSoldiers[1]} soldiers inside the frame counting those behind hills)`, c.seenSoldiers[0] + c.seenSoldiers[1] >= 150 && c.seenSoldiers[1] >= 30);
  await snap(page, 'scale-2-toward-fight');
  // Activity over 20 s.
  const t0 = await page.evaluate(() => ({ kills: window.__cmd.world.stats.kills, t: window.__cmd.world.time, dead: window.__cmd.world.ents.filter((e) => !e.alive && (e.kind === 'soldier' || e.kind === 'at')).length }));
  // 15 s of the scene's own time (SwiftShader frames are slow: wall time says little).
  await small(page, true);
  await until(page, (t) => window.__cmd.world.time - t >= 15 ? true : null, t0.t, 600000, 1000);
  await small(page, false);
  c = await census(page);
  const act = c.stats;
  row('S4', 'the fight is alive (artillery, falls, fire)', act ? `heat ${act.heat}, ${act.shells10} shells and ${act.fallen10} fallen in the last 10 s, ${c.dead} bodies (was ${t0.dead})` : 'no battle', !!act && act.shells10 >= 2 && act.fallen10 >= 1);
  row('S5', 'HUD says where the fighting is (direction, distance, intensity)', `«${c.combat}»; hot point ${act?.hotM} m, line ${act?.lineM} m`, /\d/.test(c.combat) && /intens/i.test(c.combat));
  const tr = await page.evaluate(() => window.__cmd.world.group.parent?.getObjectByName('cmd-battle')?.children.filter((m) => m.isInstancedMesh && m.name.startsWith('trench')).reduce((n, m) => n + m.count, 0) ?? 0);
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
  if (!only || only.has('plain')) {
    // The same war on open ground (the Ebro plain): the tank enters ~1 km behind a quiet stretch of the line.
    let c = await census(page);
    await snap(page, 'plain-1-entry');
    row('P0', 'on the plain at entry (before going to the fight)', `line ${b?.lineM} m; ${c.seenSoldiers[0]} ours + ${c.seenSoldiers[1]} enemy in this view, ${c.around[0]} + ${c.around[1]} in sight around (${c.soldiers[0]} + ${c.soldiers[1]} in the scene; roles ${b?.sides.map((q) => q.role).join('/')})`, !!b?.active);
    // «Ir al combate» (G, held so a SwiftShader frame sees it) drives to the hottest stretch, among our line. This shot
    // puts the tank on the enemy's side of the line: it is first set 650 m back on our own side (as if it had come up
    // from the rear), so the drive does not cross the enemy's trenches.
    await page.evaluate(() => {
      const I = window.__cmd, b = I.forces.battle.info(), P = I.world.player;
      const so = I.forces.battle.standOff(b.near ?? b.hot, 650, P.pos.clone());
      if (so) { P.pos.copy(so); P.pos.y = I.ground.heightAt(so.x, so.z); P.speed = 0; }
    });
    await sleep(4000);
    const g0 = await page.evaluate(() => ({ ...window.__cmdStats.battle, t: window.__cmd.world.time }));
    await key(page, 'KeyG', 2500);
    // (A SwiftShader frame takes a second or more: the drive starts a few frames later.)
    const started = !!(await until(page, () => (window.__cmdStats?.battle?.driving ? true : null), null, 90000, 1000));
    const gNotice = await page.evaluate(() => window.__cmdStats?.notice ?? '');
    await small(page, true);
    await until(page, () => (window.__cmdStats?.battle && !window.__cmdStats.battle.driving ? true : null), null, 2_400_000, 2000);
    await small(page, false);
    const g1 = await page.evaluate(() => ({ ...window.__cmdStats.battle, t: window.__cmd.world.time }));
    const alive = await page.evaluate(() => !!window.__cmd.controller && window.__cmd.world.player?.alive);
    row('G1', '«Ir al combate» (G) inside the battle drives to its hottest stretch', `before: line ${g0.lineM} m, stand-off ${g0.standM} m; «${gNotice}»; driving ${started}; the drive ended «${g1.lastDrive}» after ${Math.round(g1.t - g0.t)} s of scene time: line ${g1.lineM} m, stand-off ${g1.standM} m; tank alive ${alive}`, started && alive && g1.lastDrive === 'arrived' && g1.lineM < 450);
    if (!alive) return;
    await snap(page, 'plain-2-after-G');
    // At the hot stretch: what the crew sees around and toward the line.
    c = await census(page);
    // A quiet stretch of a thin front (the sim's garrisons there: a few hundred figures in all): a good share of what
    // stands there is in sight, both sides.
    row('P1', 'on the plain at the hot stretch: soldiers in sight around the player (share of the figures there)', `${c.around[0]} ours + ${c.around[1]} enemy in sight around (≤ 2.5 km) of ${c.soldiers[0]} + ${c.soldiers[1]} in the scene, ${c.seenSoldiers[0]} + ${c.seenSoldiers[1]} in this view, ${c.seenVehicles[0] + c.seenVehicles[1]} vehicles`, c.around[0] + c.around[1] >= 0.25 * (c.soldiers[0] + c.soldiers[1]) && c.around[0] > 0 && c.around[1] > 0);
    await page.evaluate(() => {
      const I = window.__cmd, b = I.forces.battle.info(), P = I.world.player, at = b.hot ?? b.near;
      if (at && P) { I.controller.aimAt(at.clone().setY(at.y + 2)); I.controller.snapTurret?.(); }
    });
    await sleep(3000);
    c = await census(page);
    await snap(page, 'plain-3-toward-line');
    row('P2', 'on the plain: the enemy line in sight looking toward it', `${c.seenSoldiers[0]} ours + ${c.seenSoldiers[1]} enemy in this view, ${c.seenVehicles[0] + c.seenVehicles[1]} vehicles`, c.seenSoldiers[1] >= 10);
    // The gunner's sight (what the right button shows) on the line.
    await page.evaluate(() => window.__cmd.controller.setZoom?.(true));
    await sleep(2500);
    await snap(page, 'plain-4-sight');
    await page.evaluate(() => window.__cmd.controller.setZoom?.(false));
    await sleep(1000);
  }
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
        // Seen from close, a man is awake (full AI, the figure a player meets there), however far from the tank.
        I.world.setDormant(best, false);
        I.freeze = true;
        // Of 12 directions around him (his front first), the first from which a man's eye (1.7 m up, d metres off)
        // sees him over the ground; else the least raised one (pass 2: raising the eye over a crest at 20 m could put
        // the camera hundreds of metres up, and the "close-up" was a far view).
        const target = best.pos.clone().setY(best.pos.y + 0.9);
        let pos = null, lowest = Infinity;
        for (let i = 0; i < 12 && !pos; i++) {
          const yaw = best.yaw + 0.6 + (i % 2 ? -1 : 1) * Math.ceil(i / 2) * (Math.PI / 6);
          const c = best.pos.clone();
          c.x += -Math.sin(yaw) * d; c.z += -Math.cos(yaw) * d;
          c.y = I.ground.heightAt(c.x, c.z) + 1.7 + d * 0.02;
          let raise = 0;
          for (let k = 1; k < 20; k++) {
            const f = k / 20, x = c.x + (target.x - c.x) * f, z = c.z + (target.z - c.z) * f;
            const over = I.ground.heightAt(x, z) + 0.3 - (c.y + (target.y - c.y) * f);
            if (over > 0) raise = Math.max(raise, over / (1 - f));
          }
          if (raise === 0) pos = c;
          else if (raise < lowest) { lowest = raise; pos = null; best.__alt = c.setY(c.y + raise); }
        }
        pos ??= best.__alt ?? best.pos.clone().setY(best.pos.y + 1.7 + d);
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

/**
 * Gauntlet (command, round 1): the same take-control, but with the clock RUNNING at 1x (the speed button) when
 * «Tomar el control aquí» is clicked (the passes above clicked while paused). The world must wait from the click, the
 * march must reach contact (no «Pulsa G»), the first view must look along the bearing to the fight, and the tank must
 * drive itself to the hottest stretch. Also opens the tactical map (M) there.
 */
async function entry1x() {
  const page = await open('f3-missions', '&run=10&panel=0');
  const off = await page.evaluate(() => {
    const a = __front.ctx.sim.view.attacks.find((x) => x.attacker === 1 && x.defender > 0 && !x.naval && x.contactX >= 0);
    return a ? { key: a.frontKey, id: a.id, troops: Math.round(a.troops) } : null;
  });
  if (!off) { row('E0', 'our offensive of the staged war', 'none', false); return; }
  await page.evaluate((k) => __front.ctx.bus.emit('frontSelected', { key: k, fly: false }), off.key);
  await until(page, (k) => !!document.querySelector(`.fu-war-front[data-key="${k}"] .fu-war-take`), off.key, 30000);
  await page.locator('.fu-time-seg button').nth(2).click({ force: true });
  const sp = await until(page, () => (window.__front.ctx.sim.view.speed === 1 ? true : null), null, 10000);
  await sleep(3000);
  const tick0 = await page.evaluate(() => window.__front.ctx.sim.view.tick);
  row('E0', 'clock at 1x before the click (the speed button)', `speed ${await page.evaluate(() => window.__front.ctx.sim.view.speed)}, tick ${tick0}`, !!sp);
  const t0 = Date.now();
  await page.locator(`.fu-war-front[data-key="${off.key}"] .fu-war-take`).first().click();
  // The click holds the world: a few real seconds later the sim has not run hours ahead.
  await sleep(4000);
  const tick1 = await page.evaluate(() => window.__front.ctx.sim.view.tick);
  row('E1', 'the world waits from the click (no game hours pass before the march)', `ticks after 4 real s: ${tick1 - tick0} (1x would be ~40)`, tick1 - tick0 <= 6);
  await small(page, true);
  const play = await until(page, () => (window.__cmdStats?.phase === 'play' ? window.__cmdStats : null), null, 900000, 1000);
  const tPlay = Math.round((Date.now() - t0) / 1000);
  const st = await page.evaluate(() => ({ tr: window.__cmdStats.transits, hostile: window.__cmdStats.nearestHostileM, battle: window.__cmdStats.battle, notice: window.__cmdStats.notice }));
  const tr = st.tr?.[0];
  row('E2', 'the march reaches the fight (contact, a battle standing), never «Pulsa G»', `${tPlay} real s to play; march ${tr ? `${tr.km.toFixed(1)} km, ${tr.legs} legs, stop «${tr.stop}${tr.short ? '/' + tr.short : ''}», ${(tr.realMs / 1000).toFixed(1)} real s` : 'none'}; nearest hostile ${st.hostile} m; battle ${st.battle?.active ? `active, line ${st.battle.lineM} m` : 'not active'}; notice «${st.notice}»`, !!play && st.hostile !== null && st.hostile < 4000 && !!st.battle?.active && !/Pulsa G/.test(st.notice ?? ''));
  // The first view looks along the bearing to the fight, over the ground (not into a slope).
  await small(page, false);
  const view = await page.evaluate(() => {
    const I = window.__cmd, cam = I.camera;
    const f = new cam.position.constructor();
    cam.getWorldDirection(f);
    let hit = -1;
    for (let s = 5; s < 3000; s += 5) {
      const x = cam.position.x + f.x * s, y = cam.position.y + f.y * s, z = cam.position.z + f.z * s;
      if (I.ground.heightAt(x, z) > y) { hit = s; break; }
    }
    const hot = window.__cmdStats.battle?.hot ?? null;
    const P = I.world.player.pos;
    const b = hot ? Math.atan2(hot.x - P.x, hot.z - P.z) : null;
    const camB = Math.atan2(f.x, f.z);
    let dB = b === null ? null : Math.abs(((camB - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    return { hit, dBdeg: dB === null ? null : Math.round((dB * 180) / Math.PI), pitch: Math.round(Math.asin(f.y) * 573) / 10 };
  });
  await snap(page, 'entry1x-1-first-view');
  row('E3', 'the first view looks toward the fight, over the ground', `view ray meets the ground at ${view.hit < 0 ? 'none (horizon)' : view.hit + ' m'}; ${view.dBdeg === null ? 'no hot point' : `${view.dBdeg}° off the bearing to the hottest point`}; pitch ${view.pitch}°`, (view.hit < 0 || view.hit > 150) && (view.dBdeg === null || view.dBdeg < 50));
  // The tactical map there.
  await page.keyboard.press('KeyM');
  await sleep(3000);
  const map = await page.evaluate(() => ({ open: document.querySelector('.fu-cmdx-map.show') !== null }));
  await snap(page, 'entry1x-2-tacmap');
  await page.keyboard.press('KeyM');
  row('E4', 'the tactical map opens at the front', JSON.stringify(map), map.open);
  // The tank drives itself to the hottest stretch.
  await small(page, true);
  const drove = await until(page, () => (window.__cmdStats?.battle && (window.__cmdStats.battle.lastDrive || (!window.__cmdStats.battle.driving && window.__cmdStats.battle.lineM < 450)) ? window.__cmdStats.battle : null), null, 1_200_000, 2000);
  await small(page, false);
  row('S7b', 'clicked at 1x: the tank drives on to the hottest stretch by itself', drove ? `drive «${drove.lastDrive}», line ${drove.lineM} m, hot point ${drove.hotM} m (${Math.round((Date.now() - t0) / 1000)} real s after the click)` : 'no drive', !!drove && drove.lineM >= 0 && drove.lineM < 450);
  await snap(page, 'entry1x-3-arrived');
  await page.close();
}

const sections = { scale, close, mg: mgFactory, combat, entry1x };
for (const [k, fn] of Object.entries(sections)) {
  if (only && !only.has(k) && !(k === 'combat' && (only.has('kill') || only.has('ram') || only.has('plain')))) continue;
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
