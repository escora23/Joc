// FRONT ULTRA — naval warfare on the sea lanes (owner item 30, DESIGN_V2 §20). Worker-safe, no DOM, no three.js.
//
// One rule set for the simulation (src/sim/naval.ts), the blockade dialog and its preview, the map, the cards and the
// panels, so every layer says the same thing:
//
//   blockade zone      a disc of BLOCKADE_RADIUS_TILES (150 km) around the station of one or more warships holding a
//                      blockade (a port, a strait from CHOKEPOINTS, or any stretch of sea). In force while at least one
//                      of its warships is on station.
//   whom it stops      BlockadeFilter: who ('war' only the nations at war with you — the default — / 'embargo' those
//                      plus the nations you embargo / 'list' the nations you pick / 'all' everyone but allies) and
//                      ships ('all' / 'transports' troop convoys only / 'trade' merchants only). Ships it does not
//                      apply to sail through untouched.
//   what it does       ships it applies to steer around the zone when there is a way (the detour is slower: a merchant
//                      is paid for the direct trip, so its port earns less per hour); ships that cannot avoid it are
//                      intercepted: action 'seize' boards merchants (they change flag and sail to your nearest port
//                      with their cargo) and forces troop convoys back to where they came from; action 'sink' sinks
//                      both (the troops aboard are lost). A port inside the zone sends no merchants at all.
//   escorts            a ship escorted by a warship cannot be boarded: at war the blockade fights the escort first; at
//                      peace it lets the convoy pass (firing on a warship would be an act of war).
//   consequences       stopping ships of a nation at war with you costs nothing diplomatically. Stopping ships of a
//                      nation at peace is piracy: its opinion of you falls per ship (PIRACY_OPINION), its allies'
//                      too, both hold a casus belli for 30 days, and the AI answers with a protest, an embargo, escorted
//                      convoys and, when angry and strong enough, war.
//
// Suez and Panama are canals: their tiles are sailable (CANALS) although the land raster has no water there.

import { MAP_H, MAP_W, TILE_COUNT, TILE_KM, WARSHIP_ENGAGE_TILES } from './constants';

/** Radius of a blockade zone (tiles; = the warships' engagement radius, 150 km). */
export const BLOCKADE_RADIUS_TILES = WARSHIP_ENGAGE_TILES;
export const BLOCKADE_RADIUS_KM = BLOCKADE_RADIUS_TILES * TILE_KM;
/** A blockading warship this close to its station (tiles) holds it: the zone is in force. */
export const BLOCKADE_STATION_TILES = 2.5;
/** Warships ordered to blockade within this many tiles of an existing blockade of their owner join it. */
export const BLOCKADE_JOIN_TILES = 4;
/** An order within this many tiles of a strait blockades the strait itself. */
export const CHOKEPOINT_SNAP_TILES = 6;
/** A boarding / sinking resolves this close to the ship (tiles). */
export const INTERCEPT_TILES = 2;
/** Hours of history behind the «per hour» figures of a blockade and of a player's losses. */
export const BLOCKADE_WINDOW_HOURS = 24;
/** A merchant or convoy stopped by a hail or a warning shot heaves to this long (ticks). */
export const HEAVE_TO_TICKS = 20;

/** Diplomatic cost of stopping ships of a nation at peace (opinion of the victim / its allies / the world, per ship). */
export const PIRACY_OPINION = {
  seize: -10,
  sink: -20,
  turnBack: -10,
  sinkTroops: -25,
  warningShot: -3,
  ally: -4,
  world: -2,
} as const;
/** Most a victim's opinion can fall from piracy (the remembered reason's cap), its allies' and the world's. */
export const PIRACY_CAP = 80;
export const PIRACY_ALLY_CAP = 16;
export const PIRACY_WORLD_CAP = 8;
/** AI answers to piracy (victim's opinion of the offender after the stops): embargo at or below, war at or below. */
export const PIRACY_EMBARGO_OPINION = -25;
export const PIRACY_WAR_OPINION = -55;

export type BlockadeWho = 'war' | 'embargo' | 'list' | 'all';
export type BlockadeShips = 'all' | 'transports' | 'trade';
export type BlockadeAction = 'seize' | 'sink';
export const BLOCKADE_WHO: readonly BlockadeWho[] = ['war', 'embargo', 'list', 'all'];
export const BLOCKADE_SHIPS: readonly BlockadeShips[] = ['all', 'transports', 'trade'];
export const BLOCKADE_ACTIONS: readonly BlockadeAction[] = ['seize', 'sink'];

/** Whom a blockade stops and what it does with them (the unitOrder `blockade` field; defaults: enemies only, seize). */
export interface BlockadeSpec {
  who: BlockadeWho;
  /** who = 'list': the nations whose ships are stopped. */
  nations?: number[];
  ships: BlockadeShips;
  action: BlockadeAction;
}
export const DEFAULT_BLOCKADE: Readonly<BlockadeSpec> = { who: 'war', ships: 'all', action: 'seize' };

/** Normalise a spec from a command (unknown values fall back to the defaults). */
export function blockadeSpec(s: Partial<BlockadeSpec> | undefined | null): BlockadeSpec {
  const who = s && BLOCKADE_WHO.includes(s.who as BlockadeWho) ? (s.who as BlockadeWho) : DEFAULT_BLOCKADE.who;
  const ships = s && BLOCKADE_SHIPS.includes(s.ships as BlockadeShips) ? (s.ships as BlockadeShips) : DEFAULT_BLOCKADE.ships;
  const action = s && BLOCKADE_ACTIONS.includes(s.action as BlockadeAction) ? (s.action as BlockadeAction) : DEFAULT_BLOCKADE.action;
  const nations = who === 'list' && Array.isArray(s?.nations) ? [...new Set(s!.nations.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 64) : undefined;
  return nations ? { who, nations, ships, action } : { who, ships, action };
}

/** The relations a filter needs (the sim's rules and the client's view both provide them). */
export interface BlockadeRelations {
  atWar(a: number, b: number): boolean;
  allied(a: number, b: number): boolean;
  /** `a` embargoes `b`. */
  embargoes(a: number, b: number): boolean;
}

/** Ship kinds a blockade looks at. */
export type ShipKind = 'trade' | 'transport';

/** Does a blockade of `owner` with `spec` stop a ship of `shipOwner` of this kind? (Never its own or an ally's.) */
export function blockadeApplies(rel: BlockadeRelations, owner: number, spec: BlockadeSpec, shipOwner: number, kind: ShipKind): boolean {
  if (shipOwner <= 0 || shipOwner === owner || rel.allied(owner, shipOwner)) return false;
  if (spec.ships === 'transports' && kind !== 'transport') return false;
  if (spec.ships === 'trade' && kind !== 'trade') return false;
  switch (spec.who) {
    case 'war': return rel.atWar(owner, shipOwner);
    case 'embargo': return rel.atWar(owner, shipOwner) || rel.embargoes(owner, shipOwner);
    case 'list': return !!spec.nations && spec.nations.includes(shipOwner);
    case 'all': return true;
  }
  return false;
}

// -------------------------------------------------------------------------------------------------
// Straits and canals
// -------------------------------------------------------------------------------------------------

export interface Chokepoint {
  key: string;
  lat: number;
  lon: number;
  /** A canal (its tiles are made sailable, see CANALS). */
  canal?: boolean;
}

/** The world's sea-lane chokepoints a blockade can close (i18n: naval.cp.<key>). The point is on the water. */
export const CHOKEPOINTS: readonly Chokepoint[] = [
  { key: 'gibraltar', lat: 35.95, lon: -5.6 },
  { key: 'suez', lat: 30.6, lon: 32.33, canal: true },
  { key: 'bosporus', lat: 41.1, lon: 29.05 },
  { key: 'hormuz', lat: 26.5, lon: 56.4 },
  { key: 'malacca', lat: 2.5, lon: 101.3 },
  { key: 'channel', lat: 50.95, lon: 1.4 },
  { key: 'panama', lat: 9.15, lon: -79.75, canal: true },
  { key: 'babelmandeb', lat: 12.6, lon: 43.4 },
];

/** Canal routes (lat, lon polylines) whose tiles are sailable in the sim's and the client's sea components. */
const CANAL_LINES: readonly (readonly [number, number])[][] = [
  // Suez: Port Said → Ismailia → Suez.
  [[31.35, 32.3], [30.6, 32.3], [29.9, 32.55]],
  // Panama: Colón → Gatún → Panama City.
  [[9.45, -79.92], [9.1, -79.75], [8.85, -79.5]],
];

let canalCache: Int32Array | null = null;

/** Tile indices of the canals (4-connected lines, so a ship can sail them tile by tile). */
export function canalTiles(): Int32Array {
  if (canalCache) return canalCache;
  const out = new Set<number>();
  const tx = (lon: number) => Math.floor(((lon + 180) / 360) * MAP_W);
  const ty = (lat: number) => Math.floor(((90 - lat) / 180) * MAP_H);
  for (const line of CANAL_LINES) {
    for (let i = 1; i < line.length; i++) {
      let x = tx(line[i - 1][1]), y = ty(line[i - 1][0]);
      const x1 = tx(line[i][1]), y1 = ty(line[i][0]);
      out.add(y * MAP_W + x);
      // 4-connected walk: step along the axis with the larger remaining gap.
      while (x !== x1 || y !== y1) {
        if (Math.abs(x1 - x) >= Math.abs(y1 - y)) x += Math.sign(x1 - x);
        else y += Math.sign(y1 - y);
        out.add(y * MAP_W + x);
      }
    }
    // Extend both ends one tile toward the sea so the canal meets open water.
    const a = line[0], b = line[line.length - 1];
    for (const [la, lo] of [a, b]) {
      const x = tx(lo), y = ty(la);
      for (const d of [-1, 1]) {
        out.add(Math.max(0, Math.min(MAP_H - 1, y + d)) * MAP_W + x);
      }
    }
  }
  canalCache = Int32Array.from([...out].filter((t) => t >= 0 && t < TILE_COUNT).sort((p, q) => p - q));
  return canalCache;
}

/** Tile of a chokepoint (its point). */
export function chokepointTile(c: Chokepoint): number {
  const x = Math.floor(((c.lon + 180) / 360) * MAP_W);
  const y = Math.floor(((90 - c.lat) / 180) * MAP_H);
  return y * MAP_W + ((x % MAP_W) + MAP_W) % MAP_W;
}

/** The chokepoint within `snap` tiles of (x, y) (continuous tile coords), nearest first, or null. */
export function chokepointNear(x: number, y: number, snap = CHOKEPOINT_SNAP_TILES): Chokepoint | null {
  let best: Chokepoint | null = null, bd = snap * snap;
  for (const c of CHOKEPOINTS) {
    const t = chokepointTile(c);
    const cx = (t % MAP_W) + 0.5, cy = Math.floor(t / MAP_W) + 0.5;
    let dx = Math.abs(cx - x);
    if (dx > MAP_W / 2) dx = MAP_W - dx;
    const d = dx * dx + (cy - y) * (cy - y);
    if (d <= bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

/** Wrapped squared tile distance between two points (x in tiles, horizontal wrap), scaled by the latitude of `ay`. */
export function zoneDist2(ax: number, ay: number, bx: number, by: number): number {
  let dx = bx - ax;
  if (dx > MAP_W / 2) dx -= MAP_W;
  else if (dx < -MAP_W / 2) dx += MAP_W;
  const lat = 90 - (ay / MAP_H) * 180;
  const c = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  dx *= c;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/**
 * Does the polyline of tile waypoints (from index `from`, starting at (sx, sy)) pass within `r` tiles of (cx, cy)?
 * Wrap-aware; distances in the zone's local metric (longitude scaled by its latitude, as the zone is drawn).
 */
export function pathCrossesZone(path: ArrayLike<number>, from: number, sx: number, sy: number, cx: number, cy: number, r: number): boolean {
  let px = sx, py = sy;
  const lat = 90 - (cy / MAP_H) * 180;
  const c = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  const r2 = r * r;
  for (let i = from; i < path.length; i++) {
    const t = path[i];
    const qx = (t % MAP_W) + 0.5, qy = Math.floor(t / MAP_W) + 0.5;
    // Segment P→Q relative to the centre, x unwrapped around the centre.
    let ax = px - cx, bx = qx - cx;
    if (ax > MAP_W / 2) ax -= MAP_W;
    else if (ax < -MAP_W / 2) ax += MAP_W;
    if (bx - ax > MAP_W / 2) bx -= MAP_W;
    else if (bx - ax < -MAP_W / 2) bx += MAP_W;
    ax *= c;
    bx *= c;
    const ay = py - cy, by = qy - cy;
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let k = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
    k = k < 0 ? 0 : k > 1 ? 1 : k;
    const ex = ax + dx * k, ey = ay + dy * k;
    if (ex * ex + ey * ey <= r2) return true;
    px = qx;
    py = qy;
  }
  return false;
}

// -------------------------------------------------------------------------------------------------
// Published views
// -------------------------------------------------------------------------------------------------

/** What a blockade did to one nation's ships. */
export interface BlockadeNationStat {
  id: number;
  /** Ships boarded, sunk, turned back, rerouted around the zone; escorted convoys let through. */
  seized: number;
  sunk: number;
  turnedBack: number;
  rerouted: number;
  passed: number;
  /** Trade gold this nation lost to the blockade (cargo taken or sunk, detours, idle ports), total. */
  lost: number;
  /** Stopped at peace: piracy (opinion, casus belli). */
  piracy: boolean;
}

/** One blockade as every client sees it (TickUpdate.blockades, full list when changed). */
export interface BlockadeView {
  id: number;
  owner: number;
  /** 'strait' (key = CHOKEPOINTS key), 'port' (portId), 'sea' (any stretch of a route). */
  kind: 'strait' | 'port' | 'sea';
  key?: string;
  portId?: number;
  /** Zone centre (continuous tile coords) and radius (tiles). */
  x: number;
  y: number;
  r: number;
  spec: BlockadeSpec;
  /** Warships assigned (on station or on their way) and how many hold the station now. */
  warships: number[];
  onStation: number;
  /** In force (a warship holds the station). */
  active: boolean;
  startTick: number;
  /** Tick it ended (0 = still standing); ended blockades stay listed for a game day. */
  endTick: number;
  seized: number;
  sunk: number;
  turnedBack: number;
  rerouted: number;
  passed: number;
  /** Seized cargo delivered to our ports (gold, total) and per hour over the last BLOCKADE_WINDOW_HOURS. */
  gold: number;
  goldPerHour: number;
  /** Trade the stopped nations lost (gold, total) and per hour. */
  enemyLost: number;
  enemyLostPerHour: number;
  /** Troops aboard convoys turned back or sunk. */
  troopsDenied: number;
  nations: BlockadeNationStat[];
}

/** A player's trade lost to blockades and gained from them (TickUpdate.naval for the human). */
export interface NavalEconomyView {
  /** Trade gold lost per hour to blockades (last BLOCKADE_WINDOW_HOURS) and in total. */
  lostPerHour: number;
  lostTotal: number;
  /** Seized cargo gold per hour gained by our blockades, and in total. */
  gainPerHour: number;
  gainTotal: number;
  /** Own merchants at sea now on a detour around a blockade, and own ports idle because of one. */
  rerouted: number;
  portsBlocked: number;
}
