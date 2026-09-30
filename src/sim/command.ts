// FRONT ULTRA — command mode, the simulation side (DESIGN_V2 §9.3, §9.7, §9.8; owner: W5-command-v2).
//
// While the human drives a unit in command mode the strategic unit really moves: the client reports its position with
// `controlledMove` and this system applies it at once (also between ticks, like any paused-time command), with the
// speed check of §9.8: the displacement since the last accepted move may not exceed
// `maxKmh × elapsed game time × 1.1`, where maxKmh is the unit's strategic speed in travel time and its vehicle's
// tactical top speed at ×1. Beyond that the move is snapped to the limit along the same line; a jump of more than 5 km
// that is also more than twice the allowed distance is rejected outright (travel at ×900 legitimately covers several km
// between two messages).
//
// Incursions (§9.7, reworked after owner feedback #18-#20): the first accepted move onto a foreign tile of a nation the
// owner is at peace (or truce) with, without an alliance or open borders, starts an incursion. The victim warns at once
// ("turn back or you will be intercepted") and gives a short grace, counted in game seconds that are real seconds at
// ×1 in command mode: 30 s on land, 25 s in the air, 40 s at sea, 15 s within 80 km of its capital. Turning back in
// time ends it with a formal protest. Staying brings the interception: the victim sends real forces from its nearest
// bases that arrive in a believable, short time (fighters scrambled from the nearest airbase in 1-3 min, patrol
// vehicles and APCs from the nearest post, town or base in 1.5-5 min, a warship in 2-7 min); real divisions within
// 30 km are ordered in too. When the force is there it escorts the intruder and gives a last warning (90 s on land,
// 45 s in the air, 90 s at sea, 30 s near the capital); ignoring it makes the victim open fire on the intruder
// (`engage`: its forces and SAM sites fire at that unit only) or, by personality or when it already hates the
// intruder, declare war. An armed incident that lasts 30 game minutes ends in war. A capital is never ignored.
// Releasing the unit never sends it home (owner feedback #18): it holds where it was left and the incursion keeps
// running on the strategic map with the same timings, until it is out.
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
import { CITY_BLOCKS } from '../shared/damage';
import { hostileTo } from '../shared/orders';
import { StructureType, UnitState, UnitType, type CommandView, type IncursionView } from '../shared/types';
import type { Game } from './game';
import { Mode, type Player, type Unit } from './state';

/** Tactical top speed of each command vehicle at ×1 (km/h): tank 61, jet 2,016, destroyer 63 (§9.8). */
export const TACTICAL_KMH: Record<'tank' | 'jet' | 'ship', number> = { tank: 65, jet: 2100, ship: 66 };
export const MOVE_TOLERANCE = 1.1;
export const MOVE_REJECT_KM = 5;
/** Grace to turn back after the warning (game s = real s at ×1), per vehicle; near the victim's capital. */
export const GRACE_SEC: Record<'tank' | 'jet' | 'ship', number> = { tank: 30, jet: 25, ship: 40 };
export const GRACE_CAPITAL_SEC = 15;
/** Within this distance of the victim's capital every step is faster (a capital is never ignored). */
export const CAPITAL_KM = 80;
/** Travel time windows of the quick-reaction force (game s), per force. */
export const QRF_WINDOW: Record<'ground' | 'air' | 'sea', [number, number]> = { ground: [90, 300], air: [60, 180], sea: [120, 420] };
/** Road speed of the ground force (km/h), dash speed of scrambled fighters (km/s), sea speed (km/h). */
export const QRF_ROAD_KMH = 80;
export const QRF_AIR_KMS = 0.5;
export const QRF_SEA_KMH = 70;
/** The last warning once the force is there (game s), per vehicle; near the capital. */
export const ESCORT_WARN_SEC: Record<'tank' | 'jet' | 'ship', number> = { tank: 90, jet: 45, ship: 90 };
export const ESCORT_WARN_CAPITAL_SEC = 30;
/** An armed incident (engage) that goes on this long becomes a war. */
export const ENGAGE_WAR_SEC = 1800;
/**
 * A unit left inside under fire (released, strategic time) is worn down by the force really there (owner feedback
 * #18, fix 2): per game minute it loses ENGAGE_KILL_PER_MIN × (firepower present ÷ its own full strength) of its
 * integrity, in tank equivalents (a division is 4 tanks, a patrol APC 0.25 of a tank, a squadron 3 jets). An equal
 * force would destroy it in 90 min; two APCs take ~4 % of a division in the 30 minutes before the incident is a war.
 */
export const ENGAGE_KILL_PER_MIN = 1 / 90;
/** Firepower of one vehicle of a quick-reaction force, in tanks: an APC or patrol vehicle, the tank leading one. */
export const QRF_APC_FIRE = 0.25;
export const QRF_TANK_FIRE = 1;
/** Full strength of each command kind in the same units (division 4 tanks, squadron 3 jets, one warship). */
export const INTRUDER_STRENGTH: Record<'tank' | 'jet' | 'ship', number> = { tank: 4, jet: 3, ship: 1 };
/** Feedback 3: a command-mode hit on a structure is accepted within this distance of the controlled unit (km). */
const STRUCTURE_HIT_KM = 30;
/** Real divisions of the victim count toward the fire only this close (km) to the intruder. */
export const ENGAGE_DIVISION_KM = 3;
/**
 * In command mode the last warning waits for an escort vehicle to be alongside in the scene (`escortAlongside`); if
 * none gets there (a broken or stalled scene; the client itself reports a force it could not place) the warning starts
 * anyway this long after the sim's arrival (game s).
 */
export const ALONGSIDE_FALLBACK_SEC = 1800;
/** Real divisions of the victim within this distance are sent toward the intruder. */
export const QRF_DIVISION_KM = 30;
/** Airborne fighters within this distance, else docked fighters at an airbase within the scramble reach, intercept. */
export const QRF_FIGHTER_KM = 300;
export const QRF_SCRAMBLE_KM = 800;
/** Warships within this distance shadow an intruding ship; else a patrol boat from a port or naval yard in reach. */
export const QRF_SHIP_KM = 150;
export const QRF_PORT_KM = 400;

interface Controlled {
  unitId: number;
  owner: number;
  kind: 'tank' | 'jet' | 'ship';
  x: number;
  y: number;
  sec: number;
}

interface Qrf {
  mode: 'ground' | 'air' | 'sea';
  fromX: number;
  fromY: number;
  x: number;
  y: number;
  vehicles: number;
  heavy: boolean;
  soldiers: number;
  dispatchSec: number;
  arriveSec: number;
  arrived: boolean;
  source: 'city' | 'post' | 'base' | 'airbase' | 'port' | 'unit' | 'border';
  unitId: number;
  divisions: number[];
  fighters: number[];
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
  graceSec: number;
  decideAtSec: number;
  response: 'none' | 'protest' | 'intercept' | 'engage' | 'war';
  respondedSec: number;
  /** Running warning deadline after the force arrived (or a protest's, when nothing can be sent); ∞ = none. */
  deadlineSec: number;
  depthKm: number;
  capitalKm: number;
  qrf: Qrf | null;
  /** Game seconds of fire taken while engaged and not controlled (strategic damage accumulator). */
  fireSec: number;
  /** The force arrived in the sim; the last warning waits for an escort vehicle alongside in the scene. */
  awaitAlong: boolean;
  /** A released unit under orders to leave (timers held while it goes). */
  leaving: boolean;
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
const tileOfXY = (x: number, y: number): number => Math.min(MAP_H - 1, Math.max(0, Math.floor(y))) * MAP_W + (Math.floor(wrapX(x)) % MAP_W);
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
    if (!this.subSteppedThisTick) {
      // Strategic time: the tick's game time in 10 s steps while an incursion runs, so its warning, answer and
      // arrival land on the same game second as in command mode (owner feedback #19: same timings on the map).
      if (this.incursions.some((i) => !i.left)) for (let t = 0; t < GAME_SECONDS_PER_TICK; t += 10) this.advance(Math.min(10, GAME_SECONDS_PER_TICK - t));
      else this.advance(GAME_SECONDS_PER_TICK);
    }
    this.subSteppedThisTick = false;
  }

  private advance(dt: number): void {
    this.sec += dt;
    if (this.incursions.length === 0 && this.controlled.size === 0) return;
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
      this.controlled.set(unitId, { unitId, owner: p.id, kind, x: u.x, y: u.y, sec: this.sec });
      this.dirty = true;
      return;
    }
    // Owner feedback #18: the unit holds where it was left (units.ts holdAfterControl). An incursion keeps running:
    // stepIncursion follows the unit on the strategic map until it is out.
    const inc = this.incursions.find((i) => i.unitId === unitId && !i.left);
    if (inc) this.log(`[command] unit ${unitId} released inside ${inc.victim}: it holds there and incursion #${inc.id} goes on`);
    this.controlled.delete(unitId);
    this.dirty = true;
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
      c = { unitId: u.id, owner: p.id, kind, x: u.x, y: u.y, sec: this.sec };
      this.controlled.set(u.id, c);
    }
    if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) return false;
    const tx = wrapX(cmd.x), ty = Math.max(0, Math.min(MAP_H - 1e-3, cmd.y));
    const dist = tileDistKm(c.x, c.y, tx, ty);
    const elapsed = Math.max(0, this.sec - c.sec);
    const maxKmh = g.commandTravel ? UNIT_DEFS[u.type].speedKmh : TACTICAL_KMH[c.kind];
    const allow = (maxKmh * elapsed / 3600) * MOVE_TOLERANCE + 0.002;
    // A jump: beyond 5 km and beyond twice what the speed allows in the elapsed game time (travel at ×900 covers
    // several km between two messages legitimately).
    if (dist > Math.max(MOVE_REJECT_KM, allow * 2)) {
      this.stats.rejected++;
      this.stats.lastRejectKm = dist;
      this.log(`[command] controlledMove rejected: jump of ${dist.toFixed(2)} km (> ${Math.max(MOVE_REJECT_KM, allow * 2).toFixed(2)} km)`);
      return false;
    }
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
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= MAP_H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const o = g.owner[yy * MAP_W + wrapX(x + dx)];
        if (o > 0) return o;
      }
    }
    return 0;
  }

  /** Whose land (or territorial water, for ships) the unit is on. */
  private groundOwner(u: Unit, kind: 'tank' | 'jet' | 'ship'): number {
    const g = this.g;
    const t = Math.min(MAP_H - 1, Math.max(0, Math.floor(u.y))) * MAP_W + (Math.floor(wrapX(u.x)) % MAP_W);
    const o = g.owner[t];
    if (kind === 'ship' || (kind !== 'jet' && isWaterTerrain(g.terrain[t]))) {
      return isWaterTerrain(g.terrain[t]) ? this.territorialOwner(t) : o;
    }
    if (kind === 'jet' && isWaterTerrain(g.terrain[t])) return 0;
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

  private capitalKmOf(victim: number, u: Unit): number {
    const P = this.g.playerById[victim];
    if (!P || P.capitalTile < 0) return -1;
    return tileDistKm((P.capitalTile % MAP_W) + 0.5, ((P.capitalTile / MAP_W) | 0) + 0.5, u.x, u.y);
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
    const capKm = this.capitalKmOf(o, u);
    const nearCapital = capKm >= 0 && capKm <= CAPITAL_KM;
    const grace = nearCapital ? GRACE_CAPITAL_SEC : GRACE_SEC[c.kind];
    const inc: Incursion = {
      id: this.nextIncursion++, intruder: c.owner, victim: o, unitId: u.id, kind: c.kind, tile: t, entryX: u.x, entryY: u.y,
      enteredSec: this.sec, graceSec: grace, decideAtSec: this.sec + grace, response: 'none', respondedSec: 0,
      deadlineSec: Number.POSITIVE_INFINITY, depthKm: 0, capitalKm: capKm, qrf: null, fireSec: 0, awaitAlong: false, leaving: false, left: false, leftSec: 0,
    };
    this.incursions.push(inc);
    g.emit({ type: 'borderIncursion', tick: g.tick, intruder: c.owner, victim: o, unitId: u.id, tile: t, stage: 'entered', kind: c.kind, sec: this.sec, graceSec: grace, nearCapital });
    this.log(`[command] incursion #${inc.id}: unit ${u.id} of ${c.owner} entered ${o} at ${this.sec.toFixed(1)} game s; warned, ${grace} s to turn back${nearCapital ? ` (capital ${capKm.toFixed(0)} km)` : ''}`);
    this.dirty = true;
  }

  private leave(inc: Incursion): void {
    if (inc.left) return;
    const g = this.g;
    // Turned back within the grace: a formal protest and a small grudge, nothing else.
    if (inc.response === 'none' && this.sec - inc.enteredSec >= 2 && g.war.pairState(inc.intruder, inc.victim) !== 'war') {
      inc.response = 'protest';
      inc.respondedSec = this.sec;
      g.diplomacy.addReason(inc.victim, inc.intruder, 'incursion', -6);
      g.emit({ type: 'borderIncursion', tick: g.tick, intruder: inc.intruder, victim: inc.victim, unitId: inc.unitId, tile: inc.tile, stage: 'response', response: 'protest', kind: inc.kind, sec: this.sec });
      this.log(`[command] incursion #${inc.id}: left after ${(this.sec - inc.enteredSec).toFixed(1)} s, within the grace: ${inc.victim} protests`);
    }
    inc.left = true;
    inc.leftSec = this.sec;
    // The force goes home: scrambled fighters return to base, a warship keeps its station where it is.
    const q = inc.qrf;
    if (q && q.unitId) {
      const r = g.unitMap.get(q.unitId);
      const V = g.playerById[inc.victim];
      if (r && !r.dead && V) g.unitSys.order(V, [r.id], r.type === UnitType.Warship ? 'hold' : 'return', tileOfXY(r.x, r.y), 0);
    }
    g.emit({ type: 'borderIncursion', tick: g.tick, intruder: inc.intruder, victim: inc.victim, unitId: inc.unitId, tile: inc.tile, stage: 'left', kind: inc.kind, sec: this.sec });
    this.dirty = true;
  }

  // =================================================================================================
  // The victim's answer: warning, interception, last warning, fire or war (owner feedback #19)
  // =================================================================================================
  private aggressive(victim: number): boolean {
    const pers = this.g.playerById[victim]?.personality ?? null;
    return pers === 'conqueror' || pers === 'nuker' || pers === 'opportunist';
  }

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
    // A released unit is followed on the strategic map (it holds, or the player moves it with orders).
    if (!this.controlled.has(u.id)) {
      if (this.groundOwner(u, inc.kind) !== inc.victim || !this.isIncursion(inc.intruder, inc.victim)) {
        this.leave(inc);
        return;
      }
    }
    inc.depthKm = Math.max(inc.depthKm, tileDistKm(inc.entryX, inc.entryY, u.x, u.y));
    const capKm = this.capitalKmOf(inc.victim, u);
    if (capKm >= 0 && (inc.capitalKm < 0 || capKm < inc.capitalKm)) {
      inc.capitalKm = capKm;
      // Heading for the capital: the grace shrinks (never ignored).
      if (capKm <= CAPITAL_KM && inc.response === 'none') inc.decideAtSec = Math.min(inc.decideAtSec, this.sec + GRACE_CAPITAL_SEC);
    }
    const nearCapital = inc.capitalKm >= 0 && inc.capitalKm <= CAPITAL_KM;
    const controlled = this.controlled.has(u.id);
    // Released and ordered out (owner feedback #18: the player can order it out): the victim sees it go and holds
    // its clocks (grace, last warning, fire, the half hour to war) while it drives out under escort.
    const leaving = !controlled && this.isLeaving(u, inc.victim);
    if (leaving !== inc.leaving) {
      inc.leaving = leaving;
      this.dirty = true;
      if (leaving) this.log(`[command] incursion #${inc.id}: unit ${u.id} is leaving ${inc.victim} under orders; the victim holds fire and its clocks`);
    }
    if (leaving) {
      if (inc.response === 'none') inc.decideAtSec += dt;
      if (Number.isFinite(inc.deadlineSec)) inc.deadlineSec += dt;
      if (inc.response === 'engage') inc.respondedSec += dt;
    }
    // The last warning waits for the escort alongside in the scene; released (no scene) or never reached, it starts.
    if (inc.awaitAlong && inc.qrf && (!controlled || this.sec - inc.qrf.arriveSec >= ALONGSIDE_FALLBACK_SEC)) {
      if (controlled) this.log(`[command] incursion #${inc.id}: no escort alongside ${ALONGSIDE_FALLBACK_SEC} s after arrival; the last warning starts`);
      this.startLastWarning(inc, nearCapital);
    }
    if (inc.response === 'none' && this.sec >= inc.decideAtSec) this.decide(inc, u);
    else if ((inc.response === 'intercept' || inc.response === 'protest') && this.sec >= inc.deadlineSec) {
      // The last warning was ignored.
      const hates = g.diplomacy.opinion(inc.victim, inc.intruder) <= -40;
      const canFire = inc.qrf !== null || (inc.kind === 'jet' && this.samCovers(inc.victim, u)) || inc.kind === 'tank';
      if ((this.aggressive(inc.victim) || hates || (nearCapital && !canFire)) && g.war.declareError(inc.victim, inc.intruder, { force: true }) === null) {
        this.respond(inc, u, 'war', true);
      } else if (canFire) this.respond(inc, u, 'engage', true);
      else {
        // Nothing to send and no will for war: another protest, another grudge.
        g.diplomacy.addReason(inc.victim, inc.intruder, 'incursion');
        inc.deadlineSec = this.sec + 600;
        this.log(`[command] incursion #${inc.id}: ${inc.victim} cannot intercept; protests again`);
      }
    } else if (inc.response === 'engage') {
      if (this.sec - inc.respondedSec >= ENGAGE_WAR_SEC && g.war.declareError(inc.victim, inc.intruder, { force: true }) === null) {
        this.respond(inc, u, 'war', true);
      } else if (!controlled && !leaving) {
        // Left inside under fire on the strategic map: the forces really there wear it down (in proportion).
        inc.fireSec += dt;
        if (inc.fireSec >= 60) {
          const mins = Math.floor(inc.fireSec / 60);
          inc.fireSec -= mins * 60;
          const share = ENGAGE_KILL_PER_MIN * this.firepower(inc, u) / INTRUDER_STRENGTH[inc.kind];
          if (share > 0) g.unitSys.damage(u, u.maxHp * Math.min(0.5, share * mins), inc.victim);
          if (u.dead) {
            this.leave(inc);
            return;
          }
        }
      }
    }
    const q = inc.qrf;
    if (q && !q.arrived) {
      // Pursue: the force heads for the intruder's current position and arrives on its schedule.
      const k = Math.min(1, (this.sec - q.dispatchSec) / Math.max(1, q.arriveSec - q.dispatchSec));
      q.x = wrapX(q.fromX + wdx(q.fromX, u.x) * k);
      q.y = q.fromY + (u.y - q.fromY) * k;
      this.carry(q, u, false);
      if (k >= 1) {
        q.arrived = true;
        q.arriveSec = this.sec;
        if (controlled && inc.response === 'intercept') {
          // Command mode: the warning starts when a vehicle is really alongside in the scene (escortAlongside).
          inc.awaitAlong = true;
          this.log(`[command] incursion #${inc.id}: the ${q.mode} force is in the area ${(this.sec - q.dispatchSec).toFixed(0)} game s after dispatch; the last warning waits for it to be alongside`);
        } else this.startLastWarning(inc, nearCapital);
      }
      this.dirty = true;
    } else if (q && q.arrived) {
      // Escort: stays with the intruder.
      q.x = u.x;
      q.y = u.y;
      this.carry(q, u, true);
    }
  }

  /** The real unit carrying the force (fighters, a warship) flies / sails along the force's path, then escorts. */
  private carry(q: Qrf, u: Unit, escorting: boolean): void {
    if (!q.unitId) return;
    const r = this.g.unitMap.get(q.unitId);
    if (!r || r.dead) {
      q.unitId = 0;
      return;
    }
    const px = r.x, py = r.y;
    if (escorting) {
      // Station on the intruder: fighters orbit it, the warship keeps company (its own step moves it).
      r.stationX = u.x;
      r.stationY = u.y;
      r.toX = u.x;
      r.toY = u.y;
      if (r.type !== UnitType.Warship) {
        r.x = u.x;
        r.y = u.y;
      }
    } else {
      r.x = q.x;
      r.y = q.y;
      r.stationX = u.x;
      r.stationY = u.y;
      r.toX = u.x;
      r.toY = u.y;
    }
    const ex = wdx(px, r.x) * kmPerTileX(r.y), ny = -(r.y - py) * TILE_KM;
    if (Math.hypot(ex, ny) > 0.05) r.heading = Math.atan2(ex, ny);
  }

  /** The force is alongside: the last warning starts now (emits 'arrived' with its length). */
  private startLastWarning(inc: Incursion, nearCapital: boolean): void {
    const g = this.g;
    const q = inc.qrf;
    inc.awaitAlong = false;
    const warn = nearCapital ? ESCORT_WARN_CAPITAL_SEC : ESCORT_WARN_SEC[inc.kind];
    if (inc.response === 'intercept') inc.deadlineSec = this.sec + warn;
    g.emit({
      type: 'borderIncursion', tick: g.tick, intruder: inc.intruder, victim: inc.victim, unitId: inc.unitId, tile: inc.tile, stage: 'arrived',
      response: inc.response === 'none' ? 'intercept' : inc.response, kind: inc.kind, sec: this.sec, deadlineSec: warn, qrfMode: q?.mode, nearCapital,
    });
    this.log(`[command] incursion #${inc.id}: the ${q?.mode ?? '-'} force is alongside ${q ? (this.sec - q.dispatchSec).toFixed(0) : '-'} game s after dispatch; last warning ${warn} s`);
    this.dirty = true;
  }

  /** Client: a vehicle of the force is at its station beside the controlled unit in the scene. */
  alongside(p: Player, unitId: number): boolean {
    const inc = this.incursions.find((i) => i.unitId === unitId && i.intruder === p.id && !i.left);
    if (!inc || !inc.awaitAlong || !inc.qrf?.arrived) return false;
    this.startLastWarning(inc, inc.capitalKm >= 0 && inc.capitalKm <= CAPITAL_KM);
    return true;
  }

  /** A released unit whose current orders take it out of `victim`'s land (or air / waters). */
  private isLeaving(u: Unit, victim: number): boolean {
    if (u.state !== UnitState.Moving && u.state !== UnitState.Returning) return false;
    const dest = u.targetTile >= 0 && u.type === UnitType.ArmoredDivision ? u.targetTile : tileOfXY(u.toX, u.toY);
    const t = dest;
    const o = this.g.owner[t];
    if (UNIT_DEFS[u.type].command === 'ship' && isWaterTerrain(this.g.terrain[t])) return this.territorialOwner(t) !== victim;
    return o !== victim;
  }

  /** Firepower of the victim's forces really engaging the intruder, in tank equivalents (see ENGAGE_KILL_PER_MIN). */
  private firepower(inc: Incursion, u: Unit): number {
    const g = this.g;
    const q = inc.qrf;
    let f = 0;
    if (q && q.arrived) {
      if (q.mode === 'ground') f += q.heavy ? QRF_TANK_FIRE + (q.vehicles - 1) * QRF_APC_FIRE : q.vehicles * QRF_APC_FIRE;
      else if (q.mode === 'sea' && !q.unitId) f += 0.3;
      if (q.unitId) {
        const r = g.unitMap.get(q.unitId);
        if (r && !r.dead) f += (r.hp / r.maxHp) * (r.type === UnitType.FighterSquadron ? 3 : 1);
      }
    }
    for (const id of q?.divisions ?? []) {
      const d = g.unitMap.get(id);
      if (d && !d.dead && tileDistKm(d.x, d.y, u.x, u.y) <= ENGAGE_DIVISION_KM) f += (d.hp / d.maxHp) * 4;
    }
    // Surface-to-air missiles fire at an aircraft that stays in their cover.
    if (inc.kind === 'jet' && this.samCovers(inc.victim, u)) f += 1.5;
    return f;
  }

  private samCovers(victim: number, u: Unit): boolean {
    for (const s of this.g.structByOwner.get(victim) ?? []) {
      if (s.type !== StructureType.SamSite || s.built < 1) continue;
      if (tileDistKm((s.tile % MAP_W) + 0.5, ((s.tile / MAP_W) | 0) + 0.5, u.x, u.y) <= 150) return true;
    }
    return false;
  }

  private decide(inc: Incursion, u: Unit): void {
    const g = this.g;
    const P = g.playerById[inc.victim];
    const op = g.diplomacy.opinion(inc.victim, inc.intruder);
    const pers = P?.personality ?? null;
    let r: 'intercept' | 'war' = 'intercept';
    if (op <= -50 && this.aggressive(inc.victim) && g.war.declareError(inc.victim, inc.intruder, { force: true }) === null) r = 'war';
    g.diplomacy.addReason(inc.victim, inc.intruder, 'incursion');
    this.log(`[command] incursion #${inc.id}: ${inc.victim} answers ${r} at ${this.sec.toFixed(1)} game s (${(this.sec - inc.enteredSec).toFixed(1)} s after the warning, opinion ${op.toFixed(0)}, ${pers ?? '-'})`);
    this.respond(inc, u, r, false);
  }

  private respond(inc: Incursion, u: Unit, r: 'intercept' | 'engage' | 'war', escalated: boolean): void {
    const g = this.g;
    inc.response = r;
    inc.respondedSec = this.sec;
    this.dirty = true;
    if (r === 'intercept') {
      this.dispatch(inc, u);
      if (!inc.qrf) {
        // Nothing to send (no airbase or fleet in reach): a protest with a deadline instead.
        inc.response = 'protest';
        inc.deadlineSec = this.sec + (inc.capitalKm >= 0 && inc.capitalKm <= CAPITAL_KM ? ESCORT_WARN_CAPITAL_SEC : ESCORT_WARN_SEC[inc.kind]) * 2;
      } else inc.deadlineSec = Number.POSITIVE_INFINITY;
    }
    if (r === 'engage') {
      inc.deadlineSec = Number.POSITIVE_INFINITY;
      this.log(`[command] incursion #${inc.id}: last warning ignored: ${inc.victim} opens fire on unit ${inc.unitId}`);
    }
    if (r === 'war') {
      g.war.recordTension(inc.victim, inc.intruder);
      const w = g.war.declare(inc.victim, inc.intruder, 'incursion', 'war.reason.incursion', { force: true });
      if (!w) {
        inc.response = inc.qrf ? 'engage' : 'intercept';
        if (!inc.qrf) this.dispatch(inc, u);
      }
    }
    g.emit({
      type: 'borderIncursion', tick: g.tick, intruder: inc.intruder, victim: inc.victim, unitId: inc.unitId, tile: inc.tile,
      stage: 'response', response: inc.response as 'protest' | 'intercept' | 'engage' | 'war', escalated, kind: inc.kind, sec: this.sec,
      etaSec: inc.qrf && !inc.qrf.arrived ? Math.max(0, inc.qrf.arriveSec - this.sec) : undefined,
      deadlineSec: Number.isFinite(inc.deadlineSec) ? inc.deadlineSec - this.sec : undefined, qrfMode: inc.qrf?.mode,
      nearCapital: inc.capitalKm >= 0 && inc.capitalKm <= CAPITAL_KM,
    });
  }

  private dispatch(inc: Incursion, u: Unit): void {
    const g = this.g;
    const V = g.playerById[inc.victim];
    if (!V) return;
    const here = tileOfXY(u.x, u.y);
    const structs = g.structByOwner.get(inc.victim) ?? [];
    const sxy = (s: { tile: number }) => ({ x: (s.tile % MAP_W) + 0.5, y: ((s.tile / MAP_W) | 0) + 0.5 });
    let q: Qrf | null = null;
    const make = (mode: Qrf['mode'], fromX: number, fromY: number, km: number, source: Qrf['source'], vehicles: number, heavy: boolean, soldiers: number, unitId: number): Qrf => {
      const [lo, hi] = QRF_WINDOW[mode];
      const raw = mode === 'air' ? 45 + km / QRF_AIR_KMS : mode === 'sea' ? (km / QRF_SEA_KMH) * 3600 : (km / QRF_ROAD_KMH) * 3600;
      const travel = Math.max(lo, Math.min(hi, raw));
      return { mode, fromX, fromY, x: fromX, y: fromY, vehicles, heavy, soldiers, dispatchSec: this.sec, arriveSec: this.sec + travel, arrived: false, source, unitId, divisions: [], fighters: [] };
    };
    if (inc.kind === 'jet') {
      // Fighters: a squadron already airborne within 300 km, else the ready one of the nearest airbase in reach.
      let best: Unit | null = null, bestD = QRF_FIGHTER_KM;
      for (const d of g.unitsByOwner.get(inc.victim) ?? []) {
        if (d.dead || d.type !== UnitType.FighterSquadron || d.state === UnitState.Controlled || d.alt <= 0 || d.mode === Mode.Docked) continue;
        const km = tileDistKm(d.x, d.y, u.x, u.y);
        if (km < bestD) {
          bestD = km;
          best = d;
        }
      }
      let source: Qrf['source'] = 'unit';
      if (!best) {
        bestD = QRF_SCRAMBLE_KM;
        for (const d of g.unitsByOwner.get(inc.victim) ?? []) {
          if (d.dead || d.type !== UnitType.FighterSquadron || d.mode !== Mode.Docked || d.readyTick > g.tick) continue;
          const km = tileDistKm(d.x, d.y, u.x, u.y);
          if (km < bestD) {
            bestD = km;
            best = d;
          }
        }
        source = 'airbase';
      }
      if (best && g.unitSys.order(V, [best.id], 'cap', here, 0)) {
        q = make('air', best.x, best.y, bestD, source, Math.max(1, Math.min(2, Math.round(best.hp / best.maxHp * 3))), false, 0, best.id);
        q.fighters.push(best.id);
      }
    } else if (inc.kind === 'ship') {
      let best: Unit | null = null, bestD = QRF_SHIP_KM;
      for (const d of g.unitsByOwner.get(inc.victim) ?? []) {
        if (d.dead || d.type !== UnitType.Warship || d.state === UnitState.Controlled) continue;
        const km = tileDistKm(d.x, d.y, u.x, u.y);
        if (km < bestD) {
          bestD = km;
          best = d;
        }
      }
      if (best && g.unitSys.order(V, [best.id], 'escort', here, u.id)) {
        q = make('sea', best.x, best.y, bestD, 'unit', 1, true, 0, best.id);
      } else {
        let port: { x: number; y: number } | null = null, pd = QRF_PORT_KM;
        for (const s of structs) {
          if (s.built < 1 || (s.type !== StructureType.Port && s.type !== StructureType.NavalYard)) continue;
          const c = sxy(s);
          const km = tileDistKm(c.x, c.y, u.x, u.y);
          if (km < pd) {
            pd = km;
            port = c;
          }
        }
        if (port) q = make('sea', port.x, port.y, pd, 'port', 1, false, 0, 0);
      }
    } else {
      // Ground: patrol vehicles and APCs of the nearest post, town or base within 150 km (a tank leads a force from
      // an army base); else the garrison of the land itself, 12 km deeper inside.
      let best: { x: number; y: number; source: 'city' | 'post' | 'base' } | null = null, bestD = 150;
      for (const s of structs) {
        if (s.built < 1) continue;
        const source = s.type === StructureType.City ? 'city' : s.type === StructureType.DefensePost ? 'post' : s.type === StructureType.ArmyBase ? 'base' : null;
        if (!source) continue;
        const c = sxy(s);
        const d = tileDistKm(c.x, c.y, u.x, u.y);
        if (d < bestD) {
          bestD = d;
          best = { x: c.x, y: c.y, source };
        }
      }
      const soldiers = Math.round(Math.max(8, Math.min(24, 8 + 16 * Math.min(1, V.troops / 400_000))));
      if (best) q = make('ground', best.x, best.y, bestD, best.source, best.source === 'base' ? 3 : 2, best.source === 'base', soldiers, 0);
      else {
        const ang = Math.atan2(u.y - inc.entryY, wdx(inc.entryX, u.x));
        const fx = wrapX(u.x + Math.cos(ang) * 12 / kmPerTileX(u.y)), fy = u.y + Math.sin(ang) * 12 / TILE_KM;
        q = make('ground', fx, fy, 12, 'border', 2, false, soldiers, 0);
      }
      for (const d of g.unitsByOwner.get(inc.victim) ?? []) {
        if (d.dead || d.state === UnitState.Controlled || d.type !== UnitType.ArmoredDivision) continue;
        if (tileDistKm(d.x, d.y, u.x, u.y) > QRF_DIVISION_KM) continue;
        if (g.unitSys.order(V, [d.id], 'move', here, 0)) q.divisions.push(d.id);
      }
    }
    inc.qrf = q;
    if (q) {
      this.log(`[command] incursion #${inc.id}: ${q.mode} force (${q.vehicles} vehicles${q.unitId ? `, unit ${q.unitId}` : ''}) from ${q.source}, arrival in ${((q.arriveSec - q.dispatchSec) / 60).toFixed(1)} game min; divisions [${q.divisions}]`);
    } else this.log(`[command] incursion #${inc.id}: ${inc.victim} has nothing in reach to intercept with`);
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
      g.economy.damage(s, Math.max(0, Math.min(1, h.dmg)), p.id, 'command');
    }
    this.dirty = true;
    return true;
  }

  /**
   * Feedback 3 (owner item #27, hook for command mode): a shell, bomb, missile or naval gun of the controlled unit hit a
   * real structure (or one block of a city). The hit goes through the sim's one damage rule (EconomySystem.damage):
   * level loss, rubble, civilian and troop losses, the diplomatic cost of a city. Validated: own unit, within
   * STRUCTURE_HIT_KM of the structure, at most 0.6 hp per report; a structure of a nation at peace is an act of war
   * (that nation declares it, as when its escort is fired upon).
   */
  structureHit(p: Player, cmd: Extract<PlayerCommand, { type: 'commandStructureHit' }>): boolean {
    const g = this.g;
    const u = g.unitMap.get(cmd.unitId);
    const s = g.structureMap.get(cmd.structureId);
    if (!u || u.dead || u.owner !== p.id || !s || s.owner === p.id || g.isAllied(p.id, s.owner)) return false;
    if (tileDistKm(u.x, u.y, s.x, s.y) > STRUCTURE_HIT_KM) {
      this.log(`[command] structure hit on ${s.id} refused: unit ${u.id} is ${tileDistKm(u.x, u.y, s.x, s.y).toFixed(1)} km away`);
      return false;
    }
    const dmg = Math.max(0, Math.min(0.6, Number(cmd.dmg) || 0));
    if (dmg <= 0) return false;
    if (s.owner > 0 && !hostileTo(g.rules, p.id, s.owner)) {
      if (g.war.declareError(s.owner, p.id, { force: true }) !== null) return false;
      const w = g.war.declare(s.owner, p.id, 'incursion', 'war.reason.structureAttacked', { force: true });
      if (!w) return false;
      this.log(`[command] ${p.id} fired on a structure of ${s.owner} at peace: ${s.owner} declares war`);
    }
    const block = typeof cmd.block === 'number' && cmd.block >= 0 && cmd.block < CITY_BLOCKS ? cmd.block | 0 : -1;
    g.economy.damage(s, dmg, p.id, 'command', block);
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
      decideAtSec: i.decideAtSec, graceSec: i.graceSec, response: i.response, respondedSec: i.respondedSec,
      deadlineSec: Number.isFinite(i.deadlineSec) ? i.deadlineSec : 0, depthKm: i.depthKm, capitalKm: i.capitalKm, left: i.left,
      awaitingAlongside: i.awaitAlong, leaving: i.leaving,
      qrf: i.qrf ? { ...i.qrf, divisions: [...i.qrf.divisions], fighters: [...i.qrf.fighters] } : null,
    }));
    const controlled = [...this.controlled.values()].map((c) => ({ unitId: c.unitId, x: c.x, y: c.y, sec: c.sec }));
    return {
      sec: this.sec, travel: this.g.commandTravel, controlled, incursions, log: this.logs.slice(-12),
      moves: { accepted: this.stats.accepted, snapped: this.stats.snapped, rejected: this.stats.rejected, lastSnapKm: this.stats.lastSnapKm, lastRejectKm: this.stats.lastRejectKm },
    };
  }
}
