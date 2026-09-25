// FRONT ULTRA — command mode: player destroyer (owner: command).
// Engine telegraph (astern .. flank) with slow spool, rudder with authority growing with speed, heel into turns,
// swell pitch / roll, grounding on shoals. The 127 mm turret traverses toward the camera aim (arc-limited by the
// superstructure) and auto-elevates for the aimed range; shells fly with drop and raise big water columns. A lead
// indicator shows where to aim to hit the nearest moving ship. Anti-ship missiles lock on ships near the crosshair.
// Two CIWS mounts automatically shred incoming missiles and aircraft.

import * as THREE from 'three';
import { angleDelta } from '../../shared/math';
import { ballisticPitch, ENT_DEFS, forwardOf, type Ent, type Proj } from '../world';
import { newHudState, project, raycast, type Controller, type ControllerCtx, type HudState, type RayHit } from './common';

const SHELL = 820;
const RELOAD = 2.4;
const SPEEDS = [-5, 0, 6, 10, 14.5, 17.5];
const T1 = new THREE.Vector3();
const T2 = new THREE.Vector3();
const T3 = new THREE.Vector3();
const DIR = new THREE.Vector3();
const EUL = new THREE.Euler();
const MOUSE = { x: 0, y: 0 };

export class ShipController implements Controller {
  readonly hud: HudState = newHudState('ship');
  aimYaw: number;
  aimPitch = -0.08;
  telegraph = 3;
  rudder = 0;
  private dist = 175;
  private reloadT = 0;
  private shells = 180;
  private ssm = 8;
  private ssmCd = 0;
  private lockT: Ent | null = null;
  private lockP = 0;
  private ciwsCd = [0, 0];
  private readonly aim: RayHit = { point: new THREE.Vector3(), dist: 0, ent: null };
  readonly aimPoint = new THREE.Vector3();
  private leadT: Ent | null = null;
  private auto: THREE.Vector3 | null = null;
  private grounded = 0;

  constructor(readonly ent: Ent, private readonly c: ControllerCtx) {
    this.aimYaw = ent.yaw;
    ent.hp = ent.maxHp = 420;
    this.hud.maxHp = 420;
    ent.speed = SPEEDS[this.telegraph + 1];
  }

  aimAt(p: THREE.Vector3): void {
    this.auto = p.clone();
    const dx = p.x - this.ent.pos.x, dz = p.z - this.ent.pos.z;
    this.aimYaw = Math.atan2(-dx, -dz);
  }

  fire(): void {
    this.reloadT = 0;
    this.shoot();
  }

  snapTurret(): void {
    const e = this.ent;
    this.updateAim();
    const want = angleDelta(e.yaw, this.aimYaw);
    e.turretYaw = Math.max(-2.5, Math.min(2.5, want));
    this.solveGun(100);
  }

  update(dt: number, allowInput: boolean): void {
    const c = this.c;
    const e = this.ent;
    const inp = c.input;
    if (!e.alive || dt <= 0) return;
    if (allowInput) {
      inp.takeMouse(MOUSE);
      const k = 0.0022 * c.sens();
      this.aimYaw -= MOUSE.x * k;
      this.aimPitch -= MOUSE.y * k * (c.invertY() ? -1 : 1);
      this.aimPitch = Math.max(-0.45, Math.min(0.2, this.aimPitch));
      const wh = inp.takeWheel();
      if (wh) this.dist = Math.max(60, Math.min(260, this.dist * (wh > 0 ? 1.12 : 0.89)));
      if (inp.hit('KeyW') || inp.hit('ArrowUp')) this.telegraph = Math.min(4, this.telegraph + 1);
      if (inp.hit('KeyS') || inp.hit('ArrowDown')) this.telegraph = Math.max(-1, this.telegraph - 1);
      const rIn = (inp.down('KeyA') || inp.down('ArrowLeft') ? 1 : 0) - (inp.down('KeyD') || inp.down('ArrowRight') ? 1 : 0);
      if (rIn) this.rudder = Math.max(-1, Math.min(1, this.rudder + rIn * dt * 0.9));
      else this.rudder += -this.rudder * Math.min(1, dt * 0.5);
    }
    // --- Hull ------------------------------------------------------------------------------------
    const target = SPEEDS[this.telegraph + 1];
    const acc = target > e.speed ? 0.55 : 0.8;
    e.speed += Math.max(-acc * dt, Math.min(acc * dt, target - e.speed));
    const auth = Math.max(0.12, Math.min(1.2, Math.abs(e.speed) / 12));
    const yawRate = this.rudder * 0.075 * auth * Math.sign(e.speed || 1);
    e.yaw += yawRate * dt;
    e.turretYaw -= yawRate * dt;
    forwardOf(e.yaw, DIR);
    const nx = e.pos.x + DIR.x * e.speed * dt, nz = e.pos.z + DIR.z * e.speed * dt;
    const bowX = nx + DIR.x * 70 * Math.sign(e.speed || 1), bowZ = nz + DIR.z * 70 * Math.sign(e.speed || 1);
    if (c.ground.heightAt(bowX, bowZ) > -3.5) {
      // Grounding: stop hard, scrape.
      if (Math.abs(e.speed) > 2) {
        c.shake(0.4);
        c.fx.hooks.sound('explosionSmall', 0.3);
      }
      e.speed = 0;
      this.grounded = 1.5;
      if (this.telegraph > 0) this.telegraph = 0;
    } else {
      e.pos.x = nx;
      e.pos.z = nz;
    }
    this.grounded = Math.max(0, this.grounded - dt);
    const hd = Math.hypot(e.pos.x, e.pos.z);
    this.hud.boundary = hd > c.radius * 0.85;
    this.hud.boundaryDir = Math.atan2(-e.pos.x, -e.pos.z);
    if (hd > c.radius) {
      e.pos.x *= c.radius / hd;
      e.pos.z *= c.radius / hd;
    }
    e.vel.copy(DIR).multiplyScalar(e.speed);
    const t = c.world.time;
    const heel = -this.rudder * Math.min(1, Math.abs(e.speed) / 14) * 0.07;
    e.bank += (heel - e.bank) * Math.min(1, dt * 0.8);
    EUL.set(Math.sin(t * 0.55) * 0.01 + Math.sin(t * 1.3) * 0.004, e.yaw, e.bank + Math.sin(t * 0.42) * 0.018, 'YXZ');
    e.quat.setFromEuler(EUL);
    e.pos.y = Math.sin(t * 0.8) * 0.35;
    // Wake & spray
    T1.copy(e.pos).addScaledVector(DIR, -64);
    T2.set(-DIR.z, 0, DIR.x);
    c.fx.wake(T1, T2, Math.abs(e.speed), 17);
    T1.copy(e.pos).addScaledVector(DIR, 72);
    c.fx.bowSpray(T1, DIR, Math.abs(e.speed));
    // --- Gun --------------------------------------------------------------------------------------
    this.updateAim();
    const want = angleDelta(e.yaw, this.aimYaw);
    const clamped = Math.max(-2.5, Math.min(2.5, want));
    const err = angleDelta(e.turretYaw, clamped);
    e.turretYaw += Math.max(-0.5 * dt, Math.min(0.5 * dt, err));
    this.solveGun(dt);
    this.reloadT = Math.max(0, this.reloadT - dt);
    this.ssmCd -= dt;
    this.updateLock(dt);
    if (allowInput) {
      const trigger = inp.lmbHit() || inp.lmb;
      if (trigger && this.reloadT <= 0 && this.shells > 0 && Math.abs(want) < 2.55) this.shoot();
      if (inp.rmbHit() && this.ssm > 0 && this.ssmCd <= 0) this.launch();
    }
    this.ciws(dt);
    let warn = false;
    for (const p of c.world.projs) if (p.alive && p.kind === 'missile' && p.team === 1 && p.target === e) warn = true;
    this.hud.missileWarning = warn;
    this.fillHud();
  }

  private updateAim(): void {
    const cam = this.c.camera;
    cam.getWorldDirection(T1);
    raycast(this.c.world, cam.position, T1, 22000, this.ent, this.aim);
    if (this.auto) this.aim.point.copy(this.auto);
    this.aimPoint.copy(this.aim.point);
  }

  private solveGun(dt: number): void {
    const e = this.ent;
    const w = this.c.world;
    w.muzzleOf(e, T2, T3);
    const dx = this.aimPoint.x - T2.x, dz = this.aimPoint.z - T2.z;
    const pitch = ballisticPitch(Math.hypot(dx, dz), this.aimPoint.y - T2.y, SHELL, 9.81);
    const local = Math.max(-0.08, Math.min(0.9, pitch));
    const rate = dt >= 1 ? 100 : 0.3 * dt;
    e.gunPitch += Math.max(-rate, Math.min(rate, local - e.gunPitch));
  }

  private shoot(): void {
    const e = this.ent;
    const c = this.c;
    this.shells--;
    this.reloadT = RELOAD;
    c.world.muzzleOf(e, T2, T3);
    T3.x += (c.fx.rand() - 0.5) * 0.004;
    T3.y += (c.fx.rand() - 0.5) * 0.002;
    T3.z += (c.fx.rand() - 0.5) * 0.004;
    T3.normalize();
    c.world.fireShell(e, 0, T2, T3, SHELL, 55, 11, false, true, 1.8);
    c.fx.muzzle(T2, T3, 3.2, false);
    c.fx.hooks.sound('navalGun', 1);
    c.shake(0.35);
    if (e.rig?.gun) e.rig.gun.position.z += 0.6;
  }

  private updateLock(dt: number): void {
    const c = this.c;
    const cam = c.camera;
    cam.getWorldDirection(T1);
    let best: Ent | null = null;
    let bestA = 0.12;
    let lead: Ent | null = null;
    let leadA = 0.35;
    for (const o of c.world.ents) {
      if (!o.alive || o.team === 0) continue;
      if (ENT_DEFS[o.kind].air) continue;
      T2.subVectors(o.pos, cam.position);
      const d = T2.length();
      T2.divideScalar(d);
      const a = Math.acos(Math.max(-1, Math.min(1, T2.dot(T1))));
      if (a < leadA && d < 16000) {
        leadA = a;
        lead = o;
      }
      if (d < 18000 && a < bestA && ENT_DEFS[o.kind].naval) {
        bestA = a;
        best = o;
      }
    }
    this.leadT = lead;
    if (best !== this.lockT) {
      this.lockT = best;
      this.lockP = 0;
    } else if (best) this.lockP = Math.min(1, this.lockP + dt / 1.6);
  }

  private launch(): void {
    const e = this.ent;
    const c = this.c;
    this.ssm--;
    this.ssmCd = 2.5;
    T2.set(this.ssm % 2 === 0 ? 2.5 : -2.5, 9, 1.5).applyQuaternion(e.quat).add(e.pos);
    forwardOf(e.yaw, T3);
    T3.y = 0.5;
    T3.normalize();
    const target = this.lockP >= 1 ? this.lockT : null;
    c.world.fireMissile(e, 0, T2, T3, target, { speed: 300, turn: 0.8, dmg: 120, splash: 14, heat: false, life: 70, seaSkim: true, player: true, scale: 1.5 });
    c.fx.muzzle(T2, T3, 1.4, false);
  }

  /** Close-in weapon systems: auto-engage incoming missiles and aircraft. */
  private ciws(dt: number): void {
    const e = this.ent;
    const c = this.c;
    const rig = e.rig;
    if (!rig) return;
    for (let i = 0; i < rig.ciws.length; i++) {
      this.ciwsCd[i] -= dt;
      if (this.ciwsCd[i] > 0) continue;
      const mount = rig.ciws[i];
      mount.getWorldPosition(T1);
      T1.y += 1.8;
      // Nearest threat: enemy missile, then enemy aircraft.
      let tp: THREE.Vector3 | null = null;
      let tv: THREE.Vector3 | null = null;
      let missile: Proj | null = null;
      let best = 2200;
      for (const p of c.world.projs) {
        if (!p.alive || p.kind !== 'missile' || p.team === 0) continue;
        const d = p.pos.distanceTo(T1);
        if (d < best) {
          best = d;
          tp = p.pos;
          tv = p.vel;
          missile = p;
        }
      }
      if (!tp) {
        for (const o of c.world.ents) {
          if (!o.alive || o.team === 0 || o.kind !== 'jet') continue;
          const d = o.pos.distanceTo(T1);
          if (d < best) {
            best = d;
            tp = o.pos;
            tv = o.vel;
          }
        }
      }
      if (!tp || !tv) continue;
      this.ciwsCd[i] = 0.035;
      const tof = best / 1100;
      T2.copy(tp).addScaledVector(tv, tof).sub(T1).normalize();
      // Aim the mount (visual)
      const local = Math.atan2(-T2.x, -T2.z) - e.yaw;
      mount.rotation.y = local;
      T3.copy(T2);
      T3.x += (c.fx.rand() - 0.5) * 0.02;
      T3.y += (c.fx.rand() - 0.5) * 0.02;
      T3.z += (c.fx.rand() - 0.5) * 0.02;
      T3.normalize();
      c.world.fireBullet(e, 0, T1, T3, 1100, 5, true, false, 0xffc070, 0.55, Math.min(2.5, tof + 0.3));
      c.fx.gunFlash(T1, T3, 1.3);
      if (c.fx.rand() < 0.2) c.fx.hooks.sound('gunfire', 0.35);
      // Missiles are small: resolve kills statistically.
      if (missile && best < 1300 && c.fx.rand() < 0.035 * 0.75) {
        c.fx.explosion(missile.pos, 1.1, 'air');
        missile.alive = false;
        if (missile.mesh) {
          missile.mesh.visible = false;
          missile.mesh = null;
        }
      }
    }
  }

  updateCamera(dt: number): void {
    const e = this.ent;
    const cam = this.c.camera;
    const cp = Math.cos(this.aimPitch);
    DIR.set(-Math.sin(this.aimYaw) * cp, Math.sin(this.aimPitch), -Math.cos(this.aimYaw) * cp);
    T1.copy(e.pos);
    T1.y += 26;
    cam.position.copy(T1).addScaledVector(DIR, -this.dist);
    cam.position.y += this.dist * 0.16;
    if (cam.position.y < 3) cam.position.y = 3;
    T2.copy(cam.position).add(DIR);
    cam.up.set(0, 1, 0);
    cam.lookAt(T2);
    cam.fov += (58 - cam.fov) * Math.min(1, dt * 4 + (dt === 0 ? 1 : 0));
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.projectMarkers();
  }

  private projectMarkers(): void {
    const e = this.ent;
    const c = this.c;
    const h = this.hud;
    // Gun impact prediction (flat sea): where the barrel's shell comes down.
    c.world.muzzleOf(e, T2, T3);
    const vy = T3.y * SHELL, vh = Math.hypot(T3.x, T3.z) * SHELL;
    const tFlight = (vy + Math.sqrt(vy * vy + 2 * 9.81 * Math.max(0, T2.y))) / 9.81;
    const hx = T3.x / Math.max(1e-6, Math.hypot(T3.x, T3.z)), hz = T3.z / Math.max(1e-6, Math.hypot(T3.x, T3.z));
    T1.set(T2.x + hx * vh * tFlight, 0, T2.z + hz * vh * tFlight);
    project(c.camera, T1, c.viewW, c.viewH, h.gun);
    // Lead indicator for the ship nearest the crosshair
    h.lead.visible = false;
    const t = this.leadT;
    if (t && t.alive) {
      const d = Math.hypot(t.pos.x - T2.x, t.pos.z - T2.z);
      const pitch = ballisticPitch(d, t.pos.y + 4 - T2.y, SHELL, 9.81);
      const tof = d / (SHELL * Math.cos(pitch));
      T1.copy(t.pos).addScaledVector(t.vel, tof);
      T1.y = 4;
      project(c.camera, T1, c.viewW, c.viewH, h.lead);
    }
    h.lockState = 0;
    if (this.lockT && this.lockT.alive) {
      h.lockState = this.lockP >= 1 ? 2 : 1;
      h.lockProgress = this.lockP;
      T1.copy(this.lockT.pos);
      T1.y += 8;
      project(c.camera, T1, c.viewW, c.viewH, h.lock);
    }
  }

  private fillHud(): void {
    const e = this.ent;
    const h = this.hud;
    h.hp = Math.max(0, e.hp);
    h.maxHp = e.maxHp;
    h.heading = -this.aimYaw;
    h.hullHeading = -e.yaw;
    h.turretRel = -e.turretYaw;
    h.speedKmh = Math.abs(e.speed) * 1.944; // knots
    h.telegraph = this.telegraph;
    h.rudder = this.rudder;
    h.reload = 1 - this.reloadT / RELOAD;
    h.rangeM = this.aim.dist;
    if (e.rig?.gun) e.rig.gun.position.z += (-2.6 - e.rig.gun.position.z) * 0.1;
    h.weapons.length = 0;
    h.weapons.push(
      { key: 'LMB', label: 'command.ammo.main', count: this.shells, max: 180, active: true, ready: h.reload },
      { key: 'RMB', label: 'command.ammo.ssm', count: this.ssm, max: 8, active: this.lockP >= 1, ready: this.ssmCd > 0 ? 1 - this.ssmCd / 2.5 : 1 },
      { key: 'AUTO', label: 'command.ammo.ciws', count: 2, max: 2, active: false, ready: 1 },
    );
  }
}
