// FRONT ULTRA — encirclement: pockets of land cut off and fully surrounded by a single enemy (no sea access) are
// captured by the encircler. Small pockets are detected immediately around each tick's conquests with a bounded
// flood fill; larger cut-off territories are found by a periodic connected-component scan of nations that lost land.
// Owner: sim-core. Worker-only.

import { MAP_H, MAP_W, TILE_COUNT } from '../shared/constants';
import type { Game } from './game';
import { neighbors4 } from './game';
import type { Player } from './state';

const POCKET_LIMIT = 900;
const COMPONENT_TILE_CAP = 60_000;

export class EnclaveSystem {
  private readonly stamp = new Uint32Array(TILE_COUNT);
  private readonly seenTick = new Uint32Array(TILE_COUNT);
  private gen = 1;
  private readonly stack: number[] = [];
  private readonly region: number[] = [];
  private readonly nb = new Int32Array(4);
  private readonly nb2 = new Int32Array(4);
  private rr = 0;

  constructor(private readonly g: Game) {}

  step(): void {
    const g = this.g;
    const tick = g.tick;
    for (const a of g.attackList) {
      if (a.ended || a.conqueredThisTick === 0) continue;
      const n = Math.min(a.conqueredThisTick, 4, a.recentN);
      for (let k = 0; k < n; k++) {
        const t = a.recent[(a.recentN - 1 - k) % a.recent.length];
        if (g.owner[t] !== a.attacker) continue;
        const m = neighbors4(t, this.nb2);
        for (let j = 0; j < m; j++) {
          const q = this.nb2[j];
          if (!g.playable[q] || g.owner[q] === a.attacker || this.seenTick[q] === tick) continue;
          this.tryPocket(q, a.attacker, tick);
        }
      }
    }
    // Periodic full scan: one nation that recently lost land, round-robin.
    if (tick % 10 === 0) {
      const list = g.playerArr;
      for (let k = 0; k < list.length; k++) {
        const p = list[(this.rr + k) % list.length];
        if (!p.alive || p.tiles === 0 || p.lastTileLossTick <= p.lastEnclaveCheckTick) continue;
        // Huge empires are expensive to flood: scan them less often (small pockets are caught per tick anyway).
        if (p.tiles > 40_000 && tick - p.lastEnclaveCheckTick < 200) continue;
        this.rr = (this.rr + k + 1) % list.length;
        p.lastEnclaveCheckTick = tick;
        this.componentScan(p);
        break;
      }
    }
  }

  private nextGen(): number {
    this.gen++;
    if (this.gen >= 0xfffffff0) {
      this.stamp.fill(0);
      this.gen = 1;
    }
    return this.gen;
  }

  /** Bounded fill of the region owned by owner[start]; captured when only `encircler` surrounds it. */
  private tryPocket(start: number, encircler: number, tick: number): void {
    const g = this.g;
    const o = g.owner[start];
    if (o !== 0 && g.isAllied(o, encircler)) return;
    const gen = this.nextGen();
    const stack = this.stack, region = this.region;
    stack.length = 0;
    region.length = 0;
    stack.push(start);
    this.stamp[start] = gen;
    let ok = true;
    while (stack.length) {
      const t = stack.pop()!;
      region.push(t);
      this.seenTick[t] = tick;
      if (region.length > POCKET_LIMIT) {
        ok = false;
        break;
      }
      const y = (t / MAP_W) | 0;
      if (y === 0 || y === MAP_H - 1) {
        ok = false;
        break;
      }
      const n = neighbors4(t, this.nb);
      for (let k = 0; k < n; k++) {
        const q = this.nb[k];
        if (!g.playable[q]) {
          if (g.nav.comp[q] >= 0) {
            ok = false; // sea access: can be supplied, not an enclave
            break;
          }
          continue;
        }
        const qo = g.owner[q];
        if (qo === o) {
          if (this.stamp[q] !== gen) {
            this.stamp[q] = gen;
            stack.push(q);
          }
        } else if (qo !== encircler) {
          ok = false;
          break;
        }
      }
      if (!ok) break;
    }
    if (!ok || region.length === 0) return;
    this.capture(region, o, encircler);
  }

  private capture(region: number[], from: number, to: number): void {
    const g = this.g;
    const victim = g.playerById[from];
    if (victim && victim.tiles > 0) {
      // The encircled garrison surrenders.
      const density = victim.troops / victim.tiles;
      const lost = Math.min(victim.troops, density * region.length);
      victim.troops -= lost;
      victim.stats.troopsLost += lost;
      const k = g.playerById[to];
      if (k) k.stats.troopsKilled += lost;
    }
    for (const t of region) g.setOwner(t, to);
  }

  /** Connected components of a nation's land; cut-off pieces enclosed by one enemy are annexed. */
  private componentScan(p: Player): void {
    const g = this.g;
    const gen = this.nextGen();
    const stack = this.stack;
    interface Comp { size: number; ocean: boolean; enemies: Map<number, number>; tiles: number[] | null; }
    const comps: Comp[] = [];
    for (const start of p.border) {
      if (this.stamp[start] === gen) continue;
      const comp: Comp = { size: 0, ocean: false, enemies: new Map(), tiles: [] };
      stack.length = 0;
      stack.push(start);
      this.stamp[start] = gen;
      while (stack.length) {
        const t = stack.pop()!;
        comp.size++;
        if (comp.tiles) {
          comp.tiles.push(t);
          if (comp.tiles.length > COMPONENT_TILE_CAP) comp.tiles = null;
        }
        const y = (t / MAP_W) | 0;
        if (y === 0 || y === MAP_H - 1) comp.ocean = true;
        const n = neighbors4(t, this.nb);
        for (let k = 0; k < n; k++) {
          const q = this.nb[k];
          if (!g.playable[q]) {
            if (g.nav.comp[q] >= 0) comp.ocean = true;
            continue;
          }
          const qo = g.owner[q];
          if (qo === p.id) {
            if (this.stamp[q] !== gen) {
              this.stamp[q] = gen;
              stack.push(q);
            }
          } else comp.enemies.set(qo, (comp.enemies.get(qo) ?? 0) + 1);
        }
      }
      comps.push(comp);
    }
    if (comps.length === 0) return;
    let largest = 0;
    for (let i = 1; i < comps.length; i++) if (comps[i].size > comps[largest].size) largest = i;
    for (let i = 0; i < comps.length; i++) {
      const c = comps[i];
      if (c.ocean || !c.tiles || c.enemies.size !== 1) continue;
      const e = c.enemies.keys().next().value as number;
      if (e === 0 || g.isAllied(p.id, e)) continue;
      if (i === largest) {
        // The whole (landlocked) nation is surrounded by one much larger power: annexation.
        const ep = g.playerById[e];
        if (comps.length > 1 || !ep || c.size > 400 || ep.tiles < c.size * 12 || ep.troops < p.troops * 2) continue;
      }
      this.capture(c.tiles, p.id, e);
    }
  }
}
