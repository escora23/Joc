// FRONT ULTRA — route lines of ships, aircraft sorties and divisions (owner: units; built by W2 for DESIGN_V2 §10.8).
//   * a ship's line in its owner's colour from the port it left (UnitView.originX/Y) to where it is, for the whole
//     trip, kept 15 real seconds after arrival or sinking and faded out over 5 s (F2, F01); a sinking leaves a small
//     red cross for 15 s;
//   * ship lines follow the sim's own water path (view.routes): the travelled part is rebuilt from the path's
//     waypoints up to the ship when the line starts and follows the path again after any jump, so a ship line never
//     crosses land; a ship with no published path draws only what it actually sails from where it was first seen;
//   * the remaining planned path drawn dashed at 40 % ahead of convoys, sorties and the selected or hovered unit,
//     along the same water path (aircraft: the great circle they fly; divisions: their land/rail waypoints);
//   * at strategic zoom (above ~2,500 km) only the human's routes, routes of players at war with the human and the
//     hovered or selected unit's route are drawn: other nations' trade and naval lines fade out from 1,800 km;
//   * after arrival the hold and fade run on a real clock evaluated every rendered frame and on a 200 ms timer (a
//     stalled frame never leaves a line stuck); with &freeze=1 the clock is frozen and lines of units that are gone
//     are dropped at once, so a frozen shot shows exactly the units in it;
//   * transport convoys 3 px with arrowheads, trade ships 1 px at 30 % below 5,000 km, warships 1.5 px while moving,
//     aircraft sorties drawn progressively from take-off and kept 10 s after landing, CAP circles while a fighter
//     patrols, divisions' dashed route with the ETA at its end on hover and selection;
//   * enemy convoys heading to the human pulse with a red outline;
//   * at most 64 route lines, evicted by priority, never by age alone: trade routes first (oldest first), then other
//     players' military routes not at war with the human, then allies'; the human's own routes and routes of
//     players at war with the human are never evicted.
// Lines are drawn in the FX trail batch (render/fx/trails.ts route styles).

import * as THREE from 'three';
import { EARTH_RADIUS_KM, HUMAN_ID, MAP_W, UNIT_DEFS } from '../../shared/constants';
import { smoothstep } from '../../shared/math';
import { latLonToVec3, tileXYToLatLon, wrapDX } from '../../shared/geo';
import { UnitState, UnitType, type LatLon, type UnitView } from '../../shared/types';
import type { FxInternal } from '../fx';
import { TRAIL_STYLES, type Trail } from '../fx/trails';
import type { Relation } from '../relations';

export const ROUTE_BUDGET = 64;

type RouteKind = 'convoy' | 'trade' | 'warship' | 'air';

/** Real seconds a finished route stays at full opacity, then fades (§10.8). */
const ENDING: Record<RouteKind, readonly [number, number]> = { convoy: [15, 5], trade: [6, 3], warship: [8, 5], air: [10, 5] };

interface Route {
  unitId: number;
  owner: number;
  type: UnitType;
  kind: RouteKind;
  trail: Trail | null;
  plan: Trail | null;
  alert: Trail | null;
  /** fx time the line started (eviction: oldest first). */
  startedAt: number;
  lastMovingAt: number;
  seen: number;
  suppressed: boolean;
  segKm: number;
  planAt: number;
  /** Tile position the planned path was last built from (rebuilt when the unit moved, even on a frozen clock). */
  planX: number;
  planY: number;
  /** The sim path the line follows (identity: a new plan replaces it) and the segment the unit was last on. */
  path: Int32Array | null;
  pathK: number;
  /** Tile position of the last point pushed (jump detection). */
  lastX: number;
  lastY: number;
  lastState: number;
  /** Last drawn position (for the sinking cross). */
  last: THREE.Vector3;
}

interface Cross {
  pos: THREE.Vector3;
  until: number;
}

export interface RouteEnv {
  fx: FxInternal;
  /** fx time (paused-aware; constant while &freeze=1). */
  now: number;
  /** Real (wall-clock) seconds: the after-arrival hold and fade are real time (§10.8), whatever the frame rate. */
  realNow: number;
  /** &freeze=1: the frame is a still of the present (no lines of units already gone, no crosses). */
  frozen: boolean;
  /** The sim's planned path of a unit (tile waypoints), if published. */
  pathOf(unitId: number): Int32Array | undefined;
  altitudeKm: number;
  relationTo(owner: number): Relation;
  radiusAt(lat: number, lon: number): number;
  ownerColor(owner: number): THREE.Color;
  /** Tile owner lookup (enemy convoy alerts). */
  ownerOfXY(x: number, y: number): number;
}

export interface TrailStats {
  budget: number;
  routes: number;
  byKind: Record<RouteKind, number>;
  human: number;
  atWarWithHuman: number;
  plans: number;
  alerts: number;
  suppressed: number;
  evicted: { total: number; trade: number; other: number; ally: number; human: number; war: number };
  crosses: number;
  /** Lines of arrived or sunk units still held or fading. */
  ending: number;
}

const tmpLL: LatLon = { lat: 0, lon: 0 };
const tmpLL2: LatLon = { lat: 0, lon: 0 };
const V = new THREE.Vector3();
const VA = new THREE.Vector3();
const VB = new THREE.Vector3();
const pathBuf = new Float32Array(260 * 3);
const KNOTS = 1024;
const knotX = new Float64Array(KNOTS);
const knotY = new Float64Array(KNOTS);

function kindOf(t: UnitType): RouteKind | null {
  switch (t) {
    case UnitType.TransportShip: return 'convoy';
    case UnitType.TradeShip: return 'trade';
    case UnitType.Warship: return 'warship';
    case UnitType.FighterSquadron:
    case UnitType.Bomber:
    case UnitType.DroneSwarm: return 'air';
    default: return null;
  }
}

/** Great-circle distance (km) between two points in continuous tile coordinates. */
export function tileDistKm(ax: number, ay: number, bx: number, by: number): number {
  tileXYToLatLon(ax, ay, tmpLL);
  tileXYToLatLon(bx, by, tmpLL2);
  const p1 = (tmpLL.lat * Math.PI) / 180, p2 = (tmpLL2.lat * Math.PI) / 180;
  const dp = p2 - p1, dl = ((tmpLL2.lon - tmpLL.lon) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Tile centre of a path waypoint. */
const tcx = (t: number): number => (t % MAP_W) + 0.5;
const tcy = (t: number): number => Math.floor(t / MAP_W) + 0.5;

/**
 * Index i of the path segment (path[i] -> path[i + 1]) nearest to the point (x, y), searching from `from` (units only
 * move forward along their path). Tile units, wrap-aware.
 */
export function nearestSegment(path: ArrayLike<number>, x: number, y: number, from = 0): number {
  const n = path.length;
  if (n < 2) return 0;
  let best = Math.min(Math.max(0, from), n - 2), bestD = Infinity;
  for (let i = best; i < n - 1; i++) {
    const ax = tcx(path[i]), ay = tcy(path[i]);
    const dx = wrapDX(ax, tcx(path[i + 1])), dy = tcy(path[i + 1]) - ay;
    const px = wrapDX(ax, x), py = y - ay;
    const L = dx * dx + dy * dy;
    const t = L > 1e-9 ? Math.min(1, Math.max(0, (px * dx + py * dy) / L)) : 0;
    const qx = dx * t - px, qy = dy * t - py;
    const d = qx * qx + qy * qy;
    if (d < bestD - 1e-9) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Ending line: held, then faded on the route clock, then killed. */
interface Ending {
  trail: Trail;
  unitId: number;
  owner: number;
  at: number;
  hold: number;
  fade: number;
  /** Strategic-zoom visibility of this line (1 for the human's and at-war routes, and the focused unit). */
  vis: number;
  protect: boolean;
}

export class RouteManager {
  private readonly routes = new Map<number, Route>();
  private readonly crosses: Cross[] = [];
  /** Lines of units that arrived or sank: held at full opacity, then faded (real seconds), then removed. */
  private readonly ending: Ending[] = [];
  private gen = 0;
  readonly evicted = { total: 0, trade: 0, other: 0, ally: 0, human: 0, war: 0 };
  /** Units whose planned path is shown because they are selected or hovered. */
  focus = new Set<number>();
  /** Clock of the after-arrival hold and fade (real seconds; constant while frozen). Set by the units layer. */
  clock: () => number = () => performance.now() / 1000;
  private fx: FxInternal | null = null;

  /** Surface point (lifted) for tile coordinates; ships sit at sea level. */
  private point(env: RouteEnv, x: number, y: number, ship: boolean, out: THREE.Vector3): THREE.Vector3 {
    tileXYToLatLon(x, y, tmpLL);
    const r = ship ? 1 : env.radiusAt(tmpLL.lat, tmpLL.lon);
    return latLonToVec3(tmpLL.lat, tmpLL.lon, r + (ship ? 0.4 : 1.2) / EARTH_RADIUS_KM, out);
  }

  /** Great-circle points from (ax, ay) to (bx, by), every `segKm`, written into pathBuf; returns the count. */
  private arc(env: RouteEnv, ax: number, ay: number, bx: number, by: number, segKm: number, ship: boolean, max = 256): number {
    const km = tileDistKm(ax, ay, bx, by);
    const n = Math.max(2, Math.min(max, Math.ceil(km / Math.max(1, segKm)) + 1));
    tileXYToLatLon(ax, ay, tmpLL);
    const la1 = (tmpLL.lat * Math.PI) / 180, lo1 = (tmpLL.lon * Math.PI) / 180;
    tileXYToLatLon(bx, by, tmpLL2);
    const la2 = (tmpLL2.lat * Math.PI) / 180, lo2 = (tmpLL2.lon * Math.PI) / 180;
    const A = VA.set(Math.cos(la1) * Math.cos(lo1), Math.sin(la1), -Math.cos(la1) * Math.sin(lo1));
    const B = VB.set(Math.cos(la2) * Math.cos(lo2), Math.sin(la2), -Math.cos(la2) * Math.sin(lo2));
    const om = Math.acos(Math.min(1, Math.max(-1, A.dot(B))));
    const so = Math.sin(om);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      if (so < 1e-6) V.copy(A);
      else V.copy(A).multiplyScalar(Math.sin((1 - t) * om) / so).addScaledVector(B, Math.sin(t * om) / so);
      V.normalize();
      const lat = Math.asin(Math.max(-1, Math.min(1, V.y))) * (180 / Math.PI);
      const lon = Math.atan2(-V.z, V.x) * (180 / Math.PI);
      const r = ship ? 1 : env.radiusAt(lat, lon);
      V.multiplyScalar(r + (ship ? 0.4 : 1.2) / EARTH_RADIUS_KM);
      pathBuf[i * 3] = V.x;
      pathBuf[i * 3 + 1] = V.y;
      pathBuf[i * 3 + 2] = V.z;
    }
    return n;
  }

  /**
   * The polyline (x0, y0) -> path[i0..i1] -> (x1, y1) as surface points into pathBuf, straight in tile space between
   * knots exactly as the sim sails it (spatial.advanceKm), every `segKm` or coarser so that it fits `max` points; every
   * waypoint is kept (a corner is never cut across land). (x0, y0) / (x1, y1) are skipped when NaN. Returns the count.
   */
  private alongPath(env: RouteEnv, path: ArrayLike<number>, x0: number, y0: number, i0: number, i1: number, x1: number, y1: number,
    segKm: number, ship: boolean, max = 256): number {
    const kx = knotX, ky = knotY;
    let k = 0;
    const add = (x: number, y: number): void => {
      if (k >= KNOTS) return;
      if (k > 0) x = kx[k - 1] + wrapDX(kx[k - 1], x);
      if (k > 0 && Math.abs(x - kx[k - 1]) < 1e-4 && Math.abs(y - ky[k - 1]) < 1e-4) return;
      kx[k] = x;
      ky[k] = y;
      k++;
    };
    if (!Number.isNaN(x0)) add(x0, y0);
    for (let i = Math.max(0, i0); i <= Math.min(i1, path.length - 1); i++) add(tcx(path[i]), tcy(path[i]));
    if (!Number.isNaN(x1)) add(x1, y1);
    if (k === 0) return 0;
    const knots = Math.min(k, max);
    let total = 0;
    for (let i = 1; i < knots; i++) total += tileDistKm(kx[i - 1], ky[i - 1], kx[i], ky[i]);
    const step = Math.max(segKm, total / Math.max(1, max - knots));
    let n = 0;
    const emit = (x: number, y: number): void => {
      const p = this.point(env, x, y, ship, V);
      pathBuf[n * 3] = p.x;
      pathBuf[n * 3 + 1] = p.y;
      pathBuf[n * 3 + 2] = p.z;
      n++;
    };
    emit(kx[0], ky[0]);
    for (let i = 1; i < knots; i++) {
      const km = tileDistKm(kx[i - 1], ky[i - 1], kx[i], ky[i]);
      const m = Math.max(1, Math.ceil(km / step));
      for (let j = 1; j <= m && n < max; j++) {
        const t = j / m;
        emit(kx[i - 1] + (kx[i] - kx[i - 1]) * t, ky[i - 1] + (ky[i] - ky[i - 1]) * t);
      }
    }
    return n;
  }

  private styleKey(kind: RouteKind): 'routeConvoy' | 'routeTrade' | 'routeWarship' | 'routeAir' {
    return kind === 'convoy' ? 'routeConvoy' : kind === 'trade' ? 'routeTrade' : kind === 'warship' ? 'routeWarship' : 'routeAir';
  }

  /**
   * Start a route's line. Ships: from the first waypoint of their sim path (the port they left, or where this
   * warship leg began) along the path up to the ship; with no path yet, from where the ship is. Aircraft: the great
   * circle from take-off.
   */
  private startTrail(env: RouteEnv, r: Route, u: UnitView, airFromOrigin: boolean): void {
    const ship = r.kind !== 'air';
    let n: number;
    const path = ship ? env.pathOf(u.id) ?? null : null;
    if (ship && path && path.length >= 2) {
      let km = 0;
      for (let i = 1; i < path.length; i++) km += tileDistKm(tcx(path[i - 1]), tcy(path[i - 1]), tcx(path[i]), tcy(path[i]));
      r.segKm = Math.max(20, km / 220);
      const k = nearestSegment(path, u.x, u.y);
      n = this.alongPath(env, path, NaN, NaN, 0, k, u.x, u.y, r.segKm, true, 240);
      r.path = path;
      r.pathK = k;
    } else if (!ship && airFromOrigin) {
      n = this.arc(env, u.originX, u.originY, u.x, u.y, r.segKm, false, 200);
    } else {
      this.point(env, u.x, u.y, ship, V);
      pathBuf[0] = V.x;
      pathBuf[1] = V.y;
      pathBuf[2] = V.z;
      n = 1;
      r.path = null;
    }
    const tr = env.fx.trails.start(this.styleKey(r.kind), pathBuf[0], pathBuf[1], pathBuf[2], env.ownerColor(r.owner));
    if (n > 1) env.fx.trails.setPath(tr, pathBuf, n);
    tr.minSegKm = r.segKm;
    r.trail = tr;
    r.startedAt = env.now;
    r.lastX = u.x;
    r.lastY = u.y;
    if (this.isAlert(env, r, u)) {
      const al = env.fx.trails.start('routeAlert', pathBuf[0], pathBuf[1], pathBuf[2]);
      if (n > 1) env.fx.trails.setPath(al, pathBuf, n);
      al.minSegKm = r.segKm;
      r.alert = al;
    }
  }

  /** An enemy convoy heading to the human: a transport of a player at war with the human, bound for human land. */
  private isAlert(env: RouteEnv, r: Route, u: UnitView): boolean {
    return r.kind === 'convoy' && r.owner !== HUMAN_ID && env.relationTo(r.owner) === 'war' && env.ownerOfXY(u.targetX, u.targetY) === HUMAN_ID;
  }

  /** Protected from eviction: the human's own routes and routes of players at war with the human. */
  private protectedRoute(env: RouteEnv, r: Route): boolean {
    return r.owner === HUMAN_ID || env.relationTo(r.owner) === 'war';
  }

  /** Eviction rank (lower goes first): trade, then others' military not at war with the human, then allies'. */
  private evictRank(env: RouteEnv, r: Route): number {
    if (this.protectedRoute(env, r)) return 99;
    if (r.kind === 'trade') return 0;
    return env.relationTo(r.owner) === 'ally' ? 2 : 1;
  }

  /**
   * Strategic-zoom clutter cut (§10.8, FEEDBACK #10): above ~2,500 km only the human's routes, routes at war with the
   * human and the hovered or selected unit's route are drawn; other lines fade out between 1,800 and 2,500 km.
   */
  private visibility(env: RouteEnv, protect: boolean, unitId: number): number {
    if (protect || this.focus.has(unitId)) return 1;
    return 1 - smoothstep(1800, 2500, env.altitudeKm);
  }

  /** Per frame for every live unit: the line follows the unit (along its sim path), the planned path ahead. */
  unit(env: RouteEnv, u: UnitView, moving: boolean): void {
    this.fx = env.fx;
    if (u.type === UnitType.ArmoredDivision) {
      this.division(env, u);
      return;
    }
    const kind = kindOf(u.type);
    if (!kind) return;
    const docked = u.state === UnitState.Docked;
    let r = this.routes.get(u.id);
    if (!r) {
      r = {
        unitId: u.id, owner: u.owner, type: u.type, kind, trail: null, plan: null, alert: null, startedAt: env.now,
        lastMovingAt: env.now, seen: 0, suppressed: false, segKm: 20, planAt: -1, planX: NaN, planY: NaN, path: null, pathK: 0,
        lastX: u.x, lastY: u.y, lastState: u.state, last: new THREE.Vector3(),
      };
      // Aircraft: a point every max(10 km, sortie length / 200). Ships: from their path length when the line starts.
      const len = tileDistKm(u.originX, u.originY, u.targetX, u.targetY) * 1.3;
      r.segKm = Math.max(kind === 'air' ? 10 : 20, len / 200);
      this.routes.set(u.id, r);
    }
    r.seen = this.gen;
    r.lastState = u.state;
    r.owner = u.owner;
    const protect = this.protectedRoute(env, r);
    // A ship that changed hands (capitulation, cession) or whose owner went to war with the human is protected now.
    if (r.suppressed && protect) r.suppressed = false;
    if (moving) r.lastMovingAt = env.now;
    const ship = kind !== 'air';
    this.point(env, u.x, u.y, ship, r.last);

    // When a line exists and should: follow the unit. When it should end: hold, then fade.
    let want: boolean;
    if (kind === 'warship') want = moving || (!!r.trail && env.now - r.lastMovingAt < 3);
    else if (kind === 'air') want = !docked;
    else want = true;
    if (!want) {
      this.endRoute(env, r);
      return;
    }
    const path = ship ? env.pathOf(u.id) ?? null : null;
    // A transport or trade ship whose line started before its path arrived: redraw it along the path from its port.
    if (r.trail && ship && !r.path && path && path.length >= 2 && kind !== 'warship') {
      env.fx.trails.kill(r.trail);
      env.fx.trails.kill(r.alert);
      r.trail = r.alert = null;
    }
    if (!r.trail && !r.suppressed) {
      this.startTrail(env, r, u, kind === 'air' && tileDistKm(u.originX, u.originY, u.x, u.y) < 2500);
    }
    const vis = this.visibility(env, protect, u.id);
    if (r.trail) {
      if (ship && path && path.length >= 2) {
        if (path !== r.path) {
          // A new plan (the next warship leg, a retarget): the line keeps what was sailed and follows the new path.
          r.path = path;
          r.pathK = 0;
        }
        // A jump longer than two line segments (a fast-forward, a stalled tab, a burst of updates): follow the
        // waypoints sailed meanwhile instead of a chord that could cross land.
        if (tileDistKm(r.lastX, r.lastY, u.x, u.y) > 2 * r.segKm) {
          const k0 = r.pathK;
          const k = nearestSegment(path, u.x, u.y, k0);
          if (k > k0) {
            const n = this.alongPath(env, path, NaN, NaN, k0 + 1, k, NaN, NaN, r.segKm, true, 240);
            for (let i = 0; i < n; i++) {
              env.fx.trails.push(r.trail, pathBuf[i * 3], pathBuf[i * 3 + 1], pathBuf[i * 3 + 2]);
              if (r.alert) env.fx.trails.push(r.alert, pathBuf[i * 3], pathBuf[i * 3 + 1], pathBuf[i * 3 + 2]);
            }
          }
          r.pathK = k;
        }
      }
      env.fx.trails.push(r.trail, r.last.x, r.last.y, r.last.z);
      if (r.alert) env.fx.trails.push(r.alert, r.last.x, r.last.y, r.last.z);
      r.lastX = u.x;
      r.lastY = u.y;
      r.trail.opacity = vis;
      if (r.alert) r.alert.opacity = vis;
    }
    // Planned path ahead (dashed): convoys and sorties always; anything selected or hovered. Ships follow their sim
    // path (no path: no preview, never a guess across land); aircraft the great circle they fly.
    const planned = (kind === 'convoy' || kind === 'air' || this.focus.has(u.id)) && tileDistKm(u.x, u.y, u.targetX, u.targetY) > 30
      && (!ship || (!!path && path.length >= 2));
    if (planned && !r.suppressed) {
      if (!r.plan) {
        r.plan = env.fx.trails.start('plan', r.last.x, r.last.y, r.last.z, env.ownerColor(r.owner));
        r.planAt = -1;
      }
      const movedTiles = Math.abs(wrapDX(r.planX, u.x)) + Math.abs(r.planY - u.y);
      if (r.planAt < 0 || env.now - r.planAt > 0.4 || !(movedTiles < 0.25) || (ship && path !== r.path)) {
        r.planAt = env.now;
        r.planX = u.x;
        r.planY = u.y;
        let n: number;
        if (ship && path) {
          const k = nearestSegment(path, u.x, u.y, r.path === path ? r.pathK : 0);
          n = this.alongPath(env, path, u.x, u.y, k + 1, path.length - 1, NaN, NaN, Math.max(15, r.segKm), true, 240);
        } else n = this.arc(env, u.x, u.y, u.targetX, u.targetY, Math.max(15, r.segKm), false, 200);
        if (n >= 2) env.fx.trails.setPath(r.plan, pathBuf, n);
      }
      r.plan.opacity = vis;
    } else if (r.plan) {
      env.fx.trails.kill(r.plan);
      r.plan = null;
    }
  }

  /** Divisions: a dashed route along their land / rail waypoints with the ETA at its end, on hover and selection only. */
  private readonly divPlans = new Map<number, { plan: Trail; at: number; x: number; y: number; path: Int32Array | null; seen: number; end: THREE.Vector3; eta: string; owner: number }>();
  private division(env: RouteEnv, u: UnitView): void {
    let d = this.divPlans.get(u.id);
    const show = this.focus.has(u.id) && hasDestination(u) && tileDistKm(u.x, u.y, u.targetX, u.targetY) > 15;
    if (!show) {
      if (d) {
        env.fx.trails.kill(d.plan);
        this.divPlans.delete(u.id);
      }
      return;
    }
    const here = this.point(env, u.x, u.y, false, V);
    if (!d) {
      d = { plan: env.fx.trails.start('plan', here.x, here.y, here.z, env.ownerColor(u.owner)), at: -1, x: NaN, y: NaN, path: null, seen: 0, end: new THREE.Vector3(), eta: '', owner: u.owner };
      this.divPlans.set(u.id, d);
    }
    d.seen = this.gen;
    const path = env.pathOf(u.id) ?? null;
    const moved = Math.abs(wrapDX(d.x, u.x)) + Math.abs(d.y - u.y);
    if (d.at < 0 || env.now - d.at > 0.4 || !(moved < 0.25) || path !== d.path) {
      d.at = env.now;
      d.x = u.x;
      d.y = u.y;
      d.path = path;
      let n: number;
      if (path && path.length >= 1) {
        const k = path.length >= 2 ? nearestSegment(path, u.x, u.y) : -1;
        n = this.alongPath(env, path, u.x, u.y, k + 1, path.length - 1, NaN, NaN, 10, false, 200);
      } else n = this.arc(env, u.x, u.y, u.targetX, u.targetY, 10, false, 200);
      if (n >= 2) {
        env.fx.trails.setPath(d.plan, pathBuf, n);
        d.end.set(pathBuf[(n - 1) * 3], pathBuf[(n - 1) * 3 + 1], pathBuf[(n - 1) * 3 + 2]);
      }
      d.eta = etaLabel(u);
    }
  }

  /** ETA labels at the end of shown division routes. */
  forEachEta(fn: (p: THREE.Vector3, eta: string, owner: number) => void): void {
    for (const d of this.divPlans.values()) fn(d.end, d.eta, d.owner);
  }

  /**
   * The unit is gone, arrived, docked or stopped: its travelled line is held and then faded on the route clock (convoys
   * 15 s + 5 s, trade 6 + 3, warships 8 + 5, sorties 10 + 5); the planned path and the alert outline go at once. While
   * frozen (&freeze=1) the line goes at once too: a frozen frame shows the present.
   */
  private endRoute(env: RouteEnv, r: Route): void {
    if (r.trail && !r.suppressed && !env.frozen) {
      const [hold, fade] = ENDING[r.kind];
      const protect = this.protectedRoute(env, r);
      this.ending.push({ trail: r.trail, unitId: r.unitId, owner: r.owner, at: this.clock(), hold, fade, protect, vis: this.visibility(env, protect, r.unitId) });
    } else if (r.trail) env.fx.trails.kill(r.trail);
    env.fx.trails.kill(r.alert);
    env.fx.trails.kill(r.plan);
    r.trail = r.alert = r.plan = null;
    r.path = null;
  }

  begin(): void {
    this.gen++;
  }

  /**
   * Hold and fade of ending lines from the route clock: full opacity for `hold` s, then linear to 0 over `fade` s, then
   * killed. Runs every rendered frame (end()) and on a 200 ms timer (tickEnding from the units layer) so the state is
   * right whatever the frame cadence: a line is never drawn past hold + fade, even after a stalled frame.
   */
  tickEnding(): void {
    const now = this.clock();
    for (let i = this.ending.length - 1; i >= 0; i--) {
      const e = this.ending[i];
      const age = now - e.at;
      if (age >= e.hold + e.fade) {
        this.fx?.trails.kill(e.trail);
        e.trail.opacity = 0;
        this.ending.splice(i, 1);
      } else e.trail.opacity = e.vis * (age <= e.hold ? 1 : 1 - (age - e.hold) / e.fade);
    }
  }

  /** After all units: end vanished units' lines (red cross if sunk), fade ending lines, enforce the budget. */
  end(env: RouteEnv): void {
    this.fx = env.fx;
    for (const [id, d] of this.divPlans) {
      if (d.seen === this.gen) continue;
      env.fx.trails.kill(d.plan);
      this.divPlans.delete(id);
    }
    for (const [id, r] of this.routes) {
      if (r.seen === this.gen) continue;
      if (r.lastState === UnitState.Destroyed && r.kind !== 'air' && !env.frozen) this.crosses.push({ pos: r.last.clone(), until: env.now + 15 });
      this.endRoute(env, r);
      this.routes.delete(id);
    }
    for (const e of this.ending) e.vis = this.visibility(env, e.protect, e.unitId);
    this.tickEnding();
    for (let i = this.crosses.length - 1; i >= 0; i--) if (this.crosses[i].until < env.now) this.crosses.splice(i, 1);
    // Budget: evict by priority, never the human's routes or routes at war with the human.
    let live = 0;
    for (const r of this.routes.values()) if (r.trail) live++;
    if (live > ROUTE_BUDGET) {
      const cands = [...this.routes.values()].filter((r) => r.trail && !this.protectedRoute(env, r))
        .sort((a, b) => this.evictRank(env, a) - this.evictRank(env, b) || a.startedAt - b.startedAt);
      for (const r of cands) {
        if (live <= ROUTE_BUDGET) break;
        const rank = this.evictRank(env, r);
        // Evicted lines vanish at once (no hold): the budget is about what is on screen.
        for (const t of [r.trail, r.alert, r.plan]) env.fx.trails.kill(t);
        r.trail = r.alert = r.plan = null;
        r.path = null;
        r.suppressed = true;
        live--;
        this.evicted.total++;
        if (rank === 0) this.evicted.trade++;
        else if (rank === 1) this.evicted.other++;
        else this.evicted.ally++;
      }
    } else if (live < ROUTE_BUDGET - 4) {
      // Room again: lift suppression, most important first (they redraw from their departure point).
      const sup = [...this.routes.values()].filter((r) => r.suppressed).sort((a, b) => this.evictRank(env, b) - this.evictRank(env, a));
      for (const r of sup) {
        if (live >= ROUTE_BUDGET - 4) break;
        r.suppressed = false;
        live++;
      }
    }
  }

  /** Crosses of sunk ships (world position, 0..1 alpha) for the icon layer. */
  forEachCross(now: number, fn: (p: THREE.Vector3, alpha: number) => void): void {
    for (const c of this.crosses) fn(c.pos, Math.min(1, (c.until - now) / 1.5));
  }

  stats(env: { relationTo(owner: number): Relation }): TrailStats {
    const byKind: Record<RouteKind, number> = { convoy: 0, trade: 0, warship: 0, air: 0 };
    let routes = 0, human = 0, war = 0, plans = 0, alerts = 0, suppressed = 0;
    for (const r of this.routes.values()) {
      if (r.suppressed) suppressed++;
      if (r.plan) plans++;
      if (r.alert) alerts++;
      if (!r.trail) continue;
      routes++;
      byKind[r.kind]++;
      if (r.owner === HUMAN_ID) human++;
      else if (env.relationTo(r.owner) === 'war') war++;
    }
    let endingHuman = 0;
    for (const e of this.ending) if (e.owner === HUMAN_ID) endingHuman++;
    return {
      budget: ROUTE_BUDGET, routes, byKind, human: human + endingHuman, ending: this.ending.length, atWarWithHuman: war, plans: plans + this.divPlans.size, alerts, suppressed,
      evicted: { ...this.evicted }, crosses: this.crosses.length,
    };
  }

  /** One unit's route line (verification): 'live' while it sails, 'ending' with its real age after arrival. */
  info(unitId: number): { state: 'live' | 'ending' | 'none'; drawn: boolean; age?: number; opacity?: number; suppressed?: boolean } {
    const r = this.routes.get(unitId);
    if (r) return { state: 'live', drawn: !!r.trail && !r.suppressed, suppressed: r.suppressed };
    const e = this.ending.find((x) => x.unitId === unitId);
    if (e) return { state: 'ending', drawn: e.trail.opacity > 0 && e.trail.count > 0, age: +(this.clock() - e.at).toFixed(2), opacity: +e.trail.opacity.toFixed(3) };
    return { state: 'none', drawn: false };
  }

  /**
   * World points of a unit's drawn route line, oldest (departure) first, plus its colour as sRGB hex (verification:
   * tools/w2-verify.mjs projects them and samples the rendered frame along the polyline).
   */
  points(unitId: number): { pts: number[]; color: string; opacity: number } | null {
    const r = this.routes.get(unitId);
    const tr = r ? (r.suppressed ? null : r.trail) : this.ending.find((x) => x.unitId === unitId)?.trail ?? null;
    if (!tr || tr.count < 2) return null;
    const cap = tr.style.maxPts;
    const pts: number[] = [];
    for (let k = tr.count - 1; k >= 0; k--) {
      const i = (tr.head - k + cap * 2) % cap;
      pts.push(tr.pts[i * 3], tr.pts[i * 3 + 1], tr.pts[i * 3 + 2]);
    }
    return { pts, color: '#' + tr.color.getHexString(), opacity: tr.opacity };
  }

  /** Human units that are protected yet suppressed (must stay 0). */
  humanSuppressed(): number {
    let n = 0;
    for (const r of this.routes.values()) if (r.owner === HUMAN_ID && r.suppressed) n++;
    return n;
  }

  clear(fx: FxInternal | undefined): void {
    if (fx) for (const r of this.routes.values()) {
      for (const t of [r.trail, r.alert, r.plan]) if (t) fx.trails.release(t);
    }
    if (fx) for (const d of this.divPlans.values()) fx.trails.release(d.plan);
    if (fx) for (const e of this.ending) fx.trails.kill(e.trail);
    this.ending.length = 0;
    this.divPlans.clear();
    this.routes.clear();
    this.crosses.length = 0;
    this.focus.clear();
    this.evicted.total = this.evicted.trade = this.evicted.other = this.evicted.ally = this.evicted.human = this.evicted.war = 0;
  }
}

/** ETA label for a unit moving at its v2 speed toward its target: "12h", "3d", "<1h". */
export function etaLabel(u: UnitView): string {
  const km = tileDistKm(u.x, u.y, u.targetX, u.targetY);
  const kmh = UNIT_DEFS[u.type]?.speedKmh ?? 40;
  const h = km / Math.max(1, kmh);
  if (h < 1) return '<1h';
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/** True when the unit is far enough from its target to show a route (continuous tiles, wrap-aware). */
export function hasDestination(u: UnitView): boolean {
  const dx = wrapDX(u.x, u.targetX), dy = u.targetY - u.y;
  return dx * dx + dy * dy > 1 && u.targetX >= 0 && u.targetX < MAP_W;
}
