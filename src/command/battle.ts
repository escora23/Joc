// FRONT ULTRA — command mode: the battle at the real scale of the front (owner item 32). Owner: command.
//
// Near a contact line at war, this stands the front's troops along it around the player, at the density the sim
// says they are there (src/shared/localForces.ts: the side's front and offensive pools per km of front), with a
// believable cap: hundreds of soldiers per side in a 2.4 km stretch of line centred on the player, plus vehicles,
// trenches, artillery, smoke and tracers. The stretch follows the player along the line.
//
//   Defenders hold trenches (a forward trench, a second trench, reserves) behind sandbag parapets, with machine
//   gunners; attackers advance in waves (squads rush, drop prone, fire, rush again) from 250-700 m behind the line to a
//   halt line short of the enemy trench, under the defenders' fire and both sides' artillery. A quiet front (no
//   offensive) is two trench lines trading fire.
//   Numbers: 1 figure = 25 troops (TROOPS_PER_SOLDIER). Every figure the player kills goes back to the sim through
//   index.ts onKill (25 troops each; a line vehicle its crew and squad). Local attrition between the two sides is only
//   the picture of the sim's own casualties: the sim stays the source of truth, and the counts here follow its pools
//   (the fallen are replaced by new waves and reserves from behind while the sim still has the troops).
//   Far figures are the world's crowd (world.ts puppets, instanced and animated in the shader); within 1 km of the
//   player they wake up with the full AI and real bullets.

import * as THREE from 'three';
import type { LocalForces, LocalFront, LocalRelation } from '../shared/localForces';
import { TROOPS_PER_SOLDIER } from '../shared/localForces';
import type { LocalFrame } from './frame';
import type { Ground } from './stream';
import { GeoBuilder } from './models/builder';
import { POSE } from './models/soldier';
import { WAKE_M, type Ent, type EntKind, type World } from './world';

/** Half the stretch of line shown around the player (m). */
export const HALF_WINDOW_M = 1200;
/** The stretch is re-centred when the player is this far along the line from its centre (m). */
const RECENTRE_M = 450;
/** Visible figures per side at most (a believable cap; the density below it is the sim's). */
export const SIDE_CAP_HOSTILE = 900;
export const SIDE_CAP_FRIENDLY = 650;
/** The front garrison within this length of line around the player is drawn into the stretch (km). */
const CONCENTRATION_KM = 16;
/** A side with troops on this front shows at least this many (a platoon's line, never "two little guys"). */
const SIDE_MIN = 60;
/** Defender's forward trench, second trench and reserves (m behind the contact line on its side). */
const TRENCH_D = 115;
const TRENCH2_D = 330;
const RESERVE_D0 = 520;
const RESERVE_D1 = 720;
/** Assault waves start this far behind the line and stop this far short of the enemy trench (m). */
const WAVE_D0 = 260;
const WAVE_D1 = 700;
const HALT_SHORT = 75;
/** Line vehicles: one per this many figures, at most these many per side. */
const FIGS_PER_VEHICLE_HOSTILE = 90;
const FIGS_PER_VEHICLE_FRIENDLY = 110;
const VEHICLES_HOSTILE = 5;
const VEHICLES_FRIENDLY = 4;
/** Bodies left on the field before the oldest far ones are cleared. */
const BODIES_MAX = 320;
/** Trench parapet segment length (m). */
const SEG_M = 3.2;
const TRENCH_CAP = 2400;
const STEP_M = 10;

export interface BattleSideInfo {
  owner: number;
  team: 0 | 1;
  role: 'attack' | 'defend' | 'hold';
  /** Figures standing now (alive) and the target from the sim's density. */
  shown: number;
  target: number;
  /** Troops the figures stand for and the sim's troops per km of this front. */
  troops: number;
  perKm: number;
  vehicles: number;
}

export interface BattleInfo {
  active: boolean;
  frontKey: number;
  /** 0..1: how hot the fighting is (the front's intensity; a quiet front smoulders at ~0.2). */
  heat: number;
  sides: BattleSideInfo[];
  /** Where the fighting is hottest now in the stretch (scene), and the line point nearest the player. */
  hot: THREE.Vector3 | null;
  near: THREE.Vector3 | null;
  /** Shells that landed in the last 10 s, and the figures fallen in the last 10 s. */
  shells10: number;
  fallen10: number;
}

export interface BattleHost {
  world: World;
  frame: LocalFrame;
  ground: Ground;
  relationOf(owner: number): LocalRelation;
  /** At war with the human now (or answering an incursion with fire, or just declared on). */
  hostile(rel: LocalRelation, owner: number): boolean;
}

interface Member {
  e: Ent;
  owner: number;
  /** Arc position along the line relative to the stretch centre (m) where it was placed. */
  s: number;
}

interface SideState {
  owner: number;
  team: 0 | 1;
  rel: LocalRelation;
  hostile: boolean;
  sign: 1 | -1;
  role: 'attack' | 'defend' | 'hold';
  target: number;
  troops: number;
  perKm: number;
  members: Member[];
  vehicles: Ent[];
  vehTarget: number;
  vehRespawnAt: number;
  arty: number;
  waveN: number;
}

const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const M4 = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const S1 = new THREE.Vector3(1, 1, 1);

export class BattleLine {
  readonly group = new THREE.Group();
  private sides = new Map<number, SideState>();
  private active = false;
  private frontKey = 0;
  private heat = 0;
  /** Stretch centre (scene) and the resampled line around it: x, z, nx, nz per STEP_M (n points to side b). */
  private centre: THREE.Vector3 | null = null;
  private pts = new Float64Array(0);
  private sMin = 0;
  private nPts = 0;
  private lineShift = 0;
  private trenchNear: THREE.InstancedMesh;
  private trenchFar: THREE.InstancedMesh;
  private trenchDirty = true;
  private trenchSides: { sign: 1 | -1; depth: number }[] = [];
  private shellTimes: number[] = [];
  private fallTimes: number[] = [];
  private bins = new Float32Array(8);
  private hot: THREE.Vector3 | null = null;
  private near: THREE.Vector3 | null = null;
  private smokeT = 20;
  private flashT = 0;
  private attrAcc = 0;
  private wrecks: THREE.Object3D[] = [];
  private wreckFires: { x: number; y: number; z: number; heat: number }[] = [];
  private decorated = false;

  constructor(private readonly host: BattleHost) {
    this.group.name = 'cmd-battle';
    this.trenchNear = new THREE.InstancedMesh(parapetGeometry(true), host.world.mats.prop, TRENCH_CAP);
    this.trenchFar = new THREE.InstancedMesh(parapetGeometry(false), host.world.mats.prop, TRENCH_CAP);
    for (const m of [this.trenchNear, this.trenchFar]) {
      m.count = 0;
      m.frustumCulled = false;
      m.receiveShadow = true;
      m.castShadow = m === this.trenchNear;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
    }
  }

  reset(): void {
    this.sides.clear();
    this.active = false;
    this.frontKey = 0;
    this.heat = 0;
    this.centre = null;
    this.nPts = 0;
    this.trenchNear.count = this.trenchFar.count = 0;
    this.trenchSides = [];
    this.shellTimes.length = 0;
    this.fallTimes.length = 0;
    this.hot = this.near = null;
    this.clearDecor();
    this.host.world.battleHeat = 0;
  }

  private clearDecor(): void {
    for (const w of this.wrecks) this.group.remove(w);
    this.wrecks.length = 0;
    this.wreckFires.length = 0;
    this.decorated = false;
  }

  info(): BattleInfo {
    const sides: BattleSideInfo[] = [];
    for (const s of this.sides.values()) {
      const shown = s.members.reduce((n, m) => n + (m.e.alive ? 1 : 0), 0);
      sides.push({
        owner: s.owner, team: s.team, role: s.role, shown, target: s.target, troops: shown * TROOPS_PER_SOLDIER, perKm: s.perKm,
        vehicles: s.vehicles.filter((v) => v.alive).length,
      });
    }
    const now = this.host.world.time;
    return {
      active: this.active, frontKey: this.frontKey, heat: this.heat, sides, hot: this.hot, near: this.near,
      shells10: this.shellTimes.filter((t) => now - t < 10).length, fallen10: this.fallTimes.filter((t) => now - t < 10).length,
    };
  }

  /** Owners whose infantry this battle stands (forces.ts then leaves their front pools to it). */
  owners(): Set<number> {
    return new Set(this.active ? [...this.sides.keys()] : []);
  }

  // ---------------------------------------------------------------------------------------------
  // The line around the player
  // ---------------------------------------------------------------------------------------------
  /** Resample the front's contact line (local km from the anchor) around the stretch centre, in scene metres. */
  private buildLine(lf: LocalForces, fr: LocalFront, player: Ent): boolean {
    const f = this.host.frame;
    const a = f.sceneOf(lf.lat, lf.lon, { x: 0, z: 0 });
    const L = fr.lineKm;
    if (L.length < 4) return false;
    const xs: number[] = [], zs: number[] = [];
    for (let i = 0; i + 1 < L.length; i += 2) {
      xs.push(a.x + L[i] * 1000);
      zs.push(a.z - L[i + 1] * 1000);
    }
    // Side b lies along side a's advance.
    const adv = { x: Math.sin(fr.advanceBearing), z: -Math.cos(fr.advanceBearing) };
    const proj = (px: number, pz: number): { s: number; d2: number } => {
      let best = { s: 0, d2: Infinity };
      let acc = 0;
      for (let i = 0; i + 1 < xs.length; i++) {
        const dx = xs[i + 1] - xs[i], dz = zs[i + 1] - zs[i];
        const l2 = dx * dx + dz * dz;
        const l = Math.sqrt(l2);
        const t = l2 > 1e-6 ? Math.max(0, Math.min(1, ((px - xs[i]) * dx + (pz - zs[i]) * dz) / l2)) : 0;
        const qx = xs[i] + dx * t - px, qz = zs[i] + dz * t - pz;
        const d2 = qx * qx + qz * qz;
        if (d2 < best.d2) best = { s: acc + l * t, d2 };
        acc += l;
      }
      return best;
    };
    const total = (() => {
      let acc = 0;
      for (let i = 0; i + 1 < xs.length; i++) acc += Math.hypot(xs[i + 1] - xs[i], zs[i + 1] - zs[i]);
      return acc;
    })();
    // Re-centre when the player has moved along the line.
    const pp = proj(player.pos.x, player.pos.z);
    let sc = this.centre ? proj(this.centre.x, this.centre.z).s : pp.s;
    if (Math.abs(pp.s - sc) > RECENTRE_M) sc = pp.s;
    const s0 = Math.max(0, sc - HALF_WINDOW_M - 400), s1 = Math.min(total, sc + HALF_WINDOW_M + 400);
    const n = Math.max(2, Math.floor((s1 - s0) / STEP_M) + 1);
    const pts = new Float64Array(n * 4);
    let seg = 0, acc = 0;
    for (let k = 0; k < n; k++) {
      const s = s0 + k * STEP_M;
      while (seg < xs.length - 2 && acc + Math.hypot(xs[seg + 1] - xs[seg], zs[seg + 1] - zs[seg]) < s) {
        acc += Math.hypot(xs[seg + 1] - xs[seg], zs[seg + 1] - zs[seg]);
        seg++;
      }
      const dx = xs[seg + 1] - xs[seg], dz = zs[seg + 1] - zs[seg];
      const l = Math.hypot(dx, dz) || 1;
      const t = Math.max(0, Math.min(1, (s - acc) / l));
      let nx = -dz / l, nz = dx / l;
      if (nx * adv.x + nz * adv.z < 0) (nx = -nx, nz = -nz);
      pts[k * 4] = xs[seg] + dx * t;
      pts[k * 4 + 1] = zs[seg] + dz * t;
      pts[k * 4 + 2] = nx;
      pts[k * 4 + 3] = nz;
    }
    // Smooth the normals (a polyline's kinks would fan the trenches).
    for (let pass = 0; pass < 3; pass++) {
      for (let k = 1; k < n - 1; k++) {
        const nx = pts[(k - 1) * 4 + 2] + pts[k * 4 + 2] * 2 + pts[(k + 1) * 4 + 2];
        const nz = pts[(k - 1) * 4 + 3] + pts[k * 4 + 3] * 2 + pts[(k + 1) * 4 + 3];
        const l = Math.hypot(nx, nz) || 1;
        pts[k * 4 + 2] = nx / l;
        pts[k * 4 + 3] = nz / l;
      }
    }
    const prevCentre = this.centre?.clone() ?? null;
    this.pts = pts;
    this.nPts = n;
    this.sMin = s0 - sc;
    const c = this.at(0, 0, V1);
    if (!this.centre) this.centre = new THREE.Vector3();
    // The line itself moved (the sim's advance): how far, for the trenches.
    if (prevCentre) this.lineShift += Math.hypot(c.x - prevCentre.x, c.z - prevCentre.z) > RECENTRE_M ? 0 : Math.hypot(c.x - prevCentre.x, c.z - prevCentre.z);
    if (!prevCentre || Math.hypot(c.x - prevCentre.x, c.z - prevCentre.z) > 60 || this.lineShift > 60) {
      this.trenchDirty = true;
      this.lineShift = 0;
    }
    this.centre.set(c.x, 0, c.z);
    const np = proj(player.pos.x, player.pos.z);
    this.near = this.at(np.s - sc, 0, new THREE.Vector3());
    return true;
  }

  /** The point at arc s (m from the stretch centre) and depth d (m toward side b), with the normal. */
  private at(s: number, d: number, out: THREE.Vector3, nOut?: { x: number; z: number }): THREE.Vector3 {
    const n = this.nPts;
    const fk = Math.max(0, Math.min(n - 1.001, (s - this.sMin) / STEP_M));
    const k = Math.floor(fk), t = fk - k;
    const P = this.pts;
    const i0 = k * 4, i1 = Math.min(n - 1, k + 1) * 4;
    const x = P[i0] + (P[i1] - P[i0]) * t, z = P[i0 + 1] + (P[i1 + 1] - P[i0 + 1]) * t;
    let nx = P[i0 + 2] + (P[i1 + 2] - P[i0 + 2]) * t, nz = P[i0 + 3] + (P[i1 + 3] - P[i0 + 3]) * t;
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    if (nOut) {
      nOut.x = nx;
      nOut.z = nz;
    }
    return out.set(x + nx * d, 0, z + nz * d);
  }

  // ---------------------------------------------------------------------------------------------
  // Reconcile with the sim (every forces refresh, 2 real s)
  // ---------------------------------------------------------------------------------------------
  reconcile(lf: LocalForces, player: Ent, initial: boolean, skipInfantry?: ReadonlySet<number>): void {
    const host = this.host;
    const fr = lf.fronts[0];
    // A battle needs a line at war within reach, between the human's side and a nation fighting it.
    let ok = !!fr && fr.nearest.distKm < 6 && fr.lineKm.length >= 4;
    if (ok && fr) {
      const ra = host.relationOf(fr.a), rb = host.relationOf(fr.b);
      const fa = ra === 'own' || ra === 'allied', fb = rb === 'own' || rb === 'allied';
      ok = (fa && host.hostile(rb, fr.b)) || (fb && host.hostile(ra, fr.a));
    }
    if (!ok || !fr) {
      this.stand(player);
      return;
    }
    if (this.frontKey && this.frontKey !== fr.key) this.stand(player);
    if (!this.buildLine(lf, fr, player)) {
      this.stand(player);
      return;
    }
    this.active = true;
    this.frontKey = fr.key;
    // Sides and roles. An offensive pool makes a side the attacker; a quiet front is two lines holding.
    const sideOf = (owner: number): 1 | -1 => (owner === fr.b || (owner !== fr.a && lf.pairs.some((p) => ((p.a === owner && p.b === fr.b) || (p.b === owner && p.a === fr.b)) && p.alliance)) ? 1 : -1);
    const live = new Set<number>();
    let attacker = 0, bestOff = 0;
    for (const sd of lf.sides) {
      if (sd.owner !== fr.a && sd.owner !== fr.b) continue;
      if (sd.pools.offensive > bestOff + 0.5) {
        bestOff = sd.pools.offensive;
        attacker = sd.owner;
      }
    }
    if (fr.quiet) attacker = 0;
    this.heat = attacker ? Math.max(0.35, Math.min(1, 0.35 + fr.intensity * 0.65)) : 0.18 + Math.min(0.15, fr.intensity * 0.3);
    host.world.battleHeat = this.heat;
    const winKm = Math.max(1, fr.windowKm);
    for (const sd of lf.sides) {
      if (sd.owner !== fr.a && sd.owner !== fr.b) continue;
      const rel = host.relationOf(sd.owner);
      const friendly = rel === 'own' || rel === 'allied';
      const hostile = host.hostile(rel, sd.owner);
      if (!friendly && !hostile) continue;
      const pool = sd.pools.front + sd.pools.offensive;
      const perKm = pool / winKm;
      const cap = hostile ? SIDE_CAP_HOSTILE : SIDE_CAP_FRIENDLY;
      // The garrison within ±CONCENTRATION_KM / 2 of the player stands in the stretch (troops gather where the line
      // is fought over); an offensive's pool is already its corridor's troops, all of it in the fight.
      const local = sd.pools.front * Math.min(1, CONCENTRATION_KM / winKm) + sd.pools.offensive;
      const want = pool < 1 ? 0 : Math.min(cap, Math.max(Math.min(SIDE_MIN, Math.round(pool)), Math.round(local)));
      let st = this.sides.get(sd.owner);
      if (!st) {
        st = {
          owner: sd.owner, team: friendly ? 0 : 1, rel, hostile, sign: sideOf(sd.owner), role: 'hold', target: 0, troops: 0, perKm: 0,
          members: [], vehicles: [], vehTarget: 0, vehRespawnAt: 0, arty: 0.3 + Math.random() * 1.2, waveN: 0,
        };
        this.sides.set(sd.owner, st);
      }
      st.rel = rel;
      st.hostile = hostile;
      st.sign = sideOf(sd.owner);
      st.role = !attacker ? 'hold' : sd.owner === attacker ? 'attack' : 'defend';
      // A side handed over by the ground battle view keeps its own soldiers (forces.ts hand-off).
      st.target = skipInfantry?.has(sd.owner) ? 0 : want;
      st.troops = pool * TROOPS_PER_SOLDIER;
      st.perKm = perKm * TROOPS_PER_SOLDIER;
      st.vehTarget = Math.min(hostile ? VEHICLES_HOSTILE : VEHICLES_FRIENDLY, Math.floor(want / (hostile ? FIGS_PER_VEHICLE_HOSTILE : FIGS_PER_VEHICLE_FRIENDLY)));
      live.add(sd.owner);
    }
    for (const [o, st] of this.sides) if (!live.has(o)) this.withdraw(st, player), this.sides.delete(o);
    if (!this.decorated) this.decorate();
    for (const st of this.sides.values()) {
      this.recentreMembers(st, player);
      this.reconcileSide(st, player, initial);
      this.reconcileVehicles(st, player, initial);
    }
    if (this.trenchDirty) this.buildTrenches(player);
    this.clearBodies(player);
  }

  /** No battle here (any more): members far from the player leave the scene, the near ones withdraw. */
  private stand(player: Ent): void {
    if (!this.active && this.sides.size === 0) return;
    for (const st of this.sides.values()) this.withdraw(st, player);
    this.sides.clear();
    this.active = false;
    this.frontKey = 0;
    this.heat = 0;
    this.host.world.battleHeat = 0;
    this.trenchNear.count = this.trenchFar.count = 0;
    this.centre = null;
    this.hot = this.near = null;
    this.clearDecor();
  }

  private withdraw(st: SideState, player: Ent): void {
    const w = this.host.world;
    for (const m of st.members) {
      if (!m.e.alive || m.e.dormant || m.e.pos.distanceTo(player.pos) > 900) w.despawn(m.e);
      else {
        m.e.order = 'goto';
        this.at(m.s, st.sign * 2500, m.e.goal);
      }
    }
    for (const v of st.vehicles) {
      if (!v.alive || v.pos.distanceTo(player.pos) > 1200) w.despawn(v);
      else {
        v.order = 'goto';
        V1.subVectors(v.pos, player.pos).setY(0).normalize().multiplyScalar(3000).add(v.pos);
        v.goal.copy(V1);
      }
    }
    st.members.length = 0;
    st.vehicles.length = 0;
  }

  /** The stretch moved along the line: members left far behind it leave (if out of the player's way). */
  private recentreMembers(st: SideState, player: Ent): void {
    const w = this.host.world;
    const c = this.centre!;
    for (let i = st.members.length - 1; i >= 0; i--) {
      const m = st.members[i];
      const e = m.e;
      // Arc position relative to the current centre: project on the stretch's tangent (good enough over 2 km).
      const along = this.alongOf(e.pos.x - c.x, e.pos.z - c.z);
      m.s = along;
      if (Math.abs(along) > HALF_WINDOW_M + 300 && (e.dormant || !e.alive) && e.pos.distanceTo(player.pos) > 700) {
        w.despawn(e);
        st.members.splice(i, 1);
      }
    }
  }

  /**
   * Where along the stretch a new figure stands (u uniform 0..1): denser around its centre (the player), so the fight
   * is thickest where the player is and thins out toward the ends of the 2.4 km.
   */
  private spread(u: number): number {
    const v = u * 2 - 1;
    return Math.sign(v) * Math.pow(Math.abs(v), 1.7) * HALF_WINDOW_M;
  }

  /** Distance along the stretch's tangent at its centre. */
  private alongOf(dx: number, dz: number): number {
    const nC = { x: 0, z: 0 };
    this.at(0, 0, V2, nC);
    // tangent = normal rotated -90°
    return dx * nC.z - dz * nC.x;
  }

  private reconcileSide(st: SideState, player: Ent, initial: boolean): void {
    const w = this.host.world;
    const alive = st.members.filter((m) => m.e.alive);
    if (alive.length > st.target * 1.1 + 4) {
      // Fewer troops here now: the farthest from the player leave (never one next to the player).
      alive.sort((a, b) => b.e.pos.distanceToSquared(player.pos) - a.e.pos.distanceToSquared(player.pos));
      for (let i = 0; i < alive.length - st.target; i++) {
        const e = alive[i].e;
        if (e.pos.distanceTo(player.pos) < 700) break;
        w.despawn(e);
        st.members.splice(st.members.indexOf(alive[i]), 1);
      }
      return;
    }
    let missing = st.target - alive.length;
    if (missing <= 0) return;
    // Initial: the whole layout at once. Afterwards a wave or a draft of reserves per refresh.
    if (!initial) missing = Math.min(missing, st.role === 'attack' ? 48 : 30);
    const rng = w.rng;
    if (st.role === 'attack') {
      // Squads of 8-12 in waves.
      while (missing > 0) {
        const size = Math.min(missing, 8 + Math.floor(rng.next() * 5));
        const s = this.spread(rng.next());
        const startD = initial ? WAVE_D0 + rng.next() * (WAVE_D1 - WAVE_D0) : WAVE_D1 + rng.next() * 250;
        // Initial waves are caught at every stage of the assault: some already half way across.
        const start = initial && rng.next() < 0.45 ? -HALT_SHORT + rng.next() * (TRENCH_D + 120) : startD;
        const wave = st.waveN++;
        for (let i = 0; i < size; i++) {
          const si = s + (rng.next() - 0.5) * 40;
          const d0 = start + (rng.next() - 0.5) * 30;
          const halt = -(TRENCH_D - HALT_SHORT) - rng.next() * 25;
          const pos = this.at(si, st.sign * d0, V1);
          const goal = this.at(si + (rng.next() - 0.5) * 20, st.sign * Math.min(d0, halt), new THREE.Vector3());
          const look = this.at(si, -st.sign * TRENCH_D, new THREE.Vector3());
          const variant: 0 | 1 | 2 = i === 0 && wave % 2 === 0 ? 1 : i === 1 ? 2 : 0;
          const e = this.soldier(st, pos.x, pos.z, 'front', goal, look, wave, variant, player);
          if (e) st.members.push({ e, owner: st.owner, s: si });
        }
        missing -= size;
      }
      return;
    }
    // Holding: forward trench 55 %, second trench 25 %, reserves 20 % (replacements come up from the reserves).
    let k = 0;
    while (missing > 0) {
      const r = rng.next();
      const s = this.spread(rng.next());
      let d: number, order: 'hold' | 'front' = 'hold';
      const goal = new THREE.Vector3();
      if (initial ? r < 0.55 : r < 0.15) d = trenchAt(TRENCH_D, s) + 0.5 + rng.next() * 0.6;
      else if (initial ? r < 0.8 : r < 0.4) d = trenchAt(TRENCH2_D, s) + 0.5 + rng.next() * 0.6;
      else d = RESERVE_D0 + rng.next() * (RESERVE_D1 - RESERVE_D0);
      const pos = this.at(s, st.sign * d, V1);
      if (!initial && d > TRENCH2_D + 50) {
        // A draft from the reserves runs up to the forward trench.
        order = 'front';
        const sg = s + (rng.next() - 0.5) * 20;
        this.at(sg, st.sign * (trenchAt(TRENCH_D, sg) + 0.7), goal);
      } else goal.copy(pos);
      const look = this.at(s, -st.sign * (st.role === 'hold' ? TRENCH_D : 300), new THREE.Vector3());
      const variant: 0 | 1 | 2 = k % 14 === 3 ? 2 : k % 9 === 5 ? 1 : 0;
      const e = this.soldier(st, pos.x, pos.z, order, goal, look, order === 'front' ? 10_000 + st.waveN++ : -1, variant, player);
      if (e) st.members.push({ e, owner: st.owner, s });
      k++;
      missing--;
    }
  }

  private soldier(st: SideState, x: number, z: number, order: 'hold' | 'front', goal: THREE.Vector3, look: THREE.Vector3, wave: number, variant: 0 | 1 | 2, player: Ent): Ent | null {
    const host = this.host;
    if (host.ground.heightAt(x, z) < 0.8) return null;
    const far = Math.hypot(x - player.pos.x, z - player.pos.z) > WAKE_M;
    const yaw = Math.atan2(-(look.x - x), -(look.z - z));
    const kind: EntKind = variant === 1 ? 'at' : 'soldier';
    const e = host.world.spawn(kind, st.team, x, z, yaw, undefined, far, variant === 2);
    if (!e.alive) return null;
    e.nation = st.owner;
    e.neutral = st.team === 1 && !st.hostile;
    e.src = { kind: 'pool', id: 0, owner: st.owner, share: 0 };
    e.order = order;
    e.goal.copy(goal);
    e.look.copy(look);
    e.wave = wave;
    e.fireCd = host.world.rng.next() * 5;
    e.pose = order === 'hold' ? (variant === 2 || e.seed < 0.3 ? POSE.prone : POSE.kneel) : POSE.prone;
    return e;
  }

  private reconcileVehicles(st: SideState, player: Ent, initial: boolean): void {
    const w = this.host.world;
    for (let i = st.vehicles.length - 1; i >= 0; i--) if (!st.vehicles[i].alive && st.vehicles[i].deadT > 120) st.vehicles.splice(i, 1);
    const alive = st.vehicles.filter((v) => v.alive);
    if (alive.length >= st.vehTarget) return;
    if (!initial && w.time < st.vehRespawnAt) return;
    st.vehRespawnAt = w.time + 45;
    const rng = w.rng;
    for (let k = alive.length; k < st.vehTarget; k++) {
      const s = (rng.next() * 2 - 1) * (HALF_WINDOW_M - 150);
      const kind: EntKind = st.role === 'attack' ? (k % 5 < 2 ? 'tank' : 'ifv') : k % 3 === 2 ? 'tank' : 'ifv';
      const d = st.role === 'attack' ? (initial ? 300 + rng.next() * 300 : WAVE_D1 + 200) : TRENCH2_D - 60 + rng.next() * 60;
      const pos = this.at(s, st.sign * d, new THREE.Vector3());
      // Never out of thin air in front of the player.
      if (!initial && pos.distanceTo(player.pos) < 700) continue;
      if (this.host.ground.heightAt(pos.x, pos.z) < 0.8) continue;
      const look = this.at(s, -st.sign * 400, V2);
      const yaw = Math.atan2(-(look.x - pos.x), -(look.z - pos.z));
      const e = w.spawn(kind, st.team, pos.x, pos.z, yaw);
      e.nation = st.owner;
      e.neutral = st.team === 1 && !st.hostile;
      // A line vehicle stands for its crew and the squad it carries (soldier-equivalents for the kill sync).
      e.src = { kind: 'pool', id: 0, owner: st.owner, share: kind === 'tank' ? 10 : 8 };
      if (st.role === 'attack') {
        e.order = 'front';
        this.at(s, -st.sign * (TRENCH_D - HALT_SHORT - 40), e.goal);
      } else {
        e.order = 'hold';
        e.goal.copy(pos);
      }
      st.vehicles.push(e);
    }
  }

  /** Bodies: the oldest far ones are cleared beyond BODIES_MAX. */
  private clearBodies(player: Ent): void {
    const w = this.host.world;
    const dead: Member[] = [];
    for (const st of this.sides.values()) for (const m of st.members) if (!m.e.alive) dead.push(m);
    if (dead.length <= BODIES_MAX) return;
    dead.sort((a, b) => b.e.deadT - a.e.deadT);
    for (let i = 0; i < dead.length - BODIES_MAX; i++) {
      const m = dead[i];
      if (m.e.pos.distanceTo(player.pos) < 250) continue;
      w.despawn(m.e);
      const st = this.sides.get(m.owner);
      if (st) st.members.splice(st.members.indexOf(m), 1);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Trenches, wrecks, craters
  // ---------------------------------------------------------------------------------------------
  private buildTrenches(player: Ent): void {
    this.trenchDirty = false;
    const g = this.host.ground;
    const lines: { sign: 1 | -1; depth: number }[] = [];
    for (const st of this.sides.values()) {
      if (st.role === 'attack') continue;
      lines.push({ sign: st.sign, depth: TRENCH_D }, { sign: st.sign, depth: TRENCH2_D });
    }
    this.trenchSides = lines;
    let nn = 0, nf = 0;
    const nrm = { x: 0, z: 0 };
    for (const ln of lines) {
      for (let s = -HALF_WINDOW_M; s <= HALF_WINDOW_M && nn + nf < TRENCH_CAP; s += SEG_M) {
        // A fire trench winds a little (bays every ~30 m); each segment lies along the trench's own course.
        const zig = (s2: number): number => trenchAt(ln.depth, s2);
        const p = this.at(s + SEG_M / 2, ln.sign * zig(s + SEG_M / 2), V1, nrm);
        const q0 = this.at(s, ln.sign * zig(s), V2);
        const q0x = q0.x, q0z = q0.z;
        const q1 = this.at(s + SEG_M, ln.sign * zig(s + SEG_M), V2);
        const h = g.heightAt(p.x, p.z);
        if (h < 0.8) continue;
        // Local X along the trench, -Z (the parapet) toward the enemy (-sign × normal).
        let tx = q1.x - q0x, tz = q1.z - q0z;
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        // -Z of the model = (-sin yaw, -cos yaw); X = (cos yaw, -sin yaw) must follow the tangent.
        let yaw = Math.atan2(-tz, tx);
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        if (fx * -ln.sign * nrm.x + fz * -ln.sign * nrm.z < 0) yaw += Math.PI;
        // Lie on the slope: tilt along the trench (local X) and across it (local Z), from the ground at its ends.
        const cx = Math.cos(yaw), sx = -Math.sin(yaw), fwx = -Math.sin(yaw), fwz = -Math.cos(yaw);
        const hR = g.heightAt(p.x + cx * 1.6, p.z + sx * 1.6), hL = g.heightAt(p.x - cx * 1.6, p.z - sx * 1.6);
        const hF = g.heightAt(p.x + fwx * 1.2, p.z + fwz * 1.2), hB = g.heightAt(p.x - fwx * 0.8, p.z - fwz * 0.8);
        E.set(Math.atan2(hF - hB, 2.0), yaw, Math.atan2(hR - hL, 3.2), 'YXZ');
        Q.setFromEuler(E);
        M4.compose(V2.set(p.x, h - 0.08, p.z), Q, S1);
        const close = Math.hypot(p.x - player.pos.x, p.z - player.pos.z) < 450;
        if (close) this.trenchNear.setMatrixAt(nn++, M4);
        else this.trenchFar.setMatrixAt(nf++, M4);
      }
    }
    this.trenchNear.count = nn;
    this.trenchFar.count = nf;
    this.trenchNear.instanceMatrix.needsUpdate = true;
    this.trenchFar.instanceMatrix.needsUpdate = true;
    this.trenchBuiltAt.copy(player.pos);
  }
  private readonly trenchBuiltAt = new THREE.Vector3();

  /** Wrecks and craters in no man's land: a fight that has been going on. */
  private decorate(): void {
    this.decorated = true;
    const w = this.host.world;
    const fx = w.fx;
    const rng = w.rng;
    const g = this.host.ground;
    for (let i = 0; i < 70; i++) {
      const p = this.at((rng.next() * 2 - 1) * HALF_WINDOW_M, (rng.next() - 0.5) * 2 * (TRENCH_D + 120), V1);
      fx.decal(p.x, p.z, 3 + rng.next() * 5, 0, 0.55 + rng.next() * 0.3, rng.next() * 6.28);
    }
    const kinds: EntKind[] = ['truck', 'ifv', 'tank', 'truck', 'ifv'];
    const nW = 5 + Math.floor(rng.next() * 4);
    for (let i = 0; i < nW; i++) {
      const p = this.at((rng.next() * 2 - 1) * (HALF_WINDOW_M - 100), (rng.next() - 0.5) * 2 * (TRENCH_D + 250), V1);
      const h = g.heightAt(p.x, p.z);
      if (h < 0.8) continue;
      const rig = w.makeRig(kinds[i % kinds.length], (i % 2) as 0 | 1);
      w.wreckRig(rig);
      rig.root.position.set(p.x, h - 0.2, p.z);
      rig.root.rotation.set(0, rng.next() * 6.28, (rng.next() - 0.5) * 0.12);
      if (rig.turret && rng.next() < 0.4) rig.turret.rotation.y = rng.next() * 6.28;
      this.group.add(rig.root);
      this.wrecks.push(rig.root);
      if (rng.next() < 0.6) this.wreckFires.push({ x: p.x, y: h + 1.5, z: p.z, heat: 0.35 + rng.next() * 0.5 });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Every local step: artillery, attrition, smoke, the hot point
  // ---------------------------------------------------------------------------------------------
  update(dt: number, player: Ent | null): void {
    if (!this.active || dt <= 0 || !player) return;
    const w = this.host.world;
    const fx = w.fx;
    const rng = w.rng;
    // Trenches near the player get the detailed parapet.
    if (this.trenchBuiltAt.distanceTo(player.pos) > 250) this.buildTrenches(player);
    // Burning wrecks.
    for (const f of this.wreckFires) {
      if (Math.abs(f.x - player.pos.x) > 3000 || Math.abs(f.z - player.pos.z) > 3000) continue;
      V1.set(f.x, f.y, f.z);
      if (f.heat > 0.6) fx.burn(V1, f.heat, dt, 0.9);
      else fx.column(V1, 0.5 + f.heat, dt);
    }
    // Artillery on the other side's positions.
    for (const st of this.sides.values()) {
      const n = st.members.length;
      if (n === 0) continue;
      // Rounds per second on the other side's stretch: ~1 at the height of an offensive, one every ~10 s on a quiet line.
      const rate = this.heat * (0.3 + 0.9 * Math.min(1, n / 400)) * (st.role === 'hold' ? 0.3 : 1);
      st.arty -= dt * rate;
      if (st.arty > 0) continue;
      st.arty = 0.6 + rng.next() * 1.4;
      this.shell(st, player);
    }
    // Battery flashes on the horizon behind both lines.
    this.flashT -= dt * this.heat;
    if (this.flashT <= 0) {
      this.flashT = 0.4 + rng.next() * 1.2;
      const sides = [...this.sides.values()];
      const st = sides[Math.floor(rng.next() * sides.length)];
      if (st) {
        const p = this.at((rng.next() * 2 - 1) * 4000, st.sign * (3500 + rng.next() * 2500), V1);
        const y = this.host.ground.surfaceAt(p.x, p.z) + 8;
        fx.particles.emit(6, p.x, y, p.z, 0, 0, 0, 0.14, 40, 90, 5, 3.6, 2, 1);
        fx.particles.emit(1, p.x, y + 10, p.z, 0, 3, 0, 6, 30, 90, 0.5, 0.48, 0.45, 0.35);
        // The rumble reaches you a few seconds later, faint.
        V2.subVectors(p, player.pos).setY(0).setLength(220).add(player.pos);
        fx.playAt('artillery', V2, 0.12);
      }
    }
    // Attrition: the sim's casualties at this front, seen as figures falling (exposed attackers first).
    this.attrAcc += dt;
    if (this.attrAcc >= 0.5) {
      const step = this.attrAcc;
      this.attrAcc = 0;
      for (const st of this.sides.values()) {
        const exposed = st.members.filter((m) => m.e.alive && m.e.dormant);
        if (!exposed.length) continue;
        const per = (st.role === 'attack' ? 0.0045 : st.role === 'defend' ? 0.0018 : 0.0007) * this.heat;
        let k = exposed.length * per * step;
        while (k > 0) {
          if (rng.next() >= Math.min(1, k)) break;
          k -= 1;
          // Attackers nearer the enemy trench fall more often.
          let m = exposed[Math.floor(rng.next() * exposed.length)];
          if (st.role === 'attack') {
            const m2 = exposed[Math.floor(rng.next() * exposed.length)];
            if (m2.e.pos.distanceToSquared(m2.e.look) < m.e.pos.distanceToSquared(m.e.look)) m = m2;
          }
          if (!m.e.alive) continue;
          w.kill(m.e, null, false);
        }
      }
    }
    // Smoke screens ahead of the assault waves.
    this.smokeT -= dt * this.heat;
    if (this.smokeT <= 0) {
      this.smokeT = 18 + rng.next() * 22;
      const att = [...this.sides.values()].find((s) => s.role === 'attack');
      if (att) {
        const p = this.at((rng.next() * 2 - 1) * HALF_WINDOW_M * 0.9, att.sign * (rng.next() * 60), V1);
        p.y = this.host.ground.heightAt(p.x, p.z);
        const n = { x: 0, z: 0 };
        this.at(0, 0, V2, n);
        V2.set(-att.sign * n.z, 0, att.sign * n.x);
        fx.smokeScreen(p, V2);
        w.addSmoke(p.x, p.y + 3, p.z, 30, 40);
      }
    }
    // The hot point: where the fighting is now (assault ranks near the enemy, shells and falls of the last seconds).
    this.bins.fill(0);
    const binOf = (x: number, z: number): number => {
      const c = this.centre!;
      const s = this.alongOf(x - c.x, z - c.z);
      return Math.max(0, Math.min(7, Math.floor((s + HALF_WINDOW_M) / (HALF_WINDOW_M / 4))));
    };
    for (const st of this.sides.values()) {
      if (st.role !== 'attack') continue;
      for (const m of st.members) {
        if (!m.e.alive) continue;
        const dl = m.e.pos.distanceTo(m.e.look);
        if (dl < 260) this.bins[binOf(m.e.pos.x, m.e.pos.z)] += 1;
      }
    }
    for (const h of this.recent) if (w.time - h.t < 15) this.bins[binOf(h.x, h.z)] += 2;
    let bi = -1, bv = 0;
    for (let i = 0; i < 8; i++) if (this.bins[i] > bv) (bv = this.bins[i], bi = i);
    if (bi >= 0) {
      const s = -HALF_WINDOW_M + (bi + 0.5) * (HALF_WINDOW_M / 4);
      this.hot = this.at(s, 0, this.hot ?? new THREE.Vector3());
      this.hot.y = this.host.ground.heightAt(this.hot.x, this.hot.z);
    } else if (this.near) this.hot = this.near.clone();
    const now = w.time;
    while (this.shellTimes.length && now - this.shellTimes[0] > 10) this.shellTimes.shift();
    while (this.fallTimes.length && now - this.fallTimes[0] > 10) this.fallTimes.shift();
    while (this.recent.length && now - this.recent[0].t > 15) this.recent.shift();
  }

  private recent: { t: number; x: number; z: number }[] = [];

  /** A figure of the battle fell (attrition, artillery or the player). */
  fell(e: Ent): void {
    if (!this.active) return;
    this.fallTimes.push(this.host.world.time);
    this.recent.push({ t: this.host.world.time, x: e.pos.x, z: e.pos.z });
    if (this.recent.length > 200) this.recent.shift();
  }

  /** One artillery round of this side on the other side's positions. */
  private shell(st: SideState, player: Ent): void {
    const w = this.host.world;
    const rng = w.rng;
    const foes = [...this.sides.values()].filter((o) => o.team !== st.team);
    const foe = foes[Math.floor(rng.next() * foes.length)];
    if (!foe) return;
    let tx = 0, tz = 0, ok = false;
    for (let tries = 0; tries < 6 && !ok; tries++) {
      const m = foe.members[Math.floor(rng.next() * foe.members.length)];
      if (m && m.e.alive) {
        tx = m.e.pos.x + (rng.next() - 0.5) * 50;
        tz = m.e.pos.z + (rng.next() - 0.5) * 50;
      } else {
        const p = this.at((rng.next() * 2 - 1) * HALF_WINDOW_M, foe.sign * (TRENCH_D + rng.next() * 400), V1);
        tx = p.x;
        tz = p.z;
      }
      const dp = Math.hypot(tx - player.pos.x, tz - player.pos.z);
      // Rounds fall near the player only now and then (it is a battle, not a shooting gallery).
      ok = dp > 35 && (dp > 140 || rng.next() < 0.15);
    }
    if (!ok) return;
    const ty = this.host.ground.heightAt(tx, tz);
    if (ty < 0.5) return;
    const n = { x: 0, z: 0 };
    this.at(0, 0, V2, n);
    // From high up on the firing side, steep.
    V1.set(tx + st.sign * n.x * 160, ty + 520, tz + st.sign * n.z * 160);
    V2.set(tx - V1.x, ty - V1.y, tz - V1.z).normalize();
    const p = w.fireShell(null, st.team, V1, V2, 330, 70, 16, false, false, 1.3);
    if (p) {
      p.gravity = 0;
      p.life = 4;
      p.tracer = false;
      p.width = 0.01;
    }
    this.shellTimes.push(w.time);
    this.recent.push({ t: w.time, x: tx, z: tz });
    if (Math.hypot(tx - player.pos.x, tz - player.pos.z) < 600) w.fx.playAt('artillery', V2.set(tx, ty, tz), 0.35);
  }
}

/** Depth of a trench line at arc s: it winds a little (bays every ~30 m). */
function trenchAt(depth: number, s: number): number {
  return depth + 3.5 * Math.sin((s / 30) * Math.PI);
}

/** Sandbag parapet with the trench behind it (3.2 m segment along X; the enemy is toward -Z). */
function parapetGeometry(detail: boolean): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const L = SEG_M + 0.3;
  // The dark trench floor behind the parapet, then the spoil berm in front of it (a low trapezoid, toward -Z).
  b.planY([[0.25, -L / 2], [0.25, L / 2], [-1.05, L / 2], [-1.05, -L / 2]], 0.04, 0x2b241c, 0, 0.0, 0);
  b.profileX([[0.2, 0], [0.55, 0.42], [1.15, 0.38], [1.9, 0]], L, 0x6e5d44, 0, -0.02, 0);
  if (detail) {
    // Two courses of sandbags on the crest, each bag a little turned.
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 6; i++) {
        const x = -L / 2 + 0.3 + i * 0.6 + (row % 2) * 0.3;
        if (x > L / 2 - 0.2) continue;
        b.box(0.58, 0.2, 0.36, row ? 0x9a8a68 : 0x8a7b5a, x, 0.5 + row * 0.19, -0.62 - row * 0.05, 0, ((i * 37 + row * 11) % 7 - 3) * 0.03, 0);
      }
    }
  } else {
    b.box(L, 0.36, 0.4, 0x8a7b5a, 0, 0.58, -0.62);
  }
  return b.build();
}
