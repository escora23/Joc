// FRONT ULTRA — nation label placement: the anchor is the "pole of inaccessibility" of each nation (the point of its
// territory farthest from any border or coast), found with a chamfer distance transform on a 2x-downsampled grid.
// labelSize is the diameter (in tiles) of the largest inscribed circle, so the globe can fit the name inside.
// Hysteresis keeps labels from jittering. Owner: sim-core. Worker-only.

import { MAP_H, MAP_W } from '../shared/constants';
import type { Game } from './game';
import type { Player } from './state';
import { wdx } from './spatial';

const S = 2;
const W = MAP_W / S;
const H = Math.ceil((MAP_H * 0.84) / S); // below ~-62° there is only ice
const INF = 0xffff;

export class LabelPlacer {
  private readonly cellOwner = new Uint16Array(W * H);
  private readonly dt = new Uint16Array(W * H);
  private bestVal = new Int32Array(256);
  private bestCell = new Int32Array(256);

  constructor(private readonly g: Game) {}

  update(): void {
    const g = this.g;
    const owner = g.owner;
    const co = this.cellOwner, dt = this.dt;
    // 1. Interior cells: all 4 tiles owned by the same player.
    for (let cy = 0; cy < H; cy++) {
      const r0 = cy * S * MAP_W, r1 = r0 + MAP_W;
      for (let cx = 0; cx < W; cx++) {
        const x = cx * S;
        const o = owner[r0 + x];
        const c = cy * W + cx;
        if (o !== 0 && owner[r0 + x + 1] === o && owner[r1 + x] === o && owner[r1 + x + 1] === o) {
          co[c] = o;
          dt[c] = INF;
        } else {
          co[c] = 0;
          dt[c] = 0;
        }
      }
    }
    // 2. Chamfer (3-4) forward & backward passes; a cell's distance also stops at other owners' cells.
    for (let cy = 0; cy < H; cy++) {
      for (let cx = 0; cx < W; cx++) {
        const c = cy * W + cx;
        if (dt[c] === 0) continue;
        const o = co[c];
        const l = cy * W + (cx === 0 ? W - 1 : cx - 1);
        let v = dt[c];
        v = Math.min(v, co[l] === o ? dt[l] + 3 : 3);
        if (cy > 0) {
          const u = c - W;
          const ul = (cy - 1) * W + (cx === 0 ? W - 1 : cx - 1);
          const ur = (cy - 1) * W + (cx === W - 1 ? 0 : cx + 1);
          v = Math.min(v, co[u] === o ? dt[u] + 3 : 3, co[ul] === o ? dt[ul] + 4 : 4, co[ur] === o ? dt[ur] + 4 : 4);
        } else v = Math.min(v, 3);
        dt[c] = v;
      }
    }
    for (let cy = H - 1; cy >= 0; cy--) {
      for (let cx = W - 1; cx >= 0; cx--) {
        const c = cy * W + cx;
        if (dt[c] === 0) continue;
        const o = co[c];
        const r = cy * W + (cx === W - 1 ? 0 : cx + 1);
        let v = dt[c];
        v = Math.min(v, co[r] === o ? dt[r] + 3 : 3);
        if (cy < H - 1) {
          const d = c + W;
          const dl = (cy + 1) * W + (cx === 0 ? W - 1 : cx - 1);
          const dr = (cy + 1) * W + (cx === W - 1 ? 0 : cx + 1);
          v = Math.min(v, co[d] === o ? dt[d] + 3 : 3, co[dl] === o ? dt[dl] + 4 : 4, co[dr] === o ? dt[dr] + 4 : 4);
        } else v = Math.min(v, 3);
        dt[c] = v;
      }
    }
    // 3. Best cell per player.
    const n = g.playerArr.length + 1;
    if (this.bestVal.length < n) {
      this.bestVal = new Int32Array(n * 2);
      this.bestCell = new Int32Array(n * 2);
    }
    const bv = this.bestVal, bc = this.bestCell;
    bv.fill(0, 0, n);
    bc.fill(-1, 0, n);
    for (let c = 0; c < W * H; c++) {
      const o = co[c];
      if (o === 0) continue;
      if (dt[c] > bv[o]) {
        bv[o] = dt[c];
        bc[o] = c;
      }
    }
    for (const p of g.playerArr) {
      if (!p.alive || p.tiles === 0) {
        p.labelSize = 0;
        continue;
      }
      const best = bc[p.id];
      if (best < 0) {
        this.placeSmall(p);
        continue;
      }
      const val = bv[p.id];
      // Hysteresis: keep the old anchor while it stays nearly as good.
      const ocx = Math.floor(p.labelX / S), ocy = Math.floor(p.labelY / S);
      const oc = ocy * W + ocx;
      let cell = best, v = val;
      if (ocy >= 0 && ocy < H && ocx >= 0 && ocx < W && co[oc] === p.id && dt[oc] >= val * 0.85 && p.labelScore > 0) {
        cell = oc;
        v = dt[oc];
      }
      p.labelX = (cell % W) * S + S / 2;
      p.labelY = Math.floor(cell / W) * S + S / 2;
      p.labelScore = v;
      p.labelSize = Math.max(2, (v / 3) * S * 2);
    }
  }

  /** Label for tiny territories: centroid of the border, snapped onto an owned tile. */
  placeSmall(p: Player): void {
    if (p.tiles === 0 || p.border.size === 0) {
      if (p.capitalTile >= 0 && p.tiles > 0) {
        p.labelX = (p.capitalTile % MAP_W) + 0.5;
        p.labelY = Math.floor(p.capitalTile / MAP_W) + 0.5;
        p.labelSize = Math.max(1.5, Math.sqrt(p.tiles) * 0.8);
      } else p.labelSize = 0;
      return;
    }
    let x0 = -1, sx = 0, sy = 0, n = 0;
    for (const t of p.border) {
      const x = (t % MAP_W) + 0.5, y = Math.floor(t / MAP_W) + 0.5;
      if (x0 < 0) x0 = x;
      sx += x0 + wdx(x0, x);
      sy += y;
      if (++n >= 400) break;
    }
    const mx = sx / n, my = sy / n;
    let best = -1, bestD = Infinity, k = 0;
    for (const t of p.border) {
      const dx = wdx(mx, (t % MAP_W) + 0.5), dy = Math.floor(t / MAP_W) + 0.5 - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = t;
      }
      if (++k >= 400) break;
    }
    p.labelX = (best % MAP_W) + 0.5;
    p.labelY = Math.floor(best / MAP_W) + 0.5;
    p.labelScore = 0;
    p.labelSize = Math.max(1.5, Math.sqrt(p.tiles) * 0.8);
  }
}
