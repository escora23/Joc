// FRONT ULTRA — unit order rules shared by the simulation and the UI preview (DESIGN_V2 §7.3, §14.1). Owner: W4.
// Worker-safe: no three.js, no DOM.
//
// The sim validates every unitOrder with orderError(); the cursor chip calls the very same function over an adapter
// of the client's GameView (src/sim/rulesView.ts), so the preview and the sim can never disagree (the v1 "aircraft
// valid on own land" bug). Everything here is pure: the RulesView answers the questions about the world.
//
//   orderError(r, unitId, order, tile, targetId)   null = the unit takes the order, else the i18n key of the reason
//   orderCheck(...)                                the same with the reason's parameters (chip text)
//   inferOrder(r, unitId, tile, targetUnit, targetStructure, shift)   the right-click context of §7.3
//   predictOffensive(r, attacker, defender, troops, tile)            the offensive chip of §7.7
//   divisionRoute(...)                             road or rail (§6.2 Factory), with its km and hours

import {
  ADVANCE_FULL_RATIO, ADVANCE_MAX_KMH, ARMOR_RAIL_KMH, CAP_RADIUS_TILES, DEFENSE_REAR_SHARE, DIVISION_ATTACH_TILES,
  DRONE_SUPPORT_TILES, EARTH_RADIUS_KM, FRONTAGE_MAX, FRONTAGE_MIN, MAP_H, MAP_W, NEUTRAL_ADVANCE_KMH,
  NEUTRAL_TROOPS_PER_FRONT_TILE, OFFENSIVE_CONTACT_TICKS, STRUCTURE_LEVELS, TILE_COUNT, TILE_KM, TROOPS_PER_FRONT_TILE,
  UNIT_DEFS, WARSHIP_BOMBARD_TILES, WARSHIP_ENGAGE_TILES, structureLevel,
} from './constants';
import {
  StructureType, TerrainFlag, UnitMode, UnitState, UnitType, type PairState, type PlayerKind, type TreatyKind,
  type UnitOrderKind,
} from './types';

// =================================================================================================
// The world as the rules see it
// =================================================================================================

export interface UnitLike {
  id: number;
  type: UnitType;
  owner: number;
  x: number;
  y: number;
  state: UnitState;
  mode: UnitMode;
  home: number;
  /** Ticks until ready (rearming aircraft), -1 = n/a. */
  etaTicks: number;
}

export interface StructureLike {
  id: number;
  type: StructureType;
  owner: number;
  tile: number;
  level: number;
  /** 0..1 construction progress. */
  built: number;
  hp: number;
}

export interface FrontLike {
  key: number;
  a: number;
  b: number;
  x: number;
  y: number;
  /** Polyline samples along the contact line [x0, y0, x1, y1, ...]. */
  samples: Float32Array;
  garrisonA: number;
  garrisonB: number;
}

/** Implemented by Game (worker) and by an adapter over GameView (main thread). */
export interface RulesView {
  readonly tick: number;
  ownerOf(tile: number): number;
  /** Terrain byte (TerrainClass | TerrainFlag). */
  terrainOf(tile: number): number;
  playable(tile: number): boolean;
  kindOf(player: number): PlayerKind | null;
  pairState(a: number, b: number): PairState;
  hasTreaty(a: number, b: number, kind: TreatyKind): boolean;
  /** `a`'s escalation level in its war with `b` (0..4). */
  escalation(a: number, b: number): number;
  /** The tick until which `a` still mobilizes against `b` (0 = ready). */
  mobilizeUntil(a: number, b: number): number;
  unit(id: number): UnitLike | null;
  structure(id: number): StructureLike | null;
  structureAt(tile: number): StructureLike | null;
  structuresOf(owner: number): Iterable<StructureLike>;
  unitsOf(owner: number): Iterable<UnitLike>;
  /** Units homed at a base (aircraft, divisions, warships) plus units queued for production there. */
  hostedAt(structureId: number): number;
  /** Fronts involving `owner`. */
  frontsOf(owner: number): Iterable<FrontLike>;
  homeTroops(player: number): number;
  sharesBorder(a: number, b: number): boolean;
  /** Land component id of a playable tile (islands and continents), -1 for water. */
  landComponent(tile: number): number;
  /** Rail network: station-id pairs (§14.5). */
  railLinks(): Int32Array;
}

// =================================================================================================
// Geometry helpers (the same numbers on both sides)
// =================================================================================================

const DEG = Math.PI / 180;

/** Great-circle km between two points in continuous tile coordinates. */
export function tileKm(ax: number, ay: number, bx: number, by: number): number {
  const la1 = (90 - (ay / MAP_H) * 180) * DEG, la2 = (90 - (by / MAP_H) * 180) * DEG;
  let dl = ((bx - ax) / MAP_W) * 360;
  if (dl > 180) dl -= 360;
  else if (dl < -180) dl += 360;
  const dp = la2 - la1, dlr = dl * DEG;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlr / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const tileCx = (t: number): number => (t % MAP_W) + 0.5;
export const tileCy = (t: number): number => Math.floor(t / MAP_W) + 0.5;

/** Visit the tiles within `r` tiles (surface-true, km) of tile `center`; stop when fn returns true. */
export function someTileWithin(center: number, r: number, fn: (t: number) => boolean): boolean {
  const cx = tileCx(center), cy = tileCy(center);
  const lat = (90 - (cy / MAP_H) * 180) * DEG;
  const c = Math.max(0.15, Math.cos(lat));
  const ry = Math.ceil(r), rx = Math.min(MAP_W / 2, Math.ceil(r / c));
  const y0 = Math.floor(cy), x0 = Math.floor(cx);
  const rkm = r * TILE_KM;
  for (let dy = -ry; dy <= ry; dy++) {
    const y = y0 + dy;
    if (y < 0 || y >= MAP_H) continue;
    for (let dx = -rx; dx <= rx; dx++) {
      const t = y * MAP_W + (((x0 + dx) % MAP_W) + MAP_W) % MAP_W;
      if (tileKm(cx, cy, tileCx(t), tileCy(t)) > rkm + 1e-6) continue;
      if (fn(t)) return true;
    }
  }
  return false;
}

const isNavigable = (terrain: number): boolean => (terrain & TerrainFlag.Navigable) !== 0 && (terrain & 0x0f) <= 1;

// =================================================================================================
// Players
// =================================================================================================

/**
 * May units of `unitOwner` enter land of `tileOwner`: their own, an ally's, or a nation that granted open borders.
 * v2-stub(W4→W3): RulesView.hasTreaty knows alliances only until W3's DiplomacySystem answers it (open borders).
 */
export function canTransit(r: RulesView, unitOwner: number, tileOwner: number): boolean {
  if (tileOwner === unitOwner) return true;
  if (tileOwner <= 0) return false;
  return r.hasTreaty(unitOwner, tileOwner, 'alliance') || r.hasTreaty(unitOwner, tileOwner, 'openBorders');
}

/** Can `a` fight `b` now: a declared war, or an independent territory (attackable without a declaration, §4.10). */
export function hostileTo(r: RulesView, a: number, b: number): boolean {
  if (a === b || a <= 0 || b <= 0) return false;
  if (r.kindOf(b) === 'tribe' || r.kindOf(a) === 'tribe') return !canTransit(r, a, b);
  return r.pairState(a, b) === 'war';
}

/** Strategic targets need escalation L2 (§5.10); everything else is military (L1). */
export const STRATEGIC_STRUCTURES: ReadonlySet<StructureType> = new Set<StructureType>([StructureType.City, StructureType.Port, StructureType.Factory]);

// =================================================================================================
// Bases and capacities
// =================================================================================================

/** Units a base hosts at its level (airbase squadrons, army-base divisions, naval-yard warships). */
export function baseCapacity(s: StructureLike): number {
  return structureLevel(s.type, s.level).capacity ?? 0;
}

/** The structure that produces / hosts / repairs a unit type. */
export function homeTypeOf(type: UnitType): StructureType | -1 {
  switch (type) {
    case UnitType.ArmoredDivision: return StructureType.ArmyBase;
    case UnitType.Warship: return StructureType.NavalYard;
    case UnitType.FighterSquadron:
    case UnitType.Bomber:
    case UnitType.DroneSwarm: return StructureType.Airbase;
    default: return -1;
  }
}

/** Reach of an aircraft, in km from its home base (§6.3). */
export function reachKm(type: UnitType): number {
  return UNIT_DEFS[type]?.rangeKm ?? 0;
}

export const isAircraft = (t: UnitType): boolean => t === UnitType.FighterSquadron || t === UnitType.Bomber || t === UnitType.DroneSwarm;

/** Units the Fuerzas panel lists and the player orders (not missiles, trade ships or trains). */
export function isForce(t: UnitType): boolean {
  return t === UnitType.ArmoredDivision || t === UnitType.Warship || t === UnitType.FighterSquadron || t === UnitType.Bomber
    || t === UnitType.DroneSwarm || t === UnitType.TransportShip;
}

// =================================================================================================
// Order validation
// =================================================================================================

export interface OrderIssue {
  /** i18n key (order.err.*). */
  key: string;
  params?: Record<string, string | number>;
  /** The order is valid once the player confirms it (a first strategic strike, §5.10). */
  confirm?: boolean;
}

export interface OrderOpts {
  /** The player already confirmed a strategic (L2) strike. */
  confirm?: boolean;
  /** Issued by an AI (no confirmation dialogs: it must hold the escalation level itself). */
  ai?: boolean;
}

/** Null when `unitId` takes `order` at `tile` (targetId: a unit or structure id, 0 = none), else the reason key. */
export function orderError(r: RulesView, unitId: number, order: UnitOrderKind, tile: number, targetId: number, opts: OrderOpts = {}): string | null {
  const e = orderCheck(r, unitId, order, tile, targetId, opts);
  return e ? e.key : null;
}

/** orderError with the reason's parameters (the chip writes «Base llena (3/3)», «Fuera de alcance: 1.000 km…»). */
export function orderCheck(r: RulesView, unitId: number, order: UnitOrderKind, tile: number, targetId: number, opts: OrderOpts = {}): OrderIssue | null {
  const u = r.unit(unitId);
  if (!u) return { key: 'order.err.noUnit' };
  if (u.state === UnitState.Controlled) return { key: 'order.err.controlled' };
  if (u.state === UnitState.Destroyed) return { key: 'order.err.noUnit' };
  if (tile < 0 || tile >= TILE_COUNT) {
    if (order !== 'hold' && order !== 'return') return { key: 'order.err.noTarget' };
  }
  switch (u.type) {
    case UnitType.ArmoredDivision: return divisionCheck(r, u, order, tile);
    case UnitType.Warship: return warshipCheck(r, u, order, tile, targetId);
    case UnitType.FighterSquadron:
    case UnitType.Bomber:
    case UnitType.DroneSwarm: return aircraftCheck(r, u, order, tile, targetId, opts);
    default: return { key: 'order.err.notOrderable' };
  }
}

function nameParam(owner: number): Record<string, number> {
  return { player: owner };
}

function hereTile(u: UnitLike): number {
  const y = Math.min(MAP_H - 1, Math.max(0, Math.floor(u.y)));
  return y * MAP_W + (((Math.floor(u.x) % MAP_W) + MAP_W) % MAP_W);
}

/** A land tile of `enemy` within DIVISION_ATTACH_TILES of land of `owner` (the front line). */
export function nearFrontLine(r: RulesView, owner: number, tile: number, reach = DIVISION_ATTACH_TILES): boolean {
  return someTileWithin(tile, reach, (t) => r.ownerOf(t) === owner && r.playable(t));
}

function divisionCheck(r: RulesView, u: UnitLike, order: UnitOrderKind, tile: number): OrderIssue | null {
  switch (order) {
    case 'hold': return null;
    case 'return': {
      for (const s of r.structuresOf(u.owner)) if (s.type === StructureType.ArmyBase && s.built >= 1) return null;
      return { key: 'order.err.noArmyBase' };
    }
    case 'move':
    case 'attach':
    case 'attack':
      break;
    default:
      return { key: 'order.err.notForDivision' };
  }
  if (!r.playable(tile)) return { key: 'order.err.divisionWater' };
  const here = hereTile(u);
  const hc = r.landComponent(here), tc = r.landComponent(tile);
  if (hc >= 0 && tc >= 0 && hc !== tc) return { key: 'order.err.noLandRoute' };
  const o = r.ownerOf(tile);
  if (order === 'move') {
    if (canTransit(r, u.owner, o)) return null;
    if (o === 0) return { key: 'order.err.unclaimed' };
    if (hostileTo(r, u.owner, o)) return { key: 'order.err.enemyLand', params: nameParam(o) };
    return { key: 'order.err.atPeace', params: nameParam(o) };
  }
  // attach / attack: enemy land of a nation at war (or an independent territory) with a front to join.
  if (o === 0 || canTransit(r, u.owner, o)) return { key: 'order.err.notEnemy' };
  if (!hostileTo(r, u.owner, o)) return { key: 'order.err.atPeace', params: nameParam(o) };
  if (!r.sharesBorder(u.owner, o)) return { key: 'order.err.noFront', params: nameParam(o) };
  if (order === 'attach' && !nearFrontLine(r, u.owner, tile)) return { key: 'order.err.tooDeep' };
  return null;
}

function warshipCheck(r: RulesView, u: UnitLike, order: UnitOrderKind, tile: number, targetId: number): OrderIssue | null {
  switch (order) {
    case 'hold': return null;
    case 'return': {
      for (const s of r.structuresOf(u.owner)) if ((s.type === StructureType.NavalYard || s.type === StructureType.Port) && s.built >= 1) return null;
      return { key: 'order.err.noPort' };
    }
    case 'move':
    case 'patrol':
      return isNavigable(r.terrainOf(tile)) ? null : { key: 'order.err.shipLand' };
    case 'blockade': {
      if (!isNavigable(r.terrainOf(tile))) return { key: 'order.err.shipLand' };
      let enemy = 0;
      someTileWithin(tile, WARSHIP_ENGAGE_TILES, (t) => {
        const o = r.ownerOf(t);
        if (o > 0 && o !== u.owner && hostileTo(r, u.owner, o)) {
          enemy = o;
          return true;
        }
        return false;
      });
      return enemy ? null : { key: 'order.err.blockadeNoEnemy' };
    }
    case 'bombard': {
      const o = r.ownerOf(tile);
      if (!r.playable(tile) || o === 0 || o === u.owner) return { key: 'order.err.bombardTarget' };
      if (!hostileTo(r, u.owner, o)) return { key: 'order.err.atPeace', params: nameParam(o) };
      const coast = someTileWithin(tile, WARSHIP_BOMBARD_TILES, (t) => isNavigable(r.terrainOf(t)));
      return coast ? null : { key: 'order.err.bombardRange', params: { tiles: WARSHIP_BOMBARD_TILES } };
    }
    case 'attack': {
      const t = r.unit(targetId);
      if (!t || (t.type !== UnitType.Warship && t.type !== UnitType.TransportShip && t.type !== UnitType.TradeShip)) return { key: 'order.err.noTarget' };
      if (!hostileTo(r, u.owner, t.owner)) return { key: 'order.err.atPeace', params: nameParam(t.owner) };
      return null;
    }
    case 'escort': {
      const t = r.unit(targetId);
      if (!t || t.owner !== u.owner || t.type !== UnitType.TransportShip) return { key: 'order.err.escortTarget' };
      return null;
    }
    default:
      return { key: 'order.err.notForShip' };
  }
}

function aircraftCheck(r: RulesView, u: UnitLike, order: UnitOrderKind, tile: number, targetId: number, opts: OrderOpts): OrderIssue | null {
  const base = r.structure(u.home);
  if (order === 'return') return u.mode === UnitMode.Docked || u.mode === UnitMode.Rearming ? { key: 'order.err.alreadyHome' } : null;
  if (order === 'rebase') {
    const s = r.structure(targetId) ?? r.structureAt(tile);
    if (!s || s.owner !== u.owner || s.type !== StructureType.Airbase || s.built < 1) return { key: 'order.err.rebaseTarget' };
    if (s.id === u.home) return { key: 'order.err.alreadyHome' };
    const cap = baseCapacity(s), used = r.hostedAt(s.id);
    if (used >= cap) return { key: 'order.err.baseFull', params: { n: used, cap } };
    return null;
  }
  if (!base || base.owner !== u.owner) return { key: 'order.err.noAirbase' };
  if (u.mode === UnitMode.Rearming) return { key: 'order.err.rearming', params: { h: Math.max(1, Math.ceil(u.etaTicks / 10)) } };
  const reach = reachKm(u.type);
  const bx = tileCx(base.tile), by = tileCy(base.tile);
  const outOfReach = (x: number, y: number): OrderIssue | null =>
    tileKm(bx, by, x, y) > reach ? { key: 'order.err.outOfReach', params: { km: reach } } : null;
  switch (order) {
    case 'cap': {
      if (u.type !== UnitType.FighterSquadron) return { key: 'order.err.notForAircraft' };
      return outOfReach(tileCx(tile), tileCy(tile));
    }
    case 'intercept': {
      if (u.type !== UnitType.FighterSquadron) return { key: 'order.err.notForAircraft' };
      const t = r.unit(targetId);
      if (!t || !isAircraft(t.type) || t.mode === UnitMode.Docked || t.mode === UnitMode.Rearming) return { key: 'order.err.interceptTarget' };
      if (!hostileTo(r, u.owner, t.owner)) return { key: 'order.err.atPeace', params: nameParam(t.owner) };
      return outOfReach(t.x, t.y);
    }
    case 'escort': {
      if (u.type !== UnitType.FighterSquadron) return { key: 'order.err.notForAircraft' };
      const t = r.unit(targetId);
      if (!t || t.owner !== u.owner || (t.type !== UnitType.Bomber && t.type !== UnitType.DroneSwarm)) return { key: 'order.err.escortTarget' };
      return null;
    }
    case 'support': {
      if (u.type !== UnitType.DroneSwarm) return { key: 'order.err.notForAircraft' };
      const far = outOfReach(tileCx(tile), tileCy(tile));
      if (far) return far;
      // Over a front at war: enemy land at war within the support radius of our land, or our land next to it.
      let enemy = 0;
      someTileWithin(tile, DRONE_SUPPORT_TILES + 1, (t) => {
        const o = r.ownerOf(t);
        if (o > 0 && o !== u.owner && r.playable(t) && hostileTo(r, u.owner, o)) {
          enemy = o;
          return true;
        }
        return false;
      });
      if (!enemy) return { key: 'order.err.supportNoFront' };
      if (!nearFrontLine(r, u.owner, tile, DRONE_SUPPORT_TILES + 1)) return { key: 'order.err.supportNoFront' };
      return escalationCheck(r, u.owner, enemy, false, opts);
    }
    case 'strike': {
      if (u.type === UnitType.FighterSquadron) return { key: 'order.err.notForAircraft' };
      const tgt = strikeTarget(r, tile, targetId);
      if (!tgt) return { key: 'order.err.noTarget' };
      if (tgt.owner === u.owner || canTransit(r, u.owner, tgt.owner) || tgt.owner === 0) return { key: 'order.err.ownTarget' };
      if (!hostileTo(r, u.owner, tgt.owner)) return { key: 'order.err.atPeace', params: nameParam(tgt.owner) };
      if (u.type === UnitType.DroneSwarm && tgt.kind !== 'structure') return { key: 'order.err.droneStructure' };
      const far = outOfReach(tgt.x, tgt.y);
      if (far) return far;
      return escalationCheck(r, u.owner, tgt.owner, tgt.strategic, opts);
    }
    default:
      return { key: 'order.err.notForAircraft' };
  }
}

/** Military targets need L1 (the human reaches it with its first strike), strategic ones L2 (§5.10). */
function escalationCheck(r: RulesView, owner: number, enemy: number, strategic: boolean, opts: OrderOpts): OrderIssue | null {
  if (r.kindOf(enemy) === 'tribe') return null;
  const lv = r.escalation(owner, enemy);
  if (opts.ai) {
    if (lv < (strategic ? 2 : 1)) return { key: 'order.err.escalation', params: { level: strategic ? 2 : 1 } };
    return null;
  }
  if (strategic && lv < 2 && !opts.confirm) return { key: 'order.err.needsL2', confirm: true };
  return null;
}

export interface StrikeTarget {
  kind: 'structure' | 'division' | 'ship' | 'front';
  id: number;
  owner: number;
  x: number;
  y: number;
  strategic: boolean;
  structure: StructureType | -1;
}

/** What a strike at `tile` / `targetId` hits: a structure, a division or a ship, else the front sector. */
export function strikeTarget(r: RulesView, tile: number, targetId: number): StrikeTarget | null {
  if (targetId > 0) {
    const s = r.structure(targetId);
    if (s) return { kind: 'structure', id: s.id, owner: s.owner, x: tileCx(s.tile), y: tileCy(s.tile), strategic: STRATEGIC_STRUCTURES.has(s.type), structure: s.type };
    const t = r.unit(targetId);
    if (t && (t.type === UnitType.ArmoredDivision || t.type === UnitType.Warship || t.type === UnitType.TransportShip)) {
      return { kind: t.type === UnitType.ArmoredDivision ? 'division' : 'ship', id: t.id, owner: t.owner, x: t.x, y: t.y, strategic: false, structure: -1 };
    }
  }
  if (tile < 0 || tile >= TILE_COUNT) return null;
  const s = r.structureAt(tile);
  if (s) return { kind: 'structure', id: s.id, owner: s.owner, x: tileCx(s.tile), y: tileCy(s.tile), strategic: STRATEGIC_STRUCTURES.has(s.type), structure: s.type };
  if (!r.playable(tile)) return null;
  const o = r.ownerOf(tile);
  return { kind: 'front', id: 0, owner: o, x: tileCx(tile), y: tileCy(tile), strategic: false, structure: -1 };
}

// =================================================================================================
// Right-click context (§7.3)
// =================================================================================================

/**
 * The order a right click gives `unitId` over `tile`, with `targetUnit` / `targetStructure` under the cursor (-1 =
 * none). Shift turns a warship move into a patrol. Returns the order and its target id; null when nothing fits (the
 * chip then shows the reason of the most natural order, see naturalOrder).
 */
export function inferOrder(r: RulesView, unitId: number, tile: number, targetUnit: number, targetStructure: number, shift = false): { order: UnitOrderKind; targetId: number } {
  const u = r.unit(unitId);
  if (!u) return { order: 'move', targetId: 0 };
  const tu = targetUnit > 0 ? r.unit(targetUnit) : null;
  const ts = targetStructure > 0 ? r.structure(targetStructure) : null;
  const o = tile >= 0 && tile < TILE_COUNT ? r.ownerOf(tile) : 0;
  const land = tile >= 0 && tile < TILE_COUNT && r.playable(tile);
  switch (u.type) {
    case UnitType.ArmoredDivision: {
      if (ts && ts.owner === u.owner && ts.type === StructureType.ArmyBase) return { order: 'return', targetId: ts.id };
      if (land && o > 0 && o !== u.owner && !canTransit(r, u.owner, o) && hostileTo(r, u.owner, o)) {
        return { order: nearFrontLine(r, u.owner, tile) ? 'attach' : 'attack', targetId: 0 };
      }
      return { order: 'move', targetId: 0 };
    }
    case UnitType.Warship: {
      if (tu && tu.owner !== u.owner && (tu.type === UnitType.Warship || tu.type === UnitType.TransportShip || tu.type === UnitType.TradeShip) && hostileTo(r, u.owner, tu.owner)) {
        return { order: 'attack', targetId: tu.id };
      }
      if (tu && tu.owner === u.owner && tu.type === UnitType.TransportShip) return { order: 'escort', targetId: tu.id };
      if (ts && ts.owner === u.owner && (ts.type === StructureType.NavalYard || ts.type === StructureType.Port)) return { order: 'return', targetId: ts.id };
      if (land) return { order: 'bombard', targetId: 0 };
      if (shift) return { order: 'patrol', targetId: 0 };
      // Water near the coast of a nation at war: blockade.
      if (tile >= 0 && orderError(r, unitId, 'blockade', tile, 0) === null) return { order: 'blockade', targetId: 0 };
      return { order: 'move', targetId: 0 };
    }
    case UnitType.FighterSquadron: {
      if (tu && isAircraft(tu.type) && tu.owner !== u.owner && hostileTo(r, u.owner, tu.owner)) return { order: 'intercept', targetId: tu.id };
      if (tu && tu.owner === u.owner && (tu.type === UnitType.Bomber || tu.type === UnitType.DroneSwarm)) return { order: 'escort', targetId: tu.id };
      if (ts && ts.owner === u.owner && ts.type === StructureType.Airbase) return { order: ts.id === u.home ? 'return' : 'rebase', targetId: ts.id };
      return { order: 'cap', targetId: 0 };
    }
    case UnitType.Bomber:
    case UnitType.DroneSwarm: {
      if (ts && ts.owner === u.owner && ts.type === StructureType.Airbase) return { order: ts.id === u.home ? 'return' : 'rebase', targetId: ts.id };
      if (u.type === UnitType.DroneSwarm && !ts && !(tu && tu.owner !== u.owner)) {
        // Over a front: support; over a structure: strike.
        if (land && orderError(r, unitId, 'support', tile, 0) === null) return { order: 'support', targetId: 0 };
        if (land && r.structureAt(tile)) return { order: 'strike', targetId: 0 };
        return { order: 'support', targetId: 0 };
      }
      const id = ts ? ts.id : tu && tu.owner !== u.owner ? tu.id : 0;
      return { order: 'strike', targetId: id };
    }
    default:
      return { order: 'move', targetId: 0 };
  }
}

// =================================================================================================
// Offensive prediction (§7.7) and the advance rule (§4.3, §4.5)
// =================================================================================================

/** Plains depth speed of a front at force ratio R (§4.5). */
export function advanceKmh(ratio: number): number {
  return ADVANCE_MAX_KMH * Math.min(1, Math.max(0, (ratio - 1) / (ADVANCE_FULL_RATIO - 1)));
}

/** Corridor width in tiles bought by `committed` troops (§4.3). */
export function frontageTiles(committed: number, neutral = false): number {
  const per = neutral ? NEUTRAL_TROOPS_PER_FRONT_TILE : TROOPS_PER_FRONT_TILE;
  return Math.min(FRONTAGE_MAX, Math.max(FRONTAGE_MIN, committed / per));
}

export interface OffensivePrediction {
  ratio: number;
  advanceKmh: number;
  frontageTiles: number;
  /** Ticks until the offensive pushes (mobilization + contact phase). */
  startsInTicks: number;
  /** The defender's garrison facing it (troops). */
  garrison: number;
}

/**
 * What a left click will launch (§7.7): force ratio against the garrison of the front nearest to `tile`, plains
 * speed, corridor width and when it starts. Attached divisions and support are shown by the front badge, not here.
 */
export function predictOffensive(r: RulesView, attacker: number, defender: number, troops: number, tile: number): OffensivePrediction {
  if (defender <= 0) {
    return { ratio: 0, advanceKmh: NEUTRAL_ADVANCE_KMH, frontageTiles: frontageTiles(troops, true), startsInTicks: OFFENSIVE_CONTACT_TICKS, garrison: 0 };
  }
  let garrison = -1, best = Infinity;
  const tx = tileCx(tile), ty = tileCy(tile);
  for (const f of r.frontsOf(defender)) {
    if (!((f.a === attacker && f.b === defender) || (f.b === attacker && f.a === defender))) continue;
    const d = tileKm(tx, ty, f.x, f.y);
    if (d < best) {
      best = d;
      garrison = f.a === defender ? f.garrisonA : f.garrisonB;
    }
  }
  if (garrison < 0) garrison = r.homeTroops(defender) * (1 - DEFENSE_REAR_SHARE) * 0.5;
  const ratio = troops / Math.max(1, garrison);
  const mob = Math.max(0, r.mobilizeUntil(attacker, defender) - r.tick);
  return { ratio, advanceKmh: advanceKmh(ratio), frontageTiles: frontageTiles(troops), startsInTicks: mob + OFFENSIVE_CONTACT_TICKS, garrison };
}

// =================================================================================================
// Division routes: road or rail (§2.3, §6.2)
// =================================================================================================

export const ROAD_KMH = UNIT_DEFS[UnitType.ArmoredDivision].speedKmh;

export interface StationLike {
  id: number;
  owner: number;
  x: number;
  y: number;
}

export interface DivisionRoute {
  rail: boolean;
  /** Total km and hours (road legs at 40 km/h, rail at 100 km/h). */
  km: number;
  hours: number;
  /** Station ids of the rail leg (empty for a road march). */
  stations: number[];
}

/**
 * Road or rail from (fx, fy) to (tx, ty): the division drives to the nearest station of its network, takes the train
 * to the station nearest to the destination and drives the rest, when that is faster than the road march by more than
 * 15 % and a rail slot is free (one division per Factory level at a time). Road legs are measured great-circle.
 */
export function divisionRoute(stations: readonly StationLike[], links: Int32Array, canUse: (owner: number) => boolean,
  fx: number, fy: number, tx: number, ty: number, slotFree: boolean): DivisionRoute {
  const roadKm = tileKm(fx, fy, tx, ty);
  const road: DivisionRoute = { rail: false, km: roadKm, hours: roadKm / ROAD_KMH, stations: [] };
  if (!slotFree || stations.length < 2 || links.length < 2 || roadKm < 150) return road;
  const byId = new Map<number, StationLike>();
  for (const s of stations) if (canUse(s.owner)) byId.set(s.id, s);
  if (byId.size < 2) return road;
  let s0: StationLike | null = null, s1: StationLike | null = null, d0 = Infinity, d1 = Infinity;
  for (const s of byId.values()) {
    const a = tileKm(fx, fy, s.x, s.y), b = tileKm(tx, ty, s.x, s.y);
    if (a < d0) { d0 = a; s0 = s; }
    if (b < d1) { d1 = b; s1 = s; }
  }
  if (!s0 || !s1 || s0 === s1) return road;
  // Dijkstra over the rail links (small graphs: a nation has tens of stations).
  const adj = new Map<number, number[]>();
  for (let i = 0; i + 1 < links.length; i += 2) {
    const a = links[i], b = links[i + 1];
    if (!byId.has(a) || !byId.has(b)) continue;
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const dist = new Map<number, number>([[s0.id, 0]]);
  const prev = new Map<number, number>();
  const open = new Set<number>([s0.id]);
  while (open.size) {
    let cur = -1, cd = Infinity;
    for (const id of open) {
      const d = dist.get(id)!;
      if (d < cd) { cd = d; cur = id; }
    }
    open.delete(cur);
    if (cur === s1.id) break;
    const cs = byId.get(cur)!;
    for (const n of adj.get(cur) ?? []) {
      const ns = byId.get(n)!;
      const nd = cd + tileKm(cs.x, cs.y, ns.x, ns.y);
      if (nd < (dist.get(n) ?? Infinity)) {
        dist.set(n, nd);
        prev.set(n, cur);
        open.add(n);
      }
    }
  }
  const railKm = dist.get(s1.id);
  if (railKm === undefined) return road;
  const hours = (d0 + d1) / ROAD_KMH + railKm / ARMOR_RAIL_KMH;
  if (hours > road.hours * 0.85) return road;
  const path: number[] = [];
  for (let k: number | undefined = s1.id; k !== undefined; k = prev.get(k)) path.push(k);
  path.reverse();
  return { rail: true, km: d0 + railKm + d1, hours, stations: path };
}

/** Rail slots of an owner: one division per operational Factory level (§6.2). */
export function railSlots(r: RulesView, owner: number): number {
  let n = 0;
  for (const s of r.structuresOf(owner)) if (s.type === StructureType.Factory && s.built >= 1) n += structureLevel(s.type, s.level).railSlots ?? 0;
  return n;
}

/** Divisions of `owner` on a train right now. */
export function railUsed(r: RulesView, owner: number): number {
  let n = 0;
  for (const u of r.unitsOf(owner)) if (u.type === UnitType.ArmoredDivision && u.mode === UnitMode.Rail) n++;
  return n;
}

/** Stations (cities, ports, factories) a division may use: operational, own or allied. */
export function railStations(r: RulesView, owner: number, into: StationLike[]): StationLike[] {
  into.length = 0;
  const seen = new Set<number>();
  const links = r.railLinks();
  for (let i = 0; i < links.length; i++) {
    const id = links[i];
    if (seen.has(id)) continue;
    seen.add(id);
    const s = r.structure(id);
    if (!s || s.built < 1) continue;
    if (!canTransit(r, owner, s.owner)) continue;
    into.push({ id: s.id, owner: s.owner, x: tileCx(s.tile), y: tileCy(s.tile) });
  }
  return into;
}

/** The division's route to `tile` as the sim will plan it (the chip says «por ferrocarril»). */
export function planDivision(r: RulesView, u: UnitLike, tile: number, scratch: StationLike[] = []): DivisionRoute {
  const stations = railStations(r, u.owner, scratch);
  const free = railUsed(r, u.owner) < railSlots(r, u.owner);
  return divisionRoute(stations, r.railLinks(), (o) => canTransit(r, u.owner, o), u.x, u.y, tileCx(tile), tileCy(tile), free);
}

/** Radii of the effect rings drawn for a selected unit (tiles): CAP circle, blockade/engagement zone, bombard reach. */
export const EFFECT_TILES = {
  cap: CAP_RADIUS_TILES,
  engage: WARSHIP_ENGAGE_TILES,
  bombard: WARSHIP_BOMBARD_TILES,
  attach: DIVISION_ATTACH_TILES,
  support: DRONE_SUPPORT_TILES,
} as const;

/** Every level table is non-empty (guards the UI against a missing type). */
export function levelsOf(type: StructureType): number {
  return STRUCTURE_LEVELS[type].length - 1;
}

// =================================================================================================
// Land components (static: from the terrain)
// =================================================================================================

const compCache = new WeakMap<Uint8Array, Int32Array>();

/** Land component per tile (4-neighbourhood, horizontal wrap), -1 for water and ice. Cached per terrain array. */
export function landComponents(terrain: Uint8Array, playable: (t: number) => boolean): Int32Array {
  let c = compCache.get(terrain);
  if (c) return c;
  c = new Int32Array(TILE_COUNT).fill(-1);
  const stack = new Int32Array(TILE_COUNT);
  let id = 0;
  for (let s = 0; s < TILE_COUNT; s++) {
    if (c[s] !== -1 || !playable(s)) continue;
    let sp = 0;
    stack[sp++] = s;
    c[s] = id;
    while (sp > 0) {
      const t = stack[--sp];
      const x = t % MAP_W;
      const l = x === 0 ? t + MAP_W - 1 : t - 1;
      const rr = x === MAP_W - 1 ? t - MAP_W + 1 : t + 1;
      if (c[l] === -1 && playable(l)) { c[l] = id; stack[sp++] = l; }
      if (c[rr] === -1 && playable(rr)) { c[rr] = id; stack[sp++] = rr; }
      if (t >= MAP_W && c[t - MAP_W] === -1 && playable(t - MAP_W)) { c[t - MAP_W] = id; stack[sp++] = t - MAP_W; }
      if (t < TILE_COUNT - MAP_W && c[t + MAP_W] === -1 && playable(t + MAP_W)) { c[t + MAP_W] = id; stack[sp++] = t + MAP_W; }
    }
    id++;
  }
  compCache.set(terrain, c);
  return c;
}
