// FRONT ULTRA — command mode shots (owner: command).
// Each shot starts the deterministic scripted session, spawns the human's unit at a chosen front, dives into command
// mode, then stages a mid-action moment: the battle is advanced with fixed steps (no input) while the player's
// vehicle is aimed and fired by an autopilot, so the capture shows enemies, explosions, tracers and the full HUD.
// Time is then frozen so the image is reproducible.

import * as THREE from 'three';
import { HUMAN_ID } from '../shared/constants';
import { latLonToTile, sunDirection, tangentFrame, worldTimeForSubsolarLon } from '../shared/geo';
import { registerShot, type ShotContext } from '../shared/shots';
import { UnitType } from '../shared/types';
import { getLocalHeightfield } from '../data';
import { commandInternals, type CommandInternals } from './index';
import type { Ent, EntKind } from './world';

/**
 * Compass bearing (deg) from (lat, lon) with the most open view of the ground between `from` and `to` meters, seen
 * from a tank's chase camera: staging picks it so the enemy line is not hidden behind a crest.
 */
function openBearing(lat: number, lon: number, from: number, to: number, prefer: number): number {
  const hf = getLocalHeightfield(lat, lon, 4.2, 161, { seed: 0 });
  const size = hf.sizeKm * 1000, r1 = hf.resolution - 1;
  const h = (x: number, n: number): number => {
    const j = Math.max(0, Math.min(r1, Math.round((x / size + 0.5) * r1)));
    const i = Math.max(0, Math.min(r1, Math.round((0.5 - n / size) * r1)));
    const v = hf.heights[i * hf.resolution + j];
    return v < 0 ? -1e3 : v;
  };
  const eye = h(0, 0) + 6;
  let best = prefer, bestScore = -Infinity;
  for (let b = 0; b < 360; b += 6) {
    const sx = Math.sin((b * Math.PI) / 180), sn = Math.cos((b * Math.PI) / 180);
    let vis = 0, n = 0;
    for (let d = from; d <= to; d += 20) {
      const th = h(sx * d, sn * d);
      if (th < -100) continue;
      n++;
      const slope = (th + 1.5 - eye) / d;
      let ok = true;
      for (let k = 12; k < d; k += 12) if (h(sx * k, sn * k) > eye + slope * k) {
        ok = false;
        break;
      }
      if (ok) vis++;
    }
    const diff = Math.abs(((b - prefer + 540) % 360) - 180);
    // Northern hemisphere: a northward view keeps the sun behind the camera.
    const score = n ? vis / n - diff / 3600 + 0.12 * Math.cos((b * Math.PI) / 180) * Math.sign(lat) : -1;
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return best;
}

/**
 * Local solar hour (7..17.5) that puts a low sun behind the camera looking along compass `bearingDeg` (best
 * back-light for the hero vehicle and the enemy line), using the game's real sun model at (lat, lon).
 */
function sunBehind(lat: number, lon: number, bearingDeg: number): number {
  return sunSetup(lat, lon, bearingDeg).hour;
}

/** Best hour for a view along `bearingDeg`, and whether the sun is then on the right of that view. */
function sunSetup(lat: number, lon: number, bearingDeg: number): { hour: number; sunRight: boolean } {
  const e = new THREE.Vector3(), n = new THREE.Vector3(), u = new THREE.Vector3(), sd = new THREE.Vector3();
  tangentFrame(lat, lon, e, n, u);
  const vx = Math.sin((bearingDeg * Math.PI) / 180), vn = Math.cos((bearingDeg * Math.PI) / 180);
  let best = 15, bestScore = -Infinity, right = true;
  for (let h = 7; h <= 17.5; h += 0.25) {
    sunDirection(worldTimeForSubsolarLon(lon - (h - 12) * 15), sd);
    const se = sd.dot(e), sn = sd.dot(n), su = sd.dot(u);
    const elev = (Math.asin(Math.max(-1, Math.min(1, su))) * 180) / Math.PI;
    if (elev < 12) continue;
    const hl = Math.hypot(se, sn) || 1;
    const behind = -(se * vx + sn * vn) / hl; // 1 = straight behind the camera
    const score = behind * 1.6 - Math.abs(elev - 28) / 40;
    if (score > bestScore) {
      bestScore = score;
      best = h;
      right = se * Math.cos((bearingDeg * Math.PI) / 180) - sn * Math.sin((bearingDeg * Math.PI) / 180) > 0;
    }
  }
  return { hour: best, sunRight: right };
}

async function takeControl(s: ShotContext, unit: UnitType, lat: number, lon: number, localHour: number, bearingDeg = -1): Promise<void> {
  const { ctx } = s;
  const I0 = commandInternals();
  if (I0 && bearingDeg >= 0) I0.pin = { seed: 0x5eed + Math.round(lat * 100) + Math.round(lon * 1000), bearingDeg };
  const h = Number(s.params.get('hour'));
  if (Number.isFinite(h) && s.params.has('hour')) localHour = h;
  // Sun: local solar time `localHour` at this longitude.
  const subsolar = lon - (localHour - 12) * 15;
  // Paused: the unit must not be moved by the autopilot before we take control (deterministic framing).
  await ctx.app.startScriptedGame({ ticks: 1200, speed: 0, worldTimeSec: worldTimeForSubsolarLon(subsolar) });
  ctx.sim.debug({ type: 'spawnUnit', unit, owner: HUMAN_ID, tile: latLonToTile(lat, lon), targetTile: -1 });
  let id = -1;
  for (let i = 0; i < 600 && id < 0; i++) {
    await s.waitFrames(1);
    for (const u of ctx.sim.view.units.values()) if (u.owner === HUMAN_ID && u.type === unit) id = u.id;
  }
  if (id < 0) throw new Error('unit did not appear');
  await ctx.app.enterCommandMode(id);
  ctx.sim.setSpeed(0);
}

function nearest(I: CommandInternals, from: THREE.Vector3, team: 0 | 1, kinds: EntKind[], minD = 0): Ent | null {
  let best: Ent | null = null, bd = Infinity;
  for (const e of I.world.ents) {
    if (!e.alive || e.team !== team || e.player || !kinds.includes(e.kind)) continue;
    const d = e.pos.distanceTo(from);
    if (d < bd && d >= minD) {
      bd = d;
      best = e;
    }
  }
  return best;
}

/** `&live=1`: enter command mode normally (intro, input, no staging) for interactive tests. */
function live(s: ShotContext): boolean {
  return s.params.get('live') === '1';
}

function internalsOrThrow(): CommandInternals {
  const I = commandInternals();
  if (!I || !I.controller) throw new Error('command mode not active');
  return I;
}

registerShot('command-tank', 'command', 'Third-person tank battle at the front (Navarre)', async (s) => {
  const lat = Number(s.params.get('lat') ?? 42.75), lon = Number(s.params.get('lon') ?? -1.65);
  const bearing = Number(s.params.get('bearing') ?? openBearing(lat, lon, 110, 350, 20));
  const sun = sunSetup(lat, lon, bearing);
  await takeControl(s, UnitType.ArmoredDivision, lat, lon, sun.hour, bearing);
  if (live(s)) return;
  const I = internalsOrThrow();
  const M = I.mission!;
  const c = I.controller!;
  const p = c.ent;
  I.skipIntro();
  I.world.godMode = true;
  const dt = 1 / 30;
  // Stage frame: a vantage point (O) and a facing (F) near the front, chosen on the real ground for the most
  // open view of 60..240 m, so the fight is not hidden behind a fold of the terrain.
  const G = I.world.ground;
  const O = new THREE.Vector3(), F = new THREE.Vector3(), R = new THREE.Vector3();
  {
    const base = M.yawTo(true) + Math.PI; // yaw toward the enemy (mission convention)
    let bestScore = -Infinity;
    const eyeP = new THREE.Vector3(), tgt = new THREE.Vector3();
    for (let ox = -240; ox <= 240; ox += 40) {
      for (let oz = -240; oz <= 240; oz += 40) {
        const h0 = G.heightAt(ox, oz);
        if (h0 < 2) continue;
        for (let dy = -1.2; dy <= 1.21; dy += 0.2) {
          const yaw = base + dy;
          const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
          eyeP.set(ox - fx * 12, 0, oz - fz * 12);
          eyeP.y = Math.max(G.heightAt(eyeP.x, eyeP.z), h0) + 4.2;
          let vis = 0, n = 0;
          for (let d = 60; d <= 240; d += 20) {
            for (const sd of [-50, 0, 50]) {
              const x = ox + fx * d - fz * sd, z = oz + fz * d + fx * sd;
              const th = G.heightAt(x, z);
              if (th < 1) continue;
              n++;
              if (I.world.los(eyeP, tgt.set(x, th + 0.8, z))) vis++;
            }
          }
          const score = n > 20 ? vis / n - Math.abs(dy) * 0.04 - Math.hypot(ox, oz) / 6000 : -1;
          if (score > bestScore) {
            bestScore = score;
            O.set(ox, h0, oz);
            F.set(fx, 0, fz);
          }
        }
      }
    }
    if (bestScore === -Infinity) {
      M.at(1, 0, F).normalize();
      O.set(0, G.heightAt(0, 0), 0);
    }
    R.set(-F.z, 0, F.x);
  }
  const fYaw = Math.atan2(-F.x, -F.z);
  const at = (along: number, side: number) => {
    const v = new THREE.Vector3(O.x + F.x * along + R.x * side, 0, O.z + F.z * along + R.z * side);
    v.y = G.heightAt(v.x, v.z);
    return v;
  };
  p.pos.copy(at(0, 0));
  // The chase camera's eye (approx.): enemies are nudged until their hull is in plain view from it.
  const eye = at(-12, 0);
  eye.y = Math.max(eye.y, p.pos.y) + 3.6;
  const hullPt = new THREE.Vector3();
  const put = (e: Ent | null | undefined, along: number, side: number, yawOff: number) => {
    if (!e) return;
    let v = at(along, side);
    const vehicle = !!e.rig;
    if (vehicle) {
      search: for (let r = 0; r <= 60; r += 6) {
        for (const [da, ds] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
          const c = at(along + da, side + ds);
          hullPt.copy(c).setY(c.y + 0.5);
          if (I.world.los(eye, hullPt) && !I.scatter.treeBlocks(eye.x, eye.z, c.x, c.z, 2)) {
            v = c;
            break search;
          }
        }
      }
    }
    e.pos.copy(v);
    e.moveT.copy(v);
    e.yaw = fYaw + Math.PI + yawOff;
  };
  // The hull angled across the line of fire so the chase camera sees it three-quarter.
  p.yaw = fYaw + (s.params.has('hullYaw') ? Number(s.params.get('hullYaw')) : sun.sunRight ? -0.5 : 0.5);
  // Stage the engagement: an enemy armored push at 120-300 m, our line firing back.
  const tanks = I.world.ents.filter((e) => e.alive && e.team === 1 && e.kind === 'tank');
  const ifvs = I.world.ents.filter((e) => e.alive && e.team === 1 && e.kind === 'ifv');
  const placeArmor = () => {
    put(tanks[0], 88, -46, 0.5);
    put(tanks[1], 74, 9, -0.35);
    put(tanks[2], 190, 70, 0.15);
    put(tanks[3], 260, -120, 0.1);
    put(ifvs[0], 165, -80, 0.6);
  };
  placeArmor();
  const inf = I.world.ents.filter((e) => e.alive && e.team === 1 && (e.kind === 'soldier' || e.kind === 'at'));
  inf.slice(0, 12).forEach((e, i) => put(e, 135 + (i % 4) * 7, -40 + i * 7, 0));
  const mates = I.world.ents.filter((e) => e.alive && e.team === 0 && e.kind === 'tank' && !e.player);
  if (mates[0]) {
    const v = at(6, -24);
    mates[0].pos.copy(v);
    mates[0].moveT.copy(v);
    mates[0].yaw = fYaw + 0.12;
  }
  const friendsInf = I.world.ents.filter((e) => e.alive && e.team === 0 && e.kind === 'soldier');
  friendsInf.slice(0, 6).forEach((e, i) => {
    const v = at(24 + (i % 3) * 3, 14 + i * 3.5);
    e.pos.copy(v);
    e.moveT.copy(v);
    e.yaw = fYaw;
  });
  I.simulate(60, dt);
  const target = tanks[1] ?? tanks[0];
  const aim = () => target && c.aimAt(target.pos.clone().setY(target.pos.y + 1.4));
  aim();
  (c as unknown as { snapTurret?: () => void }).snapTurret?.();
  I.simulate(20, dt, aim);
  // The AI has advanced them meanwhile: put the armor back in plain view for the final second.
  placeArmor();
  aim();
  (c as unknown as { snapTurret?: () => void }).snapTurret?.();
  // Artillery walking in on the enemy line; a friendly strike kills the closest enemy tank.
  M.shellAt(at(160, 60).x, at(160, 60).z);
  M.shellAt(at(210, -150).x, at(210, -150).z);
  I.simulate(26, dt, aim);
  if (tanks[0]?.alive) I.world.kill(tanks[0], mates[0] ?? p, !mates[0]);
  // The enemy returns fire.
  for (const [e, cd] of [[tanks[1], 0.05], [tanks[2], 0.3], [ifvs[0], 0.0]] as const) {
    if (!e || !e.alive) continue;
    e.target = p;
    e.fireCd = cd;
    e.state = 1;
  }
  if (mates[0]) {
    mates[0].target = tanks[2] ?? null;
    mates[0].fireCd = 0.2;
  }
  I.simulate(12, dt, aim);
  c.fire();
  I.simulate(2, dt, aim);
  if (s.params.get('zoom') === '1') {
    (c as unknown as { setZoom(on: boolean): void }).setZoom(true);
    I.simulate(8, dt);
  }
  I.freeze = true;
  await s.waitFrames(4);
});

registerShot('command-jet', 'command', 'Fighter jet dogfight over the Pyrenees', async (s) => {
  await takeControl(s, UnitType.FighterSquadron, 42.75, 0.75, 17.0, 62);
  if (live(s)) return;
  const I = internalsOrThrow();
  const c = I.controller! as unknown as { ent: Ent; aimAt(p: THREE.Vector3): void; fire(): void; snap(): void; updateCamera(dt: number): void };
  const W = I.world;
  const p = c.ent;
  I.skipIntro();
  W.godMode = true;
  const dt = 1 / 30;
  I.simulate(20, dt);
  // Frame: in a turning fight 400 m behind an enemy fighter, a second one blown apart ahead, a third dumping flares.
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(p.quat);
  fwd.y = 0;
  fwd.normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const foes = W.ents.filter((e) => e.alive && e.team === 1 && e.kind === 'jet');
  const place = (e: Ent | undefined, ahead: number, side: number, up: number, yawOff: number) => {
    if (!e) return;
    e.pos.copy(p.pos).addScaledVector(fwd, ahead).addScaledVector(right, side);
    e.pos.y += up;
    e.yaw = p.yaw + yawOff;
    e.quat.setFromEuler(new THREE.Euler(0, e.yaw, -0.5 * Math.sign(yawOff || 1), 'YXZ'));
    e.speed = 235;
    e.vel.set(0, 0, -1).applyQuaternion(e.quat).multiplyScalar(e.speed);
    e.state = 2;
    e.stateT = 5;
  };
  place(foes[0], 290, 14, 34, -0.2);
  place(foes[1], 420, -95, 45, 0.4);
  place(foes[2], 1300, 240, 140, -0.6);
  const mates = W.ents.filter((e) => e.alive && e.team === 0 && e.kind === 'jet' && !e.player);
  if (mates[0]) {
    mates[0].pos.copy(p.pos).addScaledVector(fwd, 30).addScaledVector(right, -70);
    mates[0].pos.y -= 12;
    mates[0].quat.copy(p.quat);
    mates[0].vel.copy(p.vel);
  }
  const target = foes[0];
  const lead = () => (target ? target.pos.clone().addScaledVector(target.vel, 0.35) : p.pos.clone().addScaledVector(fwd, 500));
  c.aimAt(lead());
  c.snap();
  I.simulate(6, dt, () => c.aimAt(lead()));
  // Missile away at the far fighter, which answers with flares.
  if (foes[2]) {
    const from = p.pos.clone().addScaledVector(right, 3);
    from.y -= 1.5;
    W.fireMissile(p, 0, from, new THREE.Vector3(0, 0, -1).applyQuaternion(p.quat), foes[2], { speed: 720, turn: 2.4, dmg: 90, splash: 12, heat: true, life: 12, player: true });
  }
  I.simulate(10, dt, () => c.aimAt(lead()));
  if (foes[2]) W.releaseFlares(foes[2]);
  I.simulate(12, dt, () => {
    c.aimAt(lead());
    c.fire();
  });
  // The wingman's missile finds the second fighter: the fireball is at its peak at the capture.
  if (foes[1]) W.kill(foes[1], p, true);
  I.simulate(12, dt, () => {
    c.aimAt(lead());
    c.fire();
  });
  I.freeze = true;
  await s.waitFrames(4);
});

registerShot('command-ship', 'command', 'Destroyer duel in the Strait of Gibraltar', async (s) => {
  await takeControl(s, UnitType.Warship, 35.97, -5.62, 17.3, 150);
  if (live(s)) return;
  const I = internalsOrThrow();
  const c = I.controller!;
  const W = I.world;
  const p = c.ent;
  I.skipIntro();
  W.godMode = true;
  const dt = 1 / 30;
  // Nearest shore: the fight is staged between us and the coast so the cliffs frame it.
  let coastYaw = p.yaw, best = Infinity;
  for (let a = 0; a < 72; a++) {
    const yaw = (a / 72) * Math.PI * 2;
    const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
    for (let r = 2500; r < 16000; r += 250) {
      if (W.ground.heightAt(p.pos.x + dx * r, p.pos.z + dz * r) > 8) {
        if (r < best) {
          best = r;
          coastYaw = yaw;
        }
        break;
      }
    }
  }
  p.yaw = coastYaw + 0.85;
  p.quat.setFromEuler(new THREE.Euler(0, p.yaw, 0, 'YXZ'));
  const toCoast = new THREE.Vector3(-Math.sin(coastYaw), 0, -Math.cos(coastYaw));
  // Close to ~3.8 km off the shore (staying in deep water).
  for (let k = 0; k < 40 && best > 3800; k++) {
    const nx = p.pos.x + toCoast.x * 100, nz = p.pos.z + toCoast.z * 100;
    if (W.ground.heightAt(nx, nz) > -12) break;
    p.pos.x = nx;
    p.pos.z = nz;
    best -= 100;
  }
  I.simulate(10, dt);
  const side = new THREE.Vector3(-toCoast.z, 0, toCoast.x);
  const at = (d: number, lateral: number) => p.pos.clone().addScaledVector(toCoast, d).addScaledVector(side, lateral).setY(0);
  const ships = W.ents.filter((e) => e.alive && e.team === 1 && e.kind === 'ship');
  const boats = W.ents.filter((e) => e.alive && e.team === 1 && e.kind === 'boat');
  while (ships.length < 2) ships.push(W.spawn('ship', 1, 0, 0, 0));
  while (boats.length < 2) boats.push(W.spawn('boat', 1, 0, 0, 0));
  const put = (e: Ent | undefined, pos: THREE.Vector3, yaw: number) => {
    if (!e) return;
    e.pos.copy(pos);
    e.yaw = yaw;
    e.quat.setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
  };
  // ships[0] burns on the left after our first hits; ships[1] (the locked target) is straddled in the center.
  put(ships[0], at(470, -330), coastYaw + Math.PI / 2 + 0.5);
  put(ships[1], at(Math.min(best - 1600, 1250), 60), coastYaw - Math.PI / 2 + 0.2);
  put(boats[0], at(360, 280), coastYaw + 2.4);
  put(boats[1], at(820, 520), coastYaw - 2.2);
  const esc = W.ents.find((e) => e.alive && e.team === 0 && e.kind === 'ship' && !e.player);
  put(esc, p.pos.clone().addScaledVector(side, -480).addScaledVector(toCoast, -160), p.yaw + 0.05);
  const burning = ships[0];
  const target = ships[1];
  const aim = () => {
    const t = target?.alive ? target : burning;
    if (t) c.aimAt(t.pos.clone().setY(6));
  };
  aim();
  (c as unknown as { snapTurret?: () => void }).snapTurret?.();
  I.simulate(20, dt, aim);
  // Earlier hits have set the near frigate burning (early, so the fire and smoke build up).
  if (burning) {
    burning.hp = burning.maxHp * 0.2;
    W.damage(burning, 1, p, true, null);
    W.fx.explosion(burning.pos.clone().setY(8), 2.8, 'vehicle');
  }
  c.fire();
  I.simulate(40, dt, aim);
  if (boats[0]?.alive) W.kill(boats[0], p, true);
  for (const b of boats) b.fireCd = 0;
  if (ships[1]) ships[1].fireCd = 0;
  I.simulate(60, dt, aim);
  // A salvo straddles the target: short and long shells throw up tall columns just before the capture.
  if (target) {
    const gunPos = new THREE.Vector3(), gunDir = new THREE.Vector3();
    W.muzzleOf(p, gunPos, gunDir);
    // Wide of her 55 m hit sphere, so they splash instead of hitting.
    for (const [ahead, lateral] of [[-95, 15], [80, -30], [-70, -80]]) {
      const aimP = target.pos.clone().addScaledVector(toCoast, ahead).addScaledVector(side, lateral).setY(0);
      const d = aimP.clone().sub(gunPos);
      const horiz = Math.hypot(d.x, d.z);
      const pitch = Math.atan2(d.y, horiz) + 0.5 * Math.asin(Math.min(1, (9.81 * horiz) / (820 * 820)));
      const dir = new THREE.Vector3((d.x / horiz) * Math.cos(pitch), Math.sin(pitch), (d.z / horiz) * Math.cos(pitch));
      W.fireShell(p, 0, gunPos, dir, 820, 10, 5, false, false, 1.8);
    }
  }
  // A sea-skimmer comes in from the coast side and the CIWS opens up.
  const mFrom = at(1150, 280).setY(8);
  W.fireMissile(ships[1] ?? null, 1, mFrom, p.pos.clone().sub(mFrom).normalize(), p, { speed: 270, turn: 0.6, dmg: 40, splash: 10, heat: false, life: 60, seaSkim: true, player: false, scale: 1.5 });
  I.simulate(56, dt, aim);
  c.fire();
  I.simulate(2, dt, aim);
  I.freeze = true;
  await s.waitFrames(4);
});

registerShot('command-fx', 'command', 'Close-up: an enemy tank brewing up 70 m ahead (effects check)', async (s) => {
  await takeControl(s, UnitType.ArmoredDivision, 42.75, -1.65, 16.6, 110);
  if (live(s)) return;
  const I = internalsOrThrow();
  const M = I.mission!;
  const c = I.controller!;
  I.skipIntro();
  I.world.godMode = true;
  const dt = 1 / 30;
  const foe = I.world.ents.find((e) => e.alive && e.team === 1 && e.kind === 'tank');
  if (foe) {
    const v = M.at(70, 6, new THREE.Vector3());
    foe.pos.set(v.x, I.world.ground.heightAt(v.x, v.z), v.z);
    foe.moveT.copy(foe.pos);
    foe.yaw = M.yawTo(true) + 0.6;
    c.aimAt(foe.pos.clone().setY(foe.pos.y + 1));
  }
  const after = Number(s.params.get('after') ?? 12);
  I.simulate(20, dt);
  if (foe) I.world.kill(foe, c.ent, true);
  I.simulate(after, dt);
  I.freeze = true;
  await s.waitFrames(4);
});

registerShot('command-garage', 'command', 'Model check: every ground vehicle of both teams lined up in front of the player tank', async (s) => {
  await takeControl(s, UnitType.ArmoredDivision, 42.75, -1.65, Number(s.params.get('hour') ?? 15.5), 72);
  if (live(s)) return;
  const I = internalsOrThrow();
  const M = I.mission!;
  const c = I.controller!;
  I.skipIntro();
  I.world.godMode = true;
  // Clear the field: only the lineup remains.
  for (const e of I.world.ents) if (!e.player && e.alive) {
    e.alive = false;
    if (e.rig) e.rig.root.visible = false;
    e.pos.set(1e5, -1e3, 1e5);
  }
  const kinds = (s.params.get('kinds') ?? 'tank,ifv,aa,sam,truck').split(',') as EntKind[];
  const dist = Number(s.params.get('dist') ?? 26);
  const gap = Number(s.params.get('gap') ?? 11);
  const yawOff = Number(s.params.get('yaw') ?? 0.7);
  let i = 0;
  for (const team of [1, 0] as const) {
    for (const k of kinds) {
      const side = (i - (kinds.length * 2 - 1) / 2) * gap;
      const v = M.at(dist + (team === 0 ? 14 : 0), side, new THREE.Vector3());
      const e = I.world.spawn(k, team, v.x, v.z, M.yawTo(true) + yawOff);
      e.state = 0;
      e.fireCd = 1e9;
      e.fireCd2 = 1e9;
      e.moveT.copy(e.pos);
      i++;
    }
  }
  const ahead = M.at(dist + 7, 0, new THREE.Vector3());
  c.aimAt(ahead.setY(I.world.ground.heightAt(ahead.x, ahead.z) + 1));
  (c as unknown as { snapTurret?: () => void }).snapTurret?.();
  I.simulate(4, 1 / 30);
  I.freeze = true;
  await s.waitFrames(4);
});

registerShot('command-intro', 'command', 'Take control: the cinematic swoop into the tank with the operation title card', async (s) => {
  const lat = 42.75, lon = -1.65;
  const bearing = openBearing(lat, lon, 110, 350, 20);
  await takeControl(s, UnitType.ArmoredDivision, lat, lon, sunSetup(lat, lon, bearing).hour, bearing);
  const I = internalsOrThrow();
  I.hold = true;
  I.setPhaseTime(Number(s.params.get('t') ?? 1.9));
  I.simulate(30, 1 / 30);
  await s.waitFrames(6);
});

registerShot('command-debrief', 'command', 'After-action report on leaving command mode (tank)', async (s) => {
  const lat = 42.75, lon = -1.65;
  const bearing = openBearing(lat, lon, 110, 350, 20);
  await takeControl(s, UnitType.ArmoredDivision, lat, lon, sunSetup(lat, lon, bearing).hour, bearing);
  const I = internalsOrThrow();
  I.skipIntro();
  I.world.godMode = true;
  const p = I.controller!.ent;
  I.simulate(90, 1 / 30);
  // A good sortie: armor, an IFV, the AA vehicle and infantry fall to the player's gun.
  const kinds: EntKind[] = ['tank', 'tank', 'tank', 'ifv', 'aa', 'soldier', 'soldier', 'soldier', 'at', 'soldier', 'truck'];
  for (const k of kinds) {
    const e = I.world.ents.find((o) => o.alive && o.team === 1 && o.kind === k);
    if (e) {
      I.world.stats.shots += 2;
      I.world.stats.hits += 1;
      I.world.kill(e, p, true);
    }
  }
  I.simulate(60, 1 / 30);
  I.debrief();
  I.hold = true;
  I.setPhaseTime(Number(s.params.get('t') ?? 2.2));
  I.simulate(10, 1 / 30);
  await s.waitFrames(8);
});
