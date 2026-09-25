// FRONT ULTRA — command mode shots (owner: command).
// Each shot starts the deterministic scripted session, spawns the human's unit at a chosen front, dives into command
// mode, then stages a mid-action moment: the battle is advanced with fixed steps (no input) while the player's
// vehicle is aimed and fired by an autopilot, so the capture shows enemies, explosions, tracers and the full HUD.
// Time is then frozen so the image is reproducible.

import * as THREE from 'three';
import { HUMAN_ID } from '../shared/constants';
import { latLonToTile, worldTimeForSubsolarLon } from '../shared/geo';
import { registerShot, type ShotContext } from '../shared/shots';
import { UnitType } from '../shared/types';
import { commandInternals, type CommandInternals } from './index';
import type { Ent, EntKind } from './world';

async function takeControl(s: ShotContext, unit: UnitType, lat: number, lon: number, localHour: number, bearingDeg = -1): Promise<void> {
  const { ctx } = s;
  const I0 = commandInternals();
  if (I0 && bearingDeg >= 0) I0.pin = { seed: 0x5eed + Math.round(lat * 100) + Math.round(lon * 1000), bearingDeg };
  const h = Number(s.params.get('hour'));
  if (Number.isFinite(h) && s.params.has('hour')) localHour = h;
  // Sun: local solar time `localHour` at this longitude.
  const subsolar = lon - (localHour - 12) * 15;
  await ctx.app.startScriptedGame({ ticks: 1200, speed: 1, worldTimeSec: worldTimeForSubsolarLon(subsolar) });
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
  await takeControl(s, UnitType.ArmoredDivision, 42.75, -1.65, 16.6, 72);
  if (live(s)) return;
  const I = internalsOrThrow();
  const M = I.mission!;
  const c = I.controller!;
  const p = c.ent;
  I.skipIntro();
  I.world.godMode = true;
  const dt = 1 / 30;
  const at = (along: number, side: number) => {
    const v = M.at(along, side, new THREE.Vector3());
    v.y = I.world.ground.heightAt(v.x, v.z);
    return v;
  };
  const put = (e: Ent | null, along: number, side: number, faceEnemy: boolean) => {
    if (!e) return;
    const v = at(along, side);
    e.pos.copy(v);
    e.moveT.copy(v);
    e.yaw = M.yawTo(!faceEnemy) + (faceEnemy ? 0 : 0.2);
  };
  // Stage the engagement: an enemy armored push at 250-450 m, our line firing back.
  const enemies = I.world.ents.filter((e) => e.alive && e.team === 1 && e.kind === 'tank');
  const ifvs = I.world.ents.filter((e) => e.alive && e.team === 1 && e.kind === 'ifv');
  put(enemies[0] ?? null, 235, 26, false);
  put(enemies[1] ?? null, 360, -70, false);
  put(enemies[2] ?? null, 430, 120, false);
  put(ifvs[0] ?? null, 330, 60, false);
  const inf = I.world.ents.filter((e) => e.alive && e.team === 1 && (e.kind === 'soldier' || e.kind === 'at'));
  inf.slice(0, 10).forEach((e, i) => put(e, 250 + (i % 5) * 9, -30 + i * 7, false));
  I.simulate(75, dt);
  const target = enemies[1] ?? enemies[0];
  if (target) c.aimAt(target.pos.clone().setY(target.pos.y + 1.6));
  (c as unknown as { snapTurret?: () => void }).snapTurret?.();
  I.simulate(30, dt);
  // Artillery walking in, then our first kill.
  M.shellAt(at(95, -55).x, at(95, -55).z);
  I.simulate(20, dt);
  if (enemies[0]?.alive) I.world.kill(enemies[0], p, true);
  // The enemy returns fire.
  for (const [e, cd] of [[enemies[1], 0.05], [enemies[2], 0.28], [ifvs[0], 0.0]] as const) {
    if (!e || !e.alive) continue;
    e.target = p;
    e.fireCd = cd;
    e.state = 1;
  }
  I.simulate(13, dt);
  c.fire();
  I.simulate(4, dt);
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
  place(foes[1], 560, -120, 55, 0.4);
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
  if (foes[1]) W.kill(foes[1], p, true);
  if (foes[2]) W.releaseFlares(foes[2]);
  I.simulate(12, dt, (i) => {
    c.aimAt(lead());
    if (i % 1 === 0) c.fire();
  });
  I.simulate(16, dt, () => {
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
  put(ships[0], at(900, -60), coastYaw + Math.PI / 2 + 0.3);
  put(ships[1], at(Math.min(best - 1500, 3200), 1400), coastYaw - Math.PI / 2);
  put(boats[0], at(480, -380), coastYaw + 2.4);
  put(boats[1], at(700, 520), coastYaw - 2.2);
  const esc = W.ents.find((e) => e.alive && e.team === 0 && e.kind === 'ship' && !e.player);
  put(esc, p.pos.clone().addScaledVector(side, -500).addScaledVector(toCoast, -200), p.yaw + 0.05);
  const target = ships[0];
  const aim = () => target && c.aimAt(target.pos.clone().setY(6));
  aim();
  (c as unknown as { snapTurret?: () => void }).snapTurret?.();
  I.simulate(40, dt, aim);
  // First salvo lands around the frigate; a hit sets her burning.
  c.fire();
  I.simulate(24, dt, aim);
  if (target) {
    target.hp = target.maxHp * 0.3;
    W.damage(target, 1, p, true, null);
    W.fx.explosion(target.pos.clone().setY(8), 2.2, 'vehicle');
  }
  I.simulate(40, dt, aim);
  if (boats[0]?.alive) W.kill(boats[0], p, true);
  for (const b of boats) b.fireCd = 0;
  if (ships[1]) ships[1].fireCd = 0;
  I.simulate(16, dt, aim);
  // Sea-skimmer inbound from the coast side: the CIWS opens up.
  const mFrom = at(1350, 300).setY(8);
  W.fireMissile(ships[1] ?? null, 1, mFrom, p.pos.clone().sub(mFrom).normalize(), p, { speed: 270, turn: 0.6, dmg: 40, splash: 10, heat: false, life: 60, seaSkim: true, player: false, scale: 1.5 });
  I.simulate(14, dt, aim);
  c.fire();
  I.simulate(6, dt, aim);
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
