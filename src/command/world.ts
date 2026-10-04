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
import { buildDestroyer, buildMerchant, buildPatrolBoat, buildTroopShip } from './models/ships';
import { addSoldierInstancing, buildSoldierGeometry, fieldUniform, makeSoldierMaterials, POSE, type SoldierMaterials } from './models/soldier';

export type EntKind = 'tank' | 'ifv' | 'aa' | 'sam' | 'truck' | 'soldier' | 'at' | 'jet' | 'ship' | 'boat' | 'battery'
  // Owner item 30: merchant shipping (a container ship, a troop transport).
  | 'merchant' | 'transport';

export const ENT_DEFS: Record<EntKind, { hp: number; radius: number; height: number; troops: number; air: boolean; naval: boolean; vehicle: boolean }> = {
  tank: { hp: 100, radius: 3.6, height: 2.6, troops: 800, air: false, naval: false, vehicle: true },
  ifv: { hp: 70, radius: 3.3, height: 2.6, troops: 450, air: false, naval: false, vehicle: true },
  aa: { hp: 60, radius: 3.4, height: 3.2, troops: 500, air: false, naval: false, vehicle: true },
  sam: { hp: 45, radius: 4.2, height: 3.4, troops: 700, air: false, naval: false, vehicle: true },
  truck: { hp: 30, radius: 3.5, height: 3.0, troops: 150, air: false, naval: false, vehicle: true },
  soldier: { hp: 12, radius: 0.6, height: 1.8, troops: 40, air: false, naval: false, vehicle: false },
  at: { hp: 12, radius: 0.6, height: 1.8, troops: 60, air: false, naval: false, vehicle: false },
  jet: { hp: 60, radius: 8, height: 0, troops: 900, air: true, naval: false, vehicle: true },
  ship: { hp: 320, radius: 55, height: 10, troops: 2500, air: false, naval: true, vehicle: true },
  boat: { hp: 90, radius: 18, height: 5, troops: 500, air: false, naval: true, vehicle: true },
  battery: { hp: 160, radius: 7, height: 5, troops: 900, air: false, naval: false, vehicle: true },
  merchant: { hp: 220, radius: 62, height: 20, troops: 0, air: false, naval: true, vehicle: true },
  transport: { hp: 200, radius: 55, height: 18, troops: 500, air: false, naval: true, vehicle: true },
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
  /** Soldier figure: 0 rifleman, 1 anti-tank gunner, 2 machine gunner. */
  variant: 0 | 1 | 2;
  /** Owner item 32: animation pose of a soldier (models/soldier.ts POSE), when it took it and its last shot (world s). */
  pose: number;
  poseT: number;
  fireT: number;
  /** Where a soldier of a battle line looks and fires: the other side's line (battle.ts). */
  look: THREE.Vector3;
  /** Its assault wave (rushes in step with its squad); -1 = none. */
  wave: number;
  /** Nation its figure was dressed for (uniform and band colours), -1 = not yet. */
  dressed: number;
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
  // --- v2 (W5): where it comes from in the simulation and what it is doing ---
  /** Player id of its nation (0 = unknown). */
  nation: number;
  /** A force of a nation at peace with the player (quick-reaction force, border guards): never fires, not a target. */
  neutral: boolean;
  /** The sim source it stands for (sync of kills and damage, §9.8). */
  src: EntSource | null;
  /** Part of the player's own formation (the division's tanks and IFVs, the squadron's jets). */
  formation: boolean;
  /**
   * A far soldier drawn by the cheap crowd layer (W5 hand-off, §9.6): no AI, no active instance slot; it stands where
   * the battle had it, can be hit, and wakes up (full AI) when the player comes within ~1 km.
   */
  dormant: boolean;
  /** Crowd instance slot (dormant soldiers). */
  cinst: number;
  /**
   * Owner item 32: how much a soldier is drawn larger than life so it keeps a few pixels on screen far away (1 near;
   * up to CROWD_MAX_SCALE). Its hit sphere follows the figure the player sees.
   */
  drawScale: number;
  /** Behaviour: 'front' fight toward `goal`, 'hold' stay near `goal`, 'goto' drive to `goal`, 'follow' keep `slot` off
   *  the formation leader, 'escort' shadow the player without firing, 'patrol' circle `goal` (aircraft, ships). */
  order: EntOrder;
  goal: THREE.Vector3;
  slot: THREE.Vector3;
}

export type EntOrder = 'front' | 'hold' | 'goto' | 'follow' | 'escort' | 'patrol';

/** The simulation object a local entity represents. */
export interface EntSource {
  kind: 'pool' | 'division' | 'sam' | 'post' | 'qrf' | 'ship' | 'squadron' | 'formation' | 'merchant';
  /** Unit id (division, ship, squadron), structure id (SAM, post), 0 for garrison pools. */
  id: number;
  /** Owner of the source (the nation that loses the troops or the unit). */
  owner: number;
  /** Fraction of the unit one local entity is worth (tank 0.25, IFV 0.10, jet 1/3, launcher 0.35). */
  share: number;
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
  /**
   * Feedback 3 (#27): a shell, bomb or missile crossed the segment a→b: the scenery (structures, city houses) it hit
   * first, as the impact point, or null. The world then explodes it there; the scenery owner applies the damage.
   */
  sceneryHit?(p: Proj, a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 | null;
  /** A shell, bomb or missile exploded on the ground here: buildings within its blast take it (near misses count). */
  groundBlast?(p: Proj, at: THREE.Vector3): void;
}

/** Active soldier instances per team and model; the rest of a big battle stands in the crowd. */
const SOLDIER_SLOTS = 160;
/** Crowd capacity per side (a battle view shows a few thousand soldiers). */
const CROWD_CAP = 6000;
/** Crowd soldiers within WAKE_M of the player wake up (AI); active ones beyond SLEEP_M go back to the crowd. */
export const WAKE_M = 1000;
export const SLEEP_M = 1400;
/**
 * Far soldiers grow with distance so a figure stays about CROWD_MIN_PX tall on screen (owner item 32: readable at tank
 * distances, never giants: at most CROWD_MAX_SCALE, and nothing grows in the gunner's sight before ~2 km).
 */
const CROWD_MAX_SCALE = 3.5;
const CROWD_MIN_PX = 5;
/** Soldier variants (rifleman, AT gunner, machine gunner). */
const VARIANTS = 3;
/** Visual-only tracers of the far crowd's fire (no collision): ring capacity. */
const VTRACE_CAP = 900;

const TMP = new THREE.Vector3();
const TMP2 = new THREE.Vector3();
const TMP3 = new THREE.Vector3();
const FWD = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Effect size multiplier for fires and damage smoke on big hulls. */
function fxSize(kind: EntKind): number {
  return kind === 'ship' || kind === 'merchant' || kind === 'transport' ? 3 : kind === 'boat' ? 1.8 : kind === 'battery' ? 1.5 : 1;
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
  /** Close soldiers (AI, full level of detail): one instanced mesh per team and variant. */
  private readonly soldierMeshes: THREE.InstancedMesh[] = [];
  private readonly soldierAnim: THREE.InstancedBufferAttribute[] = [];
  private readonly soldierBand: THREE.InstancedBufferAttribute[] = [];
  private readonly soldierSlots: (Ent | null)[][] = [[], [], [], [], [], []];
  /** The far crowd (dormant soldiers), one instanced mesh per side (crowd level of detail). */
  private readonly crowdMeshes: THREE.InstancedMesh[] = [];
  private readonly crowdAnim: THREE.InstancedBufferAttribute[] = [];
  private readonly crowdBand: THREE.InstancedBufferAttribute[] = [];
  private readonly crowdSlots: (Ent | null)[][] = [[], []];
  private readonly crowdFree: number[][] = [[], []];
  /** Owner item 32: the animated soldier material (shared clock = world time). */
  readonly soldierMats: SoldierMaterials;
  /** Visual tracers of the far crowd: x, y, z, vx, vy, vz, life, width per slot. */
  private readonly vtr = new Float32Array(VTRACE_CAP * 8);
  private vtrHead = 0;
  /** How hot the battle around the player is (0..1, battle.ts): the crowd fires and falls at this pace. */
  battleHeat = 0;
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
    this.templates.set('merchant', buildMerchant());
    this.templates.set('transport', buildTroopShip());
    // Owner item 32: proper soldiers (proportions, helmets, weapons, uniforms in the nation's colours), animated in the
    // vertex shader (run, kneel, prone, fire, fall): full detail near, a lighter figure for the far crowd.
    this.soldierMats = makeSoldierMaterials();
    for (let t = 0; t < 2; t++) {
      for (let v = 0; v < VARIANTS; v++) {
        const g = buildSoldierGeometry(v as 0 | 1 | 2, true, (t + v) % 3);
        const at = addSoldierInstancing(g, SOLDIER_SLOTS);
        const im = new THREE.InstancedMesh(g, this.soldierMats.standard, SOLDIER_SLOTS);
        im.customDepthMaterial = this.soldierMats.depth;
        im.count = 0;
        im.castShadow = true;
        im.receiveShadow = true;
        im.frustumCulled = false;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.name = `soldiers-${t}-${v}`;
        im.setColorAt(0, new THREE.Color(1, 1, 1));
        this.soldierMeshes.push(im);
        this.soldierAnim.push(at.anim);
        this.soldierBand.push(at.band);
        this.group.add(im);
      }
    }
    for (let t = 0; t < 2; t++) {
      const g = buildSoldierGeometry(0, false, t);
      const at = addSoldierInstancing(g, CROWD_CAP);
      const im = new THREE.InstancedMesh(g, this.soldierMats.standard, CROWD_CAP);
      im.customDepthMaterial = this.soldierMats.depth;
      im.count = 0;
      im.castShadow = false;
      im.receiveShadow = false;
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.name = `crowd-${t}`;
      im.setColorAt(0, new THREE.Color(1, 1, 1));
      this.crowdMeshes.push(im);
      this.crowdAnim.push(at.anim);
      this.crowdBand.push(at.band);
      this.group.add(im);
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
      for (const k of ['tank', 'ifv', 'aa', 'sam', 'truck', 'battery', 'jet', 'ship', 'boat', 'merchant', 'transport'] as const) {
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
    const fam = kind === 'jet' ? this.mats.jetPaint : kind === 'ship' || kind === 'boat' || kind === 'merchant' || kind === 'transport' ? this.mats.shipPaint : this.mats.paint;
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
  spawn(kind: EntKind, team: Team, x: number, z: number, yaw: number, y?: number, dormant = false, mg = false): Ent {
    const d = ENT_DEFS[kind];
    const e: Ent = {
      id: this.nextId++, kind, team, alive: true, player: false, hp: d.hp, maxHp: d.hp,
      pos: new THREE.Vector3(x, 0, z), vel: new THREE.Vector3(), yaw, speed: 0, quat: new THREE.Quaternion(),
      radius: d.radius, height: d.height, rig: null, inst: -1, variant: kind === 'at' ? 1 : mg && kind === 'soldier' ? 2 : 0, turretYaw: 0, gunPitch: 0,
      pose: POSE.idle, poseT: this.time, fireT: -100, look: new THREE.Vector3(), wave: -1, dressed: -1,
      target: null, retarget: this.rng.next() * 1.5, fireCd: 3.5 + this.rng.next() * 6, fireCd2: 7 + this.rng.next() * 9, burst: 0,
      moveT: new THREE.Vector3(x, 0, z), state: 0, stateT: 0, seed: this.rng.next(),
      pitchV: 0, rollV: 0, tiltP: 0, tiltR: 0,
      value: d.troops, strategicId: -1, group: -1, burnT: 0, deadT: 0, flares: 30, missiles: 4, bank: 0, throttle: 0.7,
      trackAcc: 0, lastHitBy: -1, tossV: null, tossSpin: 0, threatT: 0,
      nation: 0, neutral: false, src: null, formation: false, order: 'front', goal: new THREE.Vector3(x, 0, z), slot: new THREE.Vector3(),
      dormant: false, cinst: -1, drawScale: 1,
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
      // Near soldiers get a full instance slot (and the AI); far ones, or any beyond the 160 slots, join the crowd.
      if (dormant || !this.takeSoldierSlot(e)) {
        if (!this.takeCrowdSlot(e)) {
          e.alive = false;
          return e;
        }
      }
    } else {
      e.rig = this.makeRig(kind, team);
      e.rig.root.position.copy(e.pos);
      e.rig.root.rotation.y = yaw;
      this.group.add(e.rig.root);
    }
    this.ents.push(e);
    return e;
  }

  /** An active soldier instance slot (≤ SOLDIER_SLOTS per team and model). */
  private takeSoldierSlot(e: Ent): boolean {
    const slot = e.team * VARIANTS + e.variant;
    const list = this.soldierSlots[slot];
    let idx = list.indexOf(null);
    if (idx < 0) {
      idx = list.length;
      if (idx >= SOLDIER_SLOTS) return false;
      list.push(null);
    }
    list[idx] = e;
    e.inst = idx;
    e.dormant = false;
    const im = this.soldierMeshes[slot];
    im.setColorAt(idx, this.uniformOf(e, this.tmpColor));
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    this.bandOf(e, this.soldierBand[slot], idx);
    return true;
  }

  /**
   * Owner item 32: the uniform of a soldier's nation (field colours with a clear cast of the nation's colour, so the two
   * sides read apart) with a little variety per man.
   */
  private uniformOf(e: Ent, out: THREE.Color): THREE.Color {
    return fieldUniform(e.team === 0 ? 0 : 1, e.nation ? this.nationColor(e.nation) : e.team === 0 ? this.friendlyHex : this.enemyHex, e.seed, out);
  }

  /** The nation's band (helmet and sleeve) and the man's seed. */
  private bandOf(e: Ent, attr: THREE.InstancedBufferAttribute, idx: number): void {
    const c = this.tmpColor2.setHex(e.nation ? this.nationColor(e.nation) : e.team === 0 ? 0x3f8fd8 : 0xd84a3a);
    attr.setXYZW(idx, c.r, c.g, c.b, e.seed);
    attr.needsUpdate = true;
  }

  private freeSoldierSlot(e: Ent): void {
    if (e.inst < 0) return;
    const list = this.soldierSlots[e.team * VARIANTS + e.variant];
    if (list[e.inst] === e) list[e.inst] = null;
    while (list.length && list[list.length - 1] === null) list.pop();
    e.inst = -1;
  }

  private takeCrowdSlot(e: Ent): boolean {
    const list = this.crowdSlots[e.team];
    let idx = this.crowdFree[e.team].pop() ?? -1;
    if (idx < 0) {
      idx = list.length;
      if (idx >= CROWD_CAP) return false;
      list.push(null);
    }
    list[idx] = e;
    e.cinst = idx;
    e.dormant = true;
    e.speed = 0;
    e.target = null;
    e.vel.set(0, 0, 0);
    this.crowdDirty = true;
    const im = this.crowdMeshes[e.team];
    im.setColorAt(idx, this.uniformOf(e, this.tmpColor));
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    this.bandOf(e, this.crowdBand[e.team], idx);
    return true;
  }

  private freeCrowdSlot(e: Ent): void {
    if (e.cinst < 0) return;
    const list = this.crowdSlots[e.team];
    if (list[e.cinst] === e) {
      list[e.cinst] = null;
      this.crowdFree[e.team].push(e.cinst);
    }
    e.cinst = -1;
    this.crowdDirty = true;
  }

  /** Put a soldier to sleep in the crowd (far away) or wake it with a full instance and the AI. */
  setDormant(e: Ent, on: boolean): boolean {
    if (e.kind !== 'soldier' && e.kind !== 'at') return false;
    if (on === e.dormant) return true;
    if (on) {
      if (!this.takeCrowdSlot(e)) return false;
      this.freeSoldierSlot(e);
      return true;
    }
    if (!this.takeSoldierSlot(e)) return false;
    this.freeCrowdSlot(e);
    e.moveT.copy(e.pos);
    e.stateT = 0;
    return true;
  }

  /** Soldiers alive per nation (active and crowd): what the scene holds, for tools and the HUD. */
  soldiersByNation(): Record<number, { active: number; crowd: number }> {
    const out: Record<number, { active: number; crowd: number }> = {};
    for (const e of this.ents) {
      if (!e.alive || (e.kind !== 'soldier' && e.kind !== 'at')) continue;
      const o = (out[e.nation] ??= { active: 0, crowd: 0 });
      if (e.dormant) o.crowd++;
      else o.active++;
    }
    return out;
  }

  /** Living soldiers within r of a point (the battle label's count). */
  soldiersNear(x: number, z: number, r: number): number {
    let n = 0;
    for (const e of this.ents) if (e.alive && (e.kind === 'soldier' || e.kind === 'at') && Math.abs(e.pos.x - x) < r && Math.abs(e.pos.z - z) < r && Math.hypot(e.pos.x - x, e.pos.z - z) < r) n++;
    return n;
  }

  /** Nation colour for the crowd's far tint (set by the command mode). */
  nationColor: (owner: number) => number = () => 0x888888;
  private crowdAcc = 1;
  private lodAcc = 1;
  private crowdWall = 0;
  private readonly crowdCam = new THREE.Vector3(1e9, 0, 0);
  private crowdDirty = true;

  /** The scale that keeps a man CROWD_MIN_PX tall in the last frame's view (1 near, at most CROWD_MAX_SCALE). */
  private readableScale(p: THREE.Vector3): number {
    const d = Math.max(1, Math.hypot(p.x - this.viewPos.x, p.y - this.viewPos.y, p.z - this.viewPos.z));
    const px = (1.8 * this.ppm1) / d;
    return Math.max(1, Math.min(CROWD_MAX_SCALE, CROWD_MIN_PX / Math.max(1e-3, px)));
  }

  /** Set a soldier's pose (the shader animates it; the time it changed drives transitions such as a fall). */
  setPose(e: Ent, pose: number): void {
    if (e.pose === pose) return;
    e.pose = pose;
    e.poseT = this.time;
    if (e.dormant) this.crowdDirty = true;
  }

  /** A soldier fired: the recoil kick of its animation. */
  shotFired(e: Ent): void {
    e.fireT = this.time;
  }

  private crowdFov = 0;
  private crowdViewH = 900;
  /** The camera of the last frame and its pixels per metre at 1 m: far fire is drawn at least a pixel or two wide. */
  private readonly viewPos = new THREE.Vector3(1e9, 0, 0);
  private ppm1 = 965;

  /**
   * The crowd (§9.6 hand-off, owner item 32): far soldiers drawn in one instanced mesh per side, animated by the
   * battle (puppets below: trenches, waves, fire, falls), scaled up with distance only as much as keeps a figure about
   * CROWD_MIN_PX tall on screen. Every second, soldiers within WAKE_M of the player wake up (full instance, AI) and
   * active ones beyond SLEEP_M go back to the crowd.
   */
  updateCrowd(camera: THREE.PerspectiveCamera, viewH: number, player: THREE.Vector3 | null, nowMs: number): void {
    const cam = camera.position;
    // Wall-clock pacing (a slow frame must not delay the wake-up of the soldiers in front of you).
    const realDt = this.crowdWall > 0 ? Math.max(0, (nowMs - this.crowdWall) / 1000) : 1;
    this.crowdWall = nowMs;
    this.lodAcc += realDt;
    if (player && this.lodAcc >= 1) {
      this.lodAcc = 0;
      const wake: Ent[] = [];
      for (const e of this.ents) {
        if (!e.alive || e.formation || (e.kind !== 'soldier' && e.kind !== 'at')) continue;
        const d = Math.hypot(e.pos.x - player.x, e.pos.z - player.z);
        if (e.dormant && d < WAKE_M) wake.push(e);
        else if (!e.dormant && d > SLEEP_M) this.setDormant(e, true);
      }
      wake.sort((a, b) => Math.hypot(a.pos.x - player.x, a.pos.z - player.z) - Math.hypot(b.pos.x - player.x, b.pos.z - player.z));
      for (const e of wake) this.setDormant(e, false);
    }
    this.crowdAcc += realDt;
    // Pixels per metre at 1 m (the scale keeps a far figure readable in this view, chase or gunner's sight).
    const ppm1 = viewH / (2 * Math.tan((camera.fov * Math.PI) / 360));
    this.viewPos.copy(cam);
    this.ppm1 = ppm1;
    const lens = Math.abs(camera.fov - this.crowdFov) > 0.5 || Math.abs(viewH - this.crowdViewH) > 1;
    const moved = cam.distanceToSquared(this.crowdCam) > 30 * 30;
    // The puppets move every frame (rushes, falls): matrices and poses are rewritten each frame for the moving ones;
    // all of them when the camera moved or zoomed (the distance scale).
    const full = this.crowdDirty || moved || lens || this.crowdAcc >= 0.5;
    if (full) {
      this.crowdAcc = 0;
      this.crowdDirty = false;
      this.crowdCam.copy(cam);
      this.crowdFov = camera.fov;
      this.crowdViewH = viewH;
    }
    for (let t = 0; t < 2; t++) {
      const list = this.crowdSlots[t];
      const im = this.crowdMeshes[t];
      const anim = this.crowdAnim[t];
      let last = -1;
      let changed = false;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e) {
          if (full) im.setMatrixAt(i, this.m4.makeScale(0, 0, 0));
          continue;
        }
        last = i;
        if (!full && !e.alive && e.deadT > 1) continue;
        if (!full && e.alive && e.speed < 0.05 && e.fireT < this.time - 0.5 && this.time - e.poseT > 0.1) continue;
        changed = true;
        if (e.dressed !== e.nation) {
          e.dressed = e.nation;
          this.bandOf(e, this.crowdBand[t], i);
        }
        e.pos.y = this.ground.heightAt(e.pos.x, e.pos.z);
        const d = cam.distanceTo(e.pos);
        if (full) {
          // Readable far away: beyond ~500 m the uniform takes on more of the nation's colour (as the battle view's
          // masses do), so a line of men a kilometre off still reads as theirs or ours against the ground.
          this.uniformOf(e, this.tmpColor);
          const far = Math.max(0, Math.min(1, (d - 450) / 1200)) * 0.45;
          if (far > 0 && e.nation) this.tmpColor.lerp(this.tmpColor2.setHex(this.nationColor(e.nation)), far);
          if (!e.alive) this.tmpColor.multiplyScalar(0.7);
          im.setColorAt(i, this.tmpColor);
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
        }
        const px = (1.8 * ppm1) / Math.max(1, d);
        const sc = Math.max(1, Math.min(CROWD_MAX_SCALE, CROWD_MIN_PX / Math.max(1e-3, px)));
        e.drawScale = sc;
        this.e.set(0, e.yaw, 0, 'YXZ');
        this.q.setFromEuler(this.e);
        this.sc.set(sc, sc, sc);
        im.setMatrixAt(i, this.m4.compose(TMP.set(e.pos.x, e.pos.y, e.pos.z), this.q, this.sc));
        anim.setXYZW(i, e.alive ? e.pose : POSE.dead, e.seed, e.fireT, e.poseT);
      }
      if (changed || full) {
        im.count = last + 1;
        im.instanceMatrix.needsUpdate = true;
        anim.needsUpdate = true;
      }
    }
  }

  /**
   * Owner item 32: the far crowd fights. Cheap scripted behaviour for dormant soldiers, by their order:
   *   'hold'   a position or trench: kneel or lie behind cover, fire bursts toward `look` (the other side's line);
   *   'front'  an assault wave: rush toward `goal` bent low with its squad (`wave` keeps them in step), drop prone and
   *            fire, rush again, until it reaches the halt line short of the enemy trench, then fight from there;
   *   other    stand.
   * Their fire is visual (tracers and flashes without collision); casualties come from real rounds (artillery, the
   * player) and from the battle's attrition (battle.ts), all at the pace of `battleHeat`.
   */
  updatePuppets(dt: number): void {
    if (dt <= 0) return;
    const heat = this.battleHeat;
    const t = this.time;
    for (let side = 0; side < 2; side++) {
      for (const e of this.crowdSlots[side]) {
        if (!e || !e.alive) continue;
        // A nation at peace never fires (posts and patrols stand guard).
        if (e.neutral) {
          this.setPose(e, POSE.idle);
          continue;
        }
        if (e.order === 'front' && e.wave >= 0) {
          const dx = e.goal.x - e.pos.x, dz = e.goal.z - e.pos.z;
          const dist = Math.hypot(dx, dz);
          const cycle = 8 + (e.wave % 5);
          const ph = ((t + e.wave * 2.3) / cycle) % 1;
          // Half of each cycle on the move (an assault reads by its men running), half down firing.
          const rush = dist > 5 && ph < 0.5;
          if (rush) {
            this.setPose(e, e.seed < 0.25 ? POSE.run : POSE.rush);
            const sp = e.pose === POSE.run ? 3.6 : 2.8;
            e.yaw = Math.atan2(-dx, -dz);
            e.speed = sp;
            e.vel.set(dx / dist, 0, dz / dist).multiplyScalar(sp);
            const k = Math.min(1, (sp * dt) / dist);
            e.pos.x += dx * k;
            e.pos.z += dz * k;
            continue;
          }
          e.speed = 0;
          e.vel.set(0, 0, 0);
          this.setPose(e, e.variant === 1 || e.seed > 0.5 ? POSE.kneel : POSE.prone);
        } else if (e.order === 'hold') {
          e.speed = 0;
          this.setPose(e, e.variant === 2 || e.seed < 0.3 ? POSE.prone : POSE.kneel);
        } else {
          continue;
        }
        // Face the enemy and fire in bursts (machine gunners longer and more often).
        const lx = e.look.x - e.pos.x, lz = e.look.z - e.pos.z;
        if (lx * lx + lz * lz > 1) e.yaw = Math.atan2(-lx, -lz);
        if (heat <= 0.01) continue;
        e.fireCd -= dt * (0.35 + heat);
        if (e.fireCd > 0) continue;
        if (e.burst <= 0) e.burst = e.variant === 2 ? 6 + Math.floor(this.rng.next() * 8) : 2 + Math.floor(this.rng.next() * 3);
        e.burst--;
        e.fireCd = e.burst > 0 ? (e.variant === 2 ? 0.09 : 0.16) : 1.6 + this.rng.next() * (e.variant === 2 ? 3 : 6);
        e.fireT = t;
        if (e.variant === 1) {
          if (e.burst > 0) e.burst = 0;
          e.fireCd = 18 + this.rng.next() * 20;
        }
        this.puppetShot(e);
      }
    }
    // Move the visual tracers.
    const V = this.vtr;
    for (let i = 0; i < VTRACE_CAP; i++) {
      const o = i * 8;
      if (V[o + 6] <= 0) continue;
      V[o + 6] -= dt;
      if (V[o + 6] <= 0 && Math.hypot(V[o + 3], V[o + 4], V[o + 5]) < 300) {
        // An anti-tank rocket of the crowd bursts at its end.
        this.fx.explosion(TMP.set(V[o], V[o + 1], V[o + 2]), 0.6, 'ground');
      }
      V[o] += V[o + 3] * dt;
      V[o + 1] += V[o + 4] * dt;
      V[o + 2] += V[o + 5] * dt;
    }
  }

  /** One round of a crowd soldier: muzzle flash and (one in three) a tracer flying toward its target line. */
  private puppetShot(e: Ent): void {
    const fx = this.fx;
    const yawF = forwardOf(e.yaw, TMP);
    const hgt = e.pose === POSE.prone ? 0.32 : e.pose === POSE.kneel ? 0.95 : 1.35;
    const mx = e.pos.x + yawF.x * 0.9, my = e.pos.y + hgt, mz = e.pos.z + yawF.z * 0.9;
    const cam = this.viewPos;
    const dCam = Math.hypot(mx - cam.x, mz - cam.z);
    const big = Math.max(1, dCam / 250);
    // A muzzle flash stays ~3 px across however far (a line firing reads as a line of twinkles from a kilometre).
    const flash = Math.max(0.3, (3 * dCam) / this.ppm1);
    if (e.variant === 1) {
      // An anti-tank rocket: a smoky streak and a blast at its line.
      TMP2.set(mx, my, mz);
      TMP3.set(yawF.x, 0.02, yawF.z);
      fx.muzzle(TMP2, TMP3, 0.5 * Math.min(3, big), true);
      this.vtrace(mx, my, mz, e.look.x, e.look.y + 1, e.look.z, 160, 0.35 * big);
      return;
    }
    if (dCam < 3200) fx.particles.emit(6, mx, my, mz, 0, 0, 0, 0.06, flash, flash * 1.3, 3, 2, 0.9, 1);
    if (this.rng.next() < (e.variant === 2 ? 0.6 : 0.4)) {
      const spread = 6 + this.rng.next() * 18;
      const tx = e.look.x + (this.rng.next() - 0.5) * spread, tz = e.look.z + (this.rng.next() - 0.5) * spread;
      const ty = this.ground.heightAt(tx, tz) + 0.4 + this.rng.next() * 1.4;
      this.vtrace(mx, my, mz, tx, ty, tz, 780, (e.variant === 2 ? 0.14 : 0.1) * Math.min(4, big));
    }
    if (dCam < 450 && this.rng.next() < 0.06) fx.playAt('gunfire', TMP2.set(mx, my, mz), 0.18);
  }

  /** A visual tracer from a to b at `speed` m/s (no collision: the far crowd's fire). */
  vtrace(ax: number, ay: number, az: number, bx: number, by: number, bz: number, speed: number, width: number): void {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const L = Math.hypot(dx, dy, dz);
    if (L < 1) return;
    const o = this.vtrHead * 8;
    this.vtrHead = (this.vtrHead + 1) % VTRACE_CAP;
    const V = this.vtr;
    V[o] = ax;
    V[o + 1] = ay;
    V[o + 2] = az;
    V[o + 3] = (dx / L) * speed;
    V[o + 4] = (dy / L) * speed;
    V[o + 5] = (dz / L) * speed;
    V[o + 6] = L / speed;
    V[o + 7] = width;
  }

  private readonly tmpColor2 = new THREE.Color();
  private readonly tmpColor = new THREE.Color();
  private friendlyHex = 0x3f8fd8;
  private enemyHex = 0xd84a3a;

  /** The two sides' nation colours (a soldier with no nation wears its side's). */
  setTeamTints(friendly: number, enemy: number): void {
    this.friendlyHex = friendly;
    this.enemyHex = enemy;
  }

  /** Remove every entity / projectile (session end). */
  reset(): void {
    for (const e of this.ents) if (e.rig) this.group.remove(e.rig.root);
    this.ents.length = 0;
    for (const s of this.soldierSlots) s.length = 0;
    for (const im of this.soldierMeshes) im.count = 0;
    this.vtr.fill(0);
    this.battleHeat = 0;
    for (let t = 0; t < 2; t++) {
      this.crowdSlots[t].length = 0;
      this.crowdFree[t].length = 0;
      this.crowdMeshes[t].count = 0;
    }
    this.crowdDirty = true;
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

  /** Remove one entity for good (a dead body out of sight, a force that left the area). */
  despawn(e: Ent): void {
    const i = this.ents.indexOf(e);
    if (i < 0) return;
    this.ents.splice(i, 1);
    e.alive = false;
    if (e.rig) this.group.remove(e.rig.root);
    this.freeSoldierSlot(e);
    this.freeCrowdSlot(e);
    for (const o of this.ents) if (o.target === e) o.target = null;
    for (const p of this.projs) if (p.alive && p.target === e) p.target = null;
  }

  /** Floating origin moved by (dx, dz): every position this world keeps moves with it. */
  rebase(dx: number, dz: number): void {
    for (const e of this.ents) {
      e.pos.x -= dx;
      e.pos.z -= dz;
      e.moveT.x -= dx;
      e.moveT.z -= dz;
      e.goal.x -= dx;
      e.goal.z -= dz;
      if (e.rig) {
        e.rig.root.position.x -= dx;
        e.rig.root.position.z -= dz;
      }
    }
    for (const p of this.projs) {
      if (!p.alive) continue;
      p.pos.x -= dx;
      p.pos.z -= dz;
      p.prev.x -= dx;
      p.prev.z -= dz;
    }
    for (const sm of this.smokes) {
      sm.x -= dx;
      sm.z -= dz;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------------------------
  center(e: Ent, out: THREE.Vector3): THREE.Vector3 {
    out.copy(e.pos);
    if (e.kind === 'soldier' || e.kind === 'at') {
      // The body's middle in its pose (a man lying down is hit low, a kneeling one at half height).
      out.y += (e.pose === POSE.prone || e.pose === POSE.dead ? 0.28 : e.pose === POSE.kneel || e.pose === POSE.rush ? 0.62 : 0.9) * e.drawScale;
    } else if (!ENT_DEFS[e.kind].air) out.y += e.height * 0.5;
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
  // Spatial grid (owner item 32: hundreds of soldiers; rounds and blasts only test what is near them)
  // ---------------------------------------------------------------------------------------------
  private readonly grid = new Map<number, Ent[]>();
  private readonly gridPool: Ent[][] = [];
  /** Entities too big for a cell (ships, merchants): always tested. */
  private readonly bigEnts: Ent[] = [];
  private static readonly CELL = 48;

  private cellKey(cx: number, cz: number): number {
    return ((cx + 32768) & 0xffff) * 65536 + ((cz + 32768) & 0xffff);
  }

  /** Rebuild the grid of living entities (every local step). */
  private buildGrid(): void {
    for (const a of this.grid.values()) {
      a.length = 0;
      this.gridPool.push(a);
    }
    this.grid.clear();
    this.bigEnts.length = 0;
    const C = World.CELL;
    for (const e of this.ents) {
      if (!e.alive) continue;
      if (e.radius > 12 || ENT_DEFS[e.kind].air) {
        this.bigEnts.push(e);
        continue;
      }
      const k = this.cellKey(Math.floor(e.pos.x / C), Math.floor(e.pos.z / C));
      let a = this.grid.get(k);
      if (!a) {
        a = this.gridPool.pop() ?? [];
        this.grid.set(k, a);
      }
      a.push(e);
    }
  }

  /** Every living entity whose cell overlaps the box [x0, x1] × [z0, z1] (plus the big ones). Return true to stop. */
  forEachIn(x0: number, z0: number, x1: number, z1: number, fn: (e: Ent) => boolean | void): void {
    for (const e of this.bigEnts) if (e.alive && fn(e)) return;
    const C = World.CELL;
    // Members stand up to their radius (≤ 12 m) outside their cell.
    const cx0 = Math.floor((Math.min(x0, x1) - 12) / C), cx1 = Math.floor((Math.max(x0, x1) + 12) / C);
    const cz0 = Math.floor((Math.min(z0, z1) - 12) / C), cz1 = Math.floor((Math.max(z0, z1) + 12) / C);
    if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > 400) {
      // A long segment (a shell's step at high speed is ~30 m; this is a fallback): test everything.
      for (const e of this.ents) if (e.alive && e.radius <= 12 && !ENT_DEFS[e.kind].air && fn(e)) return;
      return;
    }
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const a = this.grid.get(this.cellKey(cx, cz));
        if (!a) continue;
        for (const e of a) if (e.alive && fn(e)) return;
      }
    }
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
    // Nobody fights a nation at peace by accident (owner item 31): the player is asked before the trigger fires
    // (index.ts clearToFire); a round already in the air never damages a neutral, never shows a hit on it and never
    // asks again.
    if (e.neutral) return;
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
      // Owner item 32: the man falls (the shader's fall, from now), a puff of dust where he drops; no blood.
      e.pose = -1;
      this.setPose(e, POSE.dead);
      e.speed = 0;
      if (e.dormant) this.crowdDirty = true;
      this.fx.particles.emit(2, TMP.x, TMP.y - 0.5, TMP.z, 0, 0.6, 0, 1.2, 0.5, 1.6, 0.42, 0.38, 0.32, 0.6);
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
    const hits: Ent[] = [];
    this.forEachIn(at.x - p.splash, at.z - p.splash, at.x + p.splash, at.z + p.splash, (e) => {
      if (e === direct || e.neutral || e.team === p.team) return;
      hits.push(e);
    });
    for (const e of hits) {
      if (!e.alive) continue;
      this.center(e, TMP2);
      const d = TMP2.distanceTo(at) - e.radius * 0.5;
      if (d > p.splash) continue;
      // Owner item 32: high explosive is lethal to men in the open (fragments), much less to armour.
      const man = e.kind === 'soldier' || e.kind === 'at';
      const soft = man || e.kind === 'truck';
      // Prone men and men in a trench take less of a near miss.
      const cover = man && (e.pose === POSE.prone || (e.order === 'hold' && e.pose === POSE.kneel)) ? 0.7 : 1;
      const k = (1 - Math.max(0, d) / p.splash) * (man ? 1.8 * cover : soft ? 1.4 : 0.45) * (p.ap ? 0.35 : 1);
      this.damage(e, p.dmg * k, p.owner, p.player, null);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------------------------
  update(dt: number): void {
    this.time += dt;
    this.soldierMats.time.value = this.time;
    this.buildGrid();
    this.updatePuppets(dt);
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

      // Collisions: entities near the segment (segment vs sphere)
      let hit: Ent | null = null;
      const pv = p;
      const reachK = p.vel.length() * dt + 2;
      this.forEachIn(p.prev.x, p.prev.z, p.pos.x, p.pos.z, (e) => {
        if (e.team === pv.team) return;
        // Owner item 31: our rounds go past a force of a nation at peace (no impact, no hit, no question).
        if (e.neutral && pv.team === 0) return;
        if (pv.airOnly && !ENT_DEFS[e.kind].air) return;
        this.center(e, TMP2);
        const man = e.kind === 'soldier' || e.kind === 'at';
        // Owner item 32: a man is hit within ~0.75 m of his middle by the player's guns (fair at tank ranges).
        const rad = pv.kind === 'bullet' ? (man ? (pv.player ? 0.78 : 0.55) * e.drawScale : e.radius * (ENT_DEFS[e.kind].air ? 1.1 : 0.9)) : e.radius + (pv.kind === 'missile' ? 4 : 0.3);
        // Quick reject
        const dx = TMP2.x - pv.pos.x, dy = TMP2.y - pv.pos.y, dz = TMP2.z - pv.pos.z;
        const reach = rad + reachK;
        if (dx * dx + dy * dy + dz * dz > reach * reach) return;
        if (segSphere(pv.prev, pv.pos, TMP2, rad)) {
          hit = e;
          return true;
        }
      });
      if (hit) {
        this.onHit(p, hit);
        continue;
      }
      // Buildings and structures stop shells, bombs and missiles (and take the damage: the hook's owner decides).
      // Owner item 32: the player's machine-gun rounds too (small but real damage, chips and broken glass).
      if ((p.kind === 'shell' || p.kind === 'bomb' || p.kind === 'missile' || (p.kind === 'bullet' && p.player)) && this.hooks.sceneryHit) {
        const at = this.hooks.sceneryHit(p, p.prev, p.pos);
        if (at && p.kind === 'bullet') {
          p.pos.copy(at);
          TMP.copy(p.vel).normalize().negate();
          fx.impact(p.pos, TMP, false, false);
          // Chips of masonry and, now and then, the glitter of a window going.
          fx.particles.emit(4, p.pos.x, p.pos.y, p.pos.z, TMP.x * 3, 2, TMP.z * 3, 0.9, 0.12, 0.2, 0.55, 0.52, 0.48, 1);
          if (this.rng.next() < 0.3) {
            for (let k = 0; k < 4; k++) fx.particles.emit(7, p.pos.x, p.pos.y, p.pos.z, TMP.x * 4 + (this.rng.next() - 0.5) * 4, 1 + this.rng.next() * 2, TMP.z * 4 + (this.rng.next() - 0.5) * 4, 0.6, 0.06, 0.04, 2.2, 2.6, 3, 1);
          }
          this.retire(p);
          continue;
        }
        if (at) {
          p.pos.copy(at);
          const big = p.kind === 'bomb' ? 3.2 : p.kind === 'missile' ? 1.4 : p.splash > 10 ? 1.8 : p.ap ? 1.0 : 1.3;
          fx.explosion(p.pos, big, 'vehicle');
          this.splashDamage(p, p.pos, null);
          this.retire(p);
          continue;
        }
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
          if (!water) this.hooks.groundBlast?.(p, p.pos);
        }
        this.retire(p);
      }
    }
  }

  /** One-frame sprites for live projectiles (tracers, shell glows, rocket flames, flares): every frame, even frozen. */
  renderProjectiles(): void {
    const P = this.fx.particles;
    // The far crowd's tracers.
    const V = this.vtr;
    for (let i = 0; i < VTRACE_CAP; i++) {
      const o = i * 8;
      if (V[o + 6] <= 0) continue;
      const sp = Math.hypot(V[o + 3], V[o + 4], V[o + 5]);
      const len = Math.min(24, sp * 0.024) / sp;
      // At least ~1.4 px wide where it is now (a far tracer of 0.1 m is invisible beyond a few hundred metres).
      const dv = Math.hypot(V[o] - this.viewPos.x, V[o + 1] - this.viewPos.y, V[o + 2] - this.viewPos.z);
      const w = Math.max(V[o + 7], Math.min(2.5, (1.4 * dv) / this.ppm1));
      const rocket = sp < 300;
      if (rocket) {
        P.glow(V[o], V[o + 1], V[o + 2], w * 6, 6, 3.4, 1.4, 1);
        if (this.rng.next() < 0.5) P.emit(1, V[o], V[o + 1], V[o + 2], 0, 0.4, 0, 1.4, w * 2, w * 6, 0.6, 0.58, 0.55, 0.5);
      } else {
        P.streak(V[o], V[o + 1], V[o + 2], V[o + 3] * len, V[o + 4] * len, V[o + 5] * len, w, 6.4, 3.6, 1.4, 1);
        P.glow(V[o], V[o + 1], V[o + 2], w * 3, 3.2, 1.8, 0.7, 0.9);
      }
    }
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
      if (e.kind === 'soldier' || e.kind === 'at') fx.particles.emit(2, p.pos.x, p.pos.y, p.pos.z, 0, 0.8, 0, 0.7, 0.25, 0.7, 0.5, 0.46, 0.4, 0.7);
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
    for (let sl = 0; sl < this.soldierSlots.length; sl++) {
      const list = this.soldierSlots[sl];
      const im = this.soldierMeshes[sl];
      const anim = this.soldierAnim[sl];
      let count = 0;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e) {
          this.m4.makeScale(0, 0, 0);
          im.setMatrixAt(i, this.m4);
          continue;
        }
        if (e.dressed !== e.nation) {
          e.dressed = e.nation;
          im.setColorAt(i, this.uniformOf(e, this.tmpColor));
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
          this.bandOf(e, this.soldierBand[sl], i);
        }
        if (e.alive) {
          // The AI's state picks the pose: running or walking, kneeling or standing to fire, prone in a position.
          const fighting = e.state === 1 || this.time - e.fireT < 1.5;
          const pose = e.neutral ? (e.speed > 0.3 ? POSE.walk : POSE.idle)
            : e.speed > 2.2 ? (e.seed < 0.5 ? POSE.rush : POSE.run)
              : e.speed > 0.3 ? POSE.walk
                : fighting ? (e.variant === 2 || (e.order === 'hold' && e.seed < 0.3) ? POSE.prone : e.seed < 0.65 ? POSE.kneel : POSE.aim)
                  : e.order === 'hold' ? (e.seed < 0.3 ? POSE.prone : POSE.kneel) : POSE.idle;
          this.setPose(e, pose);
        }
        this.e.set(0, e.yaw, 0, 'YXZ');
        this.q.setFromEuler(this.e);
        // Owner item 32: beyond ~350 m a man is drawn a little larger, so he keeps CROWD_MIN_PX on screen (the crowd's
        // rule; none in the gunner's sight, whose lens already magnifies).
        e.drawScale = this.readableScale(e.pos);
        this.sc.setScalar(e.drawScale);
        this.m4.compose(TMP.set(e.pos.x, e.pos.y, e.pos.z), this.q, this.sc);
        im.setMatrixAt(i, this.m4);
        anim.setXYZW(i, e.alive ? e.pose : POSE.dead, e.seed, e.fireT, e.poseT);
        count = i + 1;
      }
      im.count = count;
      if (count > 0) {
        im.instanceMatrix.needsUpdate = true;
        anim.needsUpdate = true;
      }
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
