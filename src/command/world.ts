// FRONT ULTRA — command mode: the local battle simulation (owner: command).
// Entities (vehicles, soldiers, aircraft, ships, emplacements), projectiles (shells, bullets, guided missiles,
// bombs, flares), damage with armor facing, kills (wrecks, turret toss, burning), smoke screens, and the tallies that
// feed the strategic result. AI behaviours live in ai.ts; the player's vehicle controllers in player/*.ts.
// Units: meters, seconds. Local frame: x = east, y = up (m ASL), z = south; model forward = -Z; yaw = rotation.y.

import * as THREE from 'three';
import type { CommandKind } from '../shared/types';
import type { Rng } from '../shared/rng';
import type { Effects } from './fx/effects';
import type { Ground } from './env/ground';
import type { CmdMaterials, Team } from './models/materials';
import { buildAa, buildBattery, buildSam, buildTruck } from './models/vehicles';
import { buildArmorIfv, buildArmorTank } from './models/armor';
import { buildBombGeometry, buildJet, buildMissileGeometry } from './models/aircraft';
import { buildDestroyer, buildPatrolBoat } from './models/ships';
import { soldierGeometry } from './models/props';

export type EntKind = 'tank' | 'ifv' | 'aa' | 'sam' | 'truck' | 'soldier' | 'at' | 'jet' | 'ship' | 'boat' | 'battery';

export const ENT_DEFS: Record<EntKind, { hp: number; radius: number; height: number; troops: number; air: boolean; naval: boolean; vehicle: boolean }> = {
  tank: { hp: 100, radius: 3.6, height: 2.6, troops: 800, air: false, naval: false, vehicle: true },
  ifv: { hp: 70, radius: 3.3, height: 2.6, troops: 450, air: false, naval: false, vehicle: true },
  aa: { hp: 60, radius: 3.4, height: 3.2, troops: 500, air: false, naval: false, vehicle: true },
  sam: { hp: 45, radius: 4.2, height: 3.4, troops: 700, air: false, naval: false, vehicle: true },
  truck: { hp: 30, radius: 3.5, height: 3.0, troops: 150, air: false, naval: false, vehicle: true },
  soldier: { hp: 18, radius: 0.6, height: 1.8, troops: 40, air: false, naval: false, vehicle: false },
  at: { hp: 18, radius: 0.6, height: 1.8, troops: 60, air: false, naval: false, vehicle: false },
  jet: { hp: 60, radius: 8, height: 0, troops: 900, air: true, naval: false, vehicle: true },
  ship: { hp: 320, radius: 55, height: 10, troops: 2500, air: false, naval: true, vehicle: true },
  boat: { hp: 90, radius: 18, height: 5, troops: 500, air: false, naval: true, vehicle: true },
  battery: { hp: 160, radius: 7, height: 5, troops: 900, air: false, naval: false, vehicle: true },
};

export interface Rig {
  root: THREE.Group;
  body: THREE.Object3D;
  turret: THREE.Object3D | null;
  gun: THREE.Object3D | null;
  muzzle: THREE.Object3D | null;
  radar: THREE.Object3D | null;
  flame: THREE.Mesh | null;
  missiles: THREE.Mesh[];
  meshes: THREE.Mesh[];
  ciws: THREE.Object3D[];
  gunPort: THREE.Object3D | null;
}

export interface Ent {
  id: number;
  kind: EntKind;
  team: Team;
  alive: boolean;
  player: boolean;
  hp: number;
  maxHp: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  speed: number;
  /** Full orientation for aircraft / ships (roll, pitch). Ground vehicles derive it from terrain. */
  quat: THREE.Quaternion;
  radius: number;
  height: number;
  rig: Rig | null;
  /** Soldier instance slot. */
  inst: number;
  variant: 0 | 1;
  turretYaw: number;
  gunPitch: number;
  // AI
  target: Ent | null;
  retarget: number;
  fireCd: number;
  fireCd2: number;
  burst: number;
  moveT: THREE.Vector3;
  state: number;
  stateT: number;
  seed: number;
  /** Suspension / visual tilt state (ground vehicles). */
  pitchV: number;
  rollV: number;
  tiltP: number;
  tiltR: number;
  // meta
  value: number;
  strategicId: number;
  group: number;
  burnT: number;
  deadT: number;
  flares: number;
  missiles: number;
  bank: number;
  throttle: number;
  trackAcc: number;
  lastHitBy: Team | -1;
  /** Turret toss after a catastrophic kill. */
  tossV: THREE.Vector3 | null;
  tossSpin: number;
  /** Incoming guided missile (for evasion / warnings). */
  threatT: number;
}

export type ProjKind = 'shell' | 'bullet' | 'missile' | 'bomb' | 'flare';

export interface Proj {
  alive: boolean;
  kind: ProjKind;
  team: Team;
  owner: Ent | null;
  player: boolean;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  dmg: number;
  splash: number;
  /** AP shells: armor-piercing (more direct damage, small splash). */
  ap: boolean;
  gravity: number;
  tracer: boolean;
  color: number;
  width: number;
  /** Guided missiles */
  target: Ent | null;
  decoy: Proj | null;
  speed: number;
  turn: number;
  heat: boolean;
  scale: number;
  mesh: THREE.Mesh | null;
  airOnly: boolean;
  seaSkim: boolean;
  age: number;
}

export interface SmokeZone {
  x: number;
  y: number;
  z: number;
  r: number;
  until: number;
}

export interface WorldHooks {
  /** A player projectile hit something (hit marker). kill = the hit destroyed it. */
  onPlayerHit(e: Ent, kill: boolean, ricochet: boolean): void;
  /** Any kill (kill feed, objective). */
  onKill(victim: Ent, killer: Ent | null, byPlayer: boolean): void;
  /** Player took damage (damage vignette, direction indicator). */
  onPlayerDamaged(amount: number, from: THREE.Vector3 | null): void;
  onPlayerKilled(): void;
}

const TMP = new THREE.Vector3();
const TMP2 = new THREE.Vector3();
const TMP3 = new THREE.Vector3();
const FWD = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Effect size multiplier for fires and damage smoke on big hulls. */
function fxSize(kind: EntKind): number {
  return kind === 'ship' ? 3 : kind === 'boat' ? 1.8 : kind === 'battery' ? 1.5 : 1;
}

export function forwardOf(yaw: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
}

/** Low-arc launch elevation (rad) to hit a point dx away horizontally and dy up, with speed v and gravity g. */
export function ballisticPitch(dx: number, dy: number, v: number, g: number): number {
  if (g <= 0 || dx < 1) return Math.atan2(dy, Math.max(dx, 0.001));
  const v2 = v * v;
  const disc = v2 * v2 - g * (g * dx * dx + 2 * dy * v2);
  if (disc < 0) return Math.PI / 4;
  return Math.atan((v2 - Math.sqrt(disc)) / (g * dx));
}

export class World {
  readonly group = new THREE.Group();
  readonly ents: Ent[] = [];
  readonly projs: Proj[] = [];
  readonly smokes: SmokeZone[] = [];
  private nextId = 1;
  time = 0;
  player: Ent | null = null;
  kind: CommandKind = 'tank';
  difficulty = 1;
  /** Enemy accuracy multiplier (difficulty). */
  enemySkill = 1;
  hooks: WorldHooks = {
    onPlayerHit: () => undefined, onKill: () => undefined, onPlayerDamaged: () => undefined, onPlayerKilled: () => undefined,
  };
  readonly stats = { shots: 0, hits: 0, kills: 0, troops: 0, killsByKind: new Map<EntKind, number>(), strategicKilled: [] as number[] };
  private readonly templates = new Map<string, THREE.Group>();
  private readonly soldierMeshes: THREE.InstancedMesh[] = [];
  private readonly soldierSlots: (Ent | null)[][] = [[], [], [], []];
  private readonly missileGeo: THREE.BufferGeometry;
  private readonly bombGeo: THREE.BufferGeometry;
  private readonly ordPool: THREE.Mesh[] = [];
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly sc = new THREE.Vector3();
  /** Strategic unit groups: group id -> strategic unit id. */
  readonly strategicGroups = new Map<number, number>();

  constructor(
    readonly mats: CmdMaterials,
    readonly ground: Ground,
    readonly fx: Effects,
    public rng: Rng,
  ) {
    this.group.name = 'cmd-world';
    // Two design families: the player's side fields western armor, the enemy eastern armor.
    this.templates.set('tank:0', buildArmorTank('west'));
    this.templates.set('tank:1', buildArmorTank('east'));
    this.templates.set('ifv:0', buildArmorIfv('west'));
    this.templates.set('ifv:1', buildArmorIfv('east'));
    this.templates.set('aa', buildAa());
    this.templates.set('sam', buildSam());
    this.templates.set('truck', buildTruck());
    this.templates.set('battery', buildBattery());
    this.templates.set('jet', buildJet());
    this.templates.set('ship', buildDestroyer());
    this.templates.set('boat', buildPatrolBoat());
    const sg = [soldierGeometry(0), soldierGeometry(1)];
    for (let t = 0; t < 2; t++) {
      for (let v = 0; v < 2; v++) {
        const im = new THREE.InstancedMesh(sg[v], mats.soldier, 160);
        im.count = 0;
        im.castShadow = true;
        im.receiveShadow = true;
        im.frustumCulled = false;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.name = `soldiers-${t}-${v}`;
        im.setColorAt(0, new THREE.Color(1, 1, 1));
        this.soldierMeshes.push(im);
        this.group.add(im);
      }
    }
    this.missileGeo = buildMissileGeometry(1);
    this.bombGeo = buildBombGeometry();
    for (let i = 0; i < 48; i++) {
      const m = new THREE.Mesh(i < 36 ? this.missileGeo : this.bombGeo, mats.ordnance);
      m.visible = false;
      m.castShadow = false;
      m.userData.bomb = i >= 36;
      this.ordPool.push(m);
      this.group.add(m);
    }
    for (let i = 0; i < 700; i++) this.projs.push(newProj());
  }

  // ---------------------------------------------------------------------------------------------
  // Warmup: one of everything with every material so all programs compile during loading.
  // ---------------------------------------------------------------------------------------------
  private warm: THREE.Object3D[] = [];
  warmup(on: boolean): void {
    if (on) {
      let x = -40;
      for (const k of ['tank', 'ifv', 'aa', 'sam', 'truck', 'battery', 'jet', 'ship', 'boat'] as const) {
        for (const team of [0, 1] as const) {
          const rig = this.makeRig(k, team);
          rig.root.position.set(x, 0, -30);
          x += 6;
          this.group.add(rig.root);
          this.warm.push(rig.root);
        }
      }
      const w = this.makeRig('tank', 0);
      this.wreckRig(w);
      this.group.add(w.root);
      this.warm.push(w.root);
      for (const im of this.soldierMeshes) {
        im.count = 1;
        im.setMatrixAt(0, this.m4.makeTranslation(0, 0, -10));
      }
      for (const m of this.ordPool.slice(0, 1).concat(this.ordPool.slice(40, 41))) m.visible = true;
    } else {
      for (const o of this.warm) this.group.remove(o);
      this.warm.length = 0;
      for (const im of this.soldierMeshes) im.count = 0;
      for (const m of this.ordPool) m.visible = false;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Rigs
  // ---------------------------------------------------------------------------------------------
  makeRig(kind: EntKind, team: Team): Rig {
    const k = kind === 'at' || kind === 'soldier' ? 'truck' : kind;
    const tpl = (this.templates.get(`${k}:${team}`) ?? this.templates.get(k))!;
    const root = tpl.clone(true);
    const meshes: THREE.Mesh[] = [];
    const fam = kind === 'jet' ? this.mats.jetPaint : kind === 'ship' || kind === 'boat' ? this.mats.shipPaint : this.mats.paint;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const role = m.userData.role as string;
      if (role === 'mark') m.material = this.mats.mark[team];
      else if (role === 'glass') m.material = this.mats.glass;
      else if (role === 'flame') m.material = this.mats.flame;
      else if (role === 'ordnance') m.material = this.mats.ordnance;
      else if (role === 'prop') m.material = this.mats.prop;
      else m.material = fam[team];
      meshes.push(m);
    });
    const get = (n: string) => root.getObjectByName(n) ?? null;
    const missiles: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      const m = get(`msl${i}`) as THREE.Mesh | null;
      if (m) missiles.push(m);
    }
    const ciws: THREE.Object3D[] = [];
    for (let i = 0; i < 2; i++) {
      const c = get(`ciws${i}`);
      if (c) ciws.push(c);
    }
    return {
      root, body: get('body') ?? root, turret: get('turret'), gun: get('gun'), muzzle: get('muzzle'), radar: get('radar'),
      flame: get('flame') as THREE.Mesh | null, missiles, meshes, ciws, gunPort: get('gunPort'),
    };
  }

  wreckRig(r: Rig): void {
    for (const m of r.meshes) {
      const role = m.userData.role as string;
      if (role === 'flame') m.visible = false;
      else if (role !== 'prop') m.material = this.mats.wreck;
    }
    for (const m of r.missiles) m.visible = false;
  }

  // ---------------------------------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------------------------------
  spawn(kind: EntKind, team: Team, x: number, z: number, yaw: number, y?: number): Ent {
    const d = ENT_DEFS[kind];
    const e: Ent = {
      id: this.nextId++, kind, team, alive: true, player: false, hp: d.hp, maxHp: d.hp,
      pos: new THREE.Vector3(x, 0, z), vel: new THREE.Vector3(), yaw, speed: 0, quat: new THREE.Quaternion(),
      radius: d.radius, height: d.height, rig: null, inst: -1, variant: kind === 'at' ? 1 : 0, turretYaw: 0, gunPitch: 0,
      target: null, retarget: this.rng.next() * 1.5, fireCd: 3.5 + this.rng.next() * 6, fireCd2: 7 + this.rng.next() * 9, burst: 0,
      moveT: new THREE.Vector3(x, 0, z), state: 0, stateT: 0, seed: this.rng.next(),
      pitchV: 0, rollV: 0, tiltP: 0, tiltR: 0,
      value: d.troops, strategicId: -1, group: -1, burnT: 0, deadT: 0, flares: 30, missiles: 4, bank: 0, throttle: 0.7,
      trackAcc: 0, lastHitBy: -1, tossV: null, tossSpin: 0, threatT: 0,
    };
    if (kind === 'jet') {
      e.pos.y = y ?? this.ground.surfaceAt(x, z) + 800;
      e.speed = 220;
      e.quat.setFromEuler(this.e.set(0, yaw, 0));
      forwardOf(yaw, e.vel).multiplyScalar(e.speed);
    } else if (d.naval) {
      e.pos.y = 0;
      e.quat.setFromEuler(this.e.set(0, yaw, 0));
    } else {
      e.pos.y = this.ground.heightAt(x, z);
    }
    if (kind === 'soldier' || kind === 'at') {
      const slot = team * 2 + e.variant;
      const list = this.soldierSlots[slot];
      let idx = list.indexOf(null);
      if (idx < 0) {
        idx = list.length;
        list.push(null);
      }
      if (idx >= 160) {
        e.alive = false;
        return e;
      }
      list[idx] = e;
      e.inst = idx;
      const im = this.soldierMeshes[slot];
      const v = 0.85 + this.rng.next() * 0.25;
      const tc = team === 0 ? this.friendlyTint : this.enemyTint;
      im.setColorAt(idx, this.tmpColor.copy(tc).multiplyScalar(v));
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    } else {
      e.rig = this.makeRig(kind, team);
      e.rig.root.position.copy(e.pos);
      e.rig.root.rotation.y = yaw;
      this.group.add(e.rig.root);
    }
    this.ents.push(e);
    return e;
  }

  private readonly tmpColor = new THREE.Color();
  readonly friendlyTint = new THREE.Color(0.55, 0.6, 0.45);
  readonly enemyTint = new THREE.Color(0.7, 0.62, 0.48);

  setTeamTints(friendly: number, enemy: number): void {
    const f = new THREE.Color(friendly), en = new THREE.Color(enemy);
    // Uniform shades (multiplying the figures' vertex colors): olive for ours, khaki for theirs, a hint of nation color.
    this.friendlyTint.setRGB(0.36, 0.4, 0.26).lerp(f, 0.12);
    this.enemyTint.setRGB(0.55, 0.47, 0.32).lerp(en, 0.15);
  }

  /** Remove every entity / projectile (session end). */
  reset(): void {
    for (const e of this.ents) if (e.rig) this.group.remove(e.rig.root);
    this.ents.length = 0;
    for (const s of this.soldierSlots) s.length = 0;
    for (const im of this.soldierMeshes) im.count = 0;
    for (const p of this.projs) {
      p.alive = false;
      if (p.mesh) this.releaseMesh(p);
    }
    this.smokes.length = 0;
    this.player = null;
    this.time = 0;
    this.stats.shots = this.stats.hits = this.stats.kills = this.stats.troops = 0;
    this.stats.killsByKind.clear();
    this.stats.strategicKilled.length = 0;
    this.strategicGroups.clear();
    this.nextId = 1;
  }

  // ---------------------------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------------------------
  center(e: Ent, out: THREE.Vector3): THREE.Vector3 {
    out.copy(e.pos);
    if (!ENT_DEFS[e.kind].air) out.y += e.height * 0.5;
    return out;
  }

  /** Terrain + smoke line of sight between two points. */
  los(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const steps = 14;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t;
      if (this.ground.heightAt(x, z) > y + 0.5) return false;
    }
    for (const s of this.smokes) {
      if (s.until < this.time) continue;
      if (segSphere(a, b, TMP.set(s.x, s.y, s.z), s.r)) return false;
    }
    return true;
  }

  enemiesOf(team: Team): number {
    let n = 0;
    for (const e of this.ents) if (e.alive && e.team !== team) n++;
    return n;
  }

  // ---------------------------------------------------------------------------------------------
  // Projectiles
  // ---------------------------------------------------------------------------------------------
  private allocProj(): Proj | null {
    for (const p of this.projs) if (!p.alive) return p;
    return null;
  }

  private takeMesh(bomb: boolean): THREE.Mesh | null {
    for (const m of this.ordPool) if (!m.visible && !!m.userData.bomb === bomb) {
      m.visible = true;
      return m;
    }
    return null;
  }

  private releaseMesh(p: Proj): void {
    if (p.mesh) p.mesh.visible = false;
    p.mesh = null;
  }

  fireShell(owner: Ent | null, team: Team, from: THREE.Vector3, dir: THREE.Vector3, speed: number, dmg: number, splash: number, ap: boolean, player: boolean, scale = 1): Proj | null {
    const p = this.allocProj();
    if (!p) return null;
    resetProj(p, 'shell', team, owner, player);
    p.pos.copy(from);
    p.prev.copy(from);
    p.vel.copy(dir).multiplyScalar(speed);
    if (owner && !ENT_DEFS[owner.kind].air) p.vel.addScaledVector(owner.vel, 0.5);
    p.life = 12;
    p.dmg = dmg;
    p.splash = splash;
    p.ap = ap;
    p.gravity = 9.81;
    p.tracer = true;
    p.color = ap ? 0xffc070 : 0xffa050;
    p.width = 0.35 * scale;
    p.scale = scale;
    if (player) this.stats.shots++;
    return p;
  }

  fireBullet(owner: Ent | null, team: Team, from: THREE.Vector3, dir: THREE.Vector3, speed: number, dmg: number, tracer: boolean, player: boolean, color = 0xffb060, width = 0.12, life = 2.5): Proj | null {
    const p = this.allocProj();
    if (!p) return null;
    resetProj(p, 'bullet', team, owner, player);
    p.pos.copy(from);
    p.prev.copy(from);
    p.vel.copy(dir).multiplyScalar(speed);
    if (owner) p.vel.addScaledVector(owner.vel, 1);
    p.life = life;
    p.dmg = dmg;
    p.splash = 0;
    p.gravity = 3;
    p.tracer = tracer;
    p.color = color;
    p.width = width;
    if (player) this.stats.shots += 0.1;
    return p;
  }

  fireMissile(owner: Ent | null, team: Team, from: THREE.Vector3, dir: THREE.Vector3, target: Ent | null, opts: { speed: number; turn: number; dmg: number; splash: number; heat: boolean; life: number; airOnly?: boolean; seaSkim?: boolean; player: boolean; scale?: number }): Proj | null {
    const p = this.allocProj();
    if (!p) return null;
    resetProj(p, 'missile', team, owner, opts.player);
    p.pos.copy(from);
    p.prev.copy(from);
    p.speed = opts.speed;
    p.vel.copy(dir).multiplyScalar(owner ? Math.max(owner.speed, opts.speed * 0.4) : opts.speed * 0.4);
    p.target = target;
    p.turn = opts.turn;
    p.dmg = opts.dmg;
    p.splash = opts.splash;
    p.heat = opts.heat;
    p.life = opts.life;
    p.airOnly = !!opts.airOnly;
    p.seaSkim = !!opts.seaSkim;
    p.scale = opts.scale ?? 1;
    p.gravity = 0;
    p.mesh = this.takeMesh(false);
    if (p.mesh) p.mesh.scale.setScalar(p.scale);
    if (target) target.threatT = Math.max(target.threatT, 1);
    if (opts.player) this.stats.shots++;
    this.fx.playAt('missileLaunch', from, 0.8);
    return p;
  }

  dropBomb(owner: Ent | null, team: Team, from: THREE.Vector3, vel: THREE.Vector3, dmg: number, splash: number): Proj | null {
    const p = this.allocProj();
    if (!p) return null;
    resetProj(p, 'bomb', team, owner, false);
    p.pos.copy(from);
    p.prev.copy(from);
    p.vel.copy(vel);
    p.gravity = 9.81;
    p.life = 30;
    p.dmg = dmg;
    p.splash = splash;
    p.mesh = this.takeMesh(true);
    return p;
  }

  releaseFlares(e: Ent): void {
    if (e.flares <= 0) return;
    e.flares -= 2;
    for (let i = 0; i < 2; i++) {
      const p = this.allocProj();
      if (!p) return;
      resetProj(p, 'flare', e.team, e, e.player);
      p.pos.copy(e.pos);
      p.prev.copy(e.pos);
      TMP.set((i === 0 ? -1 : 1) * 30 + (this.rng.next() - 0.5) * 20, -20 - this.rng.next() * 15, 20 + this.rng.next() * 10).applyQuaternion(e.quat);
      p.vel.copy(e.vel).multiplyScalar(0.55).add(TMP);
      p.gravity = 6;
      p.life = 3.5;
      this.fx.flare(p.pos, p.vel);
    }
    // Decoy every heat seeker aimed at e with a probability.
    for (const m of this.projs) {
      if (!m.alive || m.kind !== 'missile' || !m.heat || m.target !== e) continue;
      if (this.rng.next() < (e.player ? 0.8 : 0.55)) {
        const f = this.findFlare(e);
        if (f) {
          m.decoy = f;
          m.target = null;
        }
      }
    }
  }

  private findFlare(owner: Ent): Proj | null {
    for (const p of this.projs) if (p.alive && p.kind === 'flare' && p.owner === owner) return p;
    return null;
  }

  addSmoke(x: number, y: number, z: number, r: number, dur: number): void {
    this.smokes.push({ x, y, z, r, until: this.time + dur });
    if (this.smokes.length > 24) this.smokes.shift();
  }

  // ---------------------------------------------------------------------------------------------
  // Damage
  // ---------------------------------------------------------------------------------------------
  damage(e: Ent, amount: number, from: Ent | null, player: boolean, dir: THREE.Vector3 | null): void {
    if (!e.alive) return;
    let dmg = amount;
    let ricochet = false;
    if (dir && (e.kind === 'tank' || e.kind === 'ifv')) {
      forwardOf(e.yaw, FWD);
      const d = FWD.x * dir.x + FWD.z * dir.z;
      if (d < -0.55) dmg *= 0.6; // frontal armor
      else if (d > 0.5) dmg *= 1.45; // engine deck / rear
      if (e.kind === 'tank' && d < -0.8 && amount < 30) {
        dmg *= 0.2;
        ricochet = true;
      }
    }
    if (e.player) dmg *= this.playerDamageMul;
    e.hp -= dmg;
    e.lastHitBy = from ? from.team : player ? 0 : -1;
    const kill = e.hp <= 0;
    if (player && !e.player) {
      this.stats.hits++;
      this.hooks.onPlayerHit(e, kill, ricochet && !kill);
    }
    if (e.player) this.hooks.onPlayerDamaged(dmg, from ? from.pos : dir ? TMP3.copy(e.pos).addScaledVector(dir, -50) : null);
    if (kill) this.kill(e, from, player);
  }

  /** Enemy damage vs the player scales with difficulty; set by the mission. */
  playerDamageMul = 1;
  /** Shot mode: the player cannot die. */
  godMode = false;

  kill(e: Ent, killer: Ent | null, byPlayer: boolean): void {
    if (!e.alive) return;
    if (e.player && this.godMode) {
      e.hp = e.maxHp * 0.35;
      return;
    }
    e.alive = false;
    e.hp = 0;
    e.deadT = 0;
    const d = ENT_DEFS[e.kind];
    this.center(e, TMP);
    if (e.kind === 'soldier' || e.kind === 'at') {
      this.fx.particles.emit(4, TMP.x, TMP.y, TMP.z, 0, 2, 0, 0.6, 0.2, 0.2, 0.1, 0.08, 0.06, 1);
    } else if (d.air) {
      this.fx.explosion(TMP, 2.4, 'air');
      e.burnT = 20;
    } else if (d.naval) {
      this.fx.explosion(TMP.set(e.pos.x, 6, e.pos.z), e.kind === 'ship' ? 4 : 2.6, 'vehicle');
      e.burnT = 60;
      if (e.rig) this.wreckRig(e.rig);
    } else {
      this.fx.explosion(TMP, e.kind === 'truck' ? 1.4 : 2.1, 'vehicle');
      e.burnT = 45 + this.rng.next() * 30;
      if (e.rig) {
        this.wreckRig(e.rig);
        if (e.rig.turret && (e.kind === 'tank' || e.kind === 'ifv' || e.kind === 'aa') && this.rng.next() < 0.6) {
          e.tossV = new THREE.Vector3((this.rng.next() - 0.5) * 6, 12 + this.rng.next() * 8, (this.rng.next() - 0.5) * 6);
          e.tossSpin = (this.rng.next() - 0.5) * 8;
        }
      }
    }
    if (byPlayer && !e.player && e.team !== 0) {
      this.stats.kills++;
      this.stats.troops += e.value;
      this.stats.killsByKind.set(e.kind, (this.stats.killsByKind.get(e.kind) ?? 0) + 1);
    }
    if (e.group >= 0 && this.strategicGroups.has(e.group)) {
      const alive = this.ents.some((o) => o.alive && o.group === e.group);
      if (!alive) {
        this.stats.strategicKilled.push(this.strategicGroups.get(e.group)!);
        this.strategicGroups.delete(e.group);
      }
    }
    this.hooks.onKill(e, killer, byPlayer);
    if (e.player) this.hooks.onPlayerKilled();
  }

  private splashDamage(p: Proj, at: THREE.Vector3, direct: Ent | null): void {
    if (p.splash <= 0) return;
    for (const e of this.ents) {
      if (!e.alive || e === direct) continue;
      this.center(e, TMP2);
      const d = TMP2.distanceTo(at) - e.radius * 0.5;
      if (d > p.splash) continue;
      const soft = e.kind === 'soldier' || e.kind === 'at' || e.kind === 'truck';
      const k = (1 - Math.max(0, d) / p.splash) * (soft ? 1.4 : 0.45) * (p.ap ? 0.35 : 1);
      if (e.team === p.team && !e.player) continue;
      if (e.team === p.team && e.player) continue;
      this.damage(e, p.dmg * k, p.owner, p.player, null);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------------------------
  update(dt: number): void {
    this.time += dt;
    this.updateProjectiles(dt);
    this.updateDead(dt);
    this.updateSoldierInstances();
    for (let i = this.smokes.length - 1; i >= 0; i--) if (this.smokes[i].until < this.time) this.smokes.splice(i, 1);
  }

  private updateProjectiles(dt: number): void {
    const fx = this.fx;
    for (const p of this.projs) {
      if (!p.alive) continue;
      p.age += dt;
      p.life -= dt;
      if (p.life <= 0) {
        if (p.kind === 'missile') {
          fx.explosion(p.pos, 0.8, p.pos.y - this.ground.surfaceAt(p.pos.x, p.pos.z) > 5 ? 'air' : 'ground');
        }
        this.retire(p);
        continue;
      }
      p.prev.copy(p.pos);
      if (p.kind === 'missile') this.guide(p, dt);
      else p.vel.y -= p.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);

      // Persistent visuals (meshes, smoke); one-frame sprites are drawn by renderProjectiles().
      if (p.kind === 'missile') {
        fx.trailSeg(p.prev, p.pos, p.scale);
        if (p.mesh) {
          p.mesh.position.copy(p.pos);
          TMP.copy(p.pos).add(p.vel);
          p.mesh.lookAt(TMP);
          p.mesh.rotateY(Math.PI);
        }
      } else if (p.kind === 'bomb') {
        if (p.mesh) {
          p.mesh.position.copy(p.pos);
          TMP.copy(p.pos).add(p.vel);
          p.mesh.lookAt(TMP);
          p.mesh.rotateY(Math.PI);
        }
      } else if (p.kind === 'flare') {
        if (fx.rand() < 0.6) fx.particles.emit(1, p.pos.x, p.pos.y, p.pos.z, 0, 0, 0, 2.5, 1.2, 4, 0.85, 0.85, 0.86, 0.5);
        continue;
      }

      // Collisions: entities (segment vs sphere)
      let hit: Ent | null = null;
      for (const e of this.ents) {
        if (!e.alive || e.team === p.team) continue;
        if (p.airOnly && !ENT_DEFS[e.kind].air) continue;
        this.center(e, TMP2);
        const rad = p.kind === 'bullet' ? e.radius * (ENT_DEFS[e.kind].air ? 1.1 : 0.9) : e.radius + (p.kind === 'missile' ? 4 : 0.3);
        // Quick reject
        const dx = TMP2.x - p.pos.x, dy = TMP2.y - p.pos.y, dz = TMP2.z - p.pos.z;
        const reach = rad + p.vel.length() * dt + 2;
        if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
        if (segSphere(p.prev, p.pos, TMP2, rad)) {
          hit = e;
          break;
        }
      }
      if (hit) {
        this.onHit(p, hit);
        continue;
      }
      // Ground / water
      const gh = this.ground.heightAt(p.pos.x, p.pos.z);
      const surf = Math.max(0, gh);
      if (p.pos.y <= surf) {
        p.pos.y = surf;
        const water = gh < 0.3;
        if (p.kind === 'bullet') {
          fx.bulletHit(p.pos, water);
        } else if (p.kind === 'shell' || p.kind === 'bomb' || p.kind === 'missile') {
          const big = p.kind === 'bomb' ? 3.2 : p.kind === 'missile' ? 1.2 : p.splash > 10 ? 1.6 : p.ap ? 0.9 : 1.2;
          if (water) fx.explosion(p.pos, big * 0.9, 'water');
          else if (p.ap && p.kind === 'shell') {
            this.ground.normalAt(p.pos.x, p.pos.z, TMP);
            fx.impact(p.pos, TMP, true, false);
            fx.decal(p.pos.x, p.pos.z, 2.2, 0, 0.8);
            fx.playAt('explosionSmall', p.pos, 0.35);
          } else fx.explosion(p.pos, big, 'ground');
          this.splashDamage(p, p.pos, null);
        }
        this.retire(p);
      }
    }
  }

  /** One-frame sprites for live projectiles (tracers, shell glows, rocket flames, flares): every frame, even frozen. */
  renderProjectiles(): void {
    const P = this.fx.particles;
    for (const p of this.projs) {
      if (!p.alive) continue;
      if (p.kind === 'shell') {
        const len = Math.min(18, p.vel.length() * 0.016);
        TMP.copy(p.vel).normalize().multiplyScalar(len);
        const c = p.color;
        P.streak(p.pos.x, p.pos.y, p.pos.z, TMP.x, TMP.y, TMP.z, p.width, ((c >> 16) & 255) / 40, ((c >> 8) & 255) / 50, (c & 255) / 70, 1);
        P.glow(p.pos.x, p.pos.y, p.pos.z, 1.1 * p.scale, 5, 3, 1.4, 0.8);
      } else if (p.kind === 'bullet') {
        if (!p.tracer) continue;
        const len = Math.min(26, p.vel.length() * 0.024);
        TMP.copy(p.vel).normalize().multiplyScalar(len);
        const c = p.color;
        const r = ((c >> 16) & 255) / 40, g = ((c >> 8) & 255) / 52, b = (c & 255) / 70;
        P.streak(p.pos.x, p.pos.y, p.pos.z, TMP.x, TMP.y, TMP.z, p.width, r, g, b, 1);
        P.glow(p.pos.x, p.pos.y, p.pos.z, p.width * 3.2, r * 0.6, g * 0.6, b * 0.6, 0.9);
      } else if (p.kind === 'missile') {
        TMP.copy(p.vel).normalize();
        P.glow(p.pos.x - TMP.x * 1.8 * p.scale, p.pos.y - TMP.y * 1.8 * p.scale, p.pos.z - TMP.z * 1.8 * p.scale, 2.4 * p.scale, 6, 3.4, 1.4, 1);
        P.streak(p.pos.x - TMP.x * 1.6 * p.scale, p.pos.y - TMP.y * 1.6 * p.scale, p.pos.z - TMP.z * 1.6 * p.scale, TMP.x * 5 * p.scale, TMP.y * 5 * p.scale, TMP.z * 5 * p.scale, 0.5 * p.scale, 5, 2.6, 1, 1);
      } else if (p.kind === 'flare') {
        P.glow(p.pos.x, p.pos.y, p.pos.z, 7, 9, 6.5, 3.5, Math.min(1, p.life));
      }
    }
  }

  private onHit(p: Proj, e: Ent): void {
    const fx = this.fx;
    TMP.copy(p.vel).normalize();
    if (p.kind === 'bullet') {
      if (e.kind === 'soldier' || e.kind === 'at') fx.particles.emit(4, p.pos.x, p.pos.y, p.pos.z, 0, 1, 0, 0.4, 0.15, 0.1, 0.12, 0.05, 0.04, 1);
      else fx.impact(p.pos, TMP2.copy(TMP).negate(), false, true);
      // Small arms barely scratch armor; autocannons chew light armor but not MBTs.
      const heavy = e.kind === 'tank' || e.kind === 'battery' || e.kind === 'ship';
      const light = e.kind === 'ifv' || e.kind === 'aa' || e.kind === 'sam' || e.kind === 'boat';
      const k = heavy ? (p.dmg < 5 ? 0.03 : 0.3) : light ? (p.dmg < 5 ? 0.15 : 1) : 1;
      this.damage(e, p.dmg * k, p.owner, p.player, TMP);
    } else {
      if (p.kind === 'shell' && p.ap) {
        fx.impact(p.pos, TMP2.copy(TMP).negate(), false, true);
        fx.particles.emit(6, p.pos.x, p.pos.y, p.pos.z, 0, 0, 0, 0.2, 3, 8, 7, 4, 2, 1);
        fx.playAt('explosionSmall', p.pos, 0.6);
      } else {
        fx.explosion(p.pos, p.kind === 'missile' ? 1.1 * p.scale : 1.2, ENT_DEFS[e.kind].air ? 'air' : 'ground');
      }
      this.damage(e, p.dmg, p.owner, p.player, TMP);
      this.splashDamage(p, p.pos, e);
    }
    this.retire(p);
  }

  private retire(p: Proj): void {
    p.alive = false;
    this.releaseMesh(p);
  }

  private guide(p: Proj, dt: number): void {
    // Proportional-ish pursuit toward target (or decoy), constant speed, limited turn rate.
    let tx = 0, ty = 0, tz = 0, have = false;
    if (p.decoy && p.decoy.alive) {
      tx = p.decoy.pos.x; ty = p.decoy.pos.y; tz = p.decoy.pos.z;
      have = true;
    } else if (p.target && p.target.alive) {
      const t = p.target;
      this.center(t, TMP2);
      // Lead: time to go
      const dist = TMP2.distanceTo(p.pos);
      const tgo = dist / Math.max(50, p.speed);
      tx = TMP2.x + t.vel.x * tgo * 0.9; ty = TMP2.y + t.vel.y * tgo * 0.9; tz = TMP2.z + t.vel.z * tgo * 0.9;
      // Smoke screens break wire / laser guidance.
      for (const s of this.smokes) if (s.until > this.time && Math.hypot(t.pos.x - s.x, t.pos.z - s.z) < s.r * 1.2 && !p.heat) {
        p.target = null;
      }
      t.threatT = Math.max(t.threatT, 0.5);
      have = true;
    }
    if (p.seaSkim && have) ty = Math.max(ty, 4);
    const sp = Math.min(p.speed, p.vel.length() + p.speed * 1.8 * dt);
    if (have) {
      TMP.set(tx - p.pos.x, ty - p.pos.y, tz - p.pos.z).normalize();
      TMP3.copy(p.vel).normalize();
      const ang = Math.acos(Math.max(-1, Math.min(1, TMP3.dot(TMP))));
      const maxT = p.turn * dt;
      if (ang > 1e-4) {
        const k = Math.min(1, maxT / ang);
        TMP3.lerp(TMP, k).normalize();
      }
      // Seekers lose a target that is behind them.
      if (ang > 1.6 && p.age > 1) {
        p.target = null;
        p.decoy = null;
      }
      p.vel.copy(TMP3).multiplyScalar(sp);
    } else {
      p.vel.setLength(sp);
      p.vel.y -= 4 * dt;
    }
    if (p.seaSkim) {
      if (p.pos.y > 6) p.vel.y = Math.min(p.vel.y, -(p.pos.y - 5));
    }
    // Proximity fuse on air targets.
    const t = p.target;
    if (t && t.alive && ENT_DEFS[t.kind].air && t.pos.distanceTo(p.pos) < 9) this.onHit(p, t);
    if (p.decoy && p.decoy.alive && p.decoy.pos.distanceTo(p.pos) < 6) {
      this.fx.explosion(p.pos, 0.7, 'air');
      this.retire(p);
    }
  }

  private updateDead(dt: number): void {
    const fx = this.fx;
    for (const e of this.ents) {
      if (e.alive) {
        // Damage smoke on hurt vehicles
        if (e.rig && e.hp < e.maxHp * 0.5 && ENT_DEFS[e.kind].vehicle) {
          this.center(e, TMP);
          TMP.y += e.height * 0.4;
          fx.damageSmoke(TMP, dt, 1 - e.hp / e.maxHp, fxSize(e.kind));
          // Warships burn visibly when badly hit.
          if (ENT_DEFS[e.kind].naval && e.hp < e.maxHp * 0.35) {
            fx.shipFire(TMP, 1 - e.hp / e.maxHp, dt, fxSize(e.kind) * 0.7);
          }
        }
        if (e.threatT > 0) e.threatT -= dt;
        continue;
      }
      e.deadT += dt;
      if (e.kind === 'soldier' || e.kind === 'at') continue;
      const d = ENT_DEFS[e.kind];
      if (d.air && e.rig) {
        // Falling burning wreck
        if (e.rig.root.visible) {
          e.vel.y -= 9.8 * dt;
          e.vel.multiplyScalar(1 - 0.2 * dt);
          e.pos.addScaledVector(e.vel, dt);
          e.rig.root.position.copy(e.pos);
          e.rig.root.rotateZ(dt * 2.5);
          e.rig.root.rotateX(dt * 0.6);
          fx.burn(e.pos, 1, dt);
          const g = this.ground.surfaceAt(e.pos.x, e.pos.z);
          if (e.pos.y <= g + 2) {
            e.pos.y = g;
            fx.explosion(e.pos, 2.8, g < 0.5 ? 'water' : 'ground');
            e.rig.root.visible = false;
          }
        }
        continue;
      }
      if (d.naval && e.rig) {
        // Sinking: list and settle.
        const k = Math.min(1, e.deadT / 40);
        e.rig.root.position.y = -k * (e.kind === 'ship' ? 14 : 6);
        e.rig.root.rotation.z = k * 0.35;
        e.rig.root.rotation.x = -k * 0.08;
        if (e.burnT > 0) {
          e.burnT -= dt;
          const z = fxSize(e.kind);
          fx.shipFire(TMP.set(e.pos.x, e.rig.root.position.y + 8, e.pos.z), Math.min(1, e.burnT / 20), dt, z * 0.7);
          fx.burn(TMP.set(e.pos.x + Math.sin(e.yaw) * 20, e.rig.root.position.y + 6, e.pos.z + Math.cos(e.yaw) * 20), Math.min(1, e.burnT / 20), dt, z * 0.7);
        }
        if (k >= 1) e.rig.root.visible = false;
        continue;
      }
      if (e.tossV && e.rig && e.rig.turret) {
        const t = e.rig.turret;
        e.tossV.y -= 9.8 * dt;
        t.position.addScaledVector(e.tossV, dt);
        t.rotation.x += e.tossSpin * dt * 0.3;
        t.rotation.y += e.tossSpin * dt;
        t.getWorldPosition(TMP);
        const g = this.ground.heightAt(TMP.x, TMP.z);
        if (TMP.y < g + 0.6 && e.tossV.y < 0) {
          e.tossV = null;
          fx.impact(TMP, UP, true, false);
          fx.playAt('explosionSmall', TMP, 0.3);
        }
      }
      if (e.burnT > 0) {
        e.burnT -= dt;
        this.center(e, TMP);
        TMP.y += 0.6;
        fx.burn(TMP, Math.min(1, e.burnT / 25), dt);
      }
    }
  }

  private updateSoldierInstances(): void {
    const counts = [0, 0, 0, 0];
    for (let s = 0; s < 4; s++) {
      const list = this.soldierSlots[s];
      const im = this.soldierMeshes[s];
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e) {
          this.m4.makeScale(0, 0, 0);
          im.setMatrixAt(i, this.m4);
          continue;
        }
        if (e.alive) {
          const bob = e.speed > 0.3 ? Math.abs(Math.sin(this.time * 9 + e.seed * 20)) * 0.06 : 0;
          this.e.set(e.speed > 0.3 ? -0.1 : 0, e.yaw, 0, 'YXZ');
          this.q.setFromEuler(this.e);
          this.sc.set(1, 1, 1);
          this.m4.compose(TMP.set(e.pos.x, e.pos.y + bob, e.pos.z), this.q, this.sc);
        } else {
          // Fallen
          const k = Math.min(1, e.deadT * 3);
          this.e.set(-k * 1.45, e.yaw, 0, 'YXZ');
          this.q.setFromEuler(this.e);
          this.sc.set(1, 1, 1);
          this.m4.compose(TMP.set(e.pos.x, e.pos.y + 0.12 * k, e.pos.z), this.q, this.sc);
          e.deadT += 0; // advanced in updateDead
        }
        im.setMatrixAt(i, this.m4);
        counts[s] = i + 1;
      }
      im.count = counts[s];
      if (counts[s] > 0) im.instanceMatrix.needsUpdate = true;
    }
  }

  /** Sync vehicle rigs (position / orientation / turret / gun) from entity state. */
  syncRigs(dt: number): void {
    for (const e of this.ents) {
      const r = e.rig;
      if (!r || (!e.alive && !ENT_DEFS[e.kind].air)) continue;
      if (!e.alive) continue;
      r.root.position.copy(e.pos);
      const d = ENT_DEFS[e.kind];
      if (d.air || d.naval) {
        r.root.quaternion.copy(e.quat);
      } else {
        r.root.rotation.set(0, e.yaw, 0);
        r.body.rotation.set(e.tiltP, 0, e.tiltR, 'YXZ');
      }
      if (r.turret) r.turret.rotation.y = e.turretYaw;
      if (r.gun) r.gun.rotation.x = e.gunPitch;
      if (r.radar) r.radar.rotation.y += dt * 2.2;
    }
  }

  /** World-space muzzle position and direction of an entity's main gun. */
  muzzleOf(e: Ent, pos: THREE.Vector3, dir: THREE.Vector3): void {
    const r = e.rig;
    if (r?.muzzle) {
      r.root.updateMatrixWorld(true);
      r.muzzle.getWorldPosition(pos);
      r.muzzle.getWorldQuaternion(this.q);
      dir.set(0, 0, -1).applyQuaternion(this.q);
    } else {
      this.center(e, pos);
      pos.y += 0.4;
      forwardOf(e.yaw + e.turretYaw, dir);
    }
  }
}

function newProj(): Proj {
  return {
    alive: false, kind: 'bullet', team: 0, owner: null, player: false, pos: new THREE.Vector3(), prev: new THREE.Vector3(),
    vel: new THREE.Vector3(), life: 0, dmg: 0, splash: 0, ap: false, gravity: 0, tracer: false, color: 0xffffff, width: 0.1,
    target: null, decoy: null, speed: 0, turn: 0, heat: false, scale: 1, mesh: null, airOnly: false, seaSkim: false, age: 0,
  };
}

function resetProj(p: Proj, kind: ProjKind, team: Team, owner: Ent | null, player: boolean): void {
  p.alive = true;
  p.kind = kind;
  p.team = team;
  p.owner = owner;
  p.player = player;
  p.target = null;
  p.decoy = null;
  p.ap = false;
  p.tracer = false;
  p.airOnly = false;
  p.seaSkim = false;
  p.heat = false;
  p.scale = 1;
  p.age = 0;
  p.splash = 0;
}

const SEG_D = new THREE.Vector3();
const SEG_W = new THREE.Vector3();
/** Does segment a-b pass within r of center c? */
export function segSphere(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, r: number): boolean {
  SEG_D.subVectors(b, a);
  SEG_W.subVectors(c, a);
  const L2 = SEG_D.lengthSq();
  let t = L2 > 1e-9 ? SEG_W.dot(SEG_D) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + SEG_D.x * t - c.x, y = a.y + SEG_D.y * t - c.y, z = a.z + SEG_D.z * t - c.z;
  return x * x + y * y + z * z <= r * r;
}
