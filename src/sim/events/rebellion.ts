// FRONT ULTRA — world event: unrest and rebellion (DESIGN_V2 §5.12; owner: sim-ai, rebuilt by W1). Worker-only.
//
// Rebellions happen only where there is a cause: occupied land above 20 % of a nation's land, war exhaustion above 60,
// or a nuclear strike on its land in the last 10 days. Unrest always comes first: an `unrest` event names the region,
// the cause and the tiles at risk 480 ticks (48 h) before anything happens. If the cause disappears in the meantime
// the rebellion is cancelled (and the alert says so); a front raised to «alta» near the region halves the chance.
// When it breaks out, the region announced by the unrest (what the parent still holds of it, nothing more) forms a
// rebel movement at war with its parent, which mobilizes for 60 ticks before its first offensive (invariant 4).
// At most one rebellion per nation per 7,200 ticks; a successor takes ≤ 15 % of the world and ≤ 40 % of its parent.

import { BALANCE, MAP_W, UNREST_TICKS } from '../../shared/constants';
import { rebelColor } from '../../data/palette';
import type { SimGame, SimPlayer } from '../../shared/simapi';
import { cx, cy, emitStage, type ActiveEvent, type EventEnv } from './common';

const AFTERMATH_TICKS = 600;
const REBELLION_GAP = 7_200;
const NUCLEAR_CAUSE_TICKS = 2_400;
const MIN_REGION = 40;

export type UnrestCause = 'occupation' | 'exhaustion' | 'nuclear';

/** The cause that makes `p` ripe for a rebellion now, or null (§5.12). */
export function rebellionCause(env: EventEnv, p: SimPlayer): UnrestCause | null {
  const g = env.g;
  if (!p.alive || !p.spawned || (p.kind !== 'nation' && p.kind !== 'human') || p.tiles < 300) return null;
  if (g.tick - (env.lastRebellion.get(p.id) ?? -1_000_000) < REBELLION_GAP) return null;
  if (p.occupied > p.tiles * 0.2) return 'occupation';
  if (g.war.exhaustion(p.id) > 60) return 'exhaustion';
  const n = env.nuked.get(p.id);
  if (n && g.tick - n.tick < NUCLEAR_CAUSE_TICKS) return 'nuclear';
  return null;
}

/** Ripeness score used to pick among candidates (0 = no cause). */
export function unrest(env: EventEnv, p: SimPlayer): number {
  const cause = rebellionCause(env, p);
  if (!cause) return 0;
  const g = env.g;
  const base = cause === 'occupation' ? 2 + (p.occupied / Math.max(1, p.tiles)) * 5 : cause === 'exhaustion' ? 2 + (g.war.exhaustion(p.id) - 60) / 10 : 3;
  return base * (1 + Math.log10(Math.max(10, p.tiles)) / 4);
}

export class Rebellion implements ActiveEvent {
  readonly kind = 'rebellion' as const;
  private t = 0;
  private rebel = 0;
  private x: number;
  private y: number;
  private radius = 8;
  private region: number[] = [];
  private cause: UnrestCause | null = null;
  private erupted = false;

  constructor(readonly id: number, private readonly parent: number, private readonly seed: number, private readonly warn: boolean) {
    this.x = cx(seed);
    this.y = cy(seed);
  }

  step(env: EventEnv): boolean {
    const g = env.g;
    const p = g.player(this.parent);
    if (this.t === 0) {
      // Unrest: the region, the cause and the tiles at risk, announced UNREST_TICKS ahead.
      this.cause = p ? rebellionCause(env, p) : null;
      if (!p || !this.cause) return false;
      this.region = regionFor(env, p, this.cause, this.seed);
      if (this.region.length < MIN_REGION) return false;
      this.place();
      const until = g.tick + (this.warn ? UNREST_TICKS : 0);
      g.emit({ type: 'unrest', tick: g.tick, owner: this.parent, region: this.region.slice(), cause: this.cause, stage: 'start', untilTick: until, x: this.x, y: this.y });
      emitStage(env, this.id, this.kind, 'warning', this.x, this.y, this.radius, 0, [this.parent]);
    }
    const warnTicks = this.warn ? UNREST_TICKS : 0;
    if (!this.erupted) {
      // The cause must still hold (checked every 20 ticks and at the end).
      if ((this.t % 20 === 0 || this.t >= warnTicks) && (!p || !p.alive || rebellionCause(env, p) === null)) return this.cancel(env);
      if (this.t >= warnTicks) {
        // A front raised to «alta» near the region halves the chance (§5.12).
        if (this.raisedFrontNear(env) && env.rng.next() < 0.5) return this.cancel(env);
        if (!this.erupt(env)) return this.cancel(env);
        this.erupted = true;
      }
    }
    this.t++;
    const life = warnTicks + AFTERMATH_TICKS;
    if (this.t % 10 === 0) {
      g.setWorldEventState(this.id, {
        kind: this.kind, x: this.x, y: this.y, radius: this.radius, progress: Math.min(1, this.t / life),
        magnitude: this.erupted ? 1 : 0, players: this.rebel ? [this.parent, this.rebel] : [this.parent], heading: 0,
      });
    }
    if (this.t >= life) {
      g.setWorldEventState(this.id, null);
      emitStage(env, this.id, this.kind, 'end', this.x, this.y, this.radius, 1, this.rebel ? [this.parent, this.rebel] : [this.parent]);
      return false;
    }
    return true;
  }

  private cancel(env: EventEnv): boolean {
    const g = env.g;
    g.emit({ type: 'unrest', tick: g.tick, owner: this.parent, region: [], cause: this.cause ?? 'occupation', stage: 'cancelled', untilTick: g.tick, x: this.x, y: this.y });
    g.setWorldEventState(this.id, null);
    emitStage(env, this.id, this.kind, 'end', this.x, this.y, this.radius, 0, [this.parent]);
    return false;
  }

  private place(): void {
    const r = this.region;
    const x0 = cx(r[0]);
    let sx = 0, sy = 0;
    for (const t of r) {
      let dx = cx(t) - x0;
      if (dx > MAP_W / 2) dx -= MAP_W;
      if (dx < -MAP_W / 2) dx += MAP_W;
      sx += dx;
      sy += cy(t);
    }
    this.x = (((x0 + sx / r.length) % MAP_W) + MAP_W) % MAP_W;
    this.y = sy / r.length;
    let maxD = 0;
    for (let i = 0; i < r.length; i += 5) {
      let dx = Math.abs(cx(r[i]) - this.x);
      if (dx > MAP_W / 2) dx = MAP_W - dx;
      maxD = Math.max(maxD, Math.hypot(dx, cy(r[i]) - this.y));
    }
    this.radius = Math.max(4, maxD);
  }

  private raisedFrontNear(env: EventEnv): boolean {
    const g = env.g;
    for (const f of g.fronts.frontsOf(this.parent)) {
      const s = f.a === this.parent ? 0 : 1;
      if (f.priority[s] !== 2) continue;
      let dx = Math.abs(f.x - this.x);
      if (dx > MAP_W / 2) dx = MAP_W - dx;
      if (Math.hypot(dx, f.y - this.y) <= this.radius + 20) return true;
    }
    return false;
  }

  /** The region breaks away (what the parent still holds of it). False when too little is left. */
  private erupt(env: EventEnv): boolean {
    const g = env.g;
    const p = g.player(this.parent);
    if (!p || !p.alive || p.tiles < 300) return false;
    const region = this.region.filter((t) => g.ownerOf(t) === p.id);
    if (region.length < MIN_REGION) return false;
    const countryIdx = g.world.country[region[0]];
    const country = countryIdx > 0 ? g.world.countries[countryIdx] : undefined;
    const name = country ? `${country.nameEs} Libre` : `${p.name} Libre`;
    // DESIGN_V2 §10.2: the parent's hue rotated 25°, lightness 0.64 (never a dark grey successor state).
    const color = rebelColor(p.color);
    const rid = g.addPlayer({ name, kind: 'rebel', personality: 'conqueror', color, countryIndex: 0 });
    if (rid <= 0) return false;
    // The local garrison defects with the province.
    const share = region.length / Math.max(1, p.tiles);
    const defectors = p.troops * Math.max(0.1, Math.min(0.3, share * 2));
    g.addTroops(p.id, -defectors);
    g.transferTiles(region, rid, 'rebellion');
    const army = defectors * 1.2 + region.length * 60 + 20_000;
    g.addTroops(rid, army);
    const naturalCap = (BALANCE.troopCapBase + Math.pow(region.length, 0.6) * BALANCE.troopCapPerTile) * 0.6;
    g.setModifier(rid, 'maxTroops', Math.max(1, Math.min(10, army / Math.max(1, naturalCap))), 2400);
    g.addGold(rid, Math.min(p.gold * share, 3_000_000) + 250_000);
    g.setModifier(rid, 'defensePower', 1.5, 1500);
    g.setModifier(p.id, 'troopGrowth', 0.85, 1200);
    // The rebel movement is at war with its parent and mobilizes 60 ticks before its first offensive.
    g.war.declare(rid, p.id, 'liberation', 'war.reason.rebellion', { force: true });
    env.lastRebellion.set(p.id, g.tick);
    this.rebel = rid;
    g.emit({ type: 'unrest', tick: g.tick, owner: this.parent, region: [], cause: this.cause ?? 'occupation', stage: 'rebellion', untilTick: g.tick, x: this.x, y: this.y });
    emitStage(env, this.id, this.kind, 'start', this.x, this.y, this.radius, region.length, [this.parent, rid]);
    return true;
  }
}

/**
 * The region at risk: the largest cluster of occupied land (occupation), the land around the last nuclear strike
 * (nuclear), or a province far from the capital (exhaustion); grown inside the parent's land and capped at
 * ≤ 40 % of the parent and ≤ 15 % of the world (T20).
 */
function regionFor(env: EventEnv, p: SimPlayer, cause: UnrestCause, seed: number): number[] {
  const g = env.g;
  const cap = Math.floor(Math.min(p.tiles * 0.4, g.world.landTiles * 0.15));
  if (cause === 'occupation') {
    const occ: number[] = [];
    for (const t of g.borderTiles(p.id)) if (g.isOccupied(t)) occ.push(t);
    // Occupied land is where the front passed: start from occupied border tiles and flood through occupied land.
    const cluster = floodOccupied(g, p.id, occ, cap);
    if (cluster.length >= MIN_REGION) return grow(g, p.id, cluster, Math.min(cap, Math.round(cluster.length * 1.3)), p.capitalTile);
    return cluster;
  }
  if (cause === 'nuclear') {
    const n = env.nuked.get(p.id);
    const start = n && g.ownerOf(n.tile) === p.id ? n.tile : seed;
    return grow(g, p.id, [start], Math.min(cap, Math.max(150, Math.round(p.tiles * 0.08))), p.capitalTile);
  }
  return grow(g, p.id, [seed], Math.min(cap, Math.max(150, Math.round(p.tiles * (0.07 + env.rng.next() * 0.05)))), p.capitalTile);
}

function floodOccupied(g: SimGame, owner: number, seeds: number[], cap: number): number[] {
  const seen = new Set<number>();
  let best: number[] = [];
  for (const s of seeds) {
    if (seen.has(s)) continue;
    const comp: number[] = [s];
    seen.add(s);
    for (let i = 0; i < comp.length && comp.length < cap; i++) {
      const t = comp[i];
      const x = t % MAP_W;
      for (const n of [x === 0 ? t + MAP_W - 1 : t - 1, x === MAP_W - 1 ? t - MAP_W + 1 : t + 1, t - MAP_W, t + MAP_W]) {
        if (n < 0 || n >= g.world.terrain.length || seen.has(n)) continue;
        if (g.ownerOf(n) !== owner || !g.isOccupied(n)) continue;
        seen.add(n);
        comp.push(n);
      }
    }
    if (comp.length > best.length) best = comp;
  }
  return best;
}

/** Breadth-first blob of `owner`'s tiles from `seeds` (never within 8 tiles of the capital). */
function grow(g: SimGame, owner: number, seeds: number[], size: number, capital: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>(seeds);
  const queue = seeds.slice();
  const capX = capital >= 0 ? capital % MAP_W : -1e9, capY = capital >= 0 ? (capital / MAP_W) | 0 : -1e9;
  for (let head = 0; head < queue.length && out.length < size; head++) {
    const t = queue[head];
    if (g.ownerOf(t) !== owner) continue;
    out.push(t);
    const x = t % MAP_W;
    for (const n of [x === 0 ? t + MAP_W - 1 : t - 1, x === MAP_W - 1 ? t - MAP_W + 1 : t + 1, t - MAP_W, t + MAP_W]) {
      if (n < 0 || n >= g.world.terrain.length || seen.has(n)) continue;
      seen.add(n);
      if (g.ownerOf(n) !== owner) continue;
      let dx = Math.abs((n % MAP_W) - capX);
      if (dx > MAP_W / 2) dx = MAP_W - dx;
      const dy = ((n / MAP_W) | 0) - capY;
      if (dx * dx + dy * dy < 64) continue;
      queue.push(n);
    }
  }
  return out;
}

/** A seed tile for a rebellion in `p`: an owned tile far from the capital (sampled around the border). */
export function rebellionSeed(env: EventEnv, p: SimPlayer): number {
  const g = env.g;
  const border = g.borderTiles(p.id);
  if (border.size === 0) return -1;
  const cap = p.capitalTile;
  const step = Math.max(1, Math.floor(border.size / 60));
  let i = env.rng.int(step), best = -1, bestScore = -1;
  let k = 0;
  for (const t of border) {
    if (k++ < i) continue;
    i += step;
    let score = cap >= 0 ? distTiles(t, cap) : env.rng.next() * 100;
    if (g.isOccupied(t)) score *= 2;
    score *= 0.8 + env.rng.next() * 0.4;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

function distTiles(a: number, b: number): number {
  let dx = Math.abs((a % MAP_W) - (b % MAP_W));
  if (dx > MAP_W / 2) dx = MAP_W - dx;
  const dy = ((a / MAP_W) | 0) - ((b / MAP_W) | 0);
  return Math.sqrt(dx * dx + dy * dy);
}
