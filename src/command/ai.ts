// FRONT ULTRA — command mode: AI for every non-player unit (owner: command).
// Ground vehicles advance by bounds toward the enemy side, stop to fire, traverse turrets with limited rates and
// solve the ballistic arc (with difficulty-scaled aim error). Infantry walk in loose squads, shoot rifles in bursts,
// AT teams launch wire-guided missiles (defeated by smoke). AA guns and SAMs engage aircraft. Jets dogfight (lead
// pursuit, guns, IR missiles, overshoot / extend, break turns + flares when threatened) or fly strike runs. Warships
// and patrol boats circle and duel, coastal batteries shell ships.

import * as THREE from 'three';
import { angleDelta } from '../shared/math';
import type { Team } from './models/materials';
import { ballisticPitch, ENT_DEFS, forwardOf, type Ent, type World } from './world';

const T1 = new THREE.Vector3();
const T2 = new THREE.Vector3();
const T3 = new THREE.Vector3();
const T4 = new THREE.Vector3();
const N = new THREE.Vector3();
const M4 = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const JF = new THREE.Vector3();
const UPV = new THREE.Vector3(0, 1, 0);

export interface Front {
  /** Where each team pushes toward (team 0 pushes toward enemyBase and vice versa). */
  friendlyBase: THREE.Vector3;
  enemyBase: THREE.Vector3;
  /** Combat area radius around the origin (m). */
  radius: number;
  /** Strike runs (tank mode): the world asks the mission for targets. */
}

export class Brain {
  /** Player-attention weight: enemies prefer the player when distances are similar. */
  playerBias = 0.85;

  constructor(private readonly w: World, private readonly front: Front) {}

  update(dt: number): void {
    const w = this.w;
    for (const e of w.ents) {
      if (!e.alive || e.player) continue;
      this.shooterTeam = e.team;
      switch (e.kind) {
        case 'tank':
        case 'ifv':
        case 'truck':
          this.groundVehicle(e, dt);
          break;
        case 'aa':
          this.aa(e, dt);
          break;
        case 'sam':
          this.sam(e, dt);
          break;
        case 'soldier':
        case 'at':
          this.infantry(e, dt);
          break;
        case 'jet':
          this.jet(e, dt);
          break;
        case 'ship':
        case 'boat':
          this.ship(e, dt);
          break;
        case 'battery':
          this.battery(e, dt);
          break;
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Targeting
  // ---------------------------------------------------------------------------------------------
  pickTarget(e: Ent, range: number, filter: (t: Ent) => boolean, needLos: boolean): Ent | null {
    const w = this.w;
    let best: Ent | null = null;
    let bestScore = Infinity;
    w.center(e, T1);
    T1.y += 1;
    for (const t of w.ents) {
      if (!t.alive || t.team === e.team || !filter(t)) continue;
      const d = t.pos.distanceTo(e.pos);
      if (d > range) continue;
      let score = d * (t.player ? this.playerBias : 1) * (0.85 + 0.3 * ((t.id * 7919 + e.id * 104729) % 97) / 97);
      if (score >= bestScore) continue;
      if (needLos) {
        w.center(t, T2);
        if (!w.los(T1, T2)) continue;
      }
      best = t;
      bestScore = score;
    }
    return best;
  }

  private groundTargets = (t: Ent) => !ENT_DEFS[t.kind].air && !ENT_DEFS[t.kind].naval;
  private vehicleTargets = (t: Ent) => ENT_DEFS[t.kind].vehicle && !ENT_DEFS[t.kind].air && !ENT_DEFS[t.kind].naval;
  private airTargets = (t: Ent) => ENT_DEFS[t.kind].air;
  private navalTargets = (t: Ent) => ENT_DEFS[t.kind].naval;

  private shooterTeam: Team = 1;
  private aimError(dist: number): number {
    // Difficulty only sharpens the enemy; friendlies are steady veterans.
    const skill = this.shooterTeam === 1 ? this.w.enemySkill : 1.25;
    return ((0.006 + dist * 0.0000055) / skill) * (this.w.rng.next() - 0.5) * 2;
  }

  // ---------------------------------------------------------------------------------------------
  // Movement helpers (ground)
  // ---------------------------------------------------------------------------------------------
  private nextMoveTarget(e: Ent, stride: number): void {
    const f = this.front;
    const goal = e.team === 0 ? f.enemyBase : f.friendlyBase;
    T1.subVectors(goal, e.pos);
    T1.y = 0;
    const dist = T1.length();
    if (dist < 1) T1.set(0, 0, -1);
    T1.normalize();
    const r = this.w.rng;
    const s = Math.min(stride, dist * 0.6 + 20);
    e.moveT.set(
      e.pos.x + T1.x * s + (r.next() - 0.5) * stride * 0.9,
      0,
      e.pos.z + T1.z * s + (r.next() - 0.5) * stride * 0.9,
    );
    const lim = f.radius * 0.95;
    const l = Math.hypot(e.moveT.x, e.moveT.z);
    if (l > lim) e.moveT.multiplyScalar(lim / l);
  }

  private drive(e: Ent, dt: number, maxSpeed: number, turnRate: number, stop: boolean): void {
    const w = this.w;
    const dx = e.moveT.x - e.pos.x, dz = e.moveT.z - e.pos.z;
    const dist = Math.hypot(dx, dz);
    let want = 0;
    if (!stop && dist > 12) {
      const desired = Math.atan2(-dx, -dz);
      const err = angleDelta(e.yaw, desired);
      e.yaw += Math.max(-turnRate * dt, Math.min(turnRate * dt, err));
      want = maxSpeed * Math.max(0.15, 1 - Math.abs(err) / 1.4);
    } else if (!stop) {
      this.nextMoveTarget(e, 180);
    }
    // Look ahead for water / cliffs.
    forwardOf(e.yaw, T1);
    const ax = e.pos.x + T1.x * 14, az = e.pos.z + T1.z * 14;
    const h0 = w.ground.heightAt(e.pos.x, e.pos.z), h1 = w.ground.heightAt(ax, az);
    if (h1 < 0.6 || Math.abs(h1 - h0) > 9) {
      want = 0;
      e.yaw += turnRate * dt * 2 * (e.seed > 0.5 ? 1 : -1);
      if (e.stateT <= 0) {
        this.nextMoveTarget(e, 160);
        e.stateT = 2;
      }
    }
    const acc = want > e.speed ? 3 : 5;
    e.speed += Math.max(-acc * dt, Math.min(acc * dt, want - e.speed));
    // Separation between vehicles.
    for (const o of w.ents) {
      if (o === e || !o.rig || ENT_DEFS[o.kind].air || ENT_DEFS[o.kind].naval) continue;
      const ox = e.pos.x - o.pos.x, oz = e.pos.z - o.pos.z;
      const d2 = ox * ox + oz * oz;
      const r = e.radius + o.radius + 1.5;
      if (d2 < r * r && d2 > 1e-4) {
        const d = Math.sqrt(d2);
        const push = (r - d) * 0.5;
        e.pos.x += (ox / d) * push;
        e.pos.z += (oz / d) * push;
        if (!o.alive) e.speed *= 0.9;
      }
    }
    forwardOf(e.yaw, T1);
    e.vel.copy(T1).multiplyScalar(e.speed);
    e.pos.x += e.vel.x * dt;
    e.pos.z += e.vel.z * dt;
    this.settle(e, dt);
    if (e.speed > 2.5) w.fx.dust(e.pos.x - T1.x * 3.5, e.pos.y, e.pos.z - T1.z * 3.5, -e.vel.x, -e.vel.z, Math.min(0.8, e.speed * dt * 2.5));
  }

  /** Put a ground vehicle on the terrain with smoothed pitch / roll. */
  settle(e: Ent, dt: number): void {
    const g = this.w.ground;
    e.pos.y = g.heightAt(e.pos.x, e.pos.z);
    g.normalAt(e.pos.x, e.pos.z, N, 2.5);
    // Terrain normal to local pitch / roll
    const cy = Math.cos(e.yaw), sy = Math.sin(e.yaw);
    // local forward (-z) and right (+x) in world
    const fx = -sy, fz = -cy, rx = cy, rz = -sy;
    const pitch = Math.atan2(N.x * fx + N.z * fz, N.y); // positive when the ground ahead descends
    const roll = Math.atan2(N.x * rx + N.z * rz, N.y);
    const k = 1 - Math.exp(-8 * dt);
    e.tiltP += (-pitch - e.tiltP) * k;
    e.tiltR += (-roll - e.tiltR) * k;
    e.stateT -= dt;
  }

  private aimTurret(e: Ent, target: Ent, dt: number, speed: number, gravity: number, traverse: number, lead = 0.8): number {
    const w = this.w;
    w.center(target, T2);
    const dist0 = T2.distanceTo(e.pos);
    const tof = dist0 / speed;
    T2.addScaledVector(target.vel, tof * lead);
    const dx = T2.x - e.pos.x, dz = T2.z - e.pos.z;
    const worldYaw = Math.atan2(-dx, -dz);
    const want = angleDelta(e.yaw, worldYaw);
    const err = angleDelta(e.turretYaw, want);
    e.turretYaw += Math.max(-traverse * dt, Math.min(traverse * dt, err));
    const hd = Math.hypot(dx, dz);
    const muzzleY = e.pos.y + e.height * 0.8;
    const pitch = ballisticPitch(hd, T2.y - muzzleY, speed, gravity);
    const perr = pitch - e.tiltP * Math.cos(e.turretYaw) - e.gunPitch;
    e.gunPitch += Math.max(-0.5 * dt, Math.min(0.5 * dt, perr));
    return Math.abs(err) + Math.abs(perr) * 0.5;
  }

  // ---------------------------------------------------------------------------------------------
  // Ground vehicles
  // ---------------------------------------------------------------------------------------------
  private groundVehicle(e: Ent, dt: number): void {
    const w = this.w;
    const range = e.kind === 'tank' ? 1700 : e.kind === 'ifv' ? 1200 : 0;
    e.retarget -= dt;
    if (e.retarget <= 0 && range > 0) {
      e.retarget = 0.8 + w.rng.next() * 1.2;
      e.target = this.pickTarget(e, range, e.kind === 'ifv' ? this.groundTargets : this.vehicleTargets, true)
        ?? (e.kind === 'tank' ? this.pickTarget(e, 900, this.groundTargets, true) : null);
    }
    const t = e.target && e.target.alive ? e.target : null;
    // Stop to shoot most of the time when a target is in view.
    if (t && e.state === 0 && w.rng.next() < dt * 0.6) e.state = 1;
    if (e.state === 1 && (w.rng.next() < dt * 0.12 || !t)) e.state = 0;
    const vmax = e.kind === 'tank' ? 9 : e.kind === 'ifv' ? 10 : 11;
    this.drive(e, dt, vmax, 0.6, e.state === 1 && !!t);
    if (!t) {
      e.turretYaw += angleDelta(e.turretYaw, 0) * Math.min(1, dt * 0.8);
      e.gunPitch *= 1 - dt;
      return;
    }
    e.fireCd -= dt;
    if (e.kind === 'tank') {
      const err = this.aimTurret(e, t, dt, 620, 9.81, 0.55);
      if (e.fireCd <= 0 && err < 0.02) {
        e.fireCd = (8.5 + w.rng.next() * 4.5) / Math.sqrt(w.enemySkill);
        this.fireGun(e, t, 620, 30, 4, true, 1);
      }
    } else if (e.kind === 'ifv') {
      const err = this.aimTurret(e, t, dt, 950, 3, 0.9);
      if (e.fireCd <= 0 && err < 0.05) {
        if (e.burst <= 0) e.burst = 6;
        e.fireCd = 0.14;
        e.burst--;
        if (e.burst <= 0) e.fireCd = 2 + w.rng.next() * 2;
        w.muzzleOf(e, T3, T4);
        const d = T3.distanceTo(t.pos);
        this.jitter(T4, d);
        w.fireBullet(e, e.team, T3, T4, 950, 7, true, false, 0xffc070, 0.3);
        w.fx.gunFlash(T3, T4, 1.2);
        w.fx.playAt('gunfire', T3, 0.4);
      }
    }
  }

  private jitter(dir: THREE.Vector3, dist: number): void {
    const e1 = this.aimError(dist), e2 = this.aimError(dist);
    dir.x += e1;
    dir.y += e2 * 0.6;
    dir.z += this.aimError(dist);
    dir.normalize();
  }

  private fireGun(e: Ent, t: Ent, speed: number, dmg: number, splash: number, ap: boolean, scale: number): void {
    const w = this.w;
    w.muzzleOf(e, T3, T4);
    const d = T3.distanceTo(t.pos);
    this.jitter(T4, d);
    w.fireShell(e, e.team, T3, T4, speed, dmg, splash, ap, false, scale);
    w.fx.muzzle(T3, T4, scale, !ENT_DEFS[e.kind].naval);
    w.fx.playAt(ENT_DEFS[e.kind].naval || e.kind === 'battery' ? 'navalGun' : 'tankCannon', T3, 0.8);
    e.pitchV -= 0.25;
  }

  private aa(e: Ent, dt: number): void {
    const w = this.w;
    e.retarget -= dt;
    if (e.retarget <= 0) {
      e.retarget = 1 + w.rng.next();
      e.target = this.pickTarget(e, 2600, this.airTargets, false);
    }
    this.drive(e, dt, 6, 0.5, true);
    const t = e.target && e.target.alive ? e.target : null;
    if (!t) {
      e.gunPitch += (0.5 - e.gunPitch) * dt;
      return;
    }
    const err = this.aimTurret(e, t, dt, 1100, 1, 1.4, 1);
    e.fireCd -= dt;
    if (e.fireCd <= 0 && err < 0.1) {
      if (e.burst <= 0) e.burst = 14;
      e.fireCd = 0.06;
      e.burst--;
      if (e.burst <= 0) e.fireCd = 1.2 + w.rng.next();
      w.muzzleOf(e, T3, T4);
      const d = T3.distanceTo(t.pos);
      T4.x += (w.rng.next() - 0.5) * 0.03;
      T4.y += (w.rng.next() - 0.5) * 0.03;
      T4.z += (w.rng.next() - 0.5) * 0.03;
      T4.normalize();
      const side = e.burst % 2 === 0 ? 1 : -1;
      T1.set(side * 2.7, 0, 0).applyAxisAngle(UPV, e.yaw + e.turretYaw);
      T3.add(T1);
      w.fireBullet(e, e.team, T3, T4, 1100, 3.5 * w.enemySkill, true, false, 0xffa040, 0.55, Math.min(3.5, d / 1100 + 0.6));
      w.fx.gunFlash(T3, T4, 1.5);
      if (e.burst % 3 === 0) w.fx.playAt('gunfire', T3, 0.5);
    }
  }

  private sam(e: Ent, dt: number): void {
    const w = this.w;
    this.settle(e, dt);
    e.retarget -= dt;
    if (e.retarget <= 0) {
      e.retarget = 1.5;
      e.target = this.pickTarget(e, 7000, this.airTargets, false);
    }
    const t = e.target && e.target.alive ? e.target : null;
    if (!t) return;
    T2.subVectors(t.pos, e.pos);
    const want = angleDelta(e.yaw, Math.atan2(-T2.x, -T2.z));
    e.turretYaw += Math.max(-0.8 * dt, Math.min(0.8 * dt, angleDelta(e.turretYaw, want)));
    e.fireCd -= dt;
    if (e.fireCd <= 0 && Math.abs(angleDelta(e.turretYaw, want)) < 0.2) {
      e.fireCd = (13 + w.rng.next() * 6) / w.enemySkill;
      w.muzzleOf(e, T3, T4);
      w.fireMissile(e, e.team, T3, T4, t, { speed: 520, turn: 1.1 * Math.sqrt(w.enemySkill), dmg: 55, splash: 12, heat: true, life: 16, airOnly: true, player: false, scale: 1.6 });
      w.fx.muzzle(T3, T4, 1.2, true);
      w.fx.playAt('samLaunch', T3, 1);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Infantry
  // ---------------------------------------------------------------------------------------------
  private infantry(e: Ent, dt: number): void {
    const w = this.w;
    e.retarget -= dt;
    if (e.retarget <= 0) {
      e.retarget = 1 + w.rng.next() * 1.5;
      e.target = e.kind === 'at'
        ? this.pickTarget(e, 760, this.vehicleTargets, true) ?? this.pickTarget(e, 380, this.groundTargets, true)
        : this.pickTarget(e, 420, this.groundTargets, true);
    }
    const t = e.target && e.target.alive ? e.target : null;
    if (t && e.state === 0 && w.rng.next() < dt * 0.8) e.state = 1;
    if (e.state === 1 && (w.rng.next() < dt * 0.15 || !t)) e.state = 0;
    // Walk
    const dx = e.moveT.x - e.pos.x, dz = e.moveT.z - e.pos.z;
    const dist = Math.hypot(dx, dz);
    let sp = 0;
    if (e.state === 0) {
      if (dist < 4) this.nextMoveTarget(e, 60);
      else {
        e.yaw += angleDelta(e.yaw, Math.atan2(-dx, -dz)) * Math.min(1, dt * 4);
        sp = t ? 3.2 : 1.7;
      }
    } else if (t) {
      e.yaw += angleDelta(e.yaw, Math.atan2(-(t.pos.x - e.pos.x), -(t.pos.z - e.pos.z))) * Math.min(1, dt * 5);
    }
    e.speed += (sp - e.speed) * Math.min(1, dt * 4);
    forwardOf(e.yaw, T1);
    const nx = e.pos.x + T1.x * e.speed * dt, nz = e.pos.z + T1.z * e.speed * dt;
    if (w.ground.heightAt(nx, nz) > 0.5) {
      e.pos.x = nx;
      e.pos.z = nz;
    } else this.nextMoveTarget(e, 60);
    e.vel.copy(T1).multiplyScalar(e.speed);
    e.pos.y = w.ground.heightAt(e.pos.x, e.pos.z);
    if (!t) return;
    e.fireCd -= dt;
    e.fireCd2 -= dt;
    const d = t.pos.distanceTo(e.pos);
    if (e.kind === 'at' && ENT_DEFS[t.kind].vehicle && e.fireCd2 <= 0 && d < 760) {
      e.fireCd2 = (24 + w.rng.next() * 12) / (e.team === 1 ? w.enemySkill : 1);
      T3.copy(e.pos);
      T3.y += 1.55;
      w.center(t, T2);
      T4.subVectors(T2, T3).normalize();
      T4.y += 0.05;
      T4.normalize();
      w.fireMissile(e, e.team, T3, T4, t, { speed: 190, turn: 1.1, dmg: 34, splash: 3, heat: false, life: 6, player: false, scale: 0.7 });
      // Back blast
      w.fx.muzzle(T3.addScaledVector(T4, -1), T4.negate(), 0.5, true);
      return;
    }
    if (e.fireCd <= 0) {
      if (e.burst <= 0) e.burst = 3 + Math.floor(w.rng.next() * 3);
      e.fireCd = 0.12;
      e.burst--;
      if (e.burst <= 0) e.fireCd = 1.2 + w.rng.next() * 2.5;
      T3.copy(e.pos);
      T3.y += 1.3;
      w.center(t, T2);
      T4.subVectors(T2, T3).normalize();
      const spread = (0.012 + d * 0.00005) / w.enemySkill;
      T4.x += (w.rng.next() - 0.5) * spread * 2;
      T4.y += (w.rng.next() - 0.5) * spread;
      T4.z += (w.rng.next() - 0.5) * spread * 2;
      T4.normalize();
      w.fireBullet(e, e.team, T3, T4, 800, 4.5, w.rng.next() < 0.35, false, 0xffc080, 0.08, 1.2);
      w.fx.gunFlash(T3.addScaledVector(T4, 0.9), T4, 0.5);
      if (w.rng.next() < 0.15) w.fx.playAt('gunfire', T3, 0.25);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Aircraft
  // ---------------------------------------------------------------------------------------------
  /** Steer an aircraft toward dir with a turn-rate limit, update velocity / orientation / bank. */
  fly(e: Ent, dir: THREE.Vector3, dt: number, turn: number, speed: number): void {
    const w = this.w;
    const f = T1.set(0, 0, -1).applyQuaternion(e.quat);
    const want = T2.copy(dir).normalize();
    // Terrain floor
    const floor = w.ground.surfaceAt(e.pos.x, e.pos.z) + 160;
    const ahead = w.ground.surfaceAt(e.pos.x + f.x * 600, e.pos.z + f.z * 600) + 180;
    if (e.pos.y < Math.max(floor, ahead)) want.y = Math.max(want.y, 0.45);
    // Stay in the arena (scripted strike runs fly straight through)
    const hd = Math.hypot(e.pos.x, e.pos.z);
    if (hd > this.front.radius && e.state !== 10) {
      T3.set(-e.pos.x, 0, -e.pos.z).normalize();
      want.lerp(T3, Math.min(1, (hd - this.front.radius) / 2000)).normalize();
    }
    const ang = Math.acos(Math.max(-1, Math.min(1, f.dot(want))));
    const step = Math.min(ang, turn * dt);
    // Signed horizontal turn for bank
    const cross = f.x * want.z - f.z * want.x;
    if (ang > 1e-4) {
      T3.crossVectors(f, want).normalize();
      if (T3.lengthSq() < 0.5) T3.set(0, 1, 0);
      f.applyAxisAngle(T3, step).normalize();
    }
    const targetBank = Math.max(-1.3, Math.min(1.3, -cross * 3.5 * Math.min(1, ang * 3)));
    e.bank += (targetBank - e.bank) * Math.min(1, dt * 2.5);
    e.speed += (speed - e.speed) * Math.min(1, dt * 0.6);
    e.vel.copy(f).multiplyScalar(e.speed);
    e.pos.addScaledVector(e.vel, dt);
    T4.copy(e.pos).add(f);
    M4.lookAt(e.pos, T4, UPV);
    e.quat.setFromRotationMatrix(M4);
    Q.setFromAxisAngle(T3.set(0, 0, 1), e.bank);
    e.quat.multiply(Q);
    e.yaw = Math.atan2(-f.x, -f.z);
    if (e.rig?.flame) e.rig.flame.scale.z = 2.5 + (e.speed / 300) * 3;
    // Wingtip vapor in hard turns.
    const vap = Math.max(0, Math.min(1, (Math.abs(e.bank) - 0.75) * 1.6)) * 0.5;
    T4.set(-5.55, -0.1, 3.3).applyQuaternion(e.quat).add(e.pos);
    w.fx.ribbons.push(e.id * 2, T4.x, T4.y, T4.z, vap, 0.2, 1.6, 5);
    T4.set(5.55, -0.1, 3.3).applyQuaternion(e.quat).add(e.pos);
    w.fx.ribbons.push(e.id * 2 + 1, T4.x, T4.y, T4.z, vap, 0.2, 1.6, 5);
  }

  private jet(e: Ent, dt: number): void {
    const w = this.w;
    if (e.state === 10) return this.strikeRun(e, dt);
    if (e.state === 20) return this.antiShipRun(e, dt);
    e.retarget -= dt;
    e.stateT -= dt;
    if (e.retarget <= 0) {
      e.retarget = 2 + w.rng.next() * 2;
      e.target = this.pickTarget(e, 14000, this.airTargets, false);
    }
    const t = e.target && e.target.alive ? e.target : null;
    const f = JF.set(0, 0, -1).applyQuaternion(e.quat);
    const turn = 0.62 * (e.team === 1 ? Math.sqrt(w.enemySkill) : 1.05);
    // Threat: break turn + flares
    if (e.threatT > 0.2 && e.state !== 2) {
      e.state = 2;
      e.stateT = 3;
      if (w.rng.next() < 0.55 * w.enemySkill) w.releaseFlares(e);
    }
    const dir = N;
    if (e.state === 2) {
      dir.set(-f.z, 0.25, f.x).multiplyScalar(e.seed > 0.5 ? 1 : -1);
      if (e.stateT <= 0) e.state = 0;
      this.fly(e, dir, dt, turn * 1.3, 260);
      return;
    }
    if (e.state === 1) {
      // Extend after an overshoot
      dir.copy(f);
      dir.y += 0.15;
      if (e.stateT <= 0) e.state = 0;
      this.fly(e, dir, dt, turn * 0.5, 290);
      return;
    }
    if (!t) {
      // Patrol circle
      dir.set(-e.pos.z, 0, e.pos.x).normalize().addScaledVector(T3.set(-e.pos.x, 0, -e.pos.z).normalize(), 0.3);
      dir.y = (1200 - e.pos.y) * 0.0005;
      this.fly(e, dir, dt, turn * 0.6, 230);
      return;
    }
    const dist = t.pos.distanceTo(e.pos);
    const tof = dist / 1000;
    T3.copy(t.pos).addScaledVector(t.vel, tof).sub(e.pos);
    dir.copy(T3).normalize();
    this.fly(e, dir, dt, turn, dist > 2500 ? 280 : 240);
    f.set(0, 0, -1).applyQuaternion(e.quat);
    const ang = Math.acos(Math.max(-1, Math.min(1, f.dot(dir))));
    if (dist < 260) {
      e.state = 1;
      e.stateT = 2.5 + w.rng.next() * 2;
    }
    e.fireCd -= dt;
    e.fireCd2 -= dt;
    if (dist < 1100 && ang < 0.07 && e.fireCd <= 0) {
      if (e.burst <= 0) e.burst = 10;
      e.fireCd = 0.05;
      e.burst--;
      if (e.burst <= 0) e.fireCd = 1.1 + w.rng.next() * 1.4;
      T3.copy(e.pos).addScaledVector(f, 8);
      T2.copy(f);
      T2.x += (w.rng.next() - 0.5) * 0.02 / w.enemySkill;
      T2.y += (w.rng.next() - 0.5) * 0.02 / w.enemySkill;
      T2.z += (w.rng.next() - 0.5) * 0.02 / w.enemySkill;
      T2.normalize();
      w.fireBullet(e, e.team, T3, T2, 1000, 4, e.burst % 2 === 0, false, 0xff9a50, 0.6, 1.6);
      w.fx.gunFlash(T3, T2, 1.4);
      if (e.burst % 4 === 0) w.fx.playAt('jetCannon', T3, 0.5);
    }
    if (dist < 3800 && dist > 700 && ang < 0.35 && e.fireCd2 <= 0 && e.missiles > 0) {
      e.fireCd2 = (12 + w.rng.next() * 10) / w.enemySkill;
      e.missiles--;
      const m = e.rig?.missiles[e.missiles];
      if (m) m.visible = false;
      T3.copy(e.pos).addScaledVector(f, 2);
      T3.y -= 1;
      w.fireMissile(e, e.team, T3, f, t, { speed: 620, turn: 1.6 * Math.sqrt(w.enemySkill), dmg: 60, splash: 10, heat: true, life: 10, airOnly: true, player: false });
    }
  }

  /** Scripted strike run: fly a straight line at low altitude and drop bombs over the target zone. */
  private strikeRun(e: Ent, dt: number): void {
    const w = this.w;
    const f = JF.set(0, 0, -1).applyQuaternion(e.quat);
    N.copy(f);
    N.y = 0;
    N.normalize();
    const floor = w.ground.surfaceAt(e.pos.x, e.pos.z) + 240;
    N.y = (floor - e.pos.y) * 0.004;
    this.fly(e, N, dt, 0.3, 240);
    f.set(0, 0, -1).applyQuaternion(e.quat);
    // moveT = target zone center; drop a string of bombs when near
    const dx = e.moveT.x - e.pos.x, dz = e.moveT.z - e.pos.z;
    const along = dx * f.x + dz * f.z;
    // Bombs keep the jet's forward speed: release ~ speed * fall time before the target.
    const fall = Math.sqrt((2 * Math.max(10, e.pos.y - w.ground.heightAt(e.moveT.x, e.moveT.z))) / 9.81);
    const lead = e.speed * fall;
    e.fireCd -= dt;
    if (e.burst > 0 && along < lead + 60 && along > lead - 160 && e.fireCd <= 0) {
      e.fireCd = 0.22;
      e.burst--;
      T3.copy(e.pos);
      T3.y -= 1.5;
      w.dropBomb(e, e.team, T3, e.vel, 60, 22);
    }
    // Leave the map once well past the target.
    if (along < -2500 && Math.hypot(e.pos.x, e.pos.z) > this.front.radius * 1.5) {
      e.alive = false;
      if (e.rig) e.rig.root.visible = false;
    }
  }

  private antiShipRun(e: Ent, dt: number): void {
    const w = this.w;
    const t = w.player && w.player.alive ? w.player : e.target;
    const f = JF.set(0, 0, -1).applyQuaternion(e.quat);
    e.stateT -= dt;
    if (!t || !t.alive || e.stateT < 0) {
      N.copy(f);
      N.y = 0.2;
      this.fly(e, N, dt, 0.5, 280);
      if (e.stateT < -12) e.stateT = 20; // come around for another pass
      return;
    }
    T3.subVectors(t.pos, e.pos);
    const dist = T3.length();
    N.copy(T3).normalize();
    N.y = (220 - e.pos.y) * 0.003;
    this.fly(e, N, dt, 0.55, 260);
    f.set(0, 0, -1).applyQuaternion(e.quat);
    e.fireCd2 -= dt;
    if (dist < 6500 && e.fireCd2 <= 0 && e.missiles > 0) {
      e.fireCd2 = 14;
      e.missiles--;
      T3.copy(e.pos);
      T3.y -= 2;
      w.fireMissile(e, e.team, T3, f, t, { speed: 290, turn: 0.6, dmg: 42 * w.enemySkill, splash: 10, heat: false, life: 40, seaSkim: true, player: false, scale: 1.4 });
      e.stateT = -0.01;
    }
    if (dist < 900) e.stateT = -0.01;
  }

  // ---------------------------------------------------------------------------------------------
  // Naval
  // ---------------------------------------------------------------------------------------------
  steerShip(e: Ent, dt: number, desiredYaw: number, speed: number, turnRate: number): void {
    const w = this.w;
    // Land avoidance: probe ahead, veer toward deeper water.
    forwardOf(e.yaw, T1);
    const look = 120 + e.speed * 12;
    const h = w.ground.heightAt(e.pos.x + T1.x * look, e.pos.z + T1.z * look);
    if (h > -4) {
      forwardOf(e.yaw + 0.6, T2);
      forwardOf(e.yaw - 0.6, T3);
      const hl = w.ground.heightAt(e.pos.x + T2.x * look, e.pos.z + T2.z * look);
      const hr = w.ground.heightAt(e.pos.x + T3.x * look, e.pos.z + T3.z * look);
      desiredYaw = e.yaw + (hl < hr ? 1 : -1);
      speed *= 0.5;
    }
    const err = angleDelta(e.yaw, desiredYaw);
    const rate = turnRate * Math.min(1, 0.3 + e.speed / 10);
    e.yaw += Math.max(-rate * dt, Math.min(rate * dt, err));
    e.speed += Math.max(-1.5 * dt, Math.min(1.0 * dt, speed - e.speed));
    forwardOf(e.yaw, T1);
    e.vel.copy(T1).multiplyScalar(e.speed);
    e.pos.addScaledVector(e.vel, dt);
    e.pos.y = 0;
    const heel = Math.max(-0.12, Math.min(0.12, -err * e.speed * 0.015));
    e.bank += (heel - e.bank) * Math.min(1, dt);
    const t = w.time + e.seed * 10;
    const s = e.kind === 'boat' ? 1.8 : 1;
    w.ground.heightAt(0, 0);
    Q.setFromEuler(EUL.set(Math.sin(t * 0.7) * 0.012 * s, e.yaw, e.bank + Math.sin(t * 0.5) * 0.02 * s, 'YXZ'));
    e.quat.copy(Q);
    e.pos.y = Math.sin(t * 0.9) * 0.3 * s;
    // Wake & bow spray
    const L = e.kind === 'ship' ? 60 : 20;
    T2.copy(e.pos).addScaledVector(T1, -L);
    T3.set(-T1.z, 0, T1.x);
    w.fx.wake(T2, T3, e.speed, e.kind === 'ship' ? 16 : 7);
    T2.copy(e.pos).addScaledVector(T1, L * 1.05);
    w.fx.bowSpray(T2, T1, e.speed);
  }

  private ship(e: Ent, dt: number): void {
    const w = this.w;
    e.retarget -= dt;
    if (e.retarget <= 0) {
      e.retarget = 3;
      e.target = this.pickTarget(e, 16000, this.navalTargets, false);
    }
    const t = e.target && e.target.alive ? e.target : null;
    // Circle the target at a standoff distance; boats close in.
    const R = e.kind === 'boat' ? 1400 : 3800 + e.seed * 1500;
    let desired = e.yaw;
    if (t) {
      T1.subVectors(t.pos, e.pos);
      T1.y = 0;
      const d = T1.length();
      const toT = Math.atan2(-T1.x, -T1.z);
      const dirSign = e.seed > 0.5 ? 1 : -1;
      const radial = Math.max(-1, Math.min(1, (d - R) / 800));
      desired = toT + dirSign * (Math.PI / 2) * (1 - radial);
    } else {
      desired = Math.atan2(e.pos.x, e.pos.z);
    }
    this.steerShip(e, dt, desired, e.kind === 'boat' ? 20 : 11, e.kind === 'boat' ? 0.25 : 0.08);
    if (!t) return;
    // Main gun
    const dist = t.pos.distanceTo(e.pos);
    e.fireCd -= dt;
    e.fireCd2 -= dt;
    if (e.kind === 'ship') {
      const err = this.aimTurret(e, t, dt, 780, 9.81, 0.35, 0.9);
      if (e.fireCd <= 0 && err < 0.04 && dist < 12000) {
        e.fireCd = (4.5 + w.rng.next() * 2.5) / Math.sqrt(w.enemySkill);
        this.fireGun(e, t, 780, 20, 10, false, 1.6);
      }
      if (e.fireCd2 <= 0 && dist < 14000 && dist > 2500) {
        e.fireCd2 = (40 + w.rng.next() * 25) / w.enemySkill;
        T3.copy(e.pos);
        T3.y += 10;
        forwardOf(e.yaw, T4);
        T4.y = 0.35;
        T4.normalize();
        w.fireMissile(e, e.team, T3, T4, t, { speed: 270, turn: 0.55, dmg: 48, splash: 12, heat: false, life: 70, seaSkim: true, player: false, scale: 1.5 });
        w.fx.muzzle(T3, T4, 1.5, false);
      }
    } else {
      const err = this.aimTurret(e, t, dt, 900, 4, 1.2, 1);
      if (e.fireCd <= 0 && err < 0.06 && dist < 2600) {
        if (e.burst <= 0) e.burst = 8;
        e.fireCd = 0.18;
        e.burst--;
        if (e.burst <= 0) e.fireCd = 2.5 + w.rng.next() * 2;
        w.muzzleOf(e, T3, T4);
        this.jitter(T4, dist);
        w.fireBullet(e, e.team, T3, T4, 900, 3.2, true, false, 0xffb050, 0.5, 3.5);
        w.fx.gunFlash(T3, T4, 1.6);
        if (e.burst % 2 === 0) w.fx.playAt('gunfire', T3, 0.5);
      }
    }
  }

  private battery(e: Ent, dt: number): void {
    const w = this.w;
    e.retarget -= dt;
    if (e.retarget <= 0) {
      e.retarget = 3;
      e.target = this.pickTarget(e, 11000, this.navalTargets, false);
    }
    const t = e.target && e.target.alive ? e.target : null;
    if (!t) return;
    const err = this.aimTurret(e, t, dt, 820, 9.81, 0.25, 0.85);
    e.fireCd -= dt;
    if (e.fireCd <= 0 && err < 0.03) {
      e.fireCd = (7 + w.rng.next() * 4) / Math.sqrt(w.enemySkill);
      this.fireGun(e, t, 820, 26, 12, false, 1.8);
    }
  }
}

const EUL = new THREE.Euler();
export function teamSign(t: Team): number {
  return t === 0 ? 1 : -1;
}
