// FRONT ULTRA — route lines of ships, aircraft sorties and divisions (owner: units; built by W2 for DESIGN_V2 §10.8).
//   * a ship's line in its owner's colour from the port it left (UnitView.originX/Y) to where it is, for the whole
//     trip, kept 15 real seconds after arrival or sinking and faded out over 5 s (F2, F01); a sinking leaves a small
//     red cross for 15 s;
//   * the remaining planned path drawn dashed at 40 % ahead of convoys, sorties and the selected or hovered unit
//     (v2-stub(W2→W4): a great-circle preview until W4 publishes the sim's water paths in `routes`);
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
  now: number;
  /** Real (wall-clock) seconds: the after-arrival hold and fade are real time (§10.8), whatever the frame rate. */
  realNow: number;
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

export class RouteManager {
  private readonly routes = new Map<number, Route>();
  private readonly crosses: Cross[] = [];
  /** Lines of units that arrived or sank: held at full opacity, then faded (real seconds), then removed. */
  private readonly ending: { trail: Trail; unitId: number; owner: number; at: number; hold: number; fade: number }[] = [];
  private gen = 0;
  readonly evicted = { total: 0, trade: 0, other: 0, ally: 0, human: 0, war: 0 };
  /** Units whose planned path is shown because they are selected or hovered. */
  focus = new Set<number>();

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

  private styleFor(kind: RouteKind) {
    return kind === 'convoy' ? TRAIL_STYLES.routeConvoy : kind === 'trade' ? TRAIL_STYLES.routeTrade : kind === 'warship' ? TRAIL_STYLES.routeWarship : TRAIL_STYLES.routeAir;
  }

  private startTrail(env: RouteEnv, r: Route, u: UnitView, fromX: number, fromY: number): void {
    const ship = r.kind !== 'air';
    const n = this.arc(env, fromX, fromY, u.x, u.y, r.segKm, ship, 200);
    const key = r.kind === 'convoy' ? 'routeConvoy' : r.kind === 'trade' ? 'routeTrade' : r.kind === 'warship' ? 'routeWarship' : 'routeAir';
    const tr = env.fx.trails.start(key, pathBuf[0], pathBuf[1], pathBuf[2], env.ownerColor(r.owner));
    tr.minSegKm = r.segKm;
    if (r.kind === 'trade') tr.opacity = env.altitudeKm < 5000 ? 1 : 0;
    for (let i = 1; i < n; i++) env.fx.trails.push(tr, pathBuf[i * 3], pathBuf[i * 3 + 1], pathBuf[i * 3 + 2]);
    r.trail = tr;
    r.startedAt = env.now;
    if (this.isAlert(env, r, u)) {
      const al = env.fx.trails.start('routeAlert', pathBuf[0], pathBuf[1], pathBuf[2]);
      al.minSegKm = r.segKm;
      for (let i = 1; i < n; i++) env.fx.trails.push(al, pathBuf[i * 3], pathBuf[i * 3 + 1], pathBuf[i * 3 + 2]);
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
   * Per frame for every live unit. `pos` is the unit's drawn position (ignored), `airborne` false for docked aircraft.
   * Returns nothing; trails follow the unit.
   */
  unit(env: RouteEnv, u: UnitView, moving: boolean): void {
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
        lastMovingAt: env.now, seen: 0, suppressed: false, segKm: 20, planAt: -1, lastState: u.state, last: new THREE.Vector3(),
      };
      // A point every max(20 km, route length / 200).
      const len = tileDistKm(u.originX, u.originY, u.targetX, u.targetY) * 1.3;
      r.segKm = Math.max(kind === 'air' ? 10 : 20, len / 200);
      this.routes.set(u.id, r);
    }
    r.seen = this.gen;
    r.lastState = u.state;
    r.owner = u.owner;
    // A ship that changed hands (capitulation, cession) or whose owner went to war with the human is protected now.
    if (r.suppressed && this.protectedRoute(env, r)) r.suppressed = false;
    if (moving) r.lastMovingAt = env.now;
    const ship = kind !== 'air';
    this.point(env, u.x, u.y, ship, r.last);

    // When a line exists and should: follow the unit. When it should end: release it (hold, then fade).
    let want: boolean;
    if (kind === 'warship') want = moving || (!!r.trail && env.now - r.lastMovingAt < 3);
    else if (kind === 'air') want = !docked;
    else want = true;
    if (!want) {
      this.releaseRoute(env, r);
      return;
    }
    if (!r.trail && !r.suppressed) {
      // Transports and trade ships: from the port they left. Warships: from where this leg started. Aircraft: from
      // take-off (their base when the sortie began after we saw them docked, else their origin).
      if (kind === 'convoy' || kind === 'trade') this.startTrail(env, r, u, u.originX, u.originY);
      else if (kind === 'air' && tileDistKm(u.originX, u.originY, u.x, u.y) < 2500) this.startTrail(env, r, u, u.originX, u.originY);
      else this.startTrail(env, r, u, u.x, u.y);
    }
    if (r.trail) {
      env.fx.trails.push(r.trail, r.last.x, r.last.y, r.last.z);
      if (r.alert) env.fx.trails.push(r.alert, r.last.x, r.last.y, r.last.z);
      // Trade routes only below 5,000 km.
      if (kind === 'trade') r.trail.opacity = env.altitudeKm < 5000 ? 1 : 0;
    }
    // Planned path ahead (dashed): convoys and sorties always; anything selected or hovered.
    const planned = (kind === 'convoy' || kind === 'air' || this.focus.has(u.id)) && tileDistKm(u.x, u.y, u.targetX, u.targetY) > 30;
    if (planned) {
      if (!r.plan) r.plan = env.fx.trails.start('plan', r.last.x, r.last.y, r.last.z, env.ownerColor(r.owner));
      if (env.now - r.planAt > 0.4) {
        r.planAt = env.now;
        // v2-stub(W2→W4): great circle to the target until W4 publishes the sim's path (TickUpdate.routes).
        const n = this.arc(env, u.x, u.y, u.targetX, u.targetY, Math.max(15, r.segKm), ship, 200);
        pathBuf[0] = r.last.x;
        pathBuf[1] = r.last.y;
        pathBuf[2] = r.last.z;
        env.fx.trails.setPath(r.plan, pathBuf, n);
      }
    } else if (r.plan) {
      env.fx.trails.release(r.plan);
      r.plan = null;
    }
  }

  /** Divisions: a dashed route to their destination with the ETA at its end, on hover and selection only. */
  private readonly divPlans = new Map<number, { plan: Trail; at: number; seen: number; end: THREE.Vector3; eta: string; owner: number }>();
  private division(env: RouteEnv, u: UnitView): void {
    let d = this.divPlans.get(u.id);
    const show = this.focus.has(u.id) && hasDestination(u) && tileDistKm(u.x, u.y, u.targetX, u.targetY) > 15;
    if (!show) {
      if (d) {
        env.fx.trails.release(d.plan);
        this.divPlans.delete(u.id);
      }
      return;
    }
    const here = this.point(env, u.x, u.y, false, V);
    if (!d) {
      d = { plan: env.fx.trails.start('plan', here.x, here.y, here.z, env.ownerColor(u.owner)), at: -1, seen: 0, end: new THREE.Vector3(), eta: '', owner: u.owner };
      this.divPlans.set(u.id, d);
    }
    d.seen = this.gen;
    if (env.now - d.at > 0.4) {
      d.at = env.now;
      const n = this.arc(env, u.x, u.y, u.targetX, u.targetY, 10, false, 200);
      env.fx.trails.setPath(d.plan, pathBuf, n);
      d.end.set(pathBuf[(n - 1) * 3], pathBuf[(n - 1) * 3 + 1], pathBuf[(n - 1) * 3 + 2]);
      d.eta = etaLabel(u);
    }
  }

  /** ETA labels at the end of shown division routes. */
  forEachEta(fn: (p: THREE.Vector3, eta: string, owner: number) => void): void {
    for (const d of this.divPlans.values()) fn(d.end, d.eta, d.owner);
  }

  private releaseRoute(env: RouteEnv, r: Route): void {
    if (r.trail) env.fx.trails.release(r.trail);
    if (r.alert) env.fx.trails.release(r.alert);
    if (r.plan) env.fx.trails.release(r.plan);
    r.trail = r.alert = r.plan = null;
  }

  begin(): void {
    this.gen++;
  }

  /** After all units: release vanished units (red cross if sunk), enforce the budget. */
  end(env: RouteEnv): void {
    for (const [id, d] of this.divPlans) {
      if (d.seen === this.gen) continue;
      env.fx.trails.release(d.plan);
      this.divPlans.delete(id);
    }
    for (const [id, r] of this.routes) {
      if (r.seen === this.gen) continue;
      if (r.lastState === UnitState.Destroyed && r.kind !== 'air') this.crosses.push({ pos: r.last.clone(), until: env.now + 15 });
      // The travelled line stays (convoys 15 s + 5 s fade, trade 6 + 3, warships 8 + 5, sorties 10 + 5); the planned
      // path and the alert outline go at once.
      if (r.trail && !r.suppressed) {
        const [hold, fade] = ENDING[r.kind];
        this.ending.push({ trail: r.trail, unitId: r.unitId, owner: r.owner, at: env.realNow, hold, fade });
        r.trail = null;
      }
      this.releaseRoute(env, r);
      this.routes.delete(id);
    }
    for (let i = this.ending.length - 1; i >= 0; i--) {
      const e = this.ending[i];
      const age = env.realNow - e.at;
      if (age >= e.hold + e.fade) {
        env.fx.trails.kill(e.trail);
        this.ending.splice(i, 1);
      } else e.trail.opacity = age <= e.hold ? 1 : 1 - (age - e.hold) / e.fade;
    }
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
        for (const t of [r.trail, r.alert, r.plan]) if (t) t.opacity = 0;
        this.releaseRoute(env, r);
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
  info(unitId: number, realNow: number): { state: 'live' | 'ending' | 'none'; drawn: boolean; age?: number; opacity?: number; suppressed?: boolean } {
    const r = this.routes.get(unitId);
    if (r) return { state: 'live', drawn: !!r.trail && !r.suppressed, suppressed: r.suppressed };
    const e = this.ending.find((x) => x.unitId === unitId);
    if (e) return { state: 'ending', drawn: e.trail.opacity > 0, age: +(realNow - e.at).toFixed(2), opacity: +e.trail.opacity.toFixed(3) };
    return { state: 'none', drawn: false };
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
