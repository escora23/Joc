// FRONT ULTRA — command mode: local forces from the simulation (DESIGN_V2 §9.6; owner: W5-command-v2).
//
// Every 2 real seconds this asks src/shared/localForces.ts (the ONE derivation shared with the ground battle layer)
// what really stands around the vehicle and reconciles the local entities with it. Nothing here derives pools of its
// own: it only decides how many of the derived soldiers, tanks, aircraft and ships are shown (budgets of §9.6) and
// where they stand, and keeps each entity tied to its source so kills and damage go back to the right place (§9.8):
//   front / offensive pools  → infantry squads and AT teams near the contact line, on their side (cap 40 per side);
//   rear pool                → patrols in enemy land away from fronts (cap 12);
//   defense posts            → 6 soldiers + 1 AT team at each post within 10 km;
//   real divisions (30 km)   → 1 tank per 25 % integrity + 2 IFVs at the division's real position and heading,
//                              following its strategic movement (kinematic while far, driven by the AI near you);
//   real ships (40 km)       → the ship; SAM sites (15 km / their range for a jet) → 1 launcher per level;
//   real squadrons           → 1 jet per third of integrity when their patrol covers the place; docked fighters of
//                              an airbase at war within 150 km scramble once toward an intruding jet;
//   incursion responses      → the quick-reaction force of view.command: trucks on the road, then its soldiers.
// Forces of a nation at peace are `neutral`: they block and escort, never fire, and are never fired at by the AI.

import * as THREE from 'three';
import { HUMAN_ID, MAP_H, MAP_W } from '../shared/constants';
import type { GameView } from '../shared/api';
import { deriveLocalForces, type LocalForces, type LocalRelation } from '../shared/localForces';
import { StructureType, UnitMode, UnitType, type CommandKind } from '../shared/types';
import type { LocalFrame } from './frame';
import type { Ground } from './stream';
import { ENT_DEFS, type Ent, type EntKind, type EntSource, type World } from './world';

/** Radius of the derivation per vehicle (km): the whole area that can reach you. */
export const FORCES_RADIUS_KM: Record<CommandKind, number> = { tank: 30, jet: 150, ship: 40 };
export const INFANTRY_CAP = 40;
export const REAR_CAP = 12;
const DIVISION_KM = 30;
const SHIP_KM = 40;
const POST_KM = 10;
const SAM_KM = 15;
const SCRAMBLE_KM = 150;
/** Jet cruising altitude of the sim's aircraft (alt = 1). */
export const FLIGHT_CEILING_M = 9000;

interface Group {
  key: string;
  ents: Ent[];
  /** Last refresh that wanted it. */
  seen: number;
}

export interface ForcesLog {
  at: number;
  /** Viewer-side pools, per side: owner, relation, front/offensive/rear/posts soldiers and the visible target. */
  sides: { owner: number; relation: LocalRelation; front: number; offensive: number; rear: number; posts: number; infantry: number; shownInfantry: number; divisions: { unitId: number; tanks: number; ifvs: number }[] }[];
  frontKey: number;
  /** Nearest front point distance (km), -1 = none. */
  frontKm: number;
  hostiles: number;
  neutrals: number;
  friendlies: number;
}

const V = new THREE.Vector3();
const P2 = { x: 0, z: 0 };

export class Forces {
  private readonly groups = new Map<string, Group>();
  private refreshN = 0;
  last: LocalForces | null = null;
  log: ForcesLog = { at: 0, sides: [], frontKey: 0, frontKm: -1, hostiles: 0, neutrals: 0, friendlies: 0 };
  private scrambled = new Set<number>();
  /** Division id → last scene position of the division (tracking). */
  private readonly divPos = new Map<number, { x: number; z: number; yaw: number; moving: boolean }>();
  kind: CommandKind = 'tank';
  controlledId = 0;
  /** Soldiers per side the ground battle was showing when control was taken from it (§9.6 hand-off). */
  handoff: Map<number, number> | null = null;

  constructor(private readonly world: World, private readonly frame: LocalFrame, private readonly ground: Ground) {}

  reset(kind: CommandKind, controlledId: number): void {
    this.groups.clear();
    this.divPos.clear();
    this.scrambled.clear();
    this.refreshN = 0;
    this.last = null;
    this.kind = kind;
    this.controlledId = controlledId;
    this.handoff = null;
  }

  /** Relation of a nation to the human, as the sim sees it now. */
  relationOf(view: GameView, owner: number): LocalRelation {
    if (owner === HUMAN_ID) return 'own';
    if (owner <= 0) return 'unclaimed';
    if (view.hasTreaty(HUMAN_ID, owner, 'alliance') || view.human?.allies.includes(owner)) return 'allied';
    return view.pairState(HUMAN_ID, owner);
  }

  private team(rel: LocalRelation): 0 | 1 {
    return rel === 'own' || rel === 'allied' ? 0 : 1;
  }

  // ---------------------------------------------------------------------------------------------
  // Refresh (every 2 real s)
  // ---------------------------------------------------------------------------------------------
  refresh(view: GameView, player: Ent, alpha: number, initial: boolean): LocalForces {
    this.refreshN++;
    const f = this.frame;
    const tp = f.tileOfScene(player.pos.x, player.pos.z, { x: 0, y: 0 });
    const lf = deriveLocalForces(view, tp.x, tp.y, FORCES_RADIUS_KM[this.kind], HUMAN_ID, { alpha });
    this.last = lf;
    const n = this.refreshN;
    const want = (key: string): Group => {
      let g = this.groups.get(key);
      if (!g) this.groups.set(key, (g = { key, ents: [], seen: n }));
      g.seen = n;
      return g;
    };
    const logSides: ForcesLog['sides'] = [];
    // --- Infantry pools near the front, rear patrols, posts (ground vehicles only) ---
    const front = lf.fronts[0];
    const frontKm = front ? front.nearest.distKm : -1;
    let enemyShown = 0;
    for (const side of lf.sides) {
      const rel = side.relation;
      const hostile = rel === 'war';
      const friendly = rel === 'own' || rel === 'allied';
      const entry = {
        owner: side.owner, relation: rel, front: side.pools.front, offensive: side.pools.offensive, rear: side.pools.rear, posts: side.pools.posts,
        infantry: side.infantry, shownInfantry: 0, divisions: side.divisions.map((d) => ({ unitId: d.unitId, tanks: d.tanks, ifvs: d.ifvs })),
      };
      logSides.push(entry);
      if (this.kind !== 'tank') continue;
      if (hostile || friendly) {
        // Front and offensive pools stand along the local contact line (when it is within 6 km).
        if (front && frontKm < 6 && (side.owner === front.a || side.owner === front.b || friendly)) {
          const pool = side.pools.front + side.pools.offensive;
          const cap = this.handoff?.get(side.owner) ?? (hostile ? INFANTRY_CAP : INFANTRY_CAP / 2);
          const shown = Math.min(cap, Math.round(pool));
          entry.shownInfantry = shown;
          if (hostile) enemyShown += shown;
          this.reconcileInfantry(want(`front:${side.owner}`), shown, side.owner, rel, lf, player, 'front', initial);
        }
        if (hostile && (!front || frontKm >= 6)) {
          const shown = Math.min(REAR_CAP, Math.round(side.pools.rear));
          entry.shownInfantry += shown;
          this.reconcileInfantry(want(`rear:${side.owner}`), shown, side.owner, rel, lf, player, 'rear', initial);
        }
      }
    }
    // Posts (any nation; neutral when at peace, their soldiers stand guard).
    if (this.kind === 'tank') {
      for (const s of lf.structures) {
        if (s.type !== StructureType.DefensePost || s.built < 1 || s.distKm > POST_KM) continue;
        const rel = this.relationOf(view, s.owner);
        this.reconcilePost(want(`post:${s.structureId}`), s.structureId, s.owner, rel, s.lat, s.lon, s.level);
      }
    }
    // SAM sites.
    for (const s of lf.structures) {
      if (s.type !== StructureType.SamSite || s.built < 1) continue;
      if (this.kind !== 'jet' ? s.distKm > SAM_KM : !(s.coversAnchor || s.distKm < SAM_KM)) continue;
      const rel = this.relationOf(view, s.owner);
      this.reconcileSam(want(`sam:${s.structureId}`), s.structureId, s.owner, rel, s.lat, s.lon, Math.max(1, s.level));
    }
    // Real units.
    for (const u of lf.units) {
      if (u.unitId === this.controlledId) continue;
      const rel = this.relationOf(view, u.owner);
      if (u.type === UnitType.ArmoredDivision && this.kind === 'tank' && u.distKm <= DIVISION_KM) {
        this.reconcileDivision(want(`div:${u.unitId}`), u.unitId, u.owner, rel, u.lat, u.lon, u.heading, u.tanks, u.ifvs, u.mode, initial, player);
      } else if (u.type === UnitType.Warship && (this.kind === 'ship' || this.kind === 'tank') && u.distKm <= SHIP_KM) {
        this.reconcileShip(want(`ship:${u.unitId}`), u.unitId, u.owner, rel, u.lat, u.lon, u.heading, u.integrity);
      } else if (u.type === UnitType.FighterSquadron && this.kind === 'jet' && u.airborne && (u.reason === 'cap' || u.distKm < 80)) {
        this.reconcileJets(want(`sq:${u.unitId}`), u.unitId, u.owner, rel, u.lat, u.lon, u.heading, u.jets, player);
      }
    }
    // Scramble: docked fighters of an airbase at war within 150 km take off toward an intruding jet (once).
    if (this.kind === 'jet') {
      for (const s of lf.structures) {
        if (s.type !== StructureType.Airbase || s.distKm > SCRAMBLE_KM || this.relationOf(view, s.owner) !== 'war') continue;
        for (const u of view.units.values()) {
          if (u.type !== UnitType.FighterSquadron || u.home !== s.structureId || u.mode !== UnitMode.Docked || this.scrambled.has(u.id)) continue;
          this.scrambled.add(u.id);
          const jets = Math.max(1, Math.round(u.hp * 3));
          const g = want(`sq:${u.id}`);
          this.reconcileJets(g, u.id, u.owner, 'war', s.lat, s.lon, 0, jets, player, true);
        }
      }
    }
    // Quick-reaction forces of incursions (view.command).
    for (const inc of view.command?.incursions ?? []) {
      if (inc.left || !inc.qrf || inc.intruder !== HUMAN_ID || inc.kind === 'jet') continue;
      const rel = this.relationOf(view, inc.victim);
      this.reconcileQrf(want(`qrf:${inc.id}`), inc.victim, rel, inc.qrf.x, inc.qrf.y, inc.qrf.arrived, inc.qrf.soldiers, player);
    }
    // Groups nobody wants any more: their living members leave once out of sight; bodies are cleared later.
    for (const [k, g] of this.groups) {
      if (g.seen === n) continue;
      for (const e of [...g.ents]) {
        if (!e.alive || e.pos.distanceTo(player.pos) > 1500) {
          this.world.despawn(e);
          g.ents.splice(g.ents.indexOf(e), 1);
        } else if (e.src && e.src.kind !== 'formation') {
          // Their source is gone (the division left, a war ended): they withdraw.
          e.order = 'goto';
          V.subVectors(e.pos, player.pos).setY(0).normalize().multiplyScalar(3000).add(e.pos);
          e.goal.copy(V);
        }
      }
      if (g.ents.length === 0) this.groups.delete(k);
    }
    // Relations may have changed (a declaration): neutral flags follow the pair state.
    for (const g of this.groups.values()) {
      for (const e of g.ents) {
        if (!e.alive || e.formation || !e.nation) continue;
        const rel = this.relationOf(view, e.nation);
        e.neutral = rel !== 'war' && this.team(rel) === 1;
        if (e.order === 'escort' && rel === 'war') {
          e.order = 'front';
          e.goal.copy(player.pos);
        }
      }
    }
    // Old bodies.
    for (const g of this.groups.values()) {
      for (let i = g.ents.length - 1; i >= 0; i--) {
        const e = g.ents[i];
        if (!e.alive && (e.deadT > 90 || e.pos.distanceTo(player.pos) > 4000)) {
          this.world.despawn(e);
          g.ents.splice(i, 1);
        }
      }
    }
    // Log.
    let hostiles = 0, neutrals = 0, friendlies = 0;
    for (const e of this.world.ents) {
      if (!e.alive || e.player) continue;
      if (e.team === 0) friendlies++;
      else if (e.neutral) neutrals++;
      else hostiles++;
    }
    this.log = { at: performance.now(), sides: logSides, frontKey: lf.frontKey, frontKm, hostiles, neutrals, friendlies };
    void enemyShown;
    return lf;
  }

  // ---------------------------------------------------------------------------------------------
  // Reconcilers
  // ---------------------------------------------------------------------------------------------
  private sceneOfLL(lat: number, lon: number, out: THREE.Vector3): THREE.Vector3 {
    this.frame.sceneOf(lat, lon, P2);
    return out.set(P2.x, 0, P2.z);
  }

  private mk(kind: EntKind, team: 0 | 1, x: number, z: number, yaw: number, owner: number, rel: LocalRelation, src: EntSource, y?: number): Ent {
    const e = this.world.spawn(kind, team, x, z, yaw, y);
    e.nation = owner;
    e.neutral = team === 1 && rel !== 'war';
    e.src = src;
    return e;
  }

  private alive(g: Group): Ent[] {
    return g.ents.filter((e) => e.alive);
  }

  /** Remove extra living members, the farthest from the player first (never ones fighting right next to it). */
  private trim(g: Group, keep: number, player: Ent): void {
    const live = this.alive(g).sort((a, b) => b.pos.distanceTo(player.pos) - a.pos.distanceTo(player.pos));
    for (let i = 0; i < live.length - keep; i++) {
      const e = live[i];
      if (e.pos.distanceTo(player.pos) < 600) break;
      this.world.despawn(e);
      g.ents.splice(g.ents.indexOf(e), 1);
    }
  }

  /**
   * Infantry of a pool: squads (1 AT gunner per 6) along the contact line on the owner's side, or rear patrols.
   * Replacements walk in from the far end of the sector, out of the player's immediate view.
   */
  private reconcileInfantry(g: Group, count: number, owner: number, rel: LocalRelation, lf: LocalForces, player: Ent, where: 'front' | 'rear', initial: boolean): void {
    const live = this.alive(g);
    if (live.length > count) this.trim(g, count, player);
    if (live.length >= count) return;
    const team = this.team(rel);
    const fr = lf.fronts[0];
    const rng = this.world.rng;
    // Line frame: nearest point N, run direction L (along the line), side direction S toward this owner's land.
    const N = new THREE.Vector3(), L = new THREE.Vector3(), S = new THREE.Vector3();
    const aScene = new THREE.Vector3();
    this.sceneOfLL(lf.lat, lf.lon, aScene);
    if (where === 'front' && fr) {
      N.set(aScene.x + fr.nearest.eastKm * 1000, 0, aScene.z - fr.nearest.northKm * 1000);
      L.set(Math.sin(fr.lineBearing), 0, -Math.cos(fr.lineBearing));
      const adv = new THREE.Vector3(Math.sin(fr.advanceBearing), 0, -Math.cos(fr.advanceBearing));
      // Side a pushes into b: b's troops stand on the far side of the line along the advance direction.
      const onB = owner === fr.b || (owner !== fr.a && this.relationOf2(lf, owner, fr.b));
      S.copy(adv).multiplyScalar(onB ? 1 : -1);
    }
    let missing = count - live.length;
    let squad = 0;
    while (missing > 0) {
      const size = Math.min(missing, 5 + Math.floor(rng.next() * 3));
      // Squad anchor.
      const c = new THREE.Vector3();
      if (where === 'front' && fr) {
        const lateral = (rng.next() - 0.5) * 2 * Math.min(1400, Math.max(400, fr.windowKm * 150));
        const depth = team === 1 ? 140 + rng.next() * 420 : 90 + rng.next() * 300;
        c.copy(N).addScaledVector(L, lateral).addScaledVector(S, depth);
        // Replacements come up from behind their line.
        if (!initial) c.addScaledVector(S, 500 + rng.next() * 400);
      } else {
        const a = rng.next() * Math.PI * 2, r = 900 + rng.next() * 2200;
        c.set(player.pos.x + Math.cos(a) * r, 0, player.pos.z + Math.sin(a) * r);
      }
      // Stay on land of the right owner where possible.
      if (this.ground.heightAt(c.x, c.z) < 1) {
        missing -= size;
        continue;
      }
      for (let i = 0; i < size; i++) {
        const x = c.x + (rng.next() - 0.5) * 24, z = c.z + (rng.next() - 0.5) * 24;
        if (this.ground.heightAt(x, z) < 0.8) continue;
        const yaw = S.lengthSq() > 0 ? Math.atan2(S.x, S.z) : rng.next() * 6.28;
        const kind: EntKind = i === 0 && (squad % 2 === 0) ? 'at' : 'soldier';
        const e = this.mk(kind, team, x, z, yaw, owner, rel, { kind: 'pool', id: 0, owner, share: 0 });
        e.order = where === 'front' ? 'hold' : 'patrol';
        e.goal.set(x, 0, z);
        if (where === 'rear') e.goal.set(c.x, 0, c.z);
        g.ents.push(e);
      }
      squad++;
      missing -= size;
    }
  }

  private relationOf2(lf: LocalForces, a: number, b: number): boolean {
    // Whether a stands with b (same side of a front): allied pairs.
    return lf.pairs.some((p) => ((p.a === a && p.b === b) || (p.a === b && p.b === a)) && p.alliance);
  }

  private reconcilePost(g: Group, id: number, owner: number, rel: LocalRelation, lat: number, lon: number, level: number): void {
    if (g.ents.length > 0) return;
    const team = this.team(rel);
    const c = this.sceneOfLL(lat, lon, new THREE.Vector3());
    const rng = this.world.rng;
    const n = 6 + Math.max(0, level - 1) * 2;
    for (let i = 0; i <= n; i++) {
      const a = (i / (n + 1)) * Math.PI * 2, r = 25 + rng.next() * 30;
      const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
      if (this.ground.heightAt(x, z) < 0.8) continue;
      const e = this.mk(i === 0 ? 'at' : 'soldier', team, x, z, a + Math.PI, owner, rel, { kind: 'post', id, owner, share: 0 });
      e.order = 'hold';
      e.goal.set(x, 0, z);
      g.ents.push(e);
    }
  }

  private reconcileSam(g: Group, id: number, owner: number, rel: LocalRelation, lat: number, lon: number, launchers: number): void {
    const live = this.alive(g).length;
    const dead = g.ents.length - live;
    if (live + dead >= launchers) return;
    const team = this.team(rel);
    const c = this.sceneOfLL(lat, lon, new THREE.Vector3());
    for (let i = g.ents.length; i < launchers; i++) {
      const a = (i / launchers) * Math.PI * 2;
      const x = c.x + Math.cos(a) * 90, z = c.z + Math.sin(a) * 90;
      const e = this.mk('sam', team, x, z, a, owner, rel, { kind: 'sam', id, owner, share: 0.35 });
      e.order = 'hold';
      g.ents.push(e);
    }
  }

  private reconcileDivision(g: Group, id: number, owner: number, rel: LocalRelation, lat: number, lon: number, heading: number, tanks: number, ifvs: number, mode: number, initial: boolean, player: Ent): void {
    const team = this.team(rel);
    const c = this.sceneOfLL(lat, lon, new THREE.Vector3());
    const yaw = -heading;
    const moving = mode === UnitMode.Moving || mode === UnitMode.Rail || mode === UnitMode.Returning;
    this.divPos.set(id, { x: c.x, z: c.z, yaw, moving });
    const liveT = g.ents.filter((e) => e.alive && e.kind === 'tank');
    const liveI = g.ents.filter((e) => e.alive && e.kind === 'ifv');
    // Integrity fell (hits elsewhere, or ours synced): extra tanks leave (never the ones in a fight next to you).
    if (liveT.length > tanks) {
      for (const e of liveT.slice(tanks)) if (e.pos.distanceTo(player.pos) > 800) this.world.despawn(e), g.ents.splice(g.ents.indexOf(e), 1);
    }
    const slot = (k: number, ifv: boolean): THREE.Vector3 => {
      // Two ranks: tanks abreast 70 m apart, IFVs 90 m behind.
      const side = ifv ? (k - 0.5) * 80 : (k - (tanks - 1) / 2) * 70;
      return new THREE.Vector3(side, 0, ifv ? 90 : 0);
    };
    const place = (kind: 'tank' | 'ifv', k: number) => {
      const s = slot(k, kind === 'ifv');
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      let x = c.x + s.x * cy + s.z * sy, z = c.z - s.x * sy + s.z * cy;
      // A replacement for a tank lost in view arrives from behind the formation, not out of thin air.
      if (!initial && Math.hypot(x - player.pos.x, z - player.pos.z) < 1200) {
        x += (x - player.pos.x) * 0.8;
        z += (z - player.pos.z) * 0.8;
      }
      if (this.ground.heightAt(x, z) < 0.8) return;
      const e = this.mk(kind, team, x, z, yaw, owner, rel, { kind: 'division', id, owner, share: kind === 'tank' ? 0.25 : 0.1 });
      e.slot.copy(s);
      e.order = 'goto';
      e.goal.set(x, 0, z);
      g.ents.push(e);
    };
    // Tanks lost locally were already synced (the division's integrity fell), so only top up to the sim's count.
    for (let k = liveT.length; k < tanks; k++) place('tank', k);
    for (let k = liveI.length; k < ifvs; k++) place('ifv', k);
    // Behaviour: hostile divisions close to you fight; otherwise they follow their strategic movement.
    const near = Math.hypot(c.x - player.pos.x, c.z - player.pos.z) < 5000;
    for (const e of g.ents) {
      if (!e.alive) continue;
      e.neutral = team === 1 && rel !== 'war';
      if (team === 1 && rel === 'war' && near) {
        e.order = 'front';
        e.goal.copy(player.pos);
      } else {
        e.order = 'goto';
        const cy = Math.cos(yaw), sy = Math.sin(yaw);
        e.goal.set(c.x + e.slot.x * cy + e.slot.z * sy, 0, c.z - e.slot.x * sy + e.slot.z * cy);
      }
    }
  }

  private reconcileShip(g: Group, id: number, owner: number, rel: LocalRelation, lat: number, lon: number, heading: number, integ: number): void {
    const c = this.sceneOfLL(lat, lon, new THREE.Vector3());
    if (g.ents.length === 0) {
      if (this.ground.heightAt(c.x, c.z) > -3) return;
      const e = this.mk('ship', this.team(rel), c.x, c.z, -heading, owner, rel, { kind: 'ship', id, owner, share: 0.25 });
      e.hp = e.maxHp * Math.max(0.1, integ);
      e.order = 'patrol';
      e.goal.copy(c);
      g.ents.push(e);
      return;
    }
    for (const e of g.ents) if (e.alive) e.goal.copy(c);
  }

  private reconcileJets(g: Group, id: number, owner: number, rel: LocalRelation, lat: number, lon: number, heading: number, jets: number, player: Ent, scramble = false): void {
    const c = this.sceneOfLL(lat, lon, new THREE.Vector3());
    const live = this.alive(g).length;
    const lost = g.ents.length - live;
    const team = this.team(rel);
    for (let k = live + lost; k < jets; k++) {
      const alt = scramble ? this.ground.surfaceAt(c.x, c.z) + 300 : Math.max(this.ground.surfaceAt(c.x, c.z) + 1500, FLIGHT_CEILING_M * 0.7);
      const e = this.mk('jet', team, c.x + k * 250, c.z + k * 180, -heading, owner, rel, { kind: 'squadron', id, owner, share: 1 / 3 }, alt);
      e.order = rel === 'war' ? 'front' : team === 0 ? 'patrol' : 'escort';
      e.goal.set(c.x, alt, c.z);
      if (rel === 'war') e.goal.copy(player.pos);
      g.ents.push(e);
    }
    for (const e of g.ents) {
      if (!e.alive) continue;
      if (e.order === 'patrol') e.goal.set(c.x, e.goal.y, c.z);
    }
  }

  private reconcileQrf(g: Group, owner: number, rel: LocalRelation, tx: number, ty: number, arrived: boolean, soldiers: number, player: Ent): void {
    const f = this.frame;
    const c = f.sceneOfTile(tx, ty, P2);
    const team = this.team(rel);
    const trucks = g.ents.filter((e) => e.kind === 'truck');
    const inf = g.ents.filter((e) => e.kind !== 'truck');
    if (trucks.length === 0) {
      // Two trucks on the road (the force travels at 120 km/h between updates; tracked in track()).
      for (let k = 0; k < 2; k++) {
        const x = c.x + k * 25, z = c.z + k * 25;
        const e = this.mk('truck', team, x, z, Math.atan2(-(player.pos.x - x), -(player.pos.z - z)), owner, rel, { kind: 'qrf', id: 0, owner, share: 0 });
        e.order = 'goto';
        e.goal.set(c.x, 0, c.z);
        e.slot.set(k * 12, 0, k * 20);
        g.ents.push(e);
      }
    }
    for (const e of g.ents) if (e.kind === 'truck' && e.alive) e.goal.set(c.x, 0, c.z);
    if (arrived) {
      const liveInf = inf.filter((e) => e.alive).length;
      const lead = trucks.find((e) => e.alive) ?? trucks[0];
      const base = lead ? lead.pos : new THREE.Vector3(c.x, 0, c.z);
      for (let k = liveInf; k < soldiers && inf.length + (k - liveInf) < soldiers + 4; k++) {
        const x = base.x + (this.world.rng.next() - 0.5) * 30, z = base.z + (this.world.rng.next() - 0.5) * 30;
        if (this.ground.heightAt(x, z) < 0.8) continue;
        const e = this.mk(k % 6 === 0 ? 'at' : 'soldier', team, x, z, 0, owner, rel, { kind: 'qrf', id: 0, owner, share: 0 });
        e.order = rel === 'war' ? 'front' : 'escort';
        e.goal.copy(player.pos);
        g.ents.push(e);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Per frame: sim-driven movement of real units far from the fight
  // ---------------------------------------------------------------------------------------------
  /**
   * Quick-reaction trucks follow the force's sim position; divisions far from the player (or while time is
   * compressed) glide to their strategic position; near the player at ×1 the AI drives them.
   */
  track(view: GameView, player: Ent, dtGame: number, rate: number): void {
    for (const g of this.groups.values()) {
      const qrf = g.key.startsWith('qrf:');
      const div = g.key.startsWith('div:');
      if (!qrf && !div) continue;
      for (const e of g.ents) {
        if (!e.alive || !ENT_DEFS[e.kind].vehicle) continue;
        const far = e.pos.distanceTo(player.pos) > 2500 || rate > 1;
        if (!far && !qrf) continue;
        const gx = e.goal.x, gz = e.goal.z;
        const dx = gx - e.pos.x, dz = gz - e.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 5) continue;
        // Up to 1.5× the unit's road speed (catching up with the sim sample), never a jump.
        const vmax = (qrf ? 120 : 40) / 3.6 * 1.5;
        const step = Math.min(d, vmax * dtGame);
        e.pos.x += (dx / d) * step;
        e.pos.z += (dz / d) * step;
        e.yaw = Math.atan2(-dx, -dz);
        e.speed = dtGame > 0 ? step / dtGame : 0;
        e.pos.y = this.ground.heightAt(e.pos.x, e.pos.z);
      }
    }
    void view;
  }

  /** Where the player's formation should stand (slot offsets in the leader's frame: x right, z back). */
  static formationSlots(kind: CommandKind, n: number): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      if (kind === 'jet') out.push(new THREE.Vector3((i % 2 ? 1 : -1) * 180 * Math.ceil(i / 2), 20 * i, 160 * Math.ceil(i / 2)));
      else if (kind === 'ship') out.push(new THREE.Vector3((i % 2 ? 1 : -1) * 700, 0, 900 * Math.ceil(i / 2)));
      else out.push(new THREE.Vector3((i % 2 ? 1 : -1) * 45 * Math.ceil(i / 2), 0, 60 * Math.ceil(i / 2)));
    }
    return out;
  }

  /** Every hostile (at war) entity alive, for contact tests. */
  nearestHostile(from: THREE.Vector3): { ent: Ent | null; dist: number } {
    let best: Ent | null = null, bd = Infinity;
    for (const e of this.world.ents) {
      if (!e.alive || e.team === 0 || e.neutral || e.player) continue;
      const d = e.pos.distanceTo(from);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return { ent: best, dist: bd };
  }

  /** Real units at war within `km` (spawned or not): contact is decided on the simulation, not on what is drawn. */
  simHostileWithin(view: GameView, km: number): boolean {
    const lf = this.last;
    if (!lf) return false;
    for (const u of lf.units) {
      if (u.distKm > km || u.unitId === this.controlledId) continue;
      if (this.relationOf(view, u.owner) === 'war' && (u.type === UnitType.ArmoredDivision || u.type === UnitType.Warship || (u.type === UnitType.FighterSquadron && u.airborne))) return true;
    }
    // A front of a war within reach counts too.
    const fr = lf.fronts[0];
    if (fr && fr.nearest.distKm <= km) {
      const other = fr.a === HUMAN_ID ? fr.b : fr.b === HUMAN_ID ? fr.a : 0;
      if (other && this.relationOf(view, other) === 'war') return true;
    }
    return false;
  }
}

/** Continuous tile coords → lat/lon (sim convention). */
export function tileLatLon(x: number, y: number): { lat: number; lon: number } {
  return { lat: 90 - (y / MAP_H) * 180, lon: (x / MAP_W) * 360 - 180 };
}
