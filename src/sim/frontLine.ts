// FRONT ULTRA — the contact line of a front as ONE smoothed depth offset (DESIGN_V2 §11.5, T41). Owner: W6 (sim side).
// Worker-only, view data: nothing in the simulation reads it back.
//
// The territory changes hands in 25 km tiles, but inside the tile being taken the pressure p/θ (§4.5) says how far the
// attacker has got. The depth of the line is measured over a window 150 km along the front and ±75 km across it,
// sampled every 2.5 km (5 km off the focus): per column across the line, the side-a share of the samples, where a
// sample in a frontier tile under side a's offensive counts p/θ of a sample (and a side-a sample under side b's
// counter-offensive 1 − p/θ). A tile that falls therefore adds nothing it had not already added through its pressure:
// the measured depth moves continuously, not in 25 km steps. The mean over the columns is the raw depth.
//
// The published depth follows the raw one through a critically damped tracker (time constant 5 ticks, speed capped at
// 1.5x the §4.5 cap), integrated so that every tick the line moves exactly its published speed × one tick. The speed
// is therefore the line's own speed by construction: the front badge, the Guerra panel and the HUD strip show it as
// advanceKmh, and the ground battle draws the line gliding from one published depth to the next at that speed.
//
// Where it is measured: at the observation focus (the camera's ground point, every tick) for every front whose line
// passes within 75 km of it; elsewhere on the lead offensive's axis where it crosses the line (every 5 ticks).
// Quiet fronts away from the focus have none.

import { ADVANCE_MAX_KMH, MAP_H, MAP_W, TICKS_PER_GAME_HOUR, TILE_KM } from '../shared/constants';
import type { FrontLine } from '../shared/types';
import type { Front } from './fronts';
import type { Game } from './game';
import { latCos, wdx, wrapXf } from './spatial';
import type { Attack } from './state';

/** Window: half-length along the line and half-depth across it (km). */
export const LINE_HALF_KM = 75;
const LINE_DEPTH_KM = 75;
/** Sample spacing (km) at the focus and elsewhere. */
const STEP_FOCUS_KM = 2.5;
const STEP_AXIS_KM = 5;
/** The focus measures fronts whose line passes within this distance (km). */
const FOCUS_REACH_KM = 75;
/** A new focus more than this far from the one the reference was placed at re-places it (km). */
const FOCUS_MOVE_KM = 10;
/** Off the focus: measured every this many ticks. */
const AXIS_EVERY = 5;
/** Tracker time constants (ticks) at the focus and off it, and the speed cap (km per tick). */
const TAU_TICKS = 5;
const TAU_AXIS_TICKS = 8;
const V_MAX = (ADVANCE_MAX_KMH * 1.5) / TICKS_PER_GAME_HOUR;
/** Once the line is this far from its reference point, the reference moves onto it (km). */
const REBASE_KM = 50;
/** Keep the axis while the front's direction stays within this angle of it (cos 35°). */
const AXIS_KEEP_COS = Math.cos((35 * Math.PI) / 180);

interface LineState {
  /** Reference point (continuous tile coords) and the unit axis in local km (east, north) = side a's advance. */
  x: number;
  y: number;
  e: number;
  n: number;
  /** Published depth of the line from the reference along the axis (km) and its speed (km per tick). */
  L: number;
  V: number;
  /** Last raw depth (km) and the tick it was measured (-1 = never). */
  raw: number;
  tick: number;
  /** Measured at the observation focus, and the focus it was placed for. */
  focus: boolean;
  fx: number;
  fy: number;
}

export class FrontLines {
  private readonly lines = new Map<number, LineState>();

  constructor(private readonly g: Game) {}

  /** After each tick's offensives (FrontTracker.endTick): place, measure and track the line of every front. */
  update(fronts: Iterable<Front>): void {
    const g = this.g;
    const focus = g.observationFocus;
    const seen = new Set<number>();
    for (const f of fronts) {
      if (f.b === 0 || f.samples.length < 2) continue;
      const offA = this.live(f.offensive[0], f.key);
      const offB = this.live(f.offensive[1], f.key);
      let st = this.lines.get(f.key);
      const near = focus ? nearestOnLine(f, focus.x, focus.y) : null;
      const atFocus = !!near && near.km <= FOCUS_REACH_KM;
      if (!atFocus && !offA && !offB) continue;
      seen.add(f.key);
      if (atFocus && focus && near) {
        if (!st || !st.focus || distKm(st.fx, st.fy, focus.x, focus.y) > FOCUS_MOVE_KM) {
          st = this.place(f, near.x, near.y, st, true, focus.x, focus.y);
        }
        this.measure(f, st, offA, offB, STEP_FOCUS_KM);
      } else {
        if (!st || st.focus) {
          const p = axisPoint(f, (offA && offB ? (offA.pa >= offB.pa ? offA : offB) : offA ?? offB)!);
          st = this.place(f, p.x, p.y, st, false, 0, 0);
        }
        if (st.tick >= 0 && (g.tick + f.key) % AXIS_EVERY !== 0) continue;
        this.measure(f, st, offA, offB, STEP_AXIS_KM);
      }
    }
    for (const k of this.lines.keys()) if (!seen.has(k)) this.lines.delete(k);
  }

  /**
   * A new observation focus (the camera came down, or moved): place and read the line of every front near it at once,
   * without advancing time, so the ground battle can stand on it even while the game is paused.
   */
  refreshFocus(fronts: Iterable<Front>): boolean {
    const focus = this.g.observationFocus;
    if (!focus) return false;
    let any = false;
    for (const f of fronts) {
      if (f.b === 0 || f.samples.length < 2) continue;
      const near = nearestOnLine(f, focus.x, focus.y);
      if (near.km > FOCUS_REACH_KM) continue;
      const st = this.lines.get(f.key);
      if (st && st.focus && st.tick >= 0 && distKm(st.fx, st.fy, focus.x, focus.y) <= FOCUS_MOVE_KM) continue;
      const placed = this.place(f, near.x, near.y, st, true, focus.x, focus.y);
      this.measure(f, placed, this.live(f.offensive[0], f.key), this.live(f.offensive[1], f.key), STEP_FOCUS_KM);
      any = true;
    }
    return any;
  }

  /** The published line of a front (null when it has none yet). */
  record(key: number): FrontLine | null {
    const st = this.lines.get(key);
    if (!st || st.tick < 0) return null;
    return {
      x: +st.x.toFixed(4), y: +st.y.toFixed(4), e: +st.e.toFixed(5), n: +st.n.toFixed(5), depthKm: +st.L.toFixed(4),
      halfKm: LINE_HALF_KM, kmh: +(st.V * TICKS_PER_GAME_HOUR).toFixed(3), tick: st.tick, focus: st.focus,
    };
  }

  clear(): void {
    this.lines.clear();
  }

  private live(id: number, key: number): Attack | undefined {
    if (!id) return undefined;
    const a = this.g.attacks.byId(id);
    return a && !a.ended && a.frontKey === key && a.returnAt < 0 ? a : undefined;
  }

  /** (Re)place the reference point; the tracker's speed carries over (the same front, measured elsewhere). */
  private place(f: Front, x: number, y: number, prev: LineState | undefined, focus: boolean, fx: number, fy: number): LineState {
    const c = latCos(y);
    let e = f.dirX * TILE_KM * c, n = -f.dirY * TILE_KM;
    const l = Math.hypot(e, n) || 1;
    e /= l;
    n /= l;
    if (prev && prev.e * e + prev.n * n >= AXIS_KEEP_COS) {
      e = prev.e;
      n = prev.n;
    }
    let V = 0;
    if (prev) V = prev.V * (prev.e * e + prev.n * n);
    else if (!f.offensive[0] !== !f.offensive[1]) V = ((f.offensive[0] ? 1 : -1) * f.advanceKmh) / TICKS_PER_GAME_HOUR;
    const st: LineState = { x, y, e, n, L: 0, V, raw: 0, tick: -1, focus, fx, fy };
    this.lines.set(f.key, st);
    return st;
  }

  private measure(f: Front, st: LineState, offA: Attack | undefined, offB: Attack | undefined, step: number): void {
    const tick = this.g.tick;
    if (st.tick < 0) {
      // First reading: find the line around the reference, then centre the window on it.
      let raw = this.depth(f, st, 0, offA, offB, step);
      if (raw === null) return;
      const r2 = this.depth(f, st, raw, offA, offB, step);
      if (r2 !== null) raw = r2;
      st.L = raw;
      st.raw = raw;
      st.tick = tick;
      return;
    }
    const raw = this.depth(f, st, st.L, offA, offB, step);
    const dt = Math.max(1, Math.min(20, tick - st.tick));
    const w = 1 / (st.focus ? TAU_TICKS : TAU_AXIS_TICKS);
    for (let i = 1; i <= dt; i++) {
      // The reading ramps from the previous one over the ticks since it (off the focus it comes every 5 ticks).
      const target = raw === null ? st.L : st.raw + ((raw - st.raw) * i) / dt;
      // Critically damped: the speed turns toward the reading, then the line moves by exactly that speed.
      const acc = w * w * (target - st.L) - 2 * w * st.V;
      st.V = Math.max(-V_MAX, Math.min(V_MAX, st.V + acc));
      if (raw === null) st.V *= 0.8;
      st.L += st.V;
    }
    if (raw !== null) st.raw = raw;
    st.tick = tick;
    if (Math.abs(st.L) > REBASE_KM) {
      // The line has moved far from its reference: move the reference onto it (the line itself does not move).
      const c = latCos(st.y);
      st.x = wrapXf(st.x + (st.L * st.e) / (TILE_KM * c));
      st.y -= (st.L * st.n) / TILE_KM;
      st.raw -= st.L;
      st.L = 0;
    }
  }

  /**
   * Raw depth (km from the reference along the axis) of the a|b contact over the window centred `c` km along the axis,
   * or null when too few columns cross the line inside it (sea, third parties, the line out of the window).
   */
  private depth(f: Front, st: LineState, c: number, offA: Attack | undefined, offB: Attack | undefined, step: number): number | null {
    const g = this.g;
    const owner = g.owner;
    const a = f.a, b = f.b;
    const kmX = TILE_KM * latCos(st.y), kmY = TILE_KM;
    const nCols = Math.round((2 * LINE_HALF_KM) / step) + 1;
    const nRows = Math.round((2 * LINE_DEPTH_KM) / step) + 1;
    const d0 = c - LINE_DEPTH_KM;
    let sum = 0, cols = 0;
    for (let i = 0; i < nCols; i++) {
      const u = -LINE_HALF_KM + i * step;
      let nab = 0, wa = 0;
      for (let j = 0; j < nRows; j++) {
        const d = d0 + j * step;
        const east = d * st.e - u * st.n, north = d * st.n + u * st.e;
        const y = st.y - north / kmY;
        if (y < 0 || y >= MAP_H) continue;
        const x = st.x + east / kmX;
        const tx = ((Math.floor(x) % MAP_W) + MAP_W) % MAP_W;
        const t = Math.floor(y) * MAP_W + tx;
        const o = owner[t];
        if (o === a) {
          nab++;
          let w = 1;
          if (offB) {
            const p = offB.pressure.get(t);
            if (p !== undefined) w = 1 - Math.min(1, p / (offB.theta.get(t) ?? 1));
          }
          wa += w;
        } else if (o === b) {
          nab++;
          if (offA) {
            const p = offA.pressure.get(t);
            if (p !== undefined) wa += Math.min(1, p / (offA.theta.get(t) ?? 1));
          }
        }
      }
      // Mostly sea or third parties, or the line is not inside this column's window: no reading here.
      if (nab < 0.75 * nRows || wa < 0.5 || wa > nab - 0.5) continue;
      sum += d0 + ((wa * nRows) / nab) * step - step / 2;
      cols++;
    }
    return cols >= Math.max(3, nCols * 0.3) ? sum / cols : null;
  }
}

function distKm(ax: number, ay: number, bx: number, by: number): number {
  const c = latCos((ay + by) * 0.5);
  return Math.hypot(wdx(ax, bx) * TILE_KM * c, (by - ay) * TILE_KM);
}

/** The point of the front's tile-level contact line (half a tile ahead of side a's contact tiles) nearest to (px, py). */
export function nearestOnLine(f: Front, px: number, py: number): { x: number; y: number; km: number } {
  const s = f.samples;
  const n = s.length >> 1;
  const c = latCos(py);
  const ox = f.dirX * 0.5, oy = f.dirY * 0.5;
  let best = Infinity, bx = s[0] + ox, by = s[1] + oy;
  for (let i = 0; i < n; i++) {
    const i1 = Math.min(n - 1, i + 1);
    const ax = px + wdx(px, s[i * 2] + ox), ay = s[i * 2 + 1] + oy;
    const qx = ax + wdx(ax, s[i1 * 2] + ox), qy = s[i1 * 2 + 1] + oy;
    // Local km relative to (px, py).
    const x0 = (ax - px) * TILE_KM * c, y0 = (ay - py) * TILE_KM;
    const dx = (qx - ax) * TILE_KM * c, dy = (qy - ay) * TILE_KM;
    const L2 = dx * dx + dy * dy;
    const t = L2 > 1e-9 ? Math.max(0, Math.min(1, -(x0 * dx + y0 * dy) / L2)) : 0;
    const ex = x0 + dx * t, ey = y0 + dy * t;
    const d = Math.hypot(ex, ey);
    if (d < best) {
      best = d;
      bx = wrapXf(px + ex / (TILE_KM * c));
      by = py + ey / TILE_KM;
    }
  }
  return { x: bx, y: by, km: best };
}

/** Where the offensive's axis (origin → axis point) crosses the front's contact line; the line's middle without one. */
function axisPoint(f: Front, a: Attack | undefined): { x: number; y: number } {
  const s = f.samples;
  const n = s.length >> 1;
  let m = n >> 1;
  if (a && a.originX >= 0 && a.clickX >= 0) {
    const c = latCos(a.originY);
    let ux = wdx(a.originX, a.clickX) * c, uy = a.clickY - a.originY;
    const ul = Math.hypot(ux, uy);
    if (ul > 1e-6) {
      ux /= ul;
      uy /= ul;
      let best = Infinity;
      for (let v = 0; v < n; v++) {
        const rx = wdx(a.originX, s[v * 2]) * c, ry = s[v * 2 + 1] - a.originY;
        const perp = Math.abs(rx * uy - ry * ux);
        if (perp < best) {
          best = perp;
          m = v;
        }
      }
    }
  }
  return { x: wrapXf(s[m * 2] + f.dirX * 0.5), y: s[m * 2 + 1] + f.dirY * 0.5 };
}
