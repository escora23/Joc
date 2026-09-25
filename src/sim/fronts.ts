// FRONT ULTRA — fronts (DESIGN_V2 §4.3, §4.4, §14.2). Owner: sim-core (W1). Worker-only.
//
// A front is a contiguous contact zone between two players at war. Fronts exist for every war, even when nobody
// attacks (quiet fronts), and each has a STABLE key: after clustering, a new cluster is matched to the previous clusters
// of the same pair by centroid distance, so the badge, the panels and the offensives keep referring to the same front.
//
// Garrisons (§4.4): a player's field troops, troops × (1 − DEFENSE_REAR_SHARE), are spread over ALL its fronts at war by
// a share per front. The target share is weight × length over the sum of its fronts, weight = priority (baja 0.5,
// normal 1, alta 2) × 2 while an enemy offensive is active there. The share moves toward its target by
// 1/DEFENSE_REDEPLOY_TICKS of the gap per tick, so troops do not teleport to the front that is hit: a defender who read
// the enemy's mobilization and raised the front in time already has its troops there. A front that exists when the
// war is declared starts at its target share; a front created later (a landing, new contact) starts at 0. The
// mobilization factor mob_f ramps 0.5 → 1 over DEFENSE_MOBILIZE_TICKS from the declaration (or the front's creation).
//
// Gf = troops × (1 − rear share) × share × mob_f is published for both sides of every front (garrisonA/B), with the
// polyline of the contact, momentum, the measured advance and, near the observation focus, per-vertex progress.

import {
  ATTACKED_FRONT_WEIGHT, DEFENSE_MOBILIZE_TICKS, DEFENSE_REAR_SHARE, DEFENSE_REDEPLOY_TICKS, FRONT_PRIORITY_WEIGHT, MAP_W,
} from '../shared/constants';
import type { FrontRecord } from '../shared/protocol';
import type { Game } from './game';
import { neighbors4 } from './game';
import type { SaveReader, SaveWriter } from './save';
import type { Attack } from './state';
import { wdx, wrapXf } from './spatial';
import type { War } from './war';

const CELL = 6;
const CW = Math.ceil(MAP_W / CELL);
const MAX_CONTACT = 8000;
const MAX_SAMPLES = 64;
const MAX_CLUSTERS_PER_PAIR = 16;
/** Quiet fronts are recomputed every 20 ticks, fronts with an offensive every 5 (§14.2). */
const QUIET_EVERY = 20;
const ACTIVE_EVERY = 5;
/** Match radius (tiles) for stable keys. */
const MATCH_DIST = 8;

export interface Front {
  key: number;
  /** Sides (a = the war's aggressor). */
  a: number;
  b: number;
  war: number;
  x: number;
  y: number;
  /** Contact length in tiles (L of §4.4). */
  length: number;
  dirX: number;
  dirY: number;
  samples: number[];
  startTick: number;
  mobStart: [number, number];
  share: [number, number];
  target: [number, number];
  priority: [number, number];
  casualties: [number, number];
  /** EMA of tiles fallen per tick to each side on this front. */
  gain: [number, number];
  offensive: [number, number];
  advanceKmh: number;
  intensity: number;
  /** Tick the geometry was last refreshed. */
  seenTick: number;
}

interface Cluster {
  x: number;
  y: number;
  length: number;
  dirX: number;
  dirY: number;
  samples: number[];
}

const pairKey = (a: number, b: number): number => (a < b ? a * 4096 + b : b * 4096 + a);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export class FrontTracker {
  dirty = false;
  private readonly fronts = new Map<number, Front>();
  private readonly byPair = new Map<number, Front[]>();
  /** Priority set by a side on a front key: (player * 2^20 + key) -> 0/1/2 (survives re-clustering). */
  private readonly priorities = new Map<number, number>();
  private nextKey = 1;
  private readonly lastPairUpdate = new Map<number, number>();
  private readonly nb = new Int32Array(4);

  constructor(private readonly g: Game) {}

  // =================================================================================================
  // Queries (attacks, AI, views)
  // =================================================================================================
  get(key: number): Front | undefined {
    return this.fronts.get(key);
  }

  all(): IterableIterator<Front> {
    return this.fronts.values();
  }

  frontsOfPair(a: number, b: number): readonly Front[] {
    return this.byPair.get(pairKey(a, b)) ?? EMPTY;
  }

  frontsOf(p: number): Front[] {
    const out: Front[] = [];
    for (const f of this.fronts.values()) if (f.a === p || f.b === p) out.push(f);
    return out;
  }

  /** Garrison Gf of `p` on front `f` (troops), §4.4. */
  garrison(f: Front, p: number): number {
    const P = this.g.playerById[p];
    if (!P) return 0;
    const s = f.a === p ? 0 : 1;
    return P.troops * (1 - DEFENSE_REAR_SHARE) * f.share[s] * this.mob(f, s);
  }

  mob(f: Front, s: 0 | 1): number {
    return clamp(0.5 + 0.5 * ((this.g.tick - f.mobStart[s]) / DEFENSE_MOBILIZE_TICKS), 0.5, 1);
  }

  /** The front of the pair nearest to (x, y) (computing the pair now if it has no fronts yet). */
  frontAt(a: number, b: number, x: number, y: number): Front | undefined {
    let list = this.byPair.get(pairKey(a, b));
    if (!list || list.length === 0) {
      const w = this.g.war.between(a, b);
      if (w) this.updatePair(w, true);
      list = this.byPair.get(pairKey(a, b));
    }
    if (!list || list.length === 0) return undefined;
    let best: Front | undefined, bd = Infinity;
    for (const f of list) {
      for (let i = 0; i < f.samples.length; i += 2) {
        const dx = wdx(x, f.samples[i]), dy = f.samples[i + 1] - y;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = f;
        }
      }
    }
    return best;
  }

  setPriority(p: number, key: number, priority: 0 | 1 | 2): boolean {
    const f = this.fronts.get(key);
    if (!f || (f.a !== p && f.b !== p)) return false;
    f.priority[f.a === p ? 0 : 1] = priority;
    this.priorities.set(p * 1_048_576 + key, priority);
    this.retarget();
    this.dirty = true;
    return true;
  }

  // =================================================================================================
  // War hooks
  // =================================================================================================
  onWarDeclared(w: War): void {
    // Fronts that exist at the declaration start at their target share and mobilize from now.
    this.updatePair(w, true);
    this.retarget();
    for (const f of this.frontsOfPair(w.a, w.b)) {
      f.share[0] = f.target[0];
      f.share[1] = f.target[1];
    }
    this.dirty = true;
  }

  onWarEnded(w: War): void {
    const list = this.byPair.get(pairKey(w.a, w.b));
    if (list) for (const f of list) this.fronts.delete(f.key);
    this.byPair.delete(pairKey(w.a, w.b));
    this.retarget();
    this.dirty = true;
  }

  // =================================================================================================
  // Tick
  // =================================================================================================
  /** Every tick: garrisons redeploy toward their targets; geometry refreshes on its cadence. */
  step(): void {
    const g = this.g;
    const tick = g.tick;
    let geometry = false;
    for (const w of g.war.list()) {
      const k = pairKey(w.a, w.b);
      const last = this.lastPairUpdate.get(k) ?? -1_000_000;
      const active = g.attacks.activeBetween(w.a, w.b);
      if (tick - last >= (active ? ACTIVE_EVERY : QUIET_EVERY)) {
        this.updatePair(w, false);
        geometry = true;
      }
    }
    if (geometry) this.retarget();
    // Offensive weights change the targets as soon as an offensive starts or ends.
    else if (tick % ACTIVE_EVERY === 0) this.retarget();
    const k = 1 / DEFENSE_REDEPLOY_TICKS;
    for (const f of this.fronts.values()) {
      f.share[0] += (f.target[0] - f.share[0]) * k;
      f.share[1] += (f.target[1] - f.share[1]) * k;
    }
    if (geometry) this.dirty = true;
    // Observation time: sub-tile progress near the focus changes every tick.
    if (g.observationFocus && this.fronts.size > 0) this.dirty = true;
  }

  /** Target shares of every player over all its fronts (weight × length, §4.4). */
  private retarget(): void {
    const g = this.g;
    const sum = new Map<number, number>();
    const weightOf = (f: Front, s: 0 | 1): number => {
      const enemyOff = f.offensive[s === 0 ? 1 : 0];
      const under = enemyOff !== 0 && g.attacks.isActive(enemyOff);
      return FRONT_PRIORITY_WEIGHT[f.priority[s]] * (under ? ATTACKED_FRONT_WEIGHT : 1) * f.length;
    };
    for (const f of this.fronts.values()) {
      sum.set(f.a, (sum.get(f.a) ?? 0) + weightOf(f, 0));
      sum.set(f.b, (sum.get(f.b) ?? 0) + weightOf(f, 1));
    }
    for (const f of this.fronts.values()) {
      f.target[0] = weightOf(f, 0) / Math.max(1e-9, sum.get(f.a) ?? 1);
      f.target[1] = weightOf(f, 1) / Math.max(1e-9, sum.get(f.b) ?? 1);
    }
  }

  /** Recompute the contact clusters of a war pair and match them to the previous fronts (stable keys). */
  private updatePair(w: War, atDeclaration: boolean): void {
    const g = this.g;
    const k = pairKey(w.a, w.b);
    this.lastPairUpdate.set(k, g.tick);
    const clusters = this.clusters(w.a, w.b);
    const prev = this.byPair.get(k) ?? [];
    const next: Front[] = [];
    const used = new Set<Front>();
    // Greedy matching by centroid distance (largest clusters first).
    for (const c of clusters) {
      let best: Front | undefined, bd = MATCH_DIST * MATCH_DIST;
      for (const f of prev) {
        if (used.has(f)) continue;
        const dx = wdx(c.x, f.x), dy = f.y - c.y;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = f;
        }
      }
      if (best) {
        used.add(best);
        best.x = c.x;
        best.y = c.y;
        best.length = c.length;
        best.dirX = c.dirX;
        best.dirY = c.dirY;
        best.samples = c.samples;
        best.seenTick = g.tick;
        next.push(best);
        continue;
      }
      // A new front: inherit the garrison of an old one it split from (nearby), else start empty (§4.4).
      let parent: Front | undefined, pd = (MATCH_DIST * 2) ** 2;
      for (const f of prev) {
        const dx = wdx(c.x, f.x), dy = f.y - c.y;
        const d = dx * dx + dy * dy;
        if (d < pd) {
          pd = d;
          parent = f;
        }
      }
      const key = this.nextKey++;
      const f: Front = {
        key, a: w.a, b: w.b, war: w.id, x: c.x, y: c.y, length: c.length, dirX: c.dirX, dirY: c.dirY, samples: c.samples,
        startTick: g.tick, mobStart: atDeclaration ? [w.startTick, w.startTick] : [g.tick, g.tick],
        share: [0, 0], target: [0, 0],
        priority: [this.priorities.get(w.a * 1_048_576 + key) ?? 1, this.priorities.get(w.b * 1_048_576 + key) ?? 1],
        casualties: [0, 0], gain: [0, 0], offensive: [0, 0], advanceKmh: 0, intensity: 0.05, seenTick: g.tick,
      };
      if (parent) {
        f.share = [parent.share[0] * 0.5, parent.share[1] * 0.5];
        parent.share[0] *= 0.5;
        parent.share[1] *= 0.5;
        f.mobStart = [...parent.mobStart];
        f.priority = [...parent.priority];
        f.startTick = parent.startTick;
      }
      this.fronts.set(key, f);
      next.push(f);
    }
    // Fronts that vanished give their garrison share back to the ones that remain (they redeploy).
    for (const f of prev) if (!used.has(f)) this.fronts.delete(f.key);
    if (next.length) this.byPair.set(k, next);
    else this.byPair.delete(k);
  }

  /** Contact tiles of side a (its border tiles touching b), clustered on a coarse grid (8-connected cells). */
  private clusters(a: number, b: number): Cluster[] {
    const g = this.g;
    const A = g.playerById[a];
    if (!A) return [];
    const owner = g.owner, nb = this.nb;
    const tx: number[] = [], ty: number[] = [], dxs: number[] = [], dys: number[] = [];
    const stride = Math.max(1, Math.floor(A.border.size / MAX_CONTACT));
    let i = 0;
    for (const t of A.border) {
      if (i++ % stride !== 0) continue;
      const n = neighbors4(t, nb);
      let ddx = 0, ddy = 0, touch = false;
      const x = t % MAP_W, y = (t / MAP_W) | 0;
      for (let k = 0; k < n; k++) {
        const q = nb[k];
        if (owner[q] !== b) continue;
        touch = true;
        ddx += wdx(x, q % MAP_W);
        ddy += ((q / MAP_W) | 0) - y;
      }
      if (!touch) continue;
      tx.push(x + 0.5);
      ty.push(y + 0.5);
      dxs.push(ddx);
      dys.push(ddy);
    }
    const total = tx.length;
    if (total === 0) return [];
    const cellOf = new Map<number, number[]>();
    for (let k = 0; k < total; k++) {
      const c = Math.floor(ty[k] / CELL) * CW + Math.floor(tx[k] / CELL);
      let l = cellOf.get(c);
      if (!l) cellOf.set(c, (l = []));
      l.push(k);
    }
    const seen = new Set<number>();
    const groups: number[][] = [];
    for (const c of cellOf.keys()) {
      if (seen.has(c)) continue;
      const members: number[] = [];
      const stack = [c];
      seen.add(c);
      while (stack.length) {
        const cur = stack.pop()!;
        for (const m of cellOf.get(cur)!) members.push(m);
        const cx = cur % CW, cy = Math.floor(cur / CW);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const ncell = (cy + dy) * CW + ((cx + dx + CW) % CW);
            if (cellOf.has(ncell) && !seen.has(ncell)) {
              seen.add(ncell);
              stack.push(ncell);
            }
          }
        }
      }
      groups.push(members);
    }
    groups.sort((p, q) => q.length - p.length || tx[p[0]] - tx[q[0]]);
    const out: Cluster[] = [];
    for (const m of groups) {
      if (out.length >= MAX_CLUSTERS_PER_PAIR) break;
      out.push(this.shape(m, tx, ty, dxs, dys, stride));
    }
    return out;
  }

  /** Centroid, advance direction and a PCA-ordered polyline (<= 64 points) of one contact cluster. */
  private shape(m: number[], tx: number[], ty: number[], dxs: number[], dys: number[], stride: number): Cluster {
    const x0 = tx[m[0]];
    let mx = 0, my = 0;
    for (const k of m) {
      mx += x0 + wdx(x0, tx[k]);
      my += ty[k];
    }
    mx /= m.length;
    my /= m.length;
    let cxx = 0, cyy = 0, cxy = 0, dirX = 0, dirY = 0;
    for (const k of m) {
      const ux = x0 + wdx(x0, tx[k]) - mx, uy = ty[k] - my;
      cxx += ux * ux;
      cyy += uy * uy;
      cxy += ux * uy;
      dirX += dxs[k];
      dirY += dys[k];
    }
    const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const ax = Math.cos(th), ay = Math.sin(th);
    let lo = Infinity, hi = -Infinity;
    const proj = new Float64Array(m.length);
    for (let j = 0; j < m.length; j++) {
      const k = m[j];
      const pr = (x0 + wdx(x0, tx[k]) - mx) * ax + (ty[k] - my) * ay;
      proj[j] = pr;
      if (pr < lo) lo = pr;
      if (pr > hi) hi = pr;
    }
    const span = Math.max(1e-6, hi - lo);
    const bins = Math.max(2, Math.min(MAX_SAMPLES, Math.ceil(span / 1.5) + 1));
    const bx = new Float64Array(bins), by = new Float64Array(bins), bn = new Float64Array(bins);
    for (let j = 0; j < m.length; j++) {
      const k = m[j];
      const b = Math.min(bins - 1, Math.floor(((proj[j] - lo) / span) * bins));
      bx[b] += x0 + wdx(x0, tx[k]);
      by[b] += ty[k];
      bn[b]++;
    }
    const samples: number[] = [];
    for (let b = 0; b < bins; b++) {
      if (bn[b] === 0) continue;
      samples.push(wrapXf(bx[b] / bn[b]), by[b] / bn[b]);
    }
    if (samples.length < 4) samples.push(samples[0] + 0.01, samples[1] + 0.01);
    const dl = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
    return { x: wrapXf(mx), y: my, length: m.length * stride, dirX: dirX / dl, dirY: dirY / dl, samples };
  }

  /** Called by the attack system after each tick: offensives, casualties and gains per front. */
  noteOffensive(a: Attack, lostA: number, lostD: number): void {
    const f = this.fronts.get(a.frontKey);
    if (!f) return;
    const s = f.a === a.attacker ? 0 : 1;
    f.offensive[s] = a.id;
    f.casualties[s] += lostA;
    f.casualties[s === 0 ? 1 : 0] += lostD;
    f.advanceKmh = Math.max(f.advanceKmh * 0.98, a.advanceKmh);
  }

  /** Per-tick bookkeeping of the offensives on each front (momentum, intensity, offensive ids). */
  endTick(): void {
    const g = this.g;
    for (const f of this.fronts.values()) {
      let ga = 0, gb = 0, heat = 0, hasA = 0, hasB = 0;
      for (const s of [0, 1] as const) {
        const id = f.offensive[s];
        if (!id) continue;
        const a = g.attacks.byId(id);
        if (!a || a.ended || a.frontKey !== f.key) {
          f.offensive[s] = 0;
          continue;
        }
        if (s === 0) {
          ga += a.conqueredThisTick;
          hasA = a.id;
        } else {
          gb += a.conqueredThisTick;
          hasB = a.id;
        }
        heat = Math.max(heat, Math.min(1, 0.25 + Math.log10(1 + a.lossEma) / 4.2 + Math.min(0.3, a.conquestEma * 2)));
      }
      f.offensive = [hasA, hasB];
      f.gain[0] = f.gain[0] * 0.95 + ga * 0.05;
      f.gain[1] = f.gain[1] * 0.95 + gb * 0.05;
      f.intensity = hasA || hasB ? Math.max(0.15, heat) : 0.05;
      if (!hasA && !hasB) f.advanceKmh *= 0.9;
    }
  }

  // =================================================================================================
  // Views
  // =================================================================================================
  take(): FrontRecord[] {
    this.dirty = false;
    const g = this.g;
    const out: FrontRecord[] = [];
    const focus = g.observationFocus;
    for (const f of this.fronts.values()) {
      const ga = this.garrison(f, f.a), gb = this.garrison(f, f.b);
      const offA = f.offensive[0] ? g.attacks.byId(f.offensive[0]) : undefined;
      const offB = f.offensive[1] ? g.attacks.byId(f.offensive[1]) : undefined;
      const lead = offA && offB ? (offA.pa >= offB.pa ? offA : offB) : offA ?? offB;
      const mid = Math.floor(f.samples.length / 4) * 2;
      const rec: FrontRecord = {
        id: f.key, key: f.key, a: f.a, b: f.b, x: f.samples[mid] ?? f.x, y: f.samples[mid + 1] ?? f.y,
        intensity: f.intensity, troopsA: Math.round(ga + (offA?.troops ?? 0)), troopsB: Math.round(gb + (offB?.troops ?? 0)),
        length: f.length, dirX: f.dirX, dirY: f.dirY, samples: Float32Array.from(f.samples),
        momentum: Math.tanh(5 * (f.gain[0] - f.gain[1])), advanceKmh: +f.advanceKmh.toFixed(2), startTick: f.startTick,
        pa: Math.round(lead?.pa ?? 0), pd: Math.round(lead?.pd ?? 0), garrisonA: Math.round(ga), garrisonB: Math.round(gb),
        shareA: +f.share[0].toFixed(3), shareB: +f.share[1].toFixed(3), targetShareA: +f.target[0].toFixed(3),
        targetShareB: +f.target[1].toFixed(3), priorityA: f.priority[0], priorityB: f.priority[1],
        casualtiesA: Math.round(f.casualties[0]), casualtiesB: Math.round(f.casualties[1]),
        divisionsA: g.attacks.divisionsNear(f.a, f), divisionsB: g.attacks.divisionsNear(f.b, f),
        quiet: !offA && !offB, offensiveA: offA?.id ?? 0, offensiveB: offB?.id ?? 0,
      };
      if (focus && (offA || offB)) {
        const near = this.progressNear(f, focus.x, focus.y, offA ?? offB!);
        if (near) rec.progress = near;
      }
      out.push(rec);
    }
    return out;
  }

  /** Per polyline vertex: pressure progress (p / θ × 255) of the frontier tile nearest to it (within 150 km). */
  private progressNear(f: Front, fx: number, fy: number, a: Attack): Uint8Array | null {
    let close = false;
    for (let i = 0; i < f.samples.length; i += 2) {
      const dx = wdx(fx, f.samples[i]), dy = f.samples[i + 1] - fy;
      if (dx * dx + dy * dy < 36) {
        close = true;
        break;
      }
    }
    if (!close) return null;
    const n = f.samples.length / 2;
    const out = new Uint8Array(n);
    for (let v = 0; v < n; v++) {
      const vx = f.samples[v * 2], vy = f.samples[v * 2 + 1];
      let best = -1, bd = 4;
      for (const [t, p] of a.pressure) {
        const dx = wdx(vx, (t % MAP_W) + 0.5), dy = ((t / MAP_W) | 0) + 0.5 - vy;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = Math.min(1, p / (a.theta.get(t) ?? 1));
        }
      }
      out[v] = best < 0 ? 0 : Math.round(best * 255);
    }
    return out;
  }

  // =================================================================================================
  // Save
  // =================================================================================================
  serialize(w: SaveWriter): void {
    w.section('fronts');
    w.json({
      fronts: [...this.fronts.values()], pairs: [...this.byPair].map(([k, l]) => [k, l.map((f) => f.key)]),
      priorities: [...this.priorities], nextKey: this.nextKey, last: [...this.lastPairUpdate],
    });
  }

  restore(r: SaveReader): void {
    r.section('fronts');
    const d = r.json<{ fronts: Front[]; pairs: [number, number[]][]; priorities: [number, number][]; nextKey: number; last: [number, number][] }>();
    this.fronts.clear();
    this.byPair.clear();
    for (const f of d.fronts) this.fronts.set(f.key, f);
    for (const [k, keys] of d.pairs) this.byPair.set(k, keys.map((key) => this.fronts.get(key)!).filter(Boolean));
    this.priorities.clear();
    for (const [k, v] of d.priorities) this.priorities.set(k, v);
    this.lastPairUpdate.clear();
    for (const [k, v] of d.last) this.lastPairUpdate.set(k, v);
    this.nextKey = d.nextKey;
    this.dirty = true;
  }
}

const EMPTY: readonly Front[] = [];
