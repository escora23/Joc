// FRONT ULTRA — command mode, the simulation side (DESIGN_V2 §9.3, §9.7, §9.8; owner: W5-command-v2).
//
// While the human drives a unit in command mode the strategic unit really moves: the client reports its position with
// `controlledMove` and this system applies it at once (also between ticks, like any paused-time command), with the
// speed check of §9.8: the displacement since the last accepted move may not exceed
// `maxKmh × elapsed game time × 1.1`, where maxKmh is the unit's strategic speed in travel time and its vehicle's
// tactical top speed at ×1. Beyond that the move is snapped to the limit along the same line; a jump of more than 5 km
// is rejected outright.
//
// Incursions (§9.7): the first accepted move onto a foreign tile of a nation the owner is at peace (or truce) with,
// without an alliance or open borders, starts an incursion (`borderIncursion` entered, both sides hear of it). The
// victim decides 30–90 GAME seconds later (the sub-step advances this system between ticks, so the decision comes
// after 30–90 real seconds at ×1 and 0.5–1.5 s at ×60): protest (withdraw within 6 game hours, −15 opinion),
// intercept (a quick-reaction force from its nearest town, post or base arrives 5–15 game minutes after dispatch and
// real divisions within 30 km are ordered toward the intruder) or war (the victim declares, reason `incursion`).
// Ignoring a protest past its deadline escalates to an interception, and an ignored interception to war, by
// personality. Leaving the land ends it (`left`). Releasing the unit inside foreign land at peace walks it back to the
// nearest own tile first; the incursion lasts until it is out.
//
// Casualties (§9.8): `commandCasualties` removes the enemy soldiers killed (1 local soldier = 25 troops, sent as
// troops), damages real units and structures by the local hits; `controlledDamage` sets the controlled unit's
// integrity (0 destroys it). Nothing here runs in headless games that never take control, so determinism holds.
//
// Game time: `sec` is this system's clock in game seconds. The worker's sub-steps advance it in command mode; a
// whole tick that ran without any sub-step (strategic time) advances it by 360 s, so timers keep running after exit.

import { GAME_SECONDS_PER_TICK, HUMAN_ID, MAP_H, MAP_W, TILE_KM, UNIT_DEFS } from '../shared/constants';
import type { PlayerCommand } from '../shared/protocol';
import { isWaterTerrain } from '../shared/terrain';
import { StructureType, UnitState, UnitType, type CommandView, type IncursionView } from '../shared/types';
import type { Game } from './game';
import type { Player, Unit } from './state';

/** Tactical top speed of each command vehicle at ×1 (km/h): tank 61, jet 2,016, destroyer 63 (§9.8). */
export const TACTICAL_KMH: Record<'tank' | 'jet' | 'ship', number> = { tank: 65, jet: 2100, ship: 66 };
export const MOVE_TOLERANCE = 1.1;
export const MOVE_REJECT_KM = 5;
/** Victim decision delay window and the quick-reaction force's travel window (game seconds). */
export const DECIDE_MIN_SEC = 30, DECIDE_MAX_SEC = 90;
export const QRF_MIN_SEC = 300, QRF_MAX_SEC = 900;
/** QRF road speed (km/h): trucks and helicopters from the garrison. */
export const QRF_KMH = 120;
export const PROTEST_DEADLINE_SEC = 6 * 3600;
/** An interception that is ignored this long escalates to war (aggressive personalities). */
export const INTERCEPT_ESCALATE_SEC = 6 * 3600;
/** Real divisions of the victim within this distance are sent toward the intruder. */
export const QRF_DIVISION_KM = 30;
/** Fighters on patrol within this distance vector to an intruding jet. */
export const QRF_FIGHTER_KM = 150;

interface Controlled {
  unitId: number;
  owner: number;
  kind: 'tank' | 'jet' | 'ship';
  x: number;
  y: number;
  sec: number;
  /** Released by the player inside foreign land at peace: walking back to `homeTile`. */
  returning: boolean;
  homeX: number;
  homeY: number;
}

interface Incursion {
  id: number;
  intruder: number;
  victim: number;
  unitId: number;
  kind: 'tank' | 'jet' | 'ship';
  tile: number;
  entryX: number;
  entryY: number;
  enteredSec: number;
  decideAtSec: number;
  response: 'none' | 'protest' | 'intercept' | 'war';
  respondedSec: number;
  deadlineSec: number;
  depthKm: number;
  qrf: {
    fromX: number; fromY: number; x: number; y: number; soldiers: number; dispatchSec: number; arriveSec: number;
    arrived: boolean; source: 'city' | 'post' | 'base' | 'border'; divisions: number[]; fighters: number[];
  } | null;
  left: boolean;
  leftSec: number;
}

const wdx = (ax: number, bx: number): number => {
  let d = bx - ax;
  if (d > MAP_W / 2) d -= MAP_W;
  else if (d < -MAP_W / 2) d += MAP_W;
  return d;
};
const wrapX = (x: number): number => ((x % MAP_W) + MAP_W) % MAP_W;
const DEG = Math.PI / 180;
function kmPerTileX(y: number): number {
  const lat = 90 - (y / MAP_H) * 180;
  return TILE_KM * Math.max(0.05, Math.cos(lat * DEG));
}
/** Distance (km) between two points in continuous tile coords (local metric at their mean latitude). */
export function tileDistKm(ax: number, ay: number, bx: number, by: number): number {
  const ex = wdx(ax, bx) * kmPerTileX((ay + by) / 2), ny = (by - ay) * TILE_KM;
  return Math.hypot(ex, ny);
}

export class CommandSystem {
  /** Game seconds (see the file header). */
  sec = 0;
  private subSteppedThisTick = false;
  private readonly controlled = new Map<number, Controlled>();
  private readonly incursions: Incursion[] = [];
  private nextIncursion = 1;
  /** Tallies for the verifier (and the client's debug stats). */
  readonly stats = { accepted: 0, snapped: 0, rejected: 0, lastSnapKm: 0, lastRejectKm: 0 };
  private dirty = false;
  /** Recent decisions for the client and the verifier (§9.8 «logged»), newest last. */
  private readonly logs: { sec: number; text: string }[] = [];

  private log(text: string): void {
    this.logs.push({ sec: this.sec, text });
    if (this.logs.length > 40) this.logs.shift();
    this.dirty = true;
  }

  constructor(private readonly g: Game) {
    g.registerSubStep((dt) => this.subStep(dt));
  }

  // =================================================================================================
  // Clock
  // =================================================================================================
  private subStep(dt: number): void {
    this.subSteppedThisTick = true;
    this.advance(dt);
  }

  /** Called at the end of every tick. */
  tick(): void {
    if (!this.subSteppedThisTick) this.advance(GAME_SECONDS_PER_TICK);
    this.subSteppedThisTick = false;
  }

  private advance(dt: number): void {
    this.sec += dt;
    if (this.incursions.length === 0 && this.controlled.size === 0) return;
    for (const c of this.controlled.values()) if (c.returning) this.walkBack(c, dt);
    for (const inc of this.incursions) this.stepIncursion(inc, dt);
    // Forget incursions that ended a while ago (the client has seen them).
    for (let i = this.incursions.length - 1; i >= 0; i--) {
      const inc = this.incursions[i];
      if (inc.left && this.sec - inc.leftSec > 600) {
        this.incursions.splice(i, 1);
        this.dirty = true;
      }
    }
  }

  get active(): boolean {
    return this.controlled.size > 0 || this.incursions.length > 0;
  }

  // =================================================================================================
  // Control
  // =================================================================================================
  onControl(p: Player, unitId: number, controlled: boolean): void {
    const u = this.g.unitMap.get(unitId);
    if (!u || u.owner !== p.id) return;
    const kind = UNIT_DEFS[u.type].command;
    if (!kind) return;
    if (controlled) {
      this.controlled.set(unitId, { unitId, owner: p.id, kind, x: u.x, y: u.y, sec: this.sec, returning: false, homeX: 0, homeY: 0 });
      this.dirty = true;
      return;
    }
    const c = this.controlled.get(unitId);
    if (!c) return;
    const inc = this.incursions.find((i) => i.unitId === unitId && !i.left);
    // §9.7.5: released inside foreign land at peace → walk back to the nearest own tile first (ground and sea); a jet
    // simply returns to its base, which ends the violation of the airspace.
    if (inc && kind !== 'jet' && this.g.war.pairState(p.id, inc.victim) !== 'war') {
      const home = this.nearestOwn(p.id, u, kind === 'ship');
      if (home) {
        c.returning = true;
        c.homeX = home.x;
        c.homeY = home.y;
        u.state = UnitState.Controlled;
        this.dirty = true;
        return;
      }
    }
    if (inc) this.leave(inc);
    this.controlled.delete(unitId);
    this.dirty = true;
  }

  /** The unit's control ended in the unit system: returns false while this system still walks it home. */
  keepsControl(unitId: number): boolean {
    return !!this.controlled.get(unitId)?.returning;
  }

  private nearestOwn(owner: number, u: Unit, water: boolean): { x: number; y: number } | null {
    const g = this.g;
    const x0 = Math.floor(u.x), y0 = Math.floor(u.y);
    for (let r = 1; r <= 60; r++) {
      let best: { x: number; y: number } | null = null, bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const y = y0 + dy;
          if (y < 0 || y >= MAP_H) continue;
          const t = y * MAP_W + wrapX(x0 + dx);
          const ok = water ? isWaterTerrain(g.terrain[t]) && this.territorialOwner(t) !== this.incursionVictim(u.id) : g.owner[t] === owner;
          if (!ok) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = { x: x0 + dx + 0.5, y: y + 0.5 };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  private incursionVictim(unitId: number): number {
    return this.incursions.find((i) => i.unitId === unitId && !i.left)?.victim ?? 0;
  }

  private walkBack(c: Controlled, dt: number): void {
    const g = this.g;
    const u = g.unitMap.get(c.unitId);
    if (!u || u.dead) {
      this.controlled.delete(c.unitId);
      return;
    }
    const km = (UNIT_DEFS[u.type].speedKmh * dt) / 3600;
    const d = tileDistKm(u.x, u.y, c.homeX, c.homeY);
    if (d <= km + 0.01) {
      u.x = wrapX(c.homeX);
      u.y = c.homeY;
    } else {
      const f = km / d;
      u.heading = Math.atan2(wdx(u.x, c.homeX) * kmPerTileX(u.y), -(c.homeY - u.y) * TILE_KM);
      u.x = wrapX(u.x + wdx(u.x, c.homeX) * f);
      u.y += (c.homeY - u.y) * f;
    }
    this.checkTerritory(c, u);
    const home = c.kind === 'ship' ? this.groundOwner(u, 'ship') !== this.incursionVictim(u.id) : this.groundOwner(u, c.kind) === c.owner;
    if (d <= km + 0.01 || home) {
      const inc = this.incursions.find((i) => i.unitId === c.unitId && !i.left);
      if (inc) this.leave(inc);
      this.controlled.delete(c.unitId);
      u.state = u.savedState === UnitState.Controlled ? UnitState.Idle : u.savedState;
      this.dirty = true;
    }
  }

  // =================================================================================================
  // controlledMove (§9.8)
  // =================================================================================================
  move(p: Player, cmd: Extract<PlayerCommand, { type: 'controlledMove' }>): boolean {
    const g = this.g;
    const u = g.unitMap.get(cmd.unitId);
    if (!u || u.dead || u.owner !== p.id || u.state !== UnitState.Controlled) return false;
    let c = this.controlled.get(u.id);
    if (!c) {
      const kind = UNIT_DEFS[u.type].command;
      if (!kind) return false;
      c = { unitId: u.id, owner: p.id, kind, x: u.x, y: u.y, sec: this.sec, returning: false, homeX: 0, homeY: 0 };
      this.controlled.set(u.id, c);
    }
    if (c.returning) return false;
    if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) return false;
    const tx = wrapX(cmd.x), ty = Math.max(0, Math.min(MAP_H - 1e-3, cmd.y));
    const dist = tileDistKm(c.x, c.y, tx, ty);
    if (dist > MOVE_REJECT_KM) {
      this.stats.rejected++;
      this.stats.lastRejectKm = dist;
      this.log(`[command] controlledMove rejected: jump of ${dist.toFixed(2)} km (> ${MOVE_REJECT_KM} km)`);
      return false;
    }
    const elapsed = Math.max(0, this.sec - c.sec);
    const maxKmh = g.commandTravel ? UNIT_DEFS[u.type].speedKmh : TACTICAL_KMH[c.kind];
    const allow = (maxKmh * elapsed / 3600) * MOVE_TOLERANCE + 0.002;
    let nx = tx, ny = ty;
    if (dist > allow) {
      const f = allow / dist;
      nx = wrapX(c.x + wdx(c.x, tx) * f);
      ny = c.y + (ty - c.y) * f;
      this.stats.snapped++;
      this.stats.lastSnapKm = dist - allow;
      this.log(`[command] controlledMove snapped: ${dist.toFixed(3)} km in ${elapsed.toFixed(1)} game s > ${allow.toFixed(3)} km allowed (${maxKmh} km/h × 1.1)`);
    } else this.stats.accepted++;
    u.x = nx;
    u.y = ny;
    if (Number.isFinite(cmd.heading)) u.heading = cmd.heading;
    if (UNIT_DEFS[u.type].airborne && Number.isFinite(cmd.alt ?? NaN)) u.alt = Math.max(0, Math.min(1, cmd.alt ?? 0));
    c.x = nx;
    c.y = ny;
    c.sec = this.sec;
    this.checkTerritory(c, u);
    this.dirty = true;
    return true;
  }

  /** For water tiles: the owner of an adjacent coast (territorial waters, §9.7.6); 0 = open sea. */
  private territorialOwner(tile: number): number {
    const g = this.g;
    const x = tile % MAP_W, y = (tile / MAP_W) | 0;
    let best = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= MAP_H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const o = g.owner[yy * MAP_W + wrapX(x + dx)];
        if (o > 0) return o;
      }
    }
    return best;
  }

  /** Whose land (or territorial water, for ships) the unit is on. */
  private groundOwner(u: Unit, kind: 'tank' | 'jet' | 'ship'): number {
    const g = this.g;
    const t = Math.min(MAP_H - 1, Math.max(0, Math.floor(u.y))) * MAP_W + (Math.floor(wrapX(u.x)) % MAP_W);
    const o = g.owner[t];
    if (kind === 'ship' || (kind !== 'jet' && isWaterTerrain(g.terrain[t]))) {
      return isWaterTerrain(g.terrain[t]) ? this.territorialOwner(t) : o;
    }
    return o;
  }

  /** §9.7: whether being on `victim`'s ground is an incursion for `intruder`. */
  isIncursion(intruder: number, victim: number): boolean {
    const g = this.g;
    if (victim <= 0 || victim === intruder) return false;
    const st = g.war.pairState(intruder, victim);
    if (st === 'war') return false;
    if (g.isAllied(intruder, victim)) return false;
    if (g.diplomacy.hasTreaty(intruder, victim, 'alliance') || g.diplomacy.hasTreaty(intruder, victim, 'openBorders')) return false;
    return true;
  }

  private checkTerritory(c: Controlled, u: Unit): void {
    const o = this.groundOwner(u, c.kind);
    const open = this.incursions.find((i) => i.unitId === u.id && !i.left);
    if (open && o !== open.victim) this.leave(open);
    if (open && o === open.victim) {
      open.depthKm = Math.max(open.depthKm, tileDistKm(open.entryX, open.entryY, u.x, u.y));
      if (!this.isIncursion(c.owner, o)) this.leave(open);
      return;
    }
    if (!this.isIncursion(c.owner, o)) return;
    const g = this.g;
    const t = Math.min(MAP_H - 1, Math.max(0, Math.floor(u.y))) * MAP_W + (Math.floor(wrapX(u.x)) % MAP_W);
    // Deterministic decision delay from the ids involved (no rng stream: headless runs never get here).
    const h = ((u.id * 2654435761) ^ (o * 40503) ^ (this.nextIncursion * 69069)) >>> 0;
    const delay = DECIDE_MIN_SEC + (h % 1000) / 1000 * (DECIDE_MAX_SEC - DECIDE_MIN_SEC);
    const inc: Incursion = {
      id: this.nextIncursion++, intruder: c.owner, victim: o, unitId: u.id, kind: c.kind, tile: t, entryX: u.x, entryY: u.y,
      enteredSec: this.sec, decideAtSec: this.sec + delay, response: 'none', respondedSec: 0, deadlineSec: 0, depthKm: 0,
      qrf: null, left: false, leftSec: 0,
    };
    this.incursions.push(inc);
    g.emit({ type: 'borderIncursion', tick: g.tick, intruder: c.owner, victim: o, unitId: u.id, tile: t, stage: 'entered', kind: c.kind, sec: this.sec });
    this.log(`[command] incursion #${inc.id}: unit ${u.id} of ${c.owner} entered ${o} at ${this.sec.toFixed(1)} game s; decision at ${inc.decideAtSec.toFixed(1)}`);
    this.dirty = true;
  }

  private leave(inc: Incursion): void {
    if (inc.left) return;
    const g = this.g;
    inc.left = true;
    inc.leftSec = this.sec;
    g.emit({ type: 'borderIncursion', tick: g.tick, intruder: inc.intruder, victim: inc.victim, unitId: inc.unitId, tile: inc.tile, stage: 'left', kind: inc.kind, sec: this.sec });
    this.dirty = true;
  }

  // =================================================================================================
  // The victim's decision and the quick-reaction force
  // =================================================================================================
  private stepIncursion(inc: Incursion, dt: number): void {
    if (inc.left) return;
    const g = this.g;
    const u = g.unitMap.get(inc.unitId);
    if (!u || u.dead) {
      this.leave(inc);
      return;
    }
    if (g.war.pairState(inc.intruder, inc.victim) === 'war' && inc.response !== 'war') {
      // At war now (declared by either side): not an incursion any more.
      this.leave(inc);
      return;
    }
    if (inc.response === 'none' && this.sec >= inc.decideAtSec) this.decide(inc, u);
    else if (inc.response === 'protest' && this.sec >= inc.deadlineSec) this.respond(inc, u, 'intercept', true);
    else if (inc.response === 'intercept' && this.sec >= inc.deadlineSec) {
      const P = g.playerById[inc.victim];
      const aggressive = P?.personality === 'conqueror' || P?.personality === 'nuker' || P?.personality === 'opportunist';
      if (aggressive) this.respond(inc, u, 'war', true);
      else inc.deadlineSec = Number.POSITIVE_INFINITY;
    }
    const q = inc.qrf;
    if (q && !q.arrived) {
      // Pursue: the force heads for the intruder's current position and arrives on its schedule.
      const k = Math.min(1, (this.sec - q.dispatchSec) / Math.max(1, q.arriveSec - q.dispatchSec));
      q.x = wrapX(q.fromX + wdx(q.fromX, u.x) * k);
      q.y = q.fromY + (u.y - q.fromY) * k;
      if (k >= 1) {
        q.arrived = true;
        g.emit({ type: 'borderIncursion', tick: g.tick, intruder: inc.intruder, victim: inc.victim, unitId: inc.unitId, tile: inc.tile, stage: 'arrived', response: 'intercept', kind: inc.kind, sec: this.sec });
        this.log(`[command] incursion #${inc.id}: quick-reaction force arrived ${(this.sec - q.dispatchSec).toFixed(0)} game s after dispatch`);
      }
      this.dirty = true;
    } else if (q && q.arrived) {
      // Escort: stays with the intruder.
      q.x = u.x;
      q.y = u.y;
    }
    void dt;
  }

  private decide(inc: Incursion, u: Unit): void {
    const g = this.g;
    const P = g.playerById[inc.victim];
    const op = g.diplomacy.opinion(inc.victim, inc.intruder);
    const pers = P?.personality ?? null;
    const aggressive = pers === 'conqueror' || pers === 'nuker' || pers === 'opportunist';
    let r: 'protest' | 'intercept' | 'war';
    if (op <= -50 && aggressive && g.war.declareError(inc.victim, inc.intruder, { force: true }) === null) r = 'war';
    else if (inc.depthKm >= 20 || pers === 'conqueror' || pers === 'nuker' || (op < -10 && pers !== 'turtle' && pers !== 'trader')) r = 'intercept';
    else r = 'protest';
    g.diplomacy.addReason(inc.victim, inc.intruder, 'incursion');
    this.log(`[command] incursion #${inc.id}: ${inc.victim} decides ${r} at ${this.sec.toFixed(1)} game s (${(this.sec - inc.enteredSec).toFixed(1)} s after entry, opinion ${op.toFixed(0)}, ${pers ?? '-'})`);
    this.respond(inc, u, r, false);
  }

  private respond(inc: Incursion, u: Unit, r: 'protest' | 'intercept' | 'war', escalated: boolean): void {
    const g = this.g;
    inc.response = r;
    inc.respondedSec = this.sec;
    this.dirty = true;
    if (r === 'protest') inc.deadlineSec = this.sec + PROTEST_DEADLINE_SEC;
    if (r === 'intercept') {
      inc.deadlineSec = this.sec + INTERCEPT_ESCALATE_SEC;
      this.dispatch(inc, u);
    }
    if (r === 'war') {
      g.war.recordTension(inc.victim, inc.intruder);
      const w = g.war.declare(inc.victim, inc.intruder, 'incursion', 'war.reason.incursion', { force: true });
      if (!w) {
        inc.response = 'intercept';
        if (!inc.qrf) this.dispatch(inc, u);
      }
    }
    g.emit({
      type: 'borderIncursion', tick: g.tick, intruder: inc.intruder, victim: inc.victim, unitId: inc.unitId, tile: inc.tile,
      stage: 'response', response: inc.response as 'protest' | 'intercept' | 'war', escalated, kind: inc.kind, sec: this.sec,
      etaSec: inc.qrf ? Math.max(0, inc.qrf.arriveSec - this.sec) : undefined, deadlineSec: inc.response === 'protest' ? PROTEST_DEADLINE_SEC : undefined,
    });
  }

  private dispatch(inc: Incursion, u: Unit): void {
    const g = this.g;
    const V = g.playerById[inc.victim];
    if (!V) return;
    // Origin: the nearest town, defense post or base of the victim within 150 km; else the nearest victim tile.
    let best: { x: number; y: number; source: 'city' | 'post' | 'base' } | null = null, bestD = 150;
    for (const s of g.structByOwner.get(inc.victim) ?? []) {
      if (s.built < 1) continue;
      const source = s.type === StructureType.City ? 'city' : s.type === StructureType.DefensePost ? 'post'
        : s.type === StructureType.ArmyBase || s.type === StructureType.Airbase || s.type === StructureType.NavalYard ? 'base' : null;
      if (!source) continue;
      const sx = (s.tile % MAP_W) + 0.5, sy = ((s.tile / MAP_W) | 0) + 0.5;
      const d = tileDistKm(sx, sy, u.x, u.y);
      if (d < bestD) {
        bestD = d;
        best = { x: sx, y: sy, source };
      }
    }
    let fromX: number, fromY: number, source: 'city' | 'post' | 'base' | 'border';
    if (best) {
      fromX = best.x;
      fromY = best.y;
      source = best.source;
    } else {
      // The garrison of the land itself: a point 12 km deeper inside the victim's land from the intruder.
      const ang = Math.atan2(u.y - inc.entryY, wdx(inc.entryX, u.x));
      fromX = wrapX(u.x + Math.cos(ang) * 12 / kmPerTileX(u.y));
      fromY = u.y + Math.sin(ang) * 12 / TILE_KM;
      source = 'border';
      bestD = 12;
    }
    // 8–24 soldiers from the garrison (1 = 25 troops), more for a big army; jets meet fighters, not infantry.
    const soldiers = inc.kind === 'jet' ? 0 : Math.round(Math.max(8, Math.min(24, 8 + 16 * Math.min(1, V.troops / 400_000))));
    const travel = Math.max(QRF_MIN_SEC, Math.min(QRF_MAX_SEC, (bestD / QRF_KMH) * 3600));
    const divisions: number[] = [];
    const fighters: number[] = [];
    for (const d of g.unitsByOwner.get(inc.victim) ?? []) {
      if (d.dead || d.state === UnitState.Controlled) continue;
      const km = tileDistKm(d.x, d.y, u.x, u.y);
      if (d.type === UnitType.ArmoredDivision && inc.kind !== 'jet' && km <= QRF_DIVISION_KM) {
        const tile = Math.floor(u.y) * MAP_W + (Math.floor(wrapX(u.x)) % MAP_W);
        if (g.unitSys.order(V, [d.id], 'move', tile, 0)) divisions.push(d.id);
      } else if (d.type === UnitType.FighterSquadron && inc.kind === 'jet' && km <= QRF_FIGHTER_KM && d.alt > 0) {
        const tile = Math.floor(u.y) * MAP_W + (Math.floor(wrapX(u.x)) % MAP_W);
        if (g.unitSys.order(V, [d.id], 'cap', tile, 0)) fighters.push(d.id);
      }
    }
    inc.qrf = {
      fromX, fromY, x: fromX, y: fromY, soldiers, dispatchSec: this.sec, arriveSec: this.sec + travel, arrived: false, source,
      divisions, fighters,
    };
    this.log(`[command] incursion #${inc.id}: quick-reaction force of ${soldiers} soldiers from ${source} ${bestD.toFixed(1)} km away, arrival in ${(travel / 60).toFixed(1)} game min; divisions [${divisions}] fighters [${fighters}]`);
  }

  // =================================================================================================
  // Casualties and damage (§9.8)
  // =================================================================================================
  casualties(p: Player, cmd: Extract<PlayerCommand, { type: 'commandCasualties' }>): boolean {
    const g = this.g;
    const V = g.playerById[cmd.victim];
    if (V && V.alive && cmd.victim !== p.id && cmd.troops > 0) {
      const killed = Math.min(V.troops, Math.max(0, cmd.troops));
      V.troops -= killed;
      V.stats.troopsLost += killed;
      p.stats.troopsKilled += killed;
      p.stats.commandKills += killed;
      if (g.war.atWar(p.id, V.id)) g.war.addCasualties(p.id, V.id, 0, killed);
      // A quick-reaction force loses the soldiers killed out of it.
      for (const inc of this.incursions) {
        if (inc.victim === V.id && inc.qrf && !inc.left) inc.qrf.soldiers = Math.max(0, inc.qrf.soldiers - Math.round(killed / 25));
      }
    }
    for (const h of cmd.unitHits ?? []) {
      const u = g.unitMap.get(h.unitId);
      if (!u || u.dead || u.owner === p.id || g.isAllied(p.id, u.owner)) continue;
      g.unitSys.damage(u, u.maxHp * Math.max(0, Math.min(1, h.dmg)) + 1e-6, p.id);
    }
    for (const h of cmd.structureHits ?? []) {
      const s = g.structureMap.get(h.structureId);
      if (!s || s.owner === p.id || g.isAllied(p.id, s.owner)) continue;
      g.weapons.damageStructure(s, Math.max(0, Math.min(1, h.dmg)), p.id);
    }
    this.dirty = true;
    return true;
  }

  damage(p: Player, cmd: Extract<PlayerCommand, { type: 'controlledDamage' }>): boolean {
    const g = this.g;
    const u = g.unitMap.get(cmd.unitId);
    if (!u || u.dead || u.owner !== p.id) return false;
    const integ = Math.max(0, Math.min(1, cmd.integrity));
    const hp = u.maxHp * integ;
    if (hp >= u.hp) return true;
    if (integ <= 0.001) {
      g.unitSys.kill(u, cmd.by ?? 0);
      this.controlled.delete(u.id);
      const inc = this.incursions.find((i) => i.unitId === u.id && !i.left);
      if (inc) this.leave(inc);
    } else {
      u.hp = hp;
      u.lastHitTick = g.tick;
    }
    this.dirty = true;
    return true;
  }

  // =================================================================================================
  // View
  // =================================================================================================
  /** The command view for the client: every update while anything is active, and once after it ends. */
  view(force: boolean): CommandView | undefined {
    if (!force && !this.active && !this.dirty) return undefined;
    this.dirty = false;
    const incursions: IncursionView[] = this.incursions.filter((i) => i.intruder === HUMAN_ID || i.victim === HUMAN_ID).map((i) => ({
      id: i.id, intruder: i.intruder, victim: i.victim, unitId: i.unitId, kind: i.kind, enteredSec: i.enteredSec,
      decideAtSec: i.decideAtSec, response: i.response, respondedSec: i.respondedSec,
      deadlineSec: Number.isFinite(i.deadlineSec) ? i.deadlineSec : 0, depthKm: i.depthKm, left: i.left,
      qrf: i.qrf ? {
        x: i.qrf.x, y: i.qrf.y, fromX: i.qrf.fromX, fromY: i.qrf.fromY, soldiers: i.qrf.soldiers, dispatchSec: i.qrf.dispatchSec,
        arriveSec: i.qrf.arriveSec, arrived: i.qrf.arrived, source: i.qrf.source, divisions: i.qrf.divisions, fighters: i.qrf.fighters,
      } : null,
    }));
    const controlled = [...this.controlled.values()].map((c) => ({ unitId: c.unitId, x: c.x, y: c.y, sec: c.sec, returning: c.returning }));
    return {
      sec: this.sec, travel: this.g.commandTravel, controlled, incursions, log: this.logs.slice(-12),
      moves: { accepted: this.stats.accepted, snapped: this.stats.snapped, rejected: this.stats.rejected, lastSnapKm: this.stats.lastSnapKm, lastRejectKm: this.stats.lastRejectKm },
    };
  }
}
