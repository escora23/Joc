// FRONT ULTRA — command mode: player tank (owner: command).
// Arcade-sim handling: throttle / brake with slope-dependent acceleration, neutral steering, spring-damped hull
// pitch & roll from acceleration, terrain and recoil. The camera orbits with the mouse; the turret traverses toward
// the camera's aim at a limited rate and the gun auto-elevates to the ballistic solution for the aimed range, so the
// gun indicator (where the shell will really land) chases the crosshair. AP / HE shells with travel time and drop,
// 5 s reload, coax MG, smoke dischargers (break enemy ATGM guidance), track marks and dust.

import * as THREE from 'three';
import { angleDelta } from '../../shared/math';
import { ballisticPitch, forwardOf, segSphere, type Ent } from '../world';
import { newHudState, project, raycast, type Controller, type ControllerCtx, type HudState, type RayHit, type ShotCheck } from './common';

const AP_SPEED = 950;
const HE_SPEED = 620;
const RELOAD = 4.6;
/** Chase camera: orbit pivot height above the hull, distance behind, extra lift (tank framed below the crosshair). */
const CAM_PIVOT = 3.1;
const CAM_DIST = 14;
const CAM_LIFT = 1.9;
const T1 = new THREE.Vector3();
const T2 = new THREE.Vector3();
const T3 = new THREE.Vector3();
const DIR = new THREE.Vector3();
const N = new THREE.Vector3();
const MOUSE = { x: 0, y: 0 };
const G1 = new THREE.Vector3();
const G2 = new THREE.Vector3();

export class TankController implements Controller {
  readonly hud: HudState = newHudState('tank');
  aimYaw: number;
  aimPitch = 0.02;
  private speedTarget = 0;
  private dynP = 0;
  private dynPV = 0;
  private dynR = 0;
  private dynRV = 0;
  private ammo = [34, 20];
  private loaded = 0;
  private reloadT = 0;
  private mgAmmo = 2400;
  private mgCd = 0;
  private smoke = 2;
  private smokeCd = 0;
  private trackAcc = 0;
  private recoil = 0;
  private zoom = false;
  private readonly aim: RayHit = { point: new THREE.Vector3(), dist: 0, ent: null };
  private readonly gunBaseZ: number;
  private engineCd = 0;
  readonly aimPoint = new THREE.Vector3();
  /** Autopilot target (shots). */
  private auto: THREE.Vector3 | null = null;

  constructor(readonly ent: Ent, private readonly c: ControllerCtx) {
    this.aimYaw = ent.yaw;
    this.gunBaseZ = ent.rig?.gun?.position.z ?? 0;
    ent.hp = ent.maxHp = 200;
    this.hud.maxHp = 200;
  }

  /** Turn the view (and so the turret) toward a point, as the mouse would; nothing stays pinned. */
  lookAt(p: THREE.Vector3): void {
    const dx = p.x - this.ent.pos.x, dz = p.z - this.ent.pos.z;
    this.aimYaw = Math.atan2(-dx, -dz);
    this.aimPitch = Math.max(-0.32, Math.min(0.42, Math.atan2(p.y - this.ent.pos.y - 3, Math.hypot(dx, dz))));
  }

  aimAt(p: THREE.Vector3): void {
    this.auto = p.clone();
    const dx = p.x - this.ent.pos.x, dz = p.z - this.ent.pos.z;
    this.aimYaw = Math.atan2(-dx, -dz);
    this.aimPitch = Math.atan2(p.y - this.ent.pos.y - 3, Math.hypot(dx, dz)) + 0.03;
  }

  /**
   * Owner item 32: «Ir al combate» inside a battle drives the tank at tactical speed to this point (the hottest stretch
   * of the line), steering by itself; any driving key takes over. Cleared on arrival (within 45 m).
   */
  driveTo: THREE.Vector3 | null = null;
  /** Called once when the drive ends: the point reached, a driving key pressed, or stuck for 6 s. */
  onDriveEnd: ((why: 'arrived' | 'manual' | 'stuck') => void) | null = null;
  private driveStuck = 0;
  private driveBest = Infinity;

  /** Gunner's sight on/off (staging; players hold the right mouse button). */
  setZoom(on: boolean): void {
    this.zoom = on;
    this.forceZoom = on;
  }
  private forceZoom = false;

  /** Snap turret and gun onto the current aim (staging). */
  snapTurret(): void {
    const e = this.ent;
    e.turretYaw = angleDelta(e.yaw, this.aimYaw);
    this.updateAim();
    this.solveGun(100);
  }

  /** Load AP (0) or HE (1) now (staging; players press 1 / 2). */
  selectAmmo(i: 0 | 1): void {
    this.loaded = i;
  }

  fire(): void {
    this.reloadT = 0;
    this.shoot();
  }

  /** Move the drive's goal (the hot stretch moved): headway is measured afresh. */
  retarget(p: THREE.Vector3): void {
    if (!this.driveTo) return;
    this.driveTo.copy(p);
    this.driveBest = Infinity;
    this.driveStuck = 0;
  }

  private endDrive(why: 'arrived' | 'manual' | 'stuck'): void {
    this.driveTo = null;
    this.driveStuck = 0;
    this.driveBest = Infinity;
    const cb = this.onDriveEnd;
    this.onDriveEnd = null;
    cb?.(why);
  }

  update(dt: number, allowInput: boolean): void {
    const c = this.c;
    const e = this.ent;
    const inp = c.input;
    if (!e.alive) return;
    if (dt <= 0) return;
    // --- Look -------------------------------------------------------------------------------
    if (allowInput) {
      inp.takeMouse(MOUSE);
      const k = 0.0022 * c.sens() * (this.zoom ? 0.25 : 1);
      this.aimYaw -= MOUSE.x * k;
      this.aimPitch -= MOUSE.y * k * (c.invertY() ? -1 : 1);
      this.aimPitch = Math.max(-0.32, Math.min(0.42, this.aimPitch));
      this.zoom = inp.rmb || this.forceZoom;
    }
    // --- Drive ------------------------------------------------------------------------------
    let fwdIn = allowInput ? (inp.down('KeyW') || inp.down('ArrowUp') ? 1 : 0) - (inp.down('KeyS') || inp.down('ArrowDown') ? 1 : 0) : 0;
    let turnIn = allowInput ? (inp.down('KeyA') || inp.down('ArrowLeft') ? 1 : 0) - (inp.down('KeyD') || inp.down('ArrowRight') ? 1 : 0) : 0;
    let cruise = 17;
    if (this.driveTo) {
      if (fwdIn !== 0 || turnIn !== 0) this.endDrive('manual');
      else {
        const dx = this.driveTo.x - e.pos.x, dz = this.driveTo.z - e.pos.z;
        const dist = Math.hypot(dx, dz);
        // No headway for 10 s (a house, a cliff, a slope too steep, circling): the player drives from here.
        if (dist < this.driveBest - 8) {
          this.driveBest = dist;
          this.driveStuck = 0;
        } else this.driveStuck += dt;
        if (dist < 45 || this.driveStuck > 10) this.endDrive(dist < 45 ? 'arrived' : 'stuck');
        else {
          const turn = angleDelta(e.yaw, Math.atan2(-dx, -dz));
          turnIn = Math.max(-1, Math.min(1, turn * 2.5));
          // Slow in tight turns and for the last stretch.
          fwdIn = 1;
          cruise = Math.abs(turn) > 0.9 ? 4 : Math.min(14, 4 + dist * 0.08);
        }
      }
    }
    this.speedTarget = fwdIn > 0 ? Math.min(cruise, c.speedCap) : fwdIn < 0 ? -Math.min(6.5, c.speedCap) : 0;
    forwardOf(e.yaw, DIR);
    c.ground.normalAt(e.pos.x, e.pos.z, N, 2.5);
    const slopeAlong = -(N.x * DIR.x + N.z * DIR.z); // >0 uphill
    let acc: number;
    if (this.speedTarget === 0) acc = -Math.sign(e.speed) * Math.min(Math.abs(e.speed) / dt, 3.5);
    else if (Math.sign(this.speedTarget - e.speed) === Math.sign(e.speed) || e.speed === 0) acc = Math.sign(this.speedTarget - e.speed) * 4.6;
    else acc = Math.sign(this.speedTarget - e.speed) * 9;
    if (this.speedTarget !== 0 && Math.abs(this.speedTarget - e.speed) < Math.abs(acc) * dt) acc = (this.speedTarget - e.speed) / dt;
    acc -= 9.81 * slopeAlong * 0.55;
    const prevSpeed = e.speed;
    e.speed += acc * dt;
    if (this.speedTarget === 0 && Math.abs(e.speed) < 0.15 && Math.abs(slopeAlong) < 0.25) e.speed = 0;
    const turnRate = 0.78 - 0.3 * Math.min(1, Math.abs(e.speed) / 17);
    const yawRate = turnIn * turnRate;
    e.yaw += yawRate * dt;
    // Turret keeps its world heading while the hull turns (stabilizer).
    e.turretYaw -= yawRate * dt;
    forwardOf(e.yaw, DIR);
    const nx = e.pos.x + DIR.x * e.speed * dt, nz = e.pos.z + DIR.z * e.speed * dt;
    if (c.ground.heightAt(nx + DIR.x * 4 * Math.sign(e.speed), nz + DIR.z * 4 * Math.sign(e.speed)) < 0.5) {
      e.speed *= 0.5;
    } else {
      e.pos.x = nx;
      e.pos.z = nz;
    }
    // Obstacles and other vehicles
    for (const o of c.obstacles) {
      const dx = e.pos.x - o.x, dz = e.pos.z - o.z;
      const r = o.r + 3.2;
      const d2 = dx * dx + dz * dz;
      if (d2 < r * r && d2 > 1e-4) {
        // Owner item 32: a small house rammed at speed comes down (at war; command mode decides).
        if (c.ramObstacle && Math.abs(e.speed) > 3 && c.ramObstacle(e, o, Math.abs(e.speed))) {
          e.speed *= 0.55;
          c.shake(0.5);
          continue;
        }
        const d = Math.sqrt(d2);
        e.pos.x += (dx / d) * (r - d);
        e.pos.z += (dz / d) * (r - d);
        if (Math.abs(e.speed) > 4) c.shake(0.2);
        e.speed *= 0.6;
      }
    }
    let blocked = false;
    c.world.forEachIn(e.pos.x - 8, e.pos.z - 8, e.pos.x + 8, e.pos.z + 8, (o) => {
      if (o === e || o.kind === 'jet' || ENT_NAVAL.has(o.kind)) return;
      const man = !o.rig;
      const dx = e.pos.x - o.pos.x, dz = e.pos.z - o.pos.z;
      const r = man ? e.radius * 0.85 + 0.35 : o.radius + e.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r || d2 < 1e-4) return;
      const d = Math.sqrt(d2);
      // Closing speed along the line between the two (positive = driving into it).
      const closing = -((e.vel.x - o.vel.x) * dx + (e.vel.z - o.vel.z) * dz) / d;
      const res = c.ram ? c.ram(e, o, closing) : man ? 'pass' : 'block';
      if (res === 'pass') return;
      e.pos.x += (dx / d) * (r - d);
      e.pos.z += (dz / d) * (r - d);
      e.speed *= man ? 0 : 0.8;
      blocked = true;
    });
    void blocked;
    this.hud.boundary = false;
    e.vel.copy(DIR).multiplyScalar(e.speed);
    e.pos.y = c.ground.heightAt(e.pos.x, e.pos.z);
    // --- Suspension: terrain tilt + spring-damped dynamics ------------------------------------
    const cy = Math.cos(e.yaw), sy = Math.sin(e.yaw);
    const tp = Math.atan2(N.x * -sy + N.z * -cy, N.y);
    const tr = Math.atan2(N.x * cy + N.z * -sy, N.y);
    const accel = (e.speed - prevSpeed) / dt;
    this.dynPV += (-this.dynP * 55 - this.dynPV * 7 + accel * 0.012) * dt;
    this.dynP += this.dynPV * dt;
    this.dynRV += (-this.dynR * 45 - this.dynRV * 6 - yawRate * e.speed * 0.004) * dt;
    this.dynR += this.dynRV * dt;
    // Road noise
    const bump = Math.abs(e.speed) * 0.0009 * Math.sin(c.world.time * 23 + e.pos.x * 0.7);
    const k = 1 - Math.exp(-10 * dt);
    e.tiltP += (-tp + this.dynP + bump - e.tiltP) * k;
    e.tiltR += (-tr + this.dynR - e.tiltR) * k;
    // --- Tracks & dust ------------------------------------------------------------------------
    this.trackAcc += Math.abs(e.speed) * dt + Math.abs(yawRate) * dt * 1.5;
    if (this.trackAcc > 0.95) {
      this.trackAcc = 0;
      const rx = cy * 1.42, rz = -sy * 1.42;
      c.fx.trackMark(e.pos.x + rx, e.pos.z + rz, e.yaw, 0.72, 1.1);
      c.fx.trackMark(e.pos.x - rx, e.pos.z - rz, e.yaw, 0.72, 1.1);
    }
    if (Math.abs(e.speed) > 2) {
      const bx = e.pos.x - DIR.x * 3.6, bz = e.pos.z - DIR.z * 3.6;
      c.fx.dust(bx + cy * 1.4, e.pos.y, bz - sy * 1.4, -e.vel.x, -e.vel.z, Math.min(0.9, Math.abs(e.speed) * dt * 3));
      c.fx.dust(bx - cy * 1.4, e.pos.y, bz + sy * 1.4, -e.vel.x, -e.vel.z, Math.min(0.9, Math.abs(e.speed) * dt * 3));
      // Exhaust
      if (c.fx.rand() < dt * 6) c.fx.particles.emit(0, e.pos.x - DIR.x * 3.9, e.pos.y + 1.6, e.pos.z - DIR.z * 3.9, -DIR.x, 1.2, -DIR.z, 1.6, 0.4, 2.2, 0.1, 0.1, 0.1, 0.35);
    }
    this.engineCd -= dt;
    if (fwdIn !== 0 && this.engineCd <= 0 && Math.abs(prevSpeed) < 1) {
      c.fx.hooks.sound('tankEngine', 0.5);
      this.engineCd = 4;
    }
    // --- Turret & gun -------------------------------------------------------------------------
    this.updateAim();
    const want = angleDelta(e.yaw, this.aimYaw);
    const terr = angleDelta(e.turretYaw, want);
    const trav = 0.72;
    e.turretYaw += Math.max(-trav * dt, Math.min(trav * dt, terr));
    this.solveGun(dt);
    // --- Weapons ------------------------------------------------------------------------------
    this.reloadT = Math.max(0, this.reloadT - dt);
    this.mgCd -= dt;
    this.smokeCd -= dt;
    if (allowInput) {
      if (inp.hit('Digit1') && this.loaded !== 0) this.switchAmmo(0);
      if (inp.hit('Digit2') && this.loaded !== 1) this.switchAmmo(1);
      const fresh = inp.lmbHit();
      const trigger = fresh || inp.lmb;
      if (trigger && this.reloadT <= 0 && (this.ammo[this.loaded] <= 0 || this.clear('main', fresh))) this.shoot();
      const mgFresh = inp.hit('Space');
      if (inp.down('Space') && this.mgCd <= 0 && this.mgAmmo > 0 && this.clear('mg', mgFresh)) {
        // The coax's real rate (~700 rounds a minute) whatever the frame rate: every round due in this step goes.
        // A fresh press fires now; a held trigger catches up with the time that passed (at most a short burst).
        if (mgFresh) this.mgCd = Math.min(this.mgCd, 0);
        if (this.mgCd < -0.35) this.mgCd = -0.35;
        for (let k = 0; k < 6 && this.mgCd <= 0 && this.mgAmmo > 0; k++) this.mg();
      }
      if (inp.hit('KeyC') && this.smoke > 0 && this.smokeCd <= 0) this.popSmoke();
    }
    this.recoil = Math.max(0, this.recoil - dt * 2.2);
    if (e.rig?.gun) e.rig.gun.position.z = this.gunBaseZ + Math.pow(this.recoil, 2) * 0.9;
    this.fillHud();
  }

  /** Owner item 31: what this shot would hit is checked before it goes (command mode asks about a nation at peace). */
  private clear(weapon: 'main' | 'mg', fresh: boolean): boolean {
    const c = this.c;
    if (!c.clearToFire) return true;
    c.world.muzzleOf(this.ent, G1, G2);
    const speed = weapon === 'mg' ? 850 : this.loaded === 0 ? AP_SPEED : HE_SPEED;
    const chk: ShotCheck = { weapon, from: G1, dir: G2, speed, gravity: weapon === 'mg' ? 3 : 9.81, range: weapon === 'mg' ? 1900 : 5000, aimPoint: this.aimPoint, aimEnt: this.aim.ent, target: null, fresh };
    return c.clearToFire(chk);
  }

  private updateAim(): void {
    const cam = this.c.camera;
    cam.getWorldDirection(T1);
    raycast(this.c.world, cam.position, T1, 5000, this.ent, this.aim);
    if (this.auto) this.aim.point.copy(this.auto);
    this.aimPoint.copy(this.aim.point);
  }

  private solveGun(dt: number): void {
    const e = this.ent;
    const w = this.c.world;
    w.muzzleOf(e, T2, T3);
    const dx = this.aimPoint.x - T2.x, dz = this.aimPoint.z - T2.z;
    const hd = Math.hypot(dx, dz);
    const sp = this.loaded === 0 ? AP_SPEED : HE_SPEED;
    const pitch = ballisticPitch(hd, this.aimPoint.y - T2.y, sp, 9.81);
    const hullPitchAtTurret = e.tiltP * Math.cos(e.turretYaw) - e.tiltR * Math.sin(e.turretYaw) * 0;
    const local = Math.max(-0.14, Math.min(0.36, pitch - hullPitchAtTurret));
    const perr = local - e.gunPitch;
    const rate = dt >= 1 ? 100 : 0.42 * dt;
    e.gunPitch += Math.max(-rate, Math.min(rate, perr));
  }

  private switchAmmo(t: number): void {
    this.loaded = t;
    this.reloadT = RELOAD;
    this.c.fx.hooks.sound('build', 0.2);
  }

  private shoot(): void {
    const e = this.ent;
    const c = this.c;
    if (this.ammo[this.loaded] <= 0) {
      if (this.ammo[1 - this.loaded] > 0) this.switchAmmo(1 - this.loaded);
      return;
    }
    this.ammo[this.loaded]--;
    c.world.muzzleOf(e, T2, T3);
    const ap = this.loaded === 0;
    // Owner item 32: HE is a fragmentation round (lethal to men in the open over ~12 m, world.splashDamage).
    c.world.fireShell(e, 0, T2, T3, ap ? AP_SPEED : HE_SPEED, ap ? 60 : 40, ap ? 2.5 : 15, ap, true, 1.2);
    c.fx.muzzle(T2, T3, 1.25, true);
    c.fx.hooks.sound('tankCannon', 1);
    c.shake(0.55);
    this.recoil = 1;
    // Recoil rocks the hull opposite to the gun direction.
    const rel = e.turretYaw;
    this.dynPV += Math.cos(rel) * 0.9;
    this.dynRV += Math.sin(rel) * 0.7;
    this.reloadT = RELOAD;
    if (this.ammo[this.loaded] <= 0 && this.ammo[1 - this.loaded] > 0) this.loaded = 1 - this.loaded;
  }

  private mg(): void {
    const e = this.ent;
    const c = this.c;
    this.mgCd += 0.085;
    this.mgAmmo--;
    c.world.muzzleOf(e, T2, T3);
    // Coax sits right of the main gun, a few meters back.
    T1.set(0.32, 0.05, 4.9);
    if (e.rig?.gun) {
      T1.applyQuaternion(e.rig.gun.getWorldQuaternion(QT));
      T2.add(T1);
    }
    T3.x += (c.fx.rand() - 0.5) * 0.006;
    T3.y += (c.fx.rand() - 0.5) * 0.006;
    T3.normalize();
    c.world.fireBullet(e, 0, T2, T3, 850, 9, this.mgAmmo % 3 === 0, true, 0xffc070, 0.22, 2.2);
    c.fx.gunFlash(T2, T3, 0.7);
    if (this.mgAmmo % 4 === 0) c.fx.hooks.sound('gunfire', 0.35);
  }

  private popSmoke(): void {
    const e = this.ent;
    const c = this.c;
    this.smoke--;
    this.smokeCd = 3;
    forwardOf(e.yaw + e.turretYaw, T3);
    c.fx.smokeScreen(e.pos, T3);
    c.world.addSmoke(e.pos.x + T3.x * 26, e.pos.y + 3, e.pos.z + T3.z * 26, 24, 22);
    c.fx.hooks.sound('explosionSmall', 0.25);
  }

  private lastZoom = false;

  /** World position of the gunner's sight. */
  private sightPos(out: THREE.Vector3): THREE.Vector3 {
    const e = this.ent;
    if (e.rig?.turret) e.rig.turret.getWorldPosition(out);
    else out.copy(e.pos);
    out.y += 1.3;
    return out;
  }

  updateCamera(dt: number): void {
    const e = this.ent;
    const cam = this.c.camera;
    if (this.zoom !== this.lastZoom) {
      // Keep looking at the same point when switching between the chase camera and the gunner's sight.
      this.lastZoom = this.zoom;
      const from = this.zoom ? this.sightPos(T1) : T1.copy(e.pos).setY(e.pos.y + CAM_PIVOT + CAM_LIFT);
      T2.subVectors(this.aimPoint, from);
      const hd = Math.hypot(T2.x, T2.z);
      if (hd > 1) {
        this.aimYaw = Math.atan2(-T2.x, -T2.z);
        this.aimPitch = Math.max(-0.32, Math.min(0.42, Math.atan2(T2.y, hd)));
      }
    }
    const cp = Math.cos(this.aimPitch);
    DIR.set(-Math.sin(this.aimYaw) * cp, Math.sin(this.aimPitch), -Math.cos(this.aimYaw) * cp);
    const targetFov = this.zoom ? 13 : 58;
    cam.fov += (targetFov - cam.fov) * Math.min(1, dt * 12 + (dt === 0 ? 1 : 0));
    if (this.zoom) {
      // Gunner's sight: at the turret front, looking along the aim.
      this.sightPos(T1);
      T1.addScaledVector(DIR, 1.5);
      cam.position.copy(T1);
    } else {
      T1.copy(e.pos);
      T1.y += CAM_PIVOT;
      cam.position.copy(T1).addScaledVector(DIR, -CAM_DIST);
      cam.position.y += CAM_LIFT;
      const gh = this.c.ground.surfaceAt(cam.position.x, cam.position.z) + 1.4;
      if (cam.position.y < gh) cam.position.y = gh;
    }
    T2.copy(cam.position).add(DIR);
    cam.up.set(0, 1, 0);
    cam.lookAt(T2);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  private fillHud(): void {
    const e = this.ent;
    const c = this.c;
    const h = this.hud;
    h.hp = Math.max(0, e.hp);
    h.maxHp = e.maxHp;
    h.heading = -this.aimYaw;
    h.hullHeading = -e.yaw;
    h.turretRel = -e.turretYaw;
    h.speedKmh = Math.abs(e.speed) * 3.6;
    h.reload = 1 - this.reloadT / RELOAD;
    h.rangeM = this.aim.dist;
    h.zoom = this.zoom;
    h.weapons.length = 0;
    h.weapons.push(
      { key: '1', label: 'command.ammo.ap', count: this.ammo[0], max: 34, active: this.loaded === 0, ready: this.loaded === 0 ? h.reload : 1 },
      { key: '2', label: 'command.ammo.he', count: this.ammo[1], max: 20, active: this.loaded === 1, ready: this.loaded === 1 ? h.reload : 1 },
      { key: '␣', label: 'command.ammo.mg', count: this.mgAmmo, max: 2400, active: false, ready: 1 },
      { key: 'C', label: 'command.ammo.smoke', count: this.smoke, max: 2, active: false, ready: this.smokeCd > 0 ? 1 - this.smokeCd / 3 : 1 },
    );
    // Gun indicator: simulate the shell from the real muzzle direction.
    c.world.muzzleOf(e, T2, T3);
    const sp = this.loaded === 0 ? AP_SPEED : HE_SPEED;
    T3.multiplyScalar(sp);
    const step = 0.03;
    let hit = false;
    for (let i = 0; i < 180 && !hit; i++) {
      T1.copy(T2);
      T3.y -= 9.81 * step;
      T2.addScaledVector(T3, step);
      if (T2.y < c.ground.surfaceAt(T2.x, T2.z)) {
        hit = true;
        break;
      }
      if (i % 2 === 0) {
        for (const o of c.world.ents) {
          if (!o.alive || o === e || o.team === 0) continue;
          c.world.center(o, N);
          if (segSphere(T1, T2, N, o.radius)) {
            hit = true;
            break;
          }
        }
      }
    }
    project(c.camera, T2, c.viewW, c.viewH, h.gun);
    this.updateFocus();
  }

  private focusEnt: Ent | null = null;
  private focusN = 0;

  /**
   * Owner item 32: the target under the reticle (or the nearest hostile within ~70 px of it) is bracketed, with its
   * kind and range; a moving one gets the lead point for the loaded round (where to aim so the shell meets it).
   */
  private updateFocus(): void {
    const c = this.c;
    const h = this.hud;
    const cam = c.camera;
    const W = c.viewW, H = c.viewH;
    if (this.focusN++ % 3 === 0) {
      const a = this.aim.ent;
      let best: Ent | null = a && a.alive && a.team === 1 && !a.neutral ? a : null;
      if (!best) {
        let bd = 70 * 70;
        const cx = W / 2, cy = H / 2;
        for (const o of c.world.ents) {
          if (!o.alive || o.team !== 1 || o.neutral || o.player) continue;
          const d = o.pos.distanceTo(cam.position);
          if (d > 2600) continue;
          c.world.center(o, N);
          N.project(cam);
          if (N.z > 1 || N.z < -1) continue;
          const dx = (N.x * 0.5 + 0.5) * W - cx, dy = (-N.y * 0.5 + 0.5) * H - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 < bd) {
            bd = d2;
            best = o;
          }
        }
      }
      this.focusEnt = best;
    }
    const f = this.focusEnt;
    h.focus.visible = false;
    h.lead.visible = false;
    if (!f || !f.alive) return;
    c.world.center(f, T1);
    const dist = T1.distanceTo(this.ent.pos);
    project(cam, T1, W, H, h.focus);
    const ppm = H / (2 * Math.tan((cam.fov * Math.PI) / 360) * Math.max(1, T1.distanceTo(cam.position)));
    h.focus.r = Math.max(9, Math.min(80, (f.radius + 0.4) * ppm * 1.2));
    h.focus.kind = f.kind;
    h.focus.distM = dist;
    if (f.speed > 0.8 || f.vel.lengthSq() > 0.64) {
      const tof = dist / (this.loaded === 0 ? AP_SPEED : HE_SPEED);
      T2.copy(T1).addScaledVector(f.vel, tof);
      project(cam, T2, W, H, h.lead);
      if (Math.hypot(h.lead.x - h.focus.x, h.lead.y - h.focus.y) < 3) h.lead.visible = false;
    }
  }
}

const QT = new THREE.Quaternion();
const ENT_NAVAL = new Set(['ship', 'boat', 'merchant', 'transport']);
