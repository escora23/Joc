// FRONT ULTRA — sieges (encirclement v2, DESIGN_V2 §4.12). Owner: sim-core (W1). Worker-only.
//
// A pocket of a player's land with no sea access, fully surrounded by players AT WAR with it, is BESIEGED: defense
// power ×0.6 on its fronts (attacks.ts reads besiegedFront), the pocket's share of home troops (tiles_pocket /
// tiles_total) loses 0.5 % per game hour, and nothing can be built inside. The pocket falls only through offensives at
// the normal capped rate: nothing is annexed in one step (v1's tryPocket / componentScan annexation is gone).
//
// Detection: a connected-component scan of one player at war every few ticks (players that lost land or have sieges
// first, then round-robin over everyone at war). The only automatic transfer left is cleanup: neutral specks of ≤ 3
// tiles fully enclosed by one player's land are absorbed (no player loses anything).

import { MAP_H, MAP_W, SIEGE_ATTRITION_PER_HOUR, TICKS_PER_GAME_HOUR, TILE_COUNT } from '../shared/constants';
import type { SiegeView } from '../shared/types';
import type { Game } from './game';
import { neighbors4 } from './game';
import type { SaveReader, SaveWriter } from './save';
import type { Attack, Player } from './state';
import { wrapXf } from './spatial';

/** Components larger than this are never a siege (a whole continent-sized empire is not "a pocket"). */
const COMPONENT_TILE_CAP = 60_000;
/** Neutral specks up to this size enclosed by one player are absorbed as cleanup. */
const SPECK_MAX = 3;
/** Scan cadence (ticks) and the re-validation period of existing sieges. */
const SCAN_EVERY = 5;
const REVALIDATE_EVERY = 60;
const ROUND_ROBIN_EVERY = 200;

interface Siege {
  id: number;
  owner: number;
  by: number[];
  tiles: number[];
  x: number;
  y: number;
  sinceTick: number;
}

export class EnclaveSystem {
  siegesDirty = true;
  private readonly sieges = new Map<number, Siege>();
  /** Siege id per tile (0 = not besieged). */
  private readonly siegeOf = new Int32Array(TILE_COUNT);
  private readonly stamp = new Uint32Array(TILE_COUNT);
  private gen = 1;
  private nextId = 1;
  private readonly stack: number[] = [];
  private readonly nb = new Int32Array(4);
  private readonly nb2 = new Int32Array(4);
  private rr = 0;
  private readonly lastScan = new Map<number, number>();

  constructor(private readonly g: Game) {}

  // =================================================================================================
  // Queries
  // =================================================================================================
  isBesieged(tile: number): boolean {
    return this.siegeOf[tile] !== 0;
  }

  /** Does offensive `a` push on a besieged pocket of `defender`? (a few of its frontier tiles decide). */
  besiegedFront(defender: number, a: Attack): boolean {
    if (this.sieges.size === 0) return false;
    let n = 0;
    for (const t of a.pressure.keys()) {
      const id = this.siegeOf[t];
      if (id !== 0 && this.sieges.get(id)?.owner === defender) return true;
      if (++n >= 6) break;
    }
    return false;
  }

  views(): SiegeView[] {
    const out: SiegeView[] = [];
    for (const s of this.sieges.values()) out.push({ owner: s.owner, by: s.by.slice(), x: s.x, y: s.y, tiles: s.tiles.length, sinceTick: s.sinceTick });
    return out;
  }

  // =================================================================================================
  // Tick
  // =================================================================================================
  step(): void {
    const g = this.g;
    const tick = g.tick;
    this.cleanupSpecks();
    // Attrition: the pocket's share of home troops starves (0.5 % per game hour).
    if (this.sieges.size) {
      const perTick = SIEGE_ATTRITION_PER_HOUR / TICKS_PER_GAME_HOUR;
      for (const s of this.sieges.values()) {
        const p = g.playerById[s.owner];
        if (!p || !p.alive || p.tiles <= 0) continue;
        let n = 0;
        for (const t of s.tiles) if (g.owner[t] === s.owner) n++;
        const loss = p.troops * (n / p.tiles) * perTick;
        if (loss > 0) {
          p.troops -= loss;
          p.stats.troopsLost += loss;
        }
      }
    }
    if (tick % SCAN_EVERY !== 0) return;
    const p = this.pickScan(tick);
    if (p) {
      this.lastScan.set(p.id, tick);
      p.lastEnclaveCheckTick = tick;
      this.scan(p);
    }
  }

  /** The next player to scan: stale sieges, then players that lost land at war, then round-robin over players at war. */
  private pickScan(tick: number): Player | null {
    const g = this.g;
    const list = g.playerArr;
    const n = list.length;
    for (const s of [...this.sieges.values()]) {
      const p = g.playerById[s.owner];
      if (!p || !p.alive) {
        this.endSiege(s);
        continue;
      }
      if (tick - (this.lastScan.get(s.owner) ?? -1e9) >= REVALIDATE_EVERY) return p;
    }
    for (let k = 0; k < n; k++) {
      const p = list[(this.rr + k) % n];
      if (!p.alive || p.tiles === 0) continue;
      if (p.lastTileLossTick > p.lastEnclaveCheckTick && g.war.enemiesOf(p.id).length > 0) {
        this.rr = (this.rr + k + 1) % n;
        return p;
      }
    }
    for (let k = 0; k < n; k++) {
      const p = list[(this.rr + k) % n];
      if (!p.alive || p.tiles === 0 || g.war.enemiesOf(p.id).length === 0) continue;
      if (tick - (this.lastScan.get(p.id) ?? -1e9) < ROUND_ROBIN_EVERY) continue;
      this.rr = (this.rr + k + 1) % n;
      return p;
    }
    return null;
  }

  private nextGen(): number {
    this.gen++;
    if (this.gen >= 0xfffffff0) {
      this.stamp.fill(0);
      this.gen = 1;
    }
    return this.gen;
  }

  /** Connected components of p's land; every pocket without sea access enclosed only by p's enemies is besieged. */
  private scan(p: Player): void {
    const g = this.g;
    const gen = this.nextGen();
    const stack = this.stack;
    const found: { tiles: number[]; by: number[] }[] = [];
    for (const start of p.border) {
      if (this.stamp[start] === gen) continue;
      const tiles: number[] = [];
      const enemies = new Set<number>();
      let ocean = false, tooBig = false;
      stack.length = 0;
      stack.push(start);
      this.stamp[start] = gen;
      while (stack.length) {
        const t = stack.pop()!;
        if (!tooBig) {
          tiles.push(t);
          if (tiles.length > COMPONENT_TILE_CAP) tooBig = true;
        }
        const y = (t / MAP_W) | 0;
        if (y === 0 || y === MAP_H - 1) ocean = true;
        const n = neighbors4(t, this.nb);
        for (let k = 0; k < n; k++) {
          const q = this.nb[k];
          if (!g.playable[q]) {
            if (g.nav.comp[q] >= 0) ocean = true;
            continue;
          }
          const qo = g.owner[q];
          if (qo === p.id) {
            if (this.stamp[q] !== gen) {
              this.stamp[q] = gen;
              stack.push(q);
            }
          } else enemies.add(qo);
        }
      }
      if (ocean || tooBig || enemies.size === 0) continue;
      let ok = true;
      for (const e of enemies) {
        if (e === 0 || !g.war.atWar(p.id, e)) {
          ok = false;
          break;
        }
      }
      if (ok) found.push({ tiles, by: [...enemies].sort((a, b) => a - b) });
    }
    this.apply(p.id, found);
  }

  /** Match the pockets found to the owner's existing sieges (by shared tiles); start and end sieges accordingly. */
  private apply(owner: number, found: { tiles: number[]; by: number[] }[]): void {
    const g = this.g;
    const mine = [...this.sieges.values()].filter((s) => s.owner === owner);
    const kept = new Set<Siege>();
    for (const f of found) {
      let match: Siege | undefined;
      for (const t of f.tiles) {
        const id = this.siegeOf[t];
        if (id === 0) continue;
        const s = this.sieges.get(id);
        if (s && s.owner === owner && !kept.has(s)) {
          match = s;
          break;
        }
      }
      const [x, y] = centroid(f.tiles);
      if (match) {
        for (const t of match.tiles) if (this.siegeOf[t] === match.id) this.siegeOf[t] = 0;
        match.tiles = f.tiles;
        match.by = f.by;
        match.x = x;
        match.y = y;
        for (const t of f.tiles) this.siegeOf[t] = match.id;
        kept.add(match);
        this.siegesDirty = true;
        continue;
      }
      const s: Siege = { id: this.nextId++, owner, by: f.by, tiles: f.tiles, x, y, sinceTick: g.tick };
      this.sieges.set(s.id, s);
      for (const t of f.tiles) this.siegeOf[t] = s.id;
      kept.add(s);
      this.siegesDirty = true;
      g.emit({ type: 'siege', tick: g.tick, owner, by: f.by.slice(), stage: 'start', tiles: f.tiles.length, x, y });
    }
    for (const s of mine) if (!kept.has(s)) this.endSiege(s);
  }

  private endSiege(s: Siege): void {
    const g = this.g;
    for (const t of s.tiles) if (this.siegeOf[t] === s.id) this.siegeOf[t] = 0;
    this.sieges.delete(s.id);
    this.siegesDirty = true;
    let n = 0;
    for (const t of s.tiles) if (g.owner[t] === s.owner) n++;
    g.emit({ type: 'siege', tick: g.tick, owner: s.owner, by: s.by.slice(), stage: 'end', tiles: n, x: s.x, y: s.y });
  }

  /** Neutral specks of ≤ 3 tiles next to this tick's conquests, fully enclosed by one player's land, are absorbed. */
  private cleanupSpecks(): void {
    const g = this.g;
    for (const a of g.attackList) {
      if (a.ended || a.conqueredThisTick === 0) continue;
      const n = Math.min(a.conqueredThisTick, 6, a.recentN);
      for (let k = 0; k < n; k++) {
        const t = a.recent[(a.recentN - 1 - k) % a.recent.length];
        const owner = g.owner[t];
        if (owner === 0) continue;
        const m = neighbors4(t, this.nb2);
        for (let j = 0; j < m; j++) {
          const q = this.nb2[j];
          if (g.playable[q] && g.owner[q] === 0) this.trySpeck(q, owner);
        }
      }
    }
  }

  private trySpeck(start: number, encloser: number): void {
    const g = this.g;
    const gen = this.nextGen();
    const region: number[] = [start];
    this.stamp[start] = gen;
    for (let i = 0; i < region.length; i++) {
      const n = neighbors4(region[i], this.nb);
      for (let k = 0; k < n; k++) {
        const q = this.nb[k];
        if (!g.playable[q]) return; // touches water or ice: not an enclosed speck
        const o = g.owner[q];
        if (o === 0) {
          if (this.stamp[q] !== gen) {
            this.stamp[q] = gen;
            region.push(q);
            if (region.length > SPECK_MAX) return;
          }
        } else if (o !== encloser) return;
      }
    }
    const ctx = g.transferContext;
    g.transferContext = 'cleanup';
    for (const t of region) g.setOwner(t, encloser);
    g.transferContext = ctx;
  }

  // =================================================================================================
  // Save
  // =================================================================================================
  serialize(w: SaveWriter): void {
    w.section('sieges');
    w.json({ sieges: [...this.sieges.values()], nextId: this.nextId, lastScan: [...this.lastScan], rr: this.rr });
  }

  restore(r: SaveReader): void {
    r.section('sieges');
    const d = r.json<{ sieges: Siege[]; nextId: number; lastScan: [number, number][]; rr: number }>();
    this.sieges.clear();
    this.siegeOf.fill(0);
    for (const s of d.sieges) {
      this.sieges.set(s.id, s);
      for (const t of s.tiles) this.siegeOf[t] = s.id;
    }
    this.nextId = d.nextId;
    this.lastScan.clear();
    for (const [k, v] of d.lastScan) this.lastScan.set(k, v);
    this.rr = d.rr;
    this.siegesDirty = true;
  }
}

function centroid(tiles: number[]): [number, number] {
  if (tiles.length === 0) return [0, 0];
  const x0 = (tiles[0] % MAP_W) + 0.5;
  let sx = 0, sy = 0;
  for (const t of tiles) {
    let dx = (t % MAP_W) + 0.5 - x0;
    if (dx > MAP_W / 2) dx -= MAP_W;
    else if (dx < -MAP_W / 2) dx += MAP_W;
    sx += dx;
    sy += ((t / MAP_W) | 0) + 0.5;
  }
  return [wrapXf(x0 + sx / tiles.length), sy / tiles.length];
}
