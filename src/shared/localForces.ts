// FRONT ULTRA — shared local forces (DESIGN_V2 §9.6, §11.5, §14.11). Owner: shared (landed by W6, consumed by W5).
//
// ONE derivation for every close view. The ground battle layer (render/battle) and command mode (src/command) both ask
// this module what is really at a place: who owns and contests it, where the front line runs and which way it moves,
// how many troops each side has there, and which real divisions, ships, aircraft and structures stand around it. It
// reads the simulation state the client already mirrors (GameView: tile owners, fronts with their garrisons and
// polylines, offensives, units, structures, pair states and treaties) and invents nothing: an empty result is a
// peaceful place.
//
// Pure and deterministic for a given view (no three.js, no DOM, no i18n, no randomness): worker-safe and unit-tested
// with a fixture view (src/shared/test/localForces.test.ts). Text for `LocalForceSide.source` lives in
// src/shared/localForcesText.ts.
//
// Scale (ARCHITECTURE §15): 1 local soldier = 25 strategic troops; a division = 1 tank per 25 % integrity + 2 IFVs;
// a squadron = 1 jet per third of integrity.
//
// Infantry pools per side (§14.11), in soldiers:
//   front      Gf × (window along the front / front length) / 25, where the window is the length of the front's
//              sub-tile line inside the view circle widened by FRONT_BAND_KM (troops stand up to 8 km behind the line);
//   offensive  troops still in the offensive × (window inside its corridor / corridor width) / 25;
//   rear       DEFENSE_REAR_SHARE × home troops / tiles × viewed tiles / 25 (the rear share really is spread over all
//              the nation's land, so it adds to the front pools without double counting);
//   posts      6 soldiers (and 1 AT team) per built defense post within 25 km.
//
// Coordinates: continuous tile coords (x east, y south, x wraps) like the sim; every entity also carries lat/lon and
// local east/north km from the anchor (equirectangular around the anchor latitude, accurate to < 1 % within 150 km).
// Headings are compass radians (0 north, PI/2 east), the UnitView convention.

import {
  CAP_RADIUS_TILES, DEFENSE_REAR_SHARE, MAP_H, MAP_W, STRUCTURE_LEVELS, TILE_KM,
} from './constants';
import { tileXYToLatLon, latLonToTileXY } from './geo';
import { isNavigableTerrain, isWaterTerrain } from './terrain';
import {
  StructureType, UnitMode, UnitState, UnitType,
  type AttackView, type FrontLine, type FrontView, type PairState, type PlayerView, type StructureView, type TreatyKind, type UnitView,
} from './types';

// =================================================================================================
// Numbers (§9.6, §14.11)
// =================================================================================================

/** 1 local soldier = this many strategic troops (ARCHITECTURE §15). */
export const TROOPS_PER_SOLDIER = 25;
/** A front's garrison stands within this distance of its line: the front window is the line inside radius + band. */
export const FRONT_BAND_KM = 8;
/** Defense posts within this distance add their garrison to the owner's pool. */
export const POST_POOL_KM = 25;
export const SOLDIERS_PER_POST = 6;
export const AT_TEAMS_PER_POST = 1;
/** Readability clamp of visibleSplit() when two sides have troops (§11.5). */
export const SPLIT_MIN = 0.2;
export const SPLIT_MAX = 0.8;

// =================================================================================================
// The view it reads (a structural subset of GameView, so ctx.sim.view passes as is and a test builds a fixture)
// =================================================================================================

export type LocalForcesPlayer = Pick<PlayerView, 'id' | 'troops' | 'tiles' | 'alive'>;
export type LocalForcesUnit = Pick<UnitView,
  'id' | 'type' | 'owner' | 'x' | 'y' | 'prevX' | 'prevY' | 'heading' | 'hp' | 'state' | 'mode' | 'frontKey' | 'targetX'
  | 'targetY' | 'alt' | 'home' | 'serial'>;
export type LocalForcesStructure = Pick<StructureView, 'id' | 'type' | 'owner' | 'tile' | 'level' | 'hp' | 'built'>;
export type LocalForcesFront = Pick<FrontView,
  'key' | 'a' | 'b' | 'x' | 'y' | 'length' | 'dirX' | 'dirY' | 'samples' | 'progress' | 'line' | 'garrisonA' | 'garrisonB'
  | 'momentum' | 'advanceKmh' | 'intensity' | 'quiet' | 'offensiveA' | 'offensiveB'>;
export type LocalForcesAttack = Pick<AttackView,
  'id' | 'attacker' | 'defender' | 'troops' | 'x' | 'y' | 'originX' | 'originY' | 'frontKey' | 'frontageTiles' | 'state'
  | 'naval' | 'advanceKmh'> & Partial<Pick<AttackView, 'contactX' | 'contactY'>>;

export interface LocalForcesView {
  readonly tick: number;
  /** Terrain bytes (TerrainClass | TerrainFlag) per tile; null = treat unowned tiles as land. */
  readonly world: { readonly terrain: ArrayLike<number> } | null;
  readonly owner: ArrayLike<number>;
  readonly players: ReadonlyArray<LocalForcesPlayer | undefined>;
  readonly units: ReadonlyMap<number, LocalForcesUnit>;
  readonly structures: ReadonlyMap<number, LocalForcesStructure>;
  readonly attacks: readonly LocalForcesAttack[];
  readonly fronts: readonly LocalForcesFront[];
  pairState(a: number, b: number): PairState;
  hasTreaty(a: number, b: number, kind: TreatyKind): boolean;
  isOccupied(tile: number): boolean;
}

// =================================================================================================
// Result
// =================================================================================================

/** How a place or a side stands toward the viewer. */
export type LocalRelation = 'own' | 'allied' | 'peace' | 'truce' | 'war' | 'unclaimed';

export interface LocalPos {
  x: number;
  y: number;
  lat: number;
  lon: number;
  /** Offset from the anchor, km (east, north) and straight-line distance. */
  eastKm: number;
  northKm: number;
  distKm: number;
}

export interface LocalDivision {
  unitId: number;
  owner: number;
  /** 1 per 25 % integrity (at least 1 while the division lives). */
  tanks: number;
  ifvs: number;
  x: number;
  y: number;
  heading: number;
}

export interface LocalUnit extends LocalPos {
  unitId: number;
  type: UnitType;
  owner: number;
  heading: number;
  /** 0..1 */
  integrity: number;
  /** UnitMode and UnitState as the sim publishes them. */
  mode: number;
  state: number;
  frontKey: number;
  serial: number;
  /** Aircraft in the air (not docked or rearming); surface units false. */
  airborne: boolean;
  /** Local representation: tanks/IFVs for a division, jets for a squadron, 0 otherwise. */
  tanks: number;
  ifvs: number;
  jets: number;
  /** Why it is in the list: inside the radius, or (fighters) its air patrol covers the anchor. */
  reason: 'near' | 'cap';
}

export interface LocalStructure extends LocalPos {
  structureId: number;
  type: StructureType;
  owner: number;
  level: number;
  /** 0..1 */
  integrity: number;
  /** 0..1 construction progress (1 = operational). */
  built: number;
  /** Reach of its effect at this level, km (SAM range, defense-post zone, radar coverage, airbase scramble), 0 = n/a. */
  rangeKm: number;
  /** The anchor lies inside that reach. */
  coversAnchor: boolean;
}

export interface LocalFront {
  key: number;
  /** Side a pushes toward side b (the sim's convention; dir points from a into b). */
  a: number;
  b: number;
  quiet: boolean;
  intensity: number;
  momentum: number;
  advanceKmh: number;
  /** Front length (km) and the part of it inside the window (radius + FRONT_BAND_KM). */
  lengthKm: number;
  windowKm: number;
  /** Nearest point of the sub-tile contact line to the anchor. */
  nearest: LocalPos;
  /** Compass bearings (radians): the direction side a advances (a → b), and the line's run at the nearest point. */
  advanceBearing: number;
  lineBearing: number;
  /** Side of the line the anchor is on (a or b), from the line geometry. */
  anchorSide: number;
  /** The contact line at sub-tile precision in local km [e0, n0, e1, n1, ...] (vertices within 3 × radius). */
  lineKm: number[];
  /** Whether the line is at sub-tile precision here: the published depth line (T41) or per-vertex pressure progress. */
  subTile: boolean;
  /**
   * T41: the published contact line (FrontView.line) when this point lies within its window: the line's signed offset
   * from the point along its axis (km, + = the line lies ahead of the point in side a's advance), the axis bearing, and
   * its speed (km per game hour, signed along the axis). Inside the window `lineKm` and `nearest` follow this line.
   */
  line: { offsetKm: number; bearing: number; kmh: number; focus: boolean; tick: number } | null;
  /** Garrisons Gf of each side on the whole front (troops) and per km of front. */
  garrisonA: number;
  garrisonB: number;
  troopsPerKmA: number;
  troopsPerKmB: number;
}

export interface LocalPools {
  front: number;
  offensive: number;
  rear: number;
  posts: number;
}

export interface LocalForceSide {
  owner: number;
  relation: LocalRelation;
  /** Pair state with the viewer (own side: 'peace'). */
  pairState: PairState;
  /** Soldiers (1 = 25 troops): front + offensive + rear + posts pools. */
  infantry: number;
  /** Breakdown of `infantry`, soldiers. */
  pools: LocalPools;
  /** AT teams from defense posts. */
  atTeams: number;
  /** Strategic troops those soldiers stand for, and their density over the view area (troops per km²). */
  troops: number;
  troopsPerKm2: number;
  /** Share of the view's land this side owns (0..1). */
  landShare: number;
  divisions: LocalDivision[];
  /** Squadrons patrolling over the anchor or flying inside the radius, drones supporting a local front. */
  aircraft: { unitId: number; jets: number }[];
  ships: number[];
  sams: number[];
  posts: number[];
  /** i18n key + params for «Guarnición del frente · 1.840 tropas en la zona» (src/shared/localForcesText.ts). */
  source: string;
  sourceParams: Record<string, string | number>;
}

export interface LocalPoint {
  tile: number;
  /** Tile owner (0 = unclaimed land or open sea). */
  owner: number;
  water: boolean;
  /** Water connected to the world ocean. */
  navigable: boolean;
  /** For water next to a coast: the coast's owner (territorial waters, §9.7); 0 = open sea. */
  coastOwner: number;
  /** Captured less than 72 h ago (§4.13). */
  occupied: boolean;
  /** Whose ground (or territorial water) this is, seen by the viewer. */
  relation: LocalRelation;
  /** 'land' | 'territorial' water | open 'sea'. */
  kind: 'land' | 'territorial' | 'sea';
  /** Entering it with a unit is an incursion (§9.7): foreign, not at war, no alliance or open borders. */
  incursion: boolean;
}

export interface LocalForces {
  x: number;
  y: number;
  lat: number;
  lon: number;
  radiusKm: number;
  viewer: number;
  tick: number;
  point: LocalPoint;
  /** Owners of the land inside the circle with their share of it, largest first (water share separate). */
  owners: { owner: number; share: number; relation: LocalRelation }[];
  waterShare: number;
  /** Nearest front in the window (0 = none) and every front with a part in the window, nearest first. */
  frontKey: number;
  fronts: LocalFront[];
  /** Every side with something here: land, troops, units or structures. The viewer's side first, then by infantry. */
  sides: LocalForceSide[];
  units: LocalUnit[];
  structures: LocalStructure[];
  /** Pair states among every player involved (including the viewer), each pair once with a < b. */
  pairs: { a: number; b: number; state: PairState; alliance: boolean; openBorders: boolean }[];
  /** Nobody here is at war with anybody else here (no hostile pools). */
  peaceful: boolean;
}

export interface LocalForcesOptions {
  /** Interpolate unit positions between the previous and latest update (FrameInfo.simAlpha); default 1 = latest. */
  alpha?: number;
}

// =================================================================================================
// Geometry helpers
// =================================================================================================

const DEG = Math.PI / 180;

function wdx(ax: number, bx: number): number {
  let d = bx - ax;
  if (d > MAP_W / 2) d -= MAP_W;
  else if (d < -MAP_W / 2) d += MAP_W;
  return d;
}

function wrapXf(x: number): number {
  return ((x % MAP_W) + MAP_W) % MAP_W;
}

function tileAt(x: number, y: number): number {
  const ty = Math.max(0, Math.min(MAP_H - 1, Math.floor(y)));
  return ty * MAP_W + (Math.floor(wrapXf(x)) % MAP_W);
}

/** Compass bearing (radians, 0 north, clockwise) of a vector given in km east / north. */
function bearing(e: number, n: number): number {
  const b = Math.atan2(e, n);
  return b < 0 ? b + 2 * Math.PI : b;
}

/**
 * Depth (km) of a published line at a tick: the line moves by exactly kmh / 10 km per tick, so a reading carries to the
 * ticks after it (at most the interval between readings: 1 tick at the observation focus, 5 on the offensive's axis).
 */
export function publishedDepthAt(line: FrontLine, tick: number): number {
  const dt = Math.max(-2, Math.min(line.focus ? 1.5 : 6, tick - line.tick));
  return line.depthKm + (line.kmh / 10) * dt;
}

/**
 * Where a front's published line (FrontView.line, T41) lies seen from the point (x, y) (continuous tile coords): its
 * signed offset along the line's axis (km, + = ahead of the point in side a's advance), the point's distance along the
 * line from the line's reference point (km; the line applies within ±halfKm), and the axis bearing.
 */
export function publishedLineOffset(line: FrontLine, x: number, y: number, atTick = line.tick): { offsetKm: number; alongKm: number; bearing: number } {
  const kmX = TILE_KM * Math.max(0.05, Math.cos(tileXYToLatLon(wrapXf(x), y).lat * DEG));
  const rE = wdx(x, line.x) * kmX, rN = (y - line.y) * TILE_KM;
  return {
    offsetKm: rE * line.e + rN * line.n + publishedDepthAt(line, atTick),
    alongKm: rE * line.n - rN * line.e,
    bearing: bearing(line.e, line.n),
  };
}

/** How far from its published line (km, across it) a front decides who holds the ground (W6 final): 1.5 tiles. */
export const HOLD_BAND_KM = 1.5 * TILE_KM;

/**
 * Who holds the ground at (x, y) (continuous tile coords) as every close view shows it — ONE source of truth for the
 * ground battle's drawn line, the command-mode HUD and local forces (W6 final fix pass). Near a front between two sides
 * at war, inside its published line's window (FrontView.line) and within HOLD_BAND_KM of that line, the side of the
 * line the point is on: the sub-tile line the battle draws, which runs inside the tile being taken, so a tank standing
 * behind our drawn line is on our ground even while the sim still counts that 25 km tile as the enemy's. Elsewhere,
 * and wherever the tile is a third party's, the tile's owner. Only the viewer's own fronts (the sides of a front it does
 * not fight on keep their tile owners, so an incursion is always named after the nation the sim names).
 */
export function holderAt(view: Pick<LocalForcesView, 'owner' | 'fronts' | 'tick'>, x: number, y: number, viewer: number, fronts: readonly LocalForcesFront[] = view.fronts): number {
  const o = view.owner[tileAt(x, y)] ?? 0;
  if (o === 0) return 0;
  let best = o, bestAbs = Infinity;
  for (const f of fronts) {
    const L = f.line;
    if (!L || (o !== f.a && o !== f.b) || f.b === 0 || (f.a !== viewer && f.b !== viewer)) continue;
    const po = publishedLineOffset(L, x, y, view.tick);
    if (Math.abs(po.alongKm) > L.halfKm || Math.abs(po.offsetKm) > HOLD_BAND_KM) continue;
    if (Math.abs(po.offsetKm) >= bestAbs) continue;
    bestAbs = Math.abs(po.offsetKm);
    // offsetKm > 0: the line lies ahead of the point along its axis (toward side b), so the point is on side a's ground.
    best = po.offsetKm > 0 ? f.a : f.b;
  }
  return best;
}

/** Parameter interval [t0, t1] ⊂ [0, 1] of segment p0 + t·d inside the circle of radius r at the origin, or null. */
function clipCircle(px: number, py: number, dx: number, dy: number, r: number): [number, number] | null {
  const a = dx * dx + dy * dy;
  const b = 2 * (px * dx + py * dy);
  const c = px * px + py * py - r * r;
  if (a < 1e-12) return c <= 0 ? [0, 1] : null;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return null;
  const s = Math.sqrt(disc);
  const t0 = Math.max(0, (-b - s) / (2 * a)), t1 = Math.min(1, (-b + s) / (2 * a));
  return t1 > t0 ? [t0, t1] : null;
}

// =================================================================================================
// The derivation
// =================================================================================================

/** Local forces at (lat, lon): the same as deriveLocalForces at the tile coords of that point. */
export function deriveLocalForcesAt(
  view: LocalForcesView, lat: number, lon: number, radiusKm: number, viewer: number, opts?: LocalForcesOptions,
): LocalForces {
  const p = latLonToTileXY(lat, lon);
  return deriveLocalForces(view, p.x, p.y, radiusKm, viewer, opts);
}

/**
 * Everything the simulation really has within `radiusKm` of (x, y) (continuous tile coords), seen by `viewer`.
 * Pure: the same view gives the same result.
 */
export function deriveLocalForces(
  view: LocalForcesView, x: number, y: number, radiusKm: number, viewer: number, opts?: LocalForcesOptions,
): LocalForces {
  x = wrapXf(x);
  y = Math.max(0, Math.min(MAP_H - 1e-6, y));
  const R = Math.max(0.1, radiusKm);
  const alpha = opts?.alpha ?? 1;
  const ll = tileXYToLatLon(x, y);
  const cosLat = Math.max(0.05, Math.cos(ll.lat * DEG));
  const kmX = TILE_KM * cosLat; // km per tile eastward at the anchor latitude
  const kmY = TILE_KM; // km per tile southward
  const terrain = view.world?.terrain ?? null;
  const ownerOf = (t: number): number => view.owner[t] ?? 0;
  const isWater = (t: number): boolean => (terrain ? isWaterTerrain(terrain[t]) : false);

  const pos = (px: number, py: number): LocalPos => {
    const e = wdx(x, px) * kmX, n = (y - py) * kmY;
    const g = tileXYToLatLon(wrapXf(px), py);
    return { x: wrapXf(px), y: py, lat: g.lat, lon: g.lon, eastKm: e, northKm: n, distKm: Math.hypot(e, n) };
  };

  // --- relations ---------------------------------------------------------------------------------
  const relationOf = (o: number): LocalRelation => {
    if (o === 0) return 'unclaimed';
    if (o === viewer) return 'own';
    if (view.hasTreaty(viewer, o, 'alliance')) return 'allied';
    const s = view.pairState(viewer, o);
    return s === 'war' ? 'war' : s === 'truce' ? 'truce' : 'peace';
  };

  // --- the point itself ----------------------------------------------------------------------------
  const tile = tileAt(x, y);
  // Fronts whose published line reaches this view: near them the drawn line decides who holds the ground (holderAt).
  const lineFronts = view.fronts.filter((f) => !!f.line && (f.a === viewer || f.b === viewer) && Math.hypot(wdx(x, f.line.x) * kmX, (y - f.line.y) * kmY) <= R + f.line.halfKm + 120);
  const holder = (px: number, py: number, t: number): number => (lineFronts.length ? holderAt(view, px, py, viewer, lineFronts) : ownerOf(t));
  const pWater = isWater(tile);
  const pOwner = pWater ? ownerOf(tile) : holder(x, y, tile);
  let coastOwner = 0;
  if (pWater) {
    const tx = tile % MAP_W, ty = (tile / MAP_W) | 0;
    const nb = [tileAt(tx - 1 + 0.5, ty + 0.5), tileAt(tx + 1.5, ty + 0.5), tileAt(tx + 0.5, ty - 0.5), tileAt(tx + 0.5, ty + 1.5)];
    for (const q of nb) {
      if (!isWater(q) && ownerOf(q) !== 0) {
        coastOwner = ownerOf(q);
        break;
      }
    }
  }
  const groundOwner = pWater ? coastOwner : pOwner;
  const pRel = relationOf(groundOwner);
  const point: LocalPoint = {
    tile, owner: pOwner, water: pWater, navigable: terrain ? isNavigableTerrain(terrain[tile]) : false, coastOwner,
    occupied: view.isOccupied(tile), relation: pRel, kind: !pWater ? 'land' : coastOwner ? 'territorial' : 'sea',
    incursion: groundOwner !== 0 && groundOwner !== viewer && (pRel === 'peace' || pRel === 'truce')
      && !view.hasTreaty(viewer, groundOwner, 'openBorders'),
  };

  // --- ownership of the circle (sampled on a grid of points inside it) --------------------------------
  const land = new Map<number, number>();
  let samples = 0, water = 0;
  const N = 24;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const e = ((i + 0.5) / N * 2 - 1) * R, n = ((j + 0.5) / N * 2 - 1) * R;
      if (e * e + n * n > R * R) continue;
      samples++;
      const sx = x + e / kmX, sy = y - n / kmY;
      const t = tileAt(sx, sy);
      if (isWater(t)) {
        water++;
        continue;
      }
      const o = holder(sx, sy, t);
      land.set(o, (land.get(o) ?? 0) + 1);
    }
  }
  const areaKm2 = Math.PI * R * R;
  const tileAreaKm2 = kmX * kmY;
  const landShareOf = (o: number): number => (samples ? (land.get(o) ?? 0) / samples : 0);

  // --- sides ---------------------------------------------------------------------------------------
  const sides = new Map<number, LocalForceSide>();
  const side = (o: number): LocalForceSide => {
    let s = sides.get(o);
    if (!s) {
      s = {
        owner: o, relation: relationOf(o), pairState: o === viewer || o === 0 ? 'peace' : view.pairState(viewer, o),
        infantry: 0, pools: { front: 0, offensive: 0, rear: 0, posts: 0 }, atTeams: 0, troops: 0, troopsPerKm2: 0,
        landShare: landShareOf(o), divisions: [], aircraft: [], ships: [], sams: [], posts: [], source: 'lf.src.none',
        sourceParams: {},
      };
      sides.set(o, s);
    }
    return s;
  };
  for (const o of land.keys()) if (o !== 0) side(o);

  // --- fronts ----------------------------------------------------------------------------------------
  const Rw = R + FRONT_BAND_KM;
  const localFronts: LocalFront[] = [];
  const attacksByFront = new Map<number, LocalForcesAttack[]>();
  for (const a of view.attacks) {
    if (!a.frontKey || a.defender === 0) continue;
    let l = attacksByFront.get(a.frontKey);
    if (!l) attacksByFront.set(a.frontKey, (l = []));
    l.push(a);
  }
  for (const f of view.fronts) {
    if (f.b === 0) continue;
    const n = f.samples.length >> 1;
    if (n < 1) continue;
    // Quick reject: every vertex far away (fronts are at most 64 samples, 1.5 tiles apart).
    let near = false;
    const reach = (Rw + 60) / TILE_KM;
    for (let v = 0; v < n; v++) {
      const dx = wdx(x, f.samples[v * 2]), dy = f.samples[v * 2 + 1] - y;
      if (dx * dx * cosLat * cosLat + dy * dy <= reach * reach) {
        near = true;
        break;
      }
    }
    if (!near) continue;
    // Which offensive moves the line: side a's pushes it along dir, side b's counter-offensive pulls it back.
    const aPush = f.offensiveA !== 0, bPush = !aPush && f.offensiveB !== 0;
    const dirE = f.dirX * kmX, dirN = -f.dirY * kmY;
    // Sub-tile line in local km: samples are the centres of side a's contact tiles; the contact edge is half a tile
    // along dir, moved into the tile being taken by its pressure progress.
    const line: number[] = new Array(n * 2);
    for (let v = 0; v < n; v++) {
      const p = f.progress ? f.progress[v] / 255 : 0;
      const off = aPush ? 0.5 + p : bPush ? 0.5 - p : 0.5;
      const sx = f.samples[v * 2] + f.dirX * off, sy = f.samples[v * 2 + 1] + f.dirY * off;
      line[v * 2] = wdx(x, sx) * kmX;
      line[v * 2 + 1] = (y - sy) * kmY;
    }
    // T41: within the published line's window, the contact line IS that line (one smoothed depth, straight across
    // ±halfKm): the vertices there are moved onto it along its axis, so every consumer reads the same line.
    let lineRec: LocalFront['line'] = null;
    const fl = f.line;
    if (fl) {
      const rE = wdx(x, fl.x) * kmX, rN = (y - fl.y) * kmY;
      // The line as it is at the view's tick (readings come every tick at the focus, every 5 off it).
      const po = publishedLineOffset(fl, x, y, view.tick);
      if (Math.abs(po.alongKm) <= fl.halfKm + 10) {
        const dNow = publishedDepthAt(fl, view.tick);
        const pE = rE + dNow * fl.e, pN = rN + dNow * fl.n;
        lineRec = { offsetKm: po.offsetKm, bearing: po.bearing, kmh: fl.kmh, focus: fl.focus, tick: fl.tick };
        for (let v = 0; v < n; v++) {
          const u = (line[v * 2] - rE) * -fl.n + (line[v * 2 + 1] - rN) * fl.e;
          if (Math.abs(u) > fl.halfKm) continue;
          line[v * 2] = pE - u * fl.n;
          line[v * 2 + 1] = pN + u * fl.e;
        }
      }
    }
    // Nearest point and the window length inside the circle.
    let bestD = Infinity, bestE = line[0], bestN = line[1], bestSeg = 0, windowKm = 0;
    const segCount = Math.max(1, n - 1);
    for (let s = 0; s < segCount; s++) {
      const e0 = line[s * 2], n0 = line[s * 2 + 1];
      const e1 = n > 1 ? line[s * 2 + 2] : e0, n1 = n > 1 ? line[s * 2 + 3] : n0;
      const de = e1 - e0, dn = n1 - n0;
      const L2 = de * de + dn * dn;
      const t = L2 > 1e-9 ? Math.max(0, Math.min(1, -(e0 * de + n0 * dn) / L2)) : 0;
      const pe = e0 + de * t, pn = n0 + dn * t;
      const d = Math.hypot(pe, pn);
      if (d < bestD) {
        bestD = d;
        bestE = pe;
        bestN = pn;
        bestSeg = s;
      }
      const c = clipCircle(e0, n0, de, dn, Rw);
      if (c) windowKm += (c[1] - c[0]) * Math.sqrt(L2);
    }
    if (bestD > Rw) continue;
    const lengthKm = Math.max(TILE_KM, f.length * TILE_KM);
    const frac = Math.min(1, windowKm / lengthKm);
    // Line bearing along the nearest segment (perpendicular to the advance when the line has a single vertex).
    const s0 = bestSeg * 2;
    const le = n > 1 ? line[s0 + 2] - line[s0] : -dirN, ln = n > 1 ? line[s0 + 3] - line[s0 + 1] : dirE;
    // Side of the anchor: behind the line (against dir) is side a.
    const anchorSide = (-bestE) * dirE + (-bestN) * dirN < 0 ? f.a : f.b;
    const lineKm: number[] = [];
    for (let v = 0; v < n; v++) {
      if (Math.hypot(line[v * 2], line[v * 2 + 1]) <= 3 * R + TILE_KM) lineKm.push(line[v * 2], line[v * 2 + 1]);
    }
    const nearestPos = pos(x + bestE / kmX, y - bestN / kmY);
    localFronts.push({
      key: f.key, a: f.a, b: f.b, quiet: f.quiet, intensity: f.intensity, momentum: f.momentum, advanceKmh: f.advanceKmh,
      lengthKm, windowKm, nearest: nearestPos, advanceBearing: bearing(dirE, dirN), lineBearing: bearing(le, ln), anchorSide,
      lineKm, subTile: !!f.progress || !!lineRec, line: lineRec, garrisonA: f.garrisonA, garrisonB: f.garrisonB,
      troopsPerKmA: f.garrisonA / lengthKm, troopsPerKmB: f.garrisonB / lengthKm,
    });
    if (windowKm <= 0) continue;
    side(f.a).pools.front += (f.garrisonA * frac) / TROOPS_PER_SOLDIER;
    side(f.b).pools.front += (f.garrisonB * frac) / TROOPS_PER_SOLDIER;
    // Offensives on this front: troops × (window inside the corridor / corridor width).
    for (const at of attacksByFront.get(f.key) ?? []) {
      if (at.troops <= 0) continue;
      const corridorKm = Math.max(TILE_KM, at.frontageTiles * TILE_KM);
      // Corridor axis: the ray from the origin through the live contact (where it fights now), else through the axis
      // point (fallback: the front's advance direction through the axis point).
      const live = (at.contactX ?? -1) >= 0 && Math.hypot(wdx(at.originX, at.contactX!) * kmX, (at.originY - at.contactY!) * kmY) >= TILE_KM;
      const px = live ? at.contactX! : at.x, py = live ? at.contactY! : at.y;
      const ax = wdx(x, px) * kmX, an = (y - py) * kmY;
      let ue = wdx(at.originX, px) * kmX, un = (at.originY - py) * kmY;
      if (at.originX < 0 || Math.hypot(ue, un) < 1) {
        ue = at.attacker === f.a ? dirE : -dirE;
        un = at.attacker === f.a ? dirN : -dirN;
      }
      const ul = Math.hypot(ue, un) || 1;
      ue /= ul;
      un /= ul;
      let inCorr = 0;
      for (let s = 0; s < segCount; s++) {
        const e0 = line[s * 2], n0 = line[s * 2 + 1];
        const e1 = n > 1 ? line[s * 2 + 2] : e0, n1 = n > 1 ? line[s * 2 + 3] : n0;
        const de = e1 - e0, dn = n1 - n0;
        const c = clipCircle(e0, n0, de, dn, Rw);
        if (!c) continue;
        // Signed distance from the axis line: cross((p - axis), u) is linear in t.
        const c0 = (e0 - ax) * un - (n0 - an) * ue, c1 = de * un - dn * ue;
        let t0 = c[0], t1 = c[1];
        const h = corridorKm / 2;
        if (Math.abs(c1) < 1e-9) {
          if (Math.abs(c0) > h) continue;
        } else {
          let ta = (-h - c0) / c1, tb = (h - c0) / c1;
          if (ta > tb) [ta, tb] = [tb, ta];
          t0 = Math.max(t0, ta);
          t1 = Math.min(t1, tb);
        }
        if (t1 > t0) inCorr += (t1 - t0) * Math.hypot(de, dn);
      }
      if (inCorr > 0) side(at.attacker).pools.offensive += (at.troops * Math.min(1, inCorr / corridorKm)) / TROOPS_PER_SOLDIER;
    }
  }
  localFronts.sort((p, q) => p.nearest.distKm - q.nearest.distKm || p.key - q.key);

  // --- rear garrison over the viewed land ---------------------------------------------------------------
  for (const [o, cnt] of land) {
    if (o === 0) continue;
    const P = view.players[o];
    if (!P || !P.alive || P.tiles <= 0) continue;
    const viewedTiles = (cnt / Math.max(1, samples)) * areaKm2 / tileAreaKm2;
    side(o).pools.rear += (DEFENSE_REAR_SHARE * P.troops / P.tiles * viewedTiles) / TROOPS_PER_SOLDIER;
  }

  // --- structures --------------------------------------------------------------------------------------
  const structures: LocalStructure[] = [];
  const reachKm = (st: LocalForcesStructure): number => {
    const lv = STRUCTURE_LEVELS[st.type][Math.max(1, Math.min(STRUCTURE_LEVELS[st.type].length - 1, Math.floor(st.level)))];
    if (!lv) return 0;
    const tiles = st.type === StructureType.SamSite ? lv.rangeTiles
      : st.type === StructureType.DefensePost ? lv.radiusTiles
        : st.type === StructureType.Radar ? lv.coverageTiles
          : st.type === StructureType.Airbase ? lv.scrambleTiles : undefined;
    return (tiles ?? 0) * TILE_KM;
  };
  for (const st of view.structures.values()) {
    const sx = (st.tile % MAP_W) + 0.5, sy = ((st.tile / MAP_W) | 0) + 0.5;
    const e = wdx(x, sx) * kmX, nn = (y - sy) * kmY;
    const d = Math.hypot(e, nn);
    const range = reachKm(st);
    const covers = range > 0 && d <= range;
    const inPool = st.type === StructureType.DefensePost && d <= POST_POOL_KM;
    if (d > R && !covers && !inPool) continue;
    structures.push({
      ...pos(sx, sy), structureId: st.id, type: st.type, owner: st.owner, level: st.level, integrity: st.hp, built: st.built,
      rangeKm: range, coversAnchor: covers,
    });
    const sd = side(st.owner);
    if (st.type === StructureType.SamSite) sd.sams.push(st.id);
    if (st.type === StructureType.DefensePost) {
      sd.posts.push(st.id);
      if (inPool && st.built >= 1 && st.hp > 0) {
        sd.pools.posts += SOLDIERS_PER_POST;
        sd.atTeams += AT_TEAMS_PER_POST;
      }
    }
  }
  structures.sort((p, q) => p.distKm - q.distKm || p.structureId - q.structureId);

  // --- units ---------------------------------------------------------------------------------------------
  const units: LocalUnit[] = [];
  const localKeys = new Set(localFronts.filter((f) => f.windowKm > 0).map((f) => f.key));
  const capKm = CAP_RADIUS_TILES * TILE_KM;
  for (const u of view.units.values()) {
    if (u.state === UnitState.Destroyed) continue;
    const t = u.type;
    const surface = t === UnitType.ArmoredDivision || t === UnitType.Warship || t === UnitType.TransportShip
      || t === UnitType.TradeShip || t === UnitType.Train;
    const air = t === UnitType.FighterSquadron || t === UnitType.Bomber || t === UnitType.DroneSwarm;
    if (!surface && !air) continue; // missiles, shells and interceptors are events, not forces
    const ux = u.prevX + wdx(u.prevX, u.x) * alpha, uy = u.prevY + (u.y - u.prevY) * alpha;
    const p = pos(ux, uy);
    let reason: 'near' | 'cap' | null = p.distKm <= R ? 'near' : null;
    const airborne = air && u.mode !== UnitMode.Docked && u.mode !== UnitMode.Rearming && u.state !== UnitState.Docked;
    if (!reason && t === UnitType.FighterSquadron && airborne && u.mode === UnitMode.Patrol) {
      const ce = wdx(x, u.targetX) * kmX, cn = (y - u.targetY) * kmY;
      if (Math.hypot(ce, cn) <= capKm) reason = 'cap';
    }
    if (!reason && t === UnitType.DroneSwarm && airborne && u.frontKey && localKeys.has(u.frontKey)
      && (u.mode === UnitMode.Support || u.mode === UnitMode.Patrol)) reason = 'cap';
    if (!reason) continue;
    const hp = Math.max(0, Math.min(1, u.hp));
    const tanks = t === UnitType.ArmoredDivision ? Math.max(1, Math.ceil(hp * 4 - 1e-6)) : 0;
    const ifvs = t === UnitType.ArmoredDivision ? 2 : 0;
    const jets = air ? Math.max(1, Math.ceil(hp * 3 - 1e-6)) : 0;
    units.push({
      ...p, unitId: u.id, type: t, owner: u.owner, heading: u.heading, integrity: hp, mode: u.mode, state: u.state,
      frontKey: u.frontKey, serial: u.serial, airborne, tanks, ifvs, jets, reason,
    });
    const sd = side(u.owner);
    if (t === UnitType.ArmoredDivision) sd.divisions.push({ unitId: u.id, owner: u.owner, tanks, ifvs, x: p.x, y: p.y, heading: u.heading });
    else if (t === UnitType.Warship) sd.ships.push(u.id);
    else if (air && airborne) sd.aircraft.push({ unitId: u.id, jets });
  }
  units.sort((p, q) => p.distKm - q.distKm || p.unitId - q.unitId);

  // --- totals and source ----------------------------------------------------------------------------------
  for (const s of sides.values()) {
    const P = s.pools;
    P.front = round1(P.front);
    P.offensive = round1(P.offensive);
    P.rear = round1(P.rear);
    s.infantry = round1(P.front + P.offensive + P.rear + P.posts);
    s.troops = Math.round(s.infantry * TROOPS_PER_SOLDIER);
    s.troopsPerKm2 = s.troops / areaKm2;
    const main = P.offensive > 0 && P.offensive >= P.front ? 'offensive'
      : P.front > 0 ? 'front' : P.posts > P.rear ? 'posts' : P.rear > 0 ? 'rear' : 'none';
    s.source = `lf.src.${main}`;
    s.sourceParams = { troops: s.troops, soldiers: Math.round(s.infantry), frontKey: localFronts[0]?.key ?? 0 };
  }
  sides.delete(0);

  const order = [...sides.values()].sort((p, q) =>
    (p.owner === viewer ? -1 : 0) - (q.owner === viewer ? -1 : 0) || q.infantry - p.infantry || p.owner - q.owner);

  // --- pairs among the involved players ------------------------------------------------------------------
  const involved = new Set<number>([viewer, ...sides.keys()]);
  if (groundOwner) involved.add(groundOwner);
  involved.delete(0);
  const ids = [...involved].sort((p, q) => p - q);
  const pairs: LocalForces['pairs'] = [];
  let peaceful = true;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j];
      const state = view.pairState(a, b);
      pairs.push({ a, b, state, alliance: view.hasTreaty(a, b, 'alliance'), openBorders: view.hasTreaty(a, b, 'openBorders') });
      if (state === 'war' && hasForce(sides.get(a)) && hasForce(sides.get(b))) peaceful = false;
    }
  }
  if (localFronts.some((f) => f.windowKm > 0)) peaceful = false;

  const owners = [...land.entries()]
    .map(([o, c]) => ({ owner: o, share: samples ? c / samples : 0, relation: relationOf(o) }))
    .sort((p, q) => q.share - p.share || p.owner - q.owner);

  return {
    x, y, lat: ll.lat, lon: ll.lon, radiusKm: R, viewer, tick: view.tick, point, owners,
    waterShare: samples ? water / samples : 0, frontKey: localFronts[0]?.key ?? 0, fronts: localFronts, sides: order, units,
    structures, pairs, peaceful,
  };
}

function hasForce(s: LocalForceSide | undefined): boolean {
  return !!s && (s.infantry > 0 || s.divisions.length > 0 || s.aircraft.length > 0 || s.ships.length > 0);
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Soldiers to show per side (same order as f.sides) under a budget: in proportion to the infantry pools, each side
 * that has troops clamped to SPLIT_MIN–SPLIT_MAX of the total for readability (§11.5). Never more soldiers than the
 * pools hold: a quiet place shows few soldiers, not a filled budget. Sides with no infantry get 0.
 */
export function visibleSplit(f: LocalForces, budget: number): number[] {
  const inf = f.sides.map((s) => Math.max(0, s.infantry));
  const total = inf.reduce((a, b) => a + b, 0);
  const out = inf.map(() => 0);
  if (total <= 0 || budget <= 0) return out;
  const shown = Math.min(Math.floor(budget), Math.round(total));
  const live = inf.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
  let share = inf.map((v) => v / total);
  if (live.length >= 2) {
    const lo = live.length === 2 ? SPLIT_MIN : SPLIT_MIN / (live.length - 1);
    const hi = live.length === 2 ? SPLIT_MAX : 1;
    // Clamp, then renormalise the unclamped sides so the shares still sum to 1.
    for (let pass = 0; pass < 4; pass++) {
      const clamped = share.map((s, i) => (inf[i] > 0 ? Math.min(hi, Math.max(lo, s)) : 0));
      const sum = clamped.reduce((a, b) => a + b, 0) || 1;
      share = clamped.map((s) => s / sum);
    }
  }
  // Largest-remainder rounding so the counts add up to `shown`.
  const raw = share.map((s) => s * shown);
  for (let i = 0; i < raw.length; i++) out[i] = Math.floor(raw[i]);
  let left = shown - out.reduce((a, b) => a + b, 0);
  const idx = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((p, q) => q[0] - p[0] || p[1] - q[1]);
  for (let k = 0; left > 0 && k < idx.length; k++) {
    if (inf[idx[k][1]] <= 0) continue;
    out[idx[k][1]]++;
    left--;
  }
  return out;
}
