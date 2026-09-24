// FRONT ULTRA — front lines for the ground battle layer. Owner: sim-core. Worker-only.
// Every 5 ticks, for each active attack on a player, the contact line (attacker tiles touching the defender) is
// clustered into up to 3 segments; each segment becomes a FrontRecord with an ordered, smoothed polyline (<= 64
// points), a representative point, its advance direction, intensity and the troops on each side.

import { MAP_W } from '../shared/constants';
import type { FrontRecord } from '../shared/protocol';
import type { Game } from './game';
import { neighbors4 } from './game';
import type { Attack } from './state';
import { wdx, wrapXf } from './spatial';

const CELL = 6;
const CW = Math.ceil(MAP_W / CELL);
const MAX_CONTACT = 6000;
const MAX_SAMPLES = 64;

interface FrontData {
  id: number;
  a: number;
  b: number;
  x: number;
  y: number;
  intensity: number;
  troopsA: number;
  troopsB: number;
  length: number;
  dirX: number;
  dirY: number;
  samples: number[];
}

export class FrontTracker {
  dirty = false;
  private list: FrontData[] = [];
  private readonly nb = new Int32Array(4);
  private readonly tx: number[] = [];
  private readonly ty: number[] = [];
  private readonly dxs: number[] = [];
  private readonly dys: number[] = [];

  constructor(private readonly g: Game) {}

  /** Fresh FrontRecords (new typed arrays each call: they are transferred to the main thread). */
  take(): FrontRecord[] {
    this.dirty = false;
    return this.list.map((f) => ({ ...f, samples: Float32Array.from(f.samples) }));
  }

  get current(): readonly FrontData[] {
    return this.list;
  }

  update(): void {
    const g = this.g;
    const out: FrontData[] = [];
    for (const a of g.attackList) {
      if (a.ended || a.defender === 0 || a.boatId !== 0) continue;
      this.frontsFor(a, out);
    }
    if (out.length === 0 && this.list.length === 0) return;
    this.list = out;
    this.dirty = true;
  }

  private frontsFor(a: Attack, out: FrontData[]): void {
    const g = this.g;
    const A = g.playerById[a.attacker], D = g.playerById[a.defender];
    if (!A || !D || !D.alive) return;
    const owner = g.owner;
    const tx = this.tx, ty = this.ty, dxs = this.dxs, dys = this.dys;
    tx.length = ty.length = dxs.length = dys.length = 0;
    const nb = this.nb;
    const stride = Math.max(1, Math.floor(A.border.size / MAX_CONTACT));
    let i = 0;
    const sx = a.sourceTile >= 0 ? (a.sourceTile % MAP_W) + 0.5 : 0, sy = a.sourceTile >= 0 ? ((a.sourceTile / MAP_W) | 0) + 0.5 : 0;
    for (const t of A.border) {
      if (i++ % stride !== 0) continue;
      const n = neighbors4(t, nb);
      let ddx = 0, ddy = 0, touch = false;
      const x = t % MAP_W, y = (t / MAP_W) | 0;
      for (let k = 0; k < n; k++) {
        const q = nb[k];
        if (owner[q] !== a.defender) continue;
        touch = true;
        ddx += wdx(x, q % MAP_W);
        ddy += ((q / MAP_W) | 0) - y;
      }
      if (!touch) continue;
      if (a.naval && a.sourceTile >= 0) {
        const ex = wdx(sx, x + 0.5), ey = y + 0.5 - sy;
        if (ex * ex + ey * ey > 45 * 45) continue;
      }
      tx.push(x + 0.5);
      ty.push(y + 0.5);
      dxs.push(ddx);
      dys.push(ddy);
    }
    const total = tx.length;
    if (total < 2) return;

    // Cluster contact tiles on a coarse grid (8-connected cells).
    const cellOf = new Map<number, number[]>();
    for (let k = 0; k < total; k++) {
      const c = Math.floor(ty[k] / CELL) * CW + Math.floor(tx[k] / CELL);
      let l = cellOf.get(c);
      if (!l) cellOf.set(c, (l = []));
      l.push(k);
    }
    const seen = new Set<number>();
    const clusters: number[][] = [];
    for (const c of cellOf.keys()) {
      if (seen.has(c)) continue;
      const members: number[] = [];
      const stack = [c];
      seen.add(c);
      while (stack.length) {
        const cur = stack.pop()!;
        members.push(...cellOf.get(cur)!);
        const cx = cur % CW, cy = Math.floor(cur / CW);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nc = (cy + dy) * CW + ((cx + dx + CW) % CW);
            if (cellOf.has(nc) && !seen.has(nc)) {
              seen.add(nc);
              stack.push(nc);
            }
          }
        }
      }
      clusters.push(members);
    }
    clusters.sort((p, q) => q.length - p.length);

    // Recent conquests make a segment hotter.
    const recentN = Math.min(a.recentN, a.recent.length);
    const baseHeat = a.conquestEma > 0.05 || a.lossEma > 1
      ? Math.min(1, 0.2 + Math.log10(1 + a.lossEma) / 4.2 + Math.min(0.25, a.conquestEma / 20))
      : 0.12;
    const dBorder = Math.max(1, D.border.size);

    for (let ci = 0; ci < Math.min(3, clusters.length); ci++) {
      const m = clusters[ci];
      if (m.length < 3 && ci > 0) break;
      // Centroid & PCA (x unwrapped around the first member).
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
      // Representative point: the middle of the line.
      const mid = Math.floor(samples.length / 4) * 2;
      const dl = Math.sqrt(dirX * dirX + dirY * dirY) || 1;
      // Heat from recent conquests inside this segment.
      let recentHere = 0;
      if (recentN > 0) {
        const r2 = (span / 2 + 8) * (span / 2 + 8);
        for (let j = 0; j < recentN; j++) {
          const t = a.recent[j];
          const ex = wdx(mx, (t % MAP_W) + 0.5), ey = ((t / MAP_W) | 0) + 0.5 - my;
          if (ex * ex + ey * ey <= r2) recentHere++;
        }
      }
      const share = m.length / total;
      const intensity = Math.max(0.05, Math.min(1, baseHeat * (0.6 + 0.8 * (recentN > 0 ? recentHere / recentN : share))));
      out.push({
        id: a.id * 4 + ci,
        a: a.attacker,
        b: a.defender,
        x: samples[mid],
        y: samples[mid + 1],
        intensity,
        troopsA: Math.round(a.troops * share),
        troopsB: Math.round(Math.min(D.troops, D.troops * Math.min(1, (m.length * 1.2) / dBorder))),
        length: m.length,
        dirX: dirX / dl,
        dirY: dirY / dl,
        samples,
      });
    }
  }
}
