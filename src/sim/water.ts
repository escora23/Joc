// FRONT ULTRA — naval navigation: ocean components, coastal tiles and water pathfinding. Owner: sim-core. Worker-only.
//
// Pathfinding is hierarchical so a transport crossing the Pacific stays cheap (a few ms worst case):
//   * At construction the water of every 4x4-tile cell is split into its locally 4-connected pieces ("nodes"). Two
//     nodes are linked when a tile of one touches a tile of the other, so the coarse graph is exact: isthmuses such as
//     Panama or Suez never create phantom shortcuts, and every coarse edge is guaranteed to be sailable.
//   * A query runs A* on that graph (edge cost = distance between the nodes' representative tiles), expands the node
//     chain into tiles with tiny BFS searches restricted to each pair of consecutive nodes, and string-pulls the
//     result with water line-of-sight so ships sail straight lines between few waypoints.
// Results are cached (port-to-port trade routes repeat constantly) and fresh searches are budgeted per tick.

import { MAP_H, MAP_W, TILE_COUNT } from '../shared/constants';
import { TerrainFlag } from '../shared/types';
import { TileHeap } from './heap';

const CELL = 4;
const CW = MAP_W / CELL;
const CH = MAP_H / CELL;

export class WaterNav {
  /** Ocean component id for navigable water tiles, -1 elsewhere. */
  readonly comp: Int32Array;
  readonly compSize: number[] = [];
  /** 1 for land tiles 4-adjacent to navigable water. */
  readonly coastal: Uint8Array;
  /** Searches allowed per tick (reset by beginTick). */
  budget = 8;
  private used = 0;

  private cache = new Map<number, Int32Array>();
  // --- coarse graph (cell components) ---
  /** Node id per navigable tile (-1 elsewhere). */
  private node: Int32Array;
  private nodeCount = 0;
  /** Representative tile of each node (the node tile closest to the cell centre). */
  private nodeRep!: Int32Array;
  private adjStart!: Int32Array;
  private adjList!: Int32Array;
  private adjCost!: Float32Array;
  // A* scratch (generation-stamped, never cleared).
  private ngen = 1;
  private nstamp!: Uint32Array;
  private nclosed!: Uint32Array;
  private ng!: Float32Array;
  private nparent!: Int32Array;
  private nheap = new TileHeap(2048);
  // Local BFS scratch.
  private bgen = 1;
  private bstamp: Uint32Array;
  private bparent: Int32Array;
  private bqueue = new Int32Array(64);
  private nb = new Int32Array(8);

  constructor(private readonly terrain: Uint8Array) {
    this.comp = new Int32Array(TILE_COUNT).fill(-1);
    this.coastal = new Uint8Array(TILE_COUNT);
    this.node = new Int32Array(TILE_COUNT).fill(-1);
    this.bstamp = new Uint32Array(TILE_COUNT);
    this.bparent = new Int32Array(TILE_COUNT);
    this.labelComponents();
    this.buildGraph();
  }

  isNavigable(t: number): boolean {
    return (this.terrain[t] & TerrainFlag.Navigable) !== 0 && (this.terrain[t] & 0x0f) <= 1;
  }

  private labelComponents(): void {
    const stack = new Int32Array(TILE_COUNT);
    let id = 0;
    for (let t = 0; t < TILE_COUNT; t++) {
      if (this.comp[t] !== -1 || !this.isNavigable(t)) continue;
      let sp = 0;
      stack[sp++] = t;
      this.comp[t] = id;
      let size = 0;
      while (sp > 0) {
        const c = stack[--sp];
        size++;
        const x = c % MAP_W, y = (c / MAP_W) | 0;
        const l = y * MAP_W + (x === 0 ? MAP_W - 1 : x - 1);
        const r = y * MAP_W + (x === MAP_W - 1 ? 0 : x + 1);
        if (this.comp[l] === -1 && this.isNavigable(l)) { this.comp[l] = id; stack[sp++] = l; }
        if (this.comp[r] === -1 && this.isNavigable(r)) { this.comp[r] = id; stack[sp++] = r; }
        if (y > 0) { const u = c - MAP_W; if (this.comp[u] === -1 && this.isNavigable(u)) { this.comp[u] = id; stack[sp++] = u; } }
        if (y < MAP_H - 1) { const d = c + MAP_W; if (this.comp[d] === -1 && this.isNavigable(d)) { this.comp[d] = id; stack[sp++] = d; } }
      }
      this.compSize.push(size);
      id++;
    }
    // Coastal land.
    for (let t = 0; t < TILE_COUNT; t++) {
      if (this.comp[t] !== -1) continue;
      const x = t % MAP_W, y = (t / MAP_W) | 0;
      const l = y * MAP_W + (x === 0 ? MAP_W - 1 : x - 1);
      const r = y * MAP_W + (x === MAP_W - 1 ? 0 : x + 1);
      if (this.comp[l] >= 0 || this.comp[r] >= 0 || (y > 0 && this.comp[t - MAP_W] >= 0) || (y < MAP_H - 1 && this.comp[t + MAP_W] >= 0)) {
        this.coastal[t] = 1;
      }
    }
  }

  beginTick(): void {
    this.used = 0;
  }

  /** True when a fresh (uncached) search may run this tick. */
  canSearch(): boolean {
    return this.used < this.budget;
  }

  /** A navigable water tile 4/8-adjacent to a land tile (preferring component `comp` when >= 0), -1 if none. */
  waterNear(tile: number, comp = -1): number {
    const x = tile % MAP_W, y = (tile / MAP_W) | 0;
    let best = -1;
    for (let r = 1; r <= 2; r++) {
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= MAP_H) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const t = yy * MAP_W + ((x + dx + MAP_W) % MAP_W);
          const c = this.comp[t];
          if (c < 0) continue;
          if (comp < 0 || c === comp) {
            if (Math.abs(dx) + Math.abs(dy) === 1) return t;
            if (best < 0) best = t;
          }
        }
      }
      if (best >= 0) return best;
    }
    return best;
  }

  /** Ocean components touching a coastal land tile (up to 2, written into out). */
  coastComponents(tile: number, out: number[]): number {
    out.length = 0;
    const x = tile % MAP_W, y = (tile / MAP_W) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= MAP_H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const t = yy * MAP_W + ((x + dx + MAP_W) % MAP_W);
        const c = this.comp[t];
        if (c >= 0 && !out.includes(c)) out.push(c);
      }
    }
    return out.length;
  }

  /**
   * Smoothed water path between two navigable water tiles of the same component (waypoint tiles, start and goal
   * included). Returns null when unreachable or when the search budget is exhausted (check canSearch() first to
   * distinguish). `cacheable` paths are memoised (trade routes).
   */
  findPath(from: number, to: number, cacheable = false): Int32Array | null {
    const c = this.comp[from];
    if (c < 0 || c !== this.comp[to]) return null;
    if (from === to) return Int32Array.of(from);
    const key = from * TILE_COUNT + to;
    if (cacheable) {
      const hit = this.cache.get(key);
      if (hit) {
        this.cache.delete(key);
        this.cache.set(key, hit);
        return hit;
      }
      const rev = this.cache.get(to * TILE_COUNT + from);
      if (rev) {
        const r = rev.slice().reverse();
        this.cache.set(key, r);
        return r;
      }
    }
    if (this.used >= this.budget) return null;
    this.used++;
    let raw: number[] | null = null;
    if (this.lineOfSight(from, to, c)) raw = [from, to];
    else {
      const chain = this.nodePath(this.node[from], this.node[to]);
      if (chain) raw = this.expand(from, to, chain);
    }
    if (!raw) return null;
    const path = this.smooth(raw, c);
    if (cacheable) {
      this.cache.set(key, path);
      if (this.cache.size > 1500) {
        const first = this.cache.keys().next().value as number;
        this.cache.delete(first);
      }
    }
    return path;
  }

  // --- coarse graph ----------------------------------------------------------------------------------

  private buildGraph(): void {
    const node = this.node, comp = this.comp;
    const reps: number[] = [];
    const stack = new Int32Array(CELL * CELL);
    // 1. Split every cell's water into 4-connected pieces.
    for (let cy = 0; cy < CH; cy++) {
      for (let cx = 0; cx < CW; cx++) {
        const x0 = cx * CELL, y0 = cy * CELL;
        for (let yy = 0; yy < CELL; yy++) {
          for (let xx = 0; xx < CELL; xx++) {
            const t0 = (y0 + yy) * MAP_W + x0 + xx;
            if (comp[t0] < 0 || node[t0] >= 0) continue;
            const id = reps.length;
            let sp = 0;
            stack[sp++] = t0;
            node[t0] = id;
            let best = t0, bestD = Infinity;
            const mx = x0 + CELL / 2 - 0.5, my = y0 + CELL / 2 - 0.5;
            while (sp > 0) {
              const t = stack[--sp];
              const x = t % MAP_W, y = (t / MAP_W) | 0;
              const d = (x - mx) * (x - mx) + (y - my) * (y - my);
              if (d < bestD) {
                bestD = d;
                best = t;
              }
              if (x > x0 && node[t - 1] < 0 && comp[t - 1] >= 0) { node[t - 1] = id; stack[sp++] = t - 1; }
              if (x < x0 + CELL - 1 && node[t + 1] < 0 && comp[t + 1] >= 0) { node[t + 1] = id; stack[sp++] = t + 1; }
              if (y > y0 && node[t - MAP_W] < 0 && comp[t - MAP_W] >= 0) { node[t - MAP_W] = id; stack[sp++] = t - MAP_W; }
              if (y < y0 + CELL - 1 && node[t + MAP_W] < 0 && comp[t + MAP_W] >= 0) { node[t + MAP_W] = id; stack[sp++] = t + MAP_W; }
            }
            reps.push(best);
          }
        }
      }
    }
    const n = reps.length;
    this.nodeCount = n;
    this.nodeRep = Int32Array.from(reps);
    // 2. Links between pieces of neighbouring cells (scan every horizontal & vertical tile contact across a cell edge).
    const pairs = new Set<number>();
    const ea: number[] = [], eb: number[] = [];
    const link = (a: number, b: number) => {
      if (a === b) return;
      const k = a < b ? a * n + b : b * n + a;
      if (pairs.has(k)) return;
      pairs.add(k);
      ea.push(a);
      eb.push(b);
    };
    for (let y = 0; y < MAP_H; y++) {
      for (let cx = 0; cx < CW; cx++) {
        const x = cx * CELL + CELL - 1;
        const t = y * MAP_W + x, r = y * MAP_W + ((x + 1) % MAP_W);
        if (node[t] >= 0 && node[r] >= 0) link(node[t], node[r]);
      }
    }
    for (let cy = 0; cy < CH - 1; cy++) {
      const y = cy * CELL + CELL - 1;
      for (let x = 0; x < MAP_W; x++) {
        const t = y * MAP_W + x, d = t + MAP_W;
        if (node[t] >= 0 && node[d] >= 0) link(node[t], node[d]);
      }
    }
    const deg = new Int32Array(n + 1);
    for (let i = 0; i < ea.length; i++) {
      deg[ea[i] + 1]++;
      deg[eb[i] + 1]++;
    }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    this.adjStart = deg;
    this.adjList = new Int32Array(ea.length * 2);
    this.adjCost = new Float32Array(ea.length * 2);
    const fill = deg.slice(0, n);
    for (let i = 0; i < ea.length; i++) {
      const a = ea[i], b = eb[i];
      const cost = this.tileDist(reps[a], reps[b]);
      this.adjList[fill[a]] = b;
      this.adjCost[fill[a]++] = cost;
      this.adjList[fill[b]] = a;
      this.adjCost[fill[b]++] = cost;
    }
    this.nstamp = new Uint32Array(n);
    this.nclosed = new Uint32Array(n);
    this.ng = new Float32Array(n);
    this.nparent = new Int32Array(n);
  }

  private tileDist(a: number, b: number): number {
    let dx = Math.abs((a % MAP_W) - (b % MAP_W));
    if (dx > MAP_W / 2) dx = MAP_W - dx;
    const dy = ((a / MAP_W) | 0) - ((b / MAP_W) | 0);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** A* over the cell-piece graph; returns the node chain (start..goal) or null. */
  private nodePath(s: number, goal: number): number[] | null {
    if (s < 0 || goal < 0) return null;
    if (s === goal) return [s];
    let gen = ++this.ngen;
    if (gen >= 0xfffffff0) {
      this.nstamp.fill(0);
      this.nclosed.fill(0);
      gen = this.ngen = 1;
    }
    const heap = this.nheap;
    heap.clear();
    const rep = this.nodeRep, start = this.adjStart, list = this.adjList, cost = this.adjCost;
    const stamp = this.nstamp, closed = this.nclosed, g = this.ng, parent = this.nparent;
    const gt = rep[goal];
    const gx = gt % MAP_W, gy = (gt / MAP_W) | 0;
    stamp[s] = gen;
    g[s] = 0;
    parent[s] = -1;
    heap.push(s, 0);
    while (heap.size > 0) {
      const cur = heap.pop();
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      if (cur === goal) {
        const out: number[] = [];
        for (let k = cur; k >= 0; k = parent[k]) out.push(k);
        out.reverse();
        return out;
      }
      const gc = g[cur];
      for (let e = start[cur], end = start[cur + 1]; e < end; e++) {
        const nn = list[e];
        if (closed[nn] === gen) continue;
        const ngv = gc + cost[e];
        if (stamp[nn] === gen && g[nn] <= ngv) continue;
        stamp[nn] = gen;
        g[nn] = ngv;
        parent[nn] = cur;
        const t = rep[nn];
        let dx = Math.abs((t % MAP_W) - gx);
        if (dx > MAP_W / 2) dx = MAP_W - dx;
        const dy = ((t / MAP_W) | 0) - gy;
        heap.push(nn, ngv + Math.sqrt(dx * dx + dy * dy) * 1.08);
      }
    }
    return null;
  }

  /** Tile path from `from` to `to` following the node chain (BFS inside each consecutive pair of pieces). */
  private expand(from: number, to: number, chain: number[]): number[] | null {
    const out: number[] = [from];
    let cur = from;
    for (let i = 0; i < chain.length; i++) {
      const target = i === chain.length - 1 ? to : this.nodeRep[chain[i + 1]];
      const allowA = chain[i], allowB = i === chain.length - 1 ? chain[i] : chain[i + 1];
      if (!this.localBfs(cur, target, allowA, allowB, out)) return null;
      cur = target;
    }
    return out;
  }

  /** BFS from a to b restricted to tiles of nodes na/nb; appends the tiles after `a` to out. */
  private localBfs(a: number, b: number, na: number, nb: number, out: number[]): boolean {
    if (a === b) return true;
    let gen = ++this.bgen;
    if (gen >= 0xfffffff0) {
      this.bstamp.fill(0);
      gen = this.bgen = 1;
    }
    const node = this.node, stamp = this.bstamp, parent = this.bparent;
    let q = this.bqueue;
    let head = 0, tail = 0;
    q[tail++] = a;
    stamp[a] = gen;
    parent[a] = -1;
    while (head < tail) {
      const t = q[head++];
      if (t === b) {
        const seg: number[] = [];
        for (let k = t; k !== a; k = parent[k]) seg.push(k);
        for (let i = seg.length - 1; i >= 0; i--) out.push(seg[i]);
        return true;
      }
      const x = t % MAP_W;
      const nbs = this.nb;
      nbs[0] = x === 0 ? t + MAP_W - 1 : t - 1;
      nbs[1] = x === MAP_W - 1 ? t - MAP_W + 1 : t + 1;
      nbs[2] = t >= MAP_W ? t - MAP_W : -1;
      nbs[3] = t < TILE_COUNT - MAP_W ? t + MAP_W : -1;
      for (let k = 0; k < 4; k++) {
        const n = nbs[k];
        if (n < 0 || stamp[n] === gen) continue;
        const nd = node[n];
        if (nd !== na && nd !== nb) continue;
        stamp[n] = gen;
        parent[n] = t;
        if (tail >= q.length) {
          const bigger = new Int32Array(q.length * 2);
          bigger.set(q);
          this.bqueue = q = bigger;
        }
        q[tail++] = n;
      }
    }
    return false;
  }

  /** Continuous line of sight over water of component c between two tile centers (wrap-aware). */
  lineOfSight(a: number, b: number, c: number): boolean {
    const ax = (a % MAP_W) + 0.5, ay = ((a / MAP_W) | 0) + 0.5;
    let dx = (b % MAP_W) + 0.5 - ax;
    if (dx > MAP_W / 2) dx -= MAP_W;
    else if (dx < -MAP_W / 2) dx += MAP_W;
    const dy = ((b / MAP_W) | 0) + 0.5 - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.ceil(len / 0.35);
    for (let i = 1; i < steps; i++) {
      const f = i / steps;
      let x = Math.floor(ax + dx * f);
      const y = Math.floor(ay + dy * f);
      x = ((x % MAP_W) + MAP_W) % MAP_W;
      if (this.comp[y * MAP_W + x] !== c) return false;
    }
    return true;
  }

  private smooth(raw: number[], c: number): Int32Array {
    if (raw.length <= 2) return Int32Array.from(raw);
    const out: number[] = [raw[0]];
    let i = 0;
    const n = raw.length;
    while (i < n - 1) {
      // Exponential probe then binary search for the farthest visible waypoint (segments capped for smooth turns).
      let lo = i + 1;
      let step = 2;
      let hi = Math.min(n - 1, i + step);
      while (hi > lo && hi - i <= 160 && this.lineOfSight(raw[i], raw[hi], c)) {
        lo = hi;
        step *= 2;
        hi = Math.min(n - 1, i + step);
        if (lo === n - 1) break;
      }
      if (lo !== n - 1 && hi > lo) {
        let a = lo, b = Math.min(hi, i + 160);
        while (b - a > 1) {
          const m = (a + b) >> 1;
          if (this.lineOfSight(raw[i], raw[m], c)) a = m;
          else b = m;
        }
        lo = a;
      }
      out.push(raw[lo]);
      i = lo;
    }
    return Int32Array.from(out);
  }

  /** Random navigable tile of component c within radius of (x, y) (for patrols), -1 if none found. */
  randomWaterNear(x: number, y: number, radius: number, c: number, rnd: () => number): number {
    for (let k = 0; k < 24; k++) {
      const a = rnd() * Math.PI * 2;
      const r = radius * Math.sqrt(rnd());
      const yy = Math.floor(y + Math.sin(a) * r);
      if (yy < 1 || yy >= MAP_H - 1) continue;
      const xx = ((Math.floor(x + Math.cos(a) * r) % MAP_W) + MAP_W) % MAP_W;
      const t = yy * MAP_W + xx;
      if (this.comp[t] === c) return t;
    }
    return -1;
  }

  /** Neighbour scratch accessor for callers that need it. */
  get scratch(): Int32Array {
    return this.nb;
  }
}
