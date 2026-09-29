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
// Where it is measured (W6 final fix pass): every front with a live offensive has ONE line on that offensive's LIVE axis
// (where its axis ray meets its frontier now, Attack.liveX/Y, not where it started), over a window as wide as its
// corridor (25-75 km each side), re-placed when the advance drifts sideways from it: the front's advanceKmh is that
// line's speed, so a front that is taking tiles never reads 0 km/h however far it has gone. With the observation focus
// inside that window the same line is measured every tick at the finer step and the ground battle stands on it; a
// focus elsewhere on the front (or on a quiet front) gets its own line for the battle, and the front's advanceKmh stays
// the offensive's. Quiet fronts away from the focus have none.

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
/** Window half-length on an offensive's axis: its corridor's half width, within these bounds (km). */
const AXIS_HALF_MIN_KM = 25;
/** Consecutive empty readings after which the line's speed is not trusted (the front reports the fallen area's rate). */
const NULL_LIMIT = 2;

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
  /** Window half-length along the line (km). */
  half: number;
  /** Consecutive readings with no line inside the window. */
  nulls: number;
}

export class FrontLines {
  /** Lines at the observation focus away from an offensive's axis (and on quiet fronts): the ground battle's line. */
  private readonly lines = new Map<number, LineState>();
  /** The line on each front's lead offensive's live axis: the front's advanceKmh (and its line when no focus is apart). */
  private readonly axes = new Map<number, LineState>();

  constructor(private readonly g: Game) {}

  /** After each tick's offensives (FrontTracker.endTick): place, measure and track the line of every front. */
  update(fronts: Iterable<Front>): void {
    const g = this.g;
    const focus = g.observationFocus;
    const seenF = new Set<number>(), seenA = new Set<number>();
    for (const f of fronts) {
      if (f.b === 0 || f.samples.length < 2) continue;
      const offA = this.live(f.offensive[0], f.key);
      const offB = this.live(f.offensive[1], f.key);
      const lead = offA && offB ? (offA.pa >= offB.pa ? offA : offB) : offA ?? offB;
      const near = focus ? nearestOnLine(f, focus.x, focus.y) : null;
      const atFocus = !!near && near.km <= FOCUS_REACH_KM;
      let shared = false;
      if (lead) {
        seenA.add(f.key);
        const p = axisPoint(f, lead);
        const half = axisHalfKm(lead);
        let st = this.axes.get(f.key);
        if (!st || lateralKm(st, p.x, p.y) > Math.max(AXIS_HALF_MIN_KM, st.half * 0.5) || Math.abs(st.half - half) > 10) {
          st = this.place(this.axes, f, p.x, p.y, st ?? this.lines.get(f.key), false, 0, 0, half);
        }
        // The focus inside this window: the same line, measured every tick (the battle stands on it).
        shared = atFocus && !!near && lateralKm(st, near.x, near.y) <= st.half - 3;
        st.focus = shared;
        if (shared && focus) {
          st.fx = focus.x;
          st.fy = focus.y;
          this.measure(f, st, offA, offB, STEP_FOCUS_KM);
        } else if (st.tick < 0 || (g.tick + f.key) % AXIS_EVERY === 0) this.measure(f, st, offA, offB, STEP_AXIS_KM);
      }
      if (atFocus && !shared && focus && near) {
        seenF.add(f.key);
        let st = this.lines.get(f.key);
        if (!st || distKm(st.fx, st.fy, focus.x, focus.y) > FOCUS_MOVE_KM) {
          st = this.place(this.lines, f, near.x, near.y, st, true, focus.x, focus.y, LINE_HALF_KM);
        }
        this.measure(f, st, offA, offB, STEP_FOCUS_KM);
      }
    }
    for (const k of this.lines.keys()) if (!seenF.has(k)) this.lines.delete(k);
    for (const k of this.axes.keys()) if (!seenA.has(k)) this.axes.delete(k);
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
      const offA = this.live(f.offensive[0], f.key), offB = this.live(f.offensive[1], f.key);
      const ax = this.axes.get(f.key);
      if (ax && ax.tick >= 0 && lateralKm(ax, near.x, near.y) <= ax.half - 3) {
        // Inside the offensive's window: that line is the battle's; read it now at the fine step.
        ax.focus = true;
        ax.fx = focus.x;
        ax.fy = focus.y;
        this.lines.delete(f.key);
        continue;
      }
      const st = this.lines.get(f.key);
      if (st && st.tick >= 0 && distKm(st.fx, st.fy, focus.x, focus.y) <= FOCUS_MOVE_KM) continue;
      const placed = this.place(this.lines, f, near.x, near.y, st ?? ax, true, focus.x, focus.y, LINE_HALF_KM);
      this.measure(f, placed, offA, offB, STEP_FOCUS_KM);
      any = true;
    }
    return any;
  }

  /** The published line of a front: at the focus when one is apart from the offensive's axis, else the axis line. */
  record(key: number): FrontLine | null {
    const st = this.lines.get(key) ?? this.axes.get(key);
    if (!st || st.tick < 0) return null;
    return {
      x: +st.x.toFixed(4), y: +st.y.toFixed(4), e: +st.e.toFixed(5), n: +st.n.toFixed(5), depthKm: +st.L.toFixed(4),
      halfKm: st.half, kmh: +(st.V * TICKS_PER_GAME_HOUR).toFixed(3), tick: st.tick, focus: st.focus,
    };
  }

  /**
   * The front's measured advance (km/h, signed: + side a gains): its lead offensive's axis line, else its focus line;
   * null when there is none or it has not found the line lately (the front then reports the fallen area's rate).
   */
  kmh(key: number): number | null {
    const st = this.axes.get(key) ?? this.lines.get(key);
    if (!st || st.tick < 0 || st.nulls >= NULL_LIMIT) return null;
    return st.V * TICKS_PER_GAME_HOUR;
  }

  clear(): void {
    this.lines.clear();
    this.axes.clear();
  }

  private live(id: number, key: number): Attack | undefined {
    if (!id) return undefined;
    const a = this.g.attacks.byId(id);
    return a && !a.ended && a.frontKey === key && a.returnAt < 0 ? a : undefined;
  }

  /**
   * (Re)place the reference point on the tile-level line at (x, y), its axis the line's local normal toward side b; the
   * tracker's speed carries over (the same front, measured elsewhere).
   */
  private place(map: Map<number, LineState>, f: Front, x: number, y: number, prev: LineState | undefined, focus: boolean, fx: number, fy: number, half: number): LineState {
    const nrm = localNormal(f, x, y);
    let e = nrm.e, n = nrm.n;
    if (prev && prev.e * e + prev.n * n >= AXIS_KEEP_COS) {
      e = prev.e;
      n = prev.n;
    }
    let V = 0;
    if (prev) V = prev.V * (prev.e * e + prev.n * n);
    else if (!f.offensive[0] !== !f.offensive[1]) V = ((f.offensive[0] ? 1 : -1) * f.advanceKmh) / TICKS_PER_GAME_HOUR;
    const st: LineState = { x, y, e, n, L: 0, V, raw: 0, tick: -1, focus, fx, fy, half, nulls: 0 };
    map.set(f.key, st);
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
    st.nulls = raw === null ? st.nulls + 1 : 0;
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
    const nCols = Math.round((2 * st.half) / step) + 1;
    const nRows = Math.round((2 * LINE_DEPTH_KM) / step) + 1;
    const d0 = c - LINE_DEPTH_KM;
    let sum = 0, cols = 0;
    for (let i = 0; i < nCols; i++) {
      const u = -st.half + i * step;
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

/**
 * Where the offensive fights on the front's contact line: the point of the tile-level line nearest to its live contact
 * (Attack.liveX/Y, where its axis ray meets its frontier now); before it has one, where the ray from its origin through
 * its axis point crosses the line; the line's middle without either.
 */
function axisPoint(f: Front, a: Attack | undefined): { x: number; y: number } {
  if (a && a.liveX >= 0) {
    const p = nearestOnLine(f, a.liveX, a.liveY);
    return { x: p.x, y: p.y };
  }
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
        const perp = Math.abs(rx * uy - ry * ux) + (rx * ux + ry * uy < -2 ? 50 : 0);
        if (perp < best) {
          best = perp;
          m = v;
        }
      }
    }
  }
  return { x: wrapXf(s[m * 2] + f.dirX * 0.5), y: s[m * 2 + 1] + f.dirY * 0.5 };
}

/** Window half-length on an offensive's axis: half its corridor (km), within 25-75 km. */
function axisHalfKm(a: Attack): number {
  return Math.round(Math.max(AXIS_HALF_MIN_KM, Math.min(LINE_HALF_KM, (a.frontage * TILE_KM) / 2)));
}

/** Distance (km) along the state's line, sideways from where its line is now, to the point (x, y). */
function lateralKm(st: LineState, x: number, y: number): number {
  const c = latCos(st.y);
  const ex = wdx(st.x, x) * TILE_KM * c - st.L * st.e, ny = (st.y - y) * TILE_KM - st.L * st.n;
  return Math.abs(-ex * st.n + ny * st.e);
}

/**
 * The line's local normal toward side b (unit, local km east/north) near (x, y): perpendicular to the polyline over
 * about ±4 vertices (±6 tiles, the window's length) around its nearest vertex; the front's mean direction as fallback.
 */
function localNormal(f: Front, x: number, y: number): { e: number; n: number } {
  const c = latCos(y);
  let fe = f.dirX * TILE_KM * c, fn = -f.dirY * TILE_KM;
  const fl = Math.hypot(fe, fn) || 1;
  fe /= fl;
  fn /= fl;
  const s = f.samples;
  const nv = s.length >> 1;
  if (nv < 3) return { e: fe, n: fn };
  let m = 0, bd = Infinity;
  for (let v = 0; v < nv; v++) {
    const dx = wdx(x, s[v * 2]) * c, dy = s[v * 2 + 1] - y;
    const d = dx * dx + dy * dy;
    if (d < bd) {
      bd = d;
      m = v;
    }
  }
  const i0 = Math.max(0, m - 4), i1 = Math.min(nv - 1, m + 4);
  if (i1 - i0 < 2) return { e: fe, n: fn };
  const te = wdx(s[i0 * 2], s[i1 * 2]) * TILE_KM * c, tn = (s[i0 * 2 + 1] - s[i1 * 2 + 1]) * TILE_KM;
  const tl = Math.hypot(te, tn);
  if (tl < 1e-6) return { e: fe, n: fn };
  let e = -tn / tl, n = te / tl;
  if (e * fe + n * fn < 0) {
    e = -e;
    n = -n;
  }
  // A local normal more than 60° off the front's mean direction is noise (a bend, a pocket): keep the mean.
  return e * fe + n * fn >= 0.5 ? { e, n } : { e: fe, n: fn };
}
