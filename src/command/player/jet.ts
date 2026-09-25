// FRONT ULTRA — command mode: player fighter jet (owner: command).
// Arcade flight model with weight: the mouse moves a free aim direction and a "virtual instructor" flies the jet
// toward it (roll-to-turn when far off-axis, wings level when on target), keyboard roll / yaw / throttle override,
// afterburner, energy bleed in hard turns, gravity along the flight path, and a velocity vector that lags the nose
// (mushing) so it feels heavy but never stalls. 20 mm cannon with a lead pipper, IR missiles with a lock-on cycle
// (tone via the HUD), flares that decoy heat seekers, missile warning, pull-up / boundary warnings.

import * as THREE from 'three';
import { ENT_DEFS, type Ent } from '../world';
import { newHudState, project, type Controller, type ControllerCtx, type HudState } from './common';

const T1 = new THREE.Vector3();
const T2 = new THREE.Vector3();
const T3 = new THREE.Vector3();
const FWD = new THREE.Vector3();
const UPB = new THREE.Vector3();
const RIGHT = new THREE.Vector3();
const LOCAL = new THREE.Vector3();
const QI = new THREE.Quaternion();
const QD = new THREE.Quaternion();
const EUL = new THREE.Euler();
const MOUSE = { x: 0, y: 0 };
const BULLET = 1050;

export class JetController implements Controller {
  readonly hud: HudState = newHudState('jet');
  aimYaw: number;
  aimPitch = 0;
  readonly aimDir = new THREE.Vector3();
  throttle = 0.75;
  private ab = false;
  private rates = new THREE.Vector3();
  private gunCd = 0;
  private gunAmmo = 640;
  private missiles = 6;
  private msCd = 0;
  private flareCd = 0;
  private lockT: Ent | null = null;
  private lockP = 0;
  private camPos = new THREE.Vector3();
  private camInit = false;
  private gl = 1;
  private auto: THREE.Vector3 | null = null;
  private msIdx = 0;

  constructor(readonly ent: Ent, private readonly c: ControllerCtx) {
    this.aimYaw = ent.yaw;
    ent.hp = ent.maxHp = 120;
    this.hud.maxHp = 120;
    ent.speed = 240;
    ent.missiles = 6;
    this.updateAimDir();
  }

  private updateAimDir(): void {
    const cp = Math.cos(this.aimPitch);
    this.aimDir.set(-Math.sin(this.aimYaw) * cp, Math.sin(this.aimPitch), -Math.cos(this.aimYaw) * cp);
  }

  aimAt(p: THREE.Vector3): void {
    this.auto = p.clone();
    T1.subVectors(p, this.ent.pos).normalize();
    this.aimYaw = Math.atan2(-T1.x, -T1.z);
    this.aimPitch = Math.asin(Math.max(-1, Math.min(1, T1.y)));
    this.updateAimDir();
  }

  fire(): void {
    this.gunCd = 0;
    this.gun();
  }

  /** Staging: point the jet exactly along the aim direction. */
  snap(): void {
    const e = this.ent;
    T1.copy(e.pos).add(this.aimDir);
    const m = new THREE.Matrix4().lookAt(e.pos, T1, new THREE.Vector3(0, 1, 0));
    e.quat.setFromRotationMatrix(m);
    e.vel.copy(this.aimDir).multiplyScalar(e.speed);
  }

  update(dt: number, allowInput: boolean): void {
    const c = this.c;
    const e = this.ent;
    const inp = c.input;
    if (!e.alive || dt <= 0) return;
    if (allowInput) {
      inp.takeMouse(MOUSE);
      const k = 0.0021 * c.sens();
      this.aimYaw -= MOUSE.x * k;
      this.aimPitch -= MOUSE.y * k * (c.invertY() ? -1 : 1);
      this.aimPitch = Math.max(-1.45, Math.min(1.45, this.aimPitch));
      if (inp.down('KeyW')) this.throttle = Math.min(1, this.throttle + dt * 0.6);
      if (inp.down('KeyS')) this.throttle = Math.max(0, this.throttle - dt * 0.6);
      this.ab = inp.down('ShiftLeft') || inp.down('ShiftRight') || (inp.down('KeyW') && this.throttle >= 1);
    }
    if (this.auto) {
      T1.subVectors(this.auto, e.pos).normalize();
      this.aimYaw = Math.atan2(-T1.x, -T1.z);
      this.aimPitch = Math.asin(Math.max(-1, Math.min(1, T1.y)));
    }
    this.updateAimDir();
    // --- Instructor ---------------------------------------------------------------------------
    QI.copy(e.quat).invert();
    LOCAL.copy(this.aimDir).applyQuaternion(QI);
    FWD.set(0, 0, -1).applyQuaternion(e.quat);
    UPB.set(0, 1, 0).applyQuaternion(e.quat);
    RIGHT.set(1, 0, 0).applyQuaternion(e.quat);
    const off = Math.acos(Math.max(-1, Math.min(1, -LOCAL.z)));
    const pitchCmd = Math.atan2(LOCAL.y, -LOCAL.z) * 2.6;
    const yawCmd = -Math.atan2(LOCAL.x, -LOCAL.z) * 1.2;
    const desiredRoll = Math.atan2(LOCAL.x, LOCAL.y);
    const w = Math.min(1, Math.max(0, (off - 0.035) / 0.2));
    let rollCmd = (-RIGHT.y * 2.2) * (1 - w) + -desiredRoll * 3.2 * w;
    let yawKey = 0;
    if (allowInput) {
      const rk = (inp.down('KeyA') ? 1 : 0) - (inp.down('KeyD') ? 1 : 0);
      if (rk) rollCmd = rk * 3.4;
      yawKey = (inp.down('KeyQ') ? 1 : 0) - (inp.down('KeyE') ? 1 : 0);
    }
    const spd = e.speed;
    const auth = Math.min(1.25, Math.max(0.35, spd / 240));
    const maxP = 0.95 * auth, maxR = 3.2, maxY = 0.3;
    const tp = Math.max(-maxP * 0.6, Math.min(maxP, pitchCmd));
    const tr = Math.max(-maxR, Math.min(maxR, rollCmd));
    const ty = Math.max(-maxY, Math.min(maxY, yawCmd + yawKey * 0.4));
    const r = 1 - Math.exp(-5 * dt);
    this.rates.x += (tp - this.rates.x) * r;
    this.rates.y += (ty - this.rates.y) * r;
    this.rates.z += (tr - this.rates.z) * (1 - Math.exp(-7 * dt));
    EUL.set(this.rates.x * dt, this.rates.y * dt, this.rates.z * dt, 'XYZ');
    QD.setFromEuler(EUL);
    e.quat.multiply(QD).normalize();
    FWD.set(0, 0, -1).applyQuaternion(e.quat);
    // --- Energy -------------------------------------------------------------------------------
    const thrust = this.throttle * 38 + (this.ab ? 30 : 0);
    const drag = 0.000235 * spd * spd;
    const turnBleed = Math.abs(this.rates.x) * spd * 0.055;
    e.speed += (thrust - drag - turnBleed - 9.81 * FWD.y * 0.9) * dt;
    e.speed = Math.max(95, Math.min(560, e.speed));
    this.gl = Math.min(9.6, 1 + (Math.abs(this.rates.x) * spd / 9.81) * 0.42);
    // Velocity lags the nose (weight).
    T1.copy(FWD).multiplyScalar(e.speed);
    e.vel.lerp(T1, 1 - Math.exp(-3.2 * dt));
    e.vel.y -= 9.81 * dt * 0.25 * (1 - Math.min(1, spd / 200));
    e.pos.addScaledVector(e.vel, dt);
    e.yaw = Math.atan2(-FWD.x, -FWD.z);
    // --- Terrain & boundary ---------------------------------------------------------------------
    const ground = c.ground.surfaceAt(e.pos.x, e.pos.z);
    if (e.pos.y < ground + 3) {
      c.world.kill(e, null, false);
      c.fx.explosion(e.pos, 3.5, ground < 0.5 ? 'water' : 'ground');
      return;
    }
    // Time-to-impact along the velocity
    let pull = false;
    for (let s = 1; s <= 6; s++) {
      T2.copy(e.pos).addScaledVector(e.vel, s * 0.7);
      if (T2.y < c.ground.surfaceAt(T2.x, T2.z) + 20) {
        pull = true;
        break;
      }
    }
    this.hud.pullUp = pull;
    this.hud.stall = e.speed < 120;
    const hd = Math.hypot(e.pos.x, e.pos.z);
    this.hud.boundary = hd > c.radius * 0.9;
    this.hud.boundaryDir = Math.atan2(-e.pos.x, -e.pos.z);
    if (e.pos.y > 12000) e.vel.y = Math.min(e.vel.y, 0);
    // Afterburner flame
    if (e.rig?.flame) {
      const f = 1.2 + this.throttle * 2.5 + (this.ab ? 4 + Math.sin(c.world.time * 40) * 0.5 : 0);
      e.rig.flame.scale.set(this.ab ? 1.15 : 0.9, this.ab ? 1.15 : 0.9, f);
      e.rig.flame.visible = true;
    }
    // Wingtip vortices: vapor ribbons stream off the tips when pulling G.
    const vap = Math.max(0, Math.min(1, (this.gl - 3.2) / 4)) * 0.45;
    T2.set(-5.55, -0.1, 3.3).applyQuaternion(e.quat).add(e.pos);
    c.fx.ribbons.push(e.id * 2, T2.x, T2.y, T2.z, vap, 0.2, 1.8, 5);
    T2.set(5.55, -0.1, 3.3).applyQuaternion(e.quat).add(e.pos);
    c.fx.ribbons.push(e.id * 2 + 1, T2.x, T2.y, T2.z, vap, 0.2, 1.8, 5);
    // --- Weapons --------------------------------------------------------------------------------
    this.gunCd -= dt;
    this.msCd -= dt;
    this.flareCd -= dt;
    this.updateLock(dt);
    if (allowInput) {
      const trigger = inp.lmbHit() || inp.lmb;
      if (trigger && this.gunCd <= 0 && this.gunAmmo > 0) this.gun();
      if (inp.rmbHit() && this.msCd <= 0 && this.missiles > 0) this.launch();
      if (inp.hit('KeyF') && this.flareCd <= 0) {
        this.flareCd = 0.7;
        c.world.releaseFlares(e);
      }
    }
    // Missile warning
    let warn = false;
    for (const p of c.world.projs) if (p.alive && p.kind === 'missile' && p.target === e) warn = true;
    this.hud.missileWarning = warn;
    this.fillHud();
  }

  private gun(): void {
    const e = this.ent;
    const c = this.c;
    this.gunCd = 1 / 30;
    this.gunAmmo--;
    FWD.set(0, 0, -1).applyQuaternion(e.quat);
    if (e.rig?.gunPort) e.rig.gunPort.getWorldPosition(T2);
    else T2.copy(e.pos);
    T2.addScaledVector(e.vel, 1 / 60);
    T3.copy(FWD);
    T3.x += (c.fx.rand() - 0.5) * 0.004;
    T3.y += (c.fx.rand() - 0.5) * 0.004;
    T3.normalize();
    c.world.fireBullet(e, 0, T2, T3, BULLET, 6, true, true, 0xffd080, 0.75, 2.2);
    c.fx.gunFlash(T2, T3, 1.6);
    if (this.gunAmmo % 5 === 0) c.fx.hooks.sound('jetCannon', 0.5);
    c.shake(0.04);
  }

  private updateLock(dt: number): void {
    const e = this.ent;
    const c = this.c;
    FWD.set(0, 0, -1).applyQuaternion(e.quat);
    // Best candidate in the seeker cone around the aim direction.
    let best: Ent | null = null;
    let bestA = 0.26;
    for (const o of c.world.ents) {
      if (!o.alive || o.team === 0) continue;
      if (!ENT_DEFS[o.kind].vehicle) continue;
      T1.subVectors(o.pos, e.pos);
      const d = T1.length();
      if (d > 5500 || d < 150) continue;
      T1.divideScalar(d);
      const a = Math.acos(Math.max(-1, Math.min(1, T1.dot(this.aimDir))));
      const score = a * (ENT_DEFS[o.kind].air ? 0.7 : 1);
      if (score < bestA) {
        bestA = score;
        best = o;
      }
    }
    if (best !== this.lockT) {
      this.lockT = best;
      this.lockP = 0;
    } else if (best) {
      this.lockP = Math.min(1, this.lockP + dt / 1.1);
    }
  }

  private launch(): void {
    const e = this.ent;
    const c = this.c;
    this.msCd = 0.6;
    this.missiles--;
    const m = e.rig?.missiles[this.msIdx % 4];
    this.msIdx++;
    if (m && this.missiles < 4) m.visible = false;
    FWD.set(0, 0, -1).applyQuaternion(e.quat);
    if (m) m.getWorldPosition(T2);
    else T2.copy(e.pos);
    T2.y -= 0.5;
    const target = this.lockP >= 1 ? this.lockT : null;
    c.world.fireMissile(e, 0, T2, FWD, target, { speed: 720, turn: 2.4, dmg: 90, splash: 12, heat: true, life: 12, player: true });
  }

  updateCamera(dt: number): void {
    const e = this.ent;
    const cam = this.c.camera;
    // Behind the aim direction, world-up camera (mouse-aim style), slight lag.
    T1.copy(e.pos).addScaledVector(this.aimDir, -30);
    T1.y += 9.5;
    if (!this.camInit || dt === 0) {
      this.camPos.copy(T1);
      this.camInit = true;
    } else this.camPos.lerp(T1, 1 - Math.exp(-14 * dt));
    cam.position.copy(this.camPos);
    const gh = this.c.ground.surfaceAt(cam.position.x, cam.position.z) + 2;
    if (cam.position.y < gh) cam.position.y = gh;
    T2.copy(e.pos).addScaledVector(this.aimDir, 400);
    T2.y += 9.5;
    cam.up.set(0, 1, 0);
    cam.lookAt(T2);
    const fov = 66 + Math.min(10, (e.speed - 240) * 0.03);
    cam.fov += (fov - cam.fov) * Math.min(1, dt * 3 + (dt === 0 ? 1 : 0));
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    // Nose marker / lead pipper need the final camera.
    this.projectMarkers();
  }

  private projectMarkers(): void {
    const e = this.ent;
    const c = this.c;
    const h = this.hud;
    FWD.set(0, 0, -1).applyQuaternion(e.quat);
    T1.copy(e.pos).addScaledVector(FWD, 900);
    project(c.camera, T1, c.viewW, c.viewH, h.gun);
    h.lead.visible = false;
    h.lockState = 0;
    const t = this.lockT;
    if (t && t.alive) {
      const d = t.pos.distanceTo(e.pos);
      h.lockState = this.lockP >= 1 ? 2 : 1;
      h.lockProgress = this.lockP;
      project(c.camera, t.pos, c.viewW, c.viewH, h.lock);
      if (d < 1800) {
        const tof = d / (BULLET + e.speed * 0.5);
        T1.copy(t.pos).addScaledVector(t.vel, tof).addScaledVector(e.vel, -tof * 0.05);
        project(c.camera, T1, c.viewW, c.viewH, h.lead);
      }
    }
  }

  private fillHud(): void {
    const e = this.ent;
    const h = this.hud;
    h.hp = Math.max(0, e.hp);
    h.maxHp = e.maxHp;
    FWD.set(0, 0, -1).applyQuaternion(e.quat);
    h.heading = -Math.atan2(-this.aimDir.x, -this.aimDir.z);
    h.hullHeading = -e.yaw;
    h.speedKmh = e.speed * 3.6;
    h.altM = e.pos.y;
    h.throttle = this.throttle;
    h.afterburner = this.ab;
    h.pitch = Math.asin(Math.max(-1, Math.min(1, FWD.y)));
    RIGHT.set(1, 0, 0).applyQuaternion(e.quat);
    UPB.set(0, 1, 0).applyQuaternion(e.quat);
    h.roll = Math.atan2(RIGHT.y, UPB.y);
    h.gLoad = this.gl;
    h.reload = 1;
    h.weapons.length = 0;
    h.weapons.push(
      { key: 'LMB', label: 'command.ammo.gun', count: this.gunAmmo, max: 640, active: true, ready: 1 },
      { key: 'RMB', label: 'command.ammo.aam', count: this.missiles, max: 6, active: this.lockP >= 1, ready: this.msCd > 0 ? 1 - this.msCd / 0.6 : 1 },
      { key: 'F', label: 'command.ammo.flares', count: e.flares, max: 30, active: false, ready: this.flareCd > 0 ? 1 - this.flareCd / 0.7 : 1 },
    );
    h.rangeM = this.lockT ? this.lockT.pos.distanceTo(e.pos) : 0;
  }
}
