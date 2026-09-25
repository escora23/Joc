// FRONT ULTRA — world event: rebellion (owner: sim-ai). Worker-only, deterministic.
//
// Overextended empires crack. The candidate is a big nation spread thin (troops far below its cap), growing fast,
// losing wars or its capital. Unrest is reported first (warning); then a contiguous province far from the capital
// breaks away as a new rebel nation ("<Country> Libre"), taking part of the local garrison and every structure in
// the province with it. The AI director gives the rebels a brain that fights their former masters.

import { BALANCE, MAP_W } from '../../shared/constants';
import { rebelColor } from '../../data/palette';
import type { SimGame, SimPlayer } from '../../shared/simapi';
import { cx, cy, emitStage, type ActiveEvent, type EventEnv } from './common';

const WARNING_TICKS = 300;
const AFTERMATH_TICKS = 600;

/** How ripe `p` is for a rebellion (0 = not at all). */
export function unrest(env: EventEnv, p: SimPlayer): number {
  const g = env.g;
  if (!p.alive || !p.spawned || (p.kind !== 'nation' && p.kind !== 'human') || p.tiles < 1500) return 0;
  const fill = p.troops / Math.max(1, p.maxTroops);
  const past = env.pastTiles.get(p.id) ?? p.tiles;
  const growth = Math.min(2, Math.max(0, (p.tiles - past) / Math.max(4000, past)));
  const share = p.tiles / Math.max(1, g.world.landTiles);
  // Size, sprawl and speed of conquest breed unrest; a thin garrison makes it worse.
  let s = Math.log10(p.tiles) * (1 + growth * 2.5) * (1 + share * 6) * (1.3 - Math.min(1, fill) * 0.6);
  let incoming = 0;
  for (const a of g.incomingAttacks(p.id)) incoming += a.troops;
  s *= 1 + Math.min(1, incoming / Math.max(1, p.troops));
  if (p.capitalTile < 0) s *= 1.5;
  return s;
}

export class Rebellion implements ActiveEvent {
  readonly kind = 'rebellion' as const;
  private t = 0;
  private rebel = 0;
  private readonly x: number;
  private readonly y: number;
  private radius = 12;

  constructor(readonly id: number, private readonly parent: number, private readonly seed: number, private readonly warn: boolean) {
    this.x = cx(seed);
    this.y = cy(seed);
  }

  step(env: EventEnv): boolean {
    const g = env.g;
    const warnTicks = this.warn ? WARNING_TICKS : 0;
    if (this.t === 0 && this.warn) emitStage(env, this.id, this.kind, 'warning', this.x, this.y, this.radius, 0, [this.parent]);
    if (this.t === warnTicks) {
      if (!this.erupt(env)) {
        g.setWorldEventState(this.id, null);
        emitStage(env, this.id, this.kind, 'end', this.x, this.y, this.radius, 0, [this.parent]);
        return false;
      }
    }
    this.t++;
    const life = warnTicks + AFTERMATH_TICKS;
    if (this.t % 10 === 0) {
      g.setWorldEventState(this.id, {
        kind: this.kind, x: this.x, y: this.y, radius: this.radius, progress: Math.min(1, this.t / life),
        magnitude: this.t < warnTicks ? 0 : 1, players: this.rebel ? [this.parent, this.rebel] : [this.parent], heading: 0,
      });
    }
    if (this.t >= life) {
      g.setWorldEventState(this.id, null);
      emitStage(env, this.id, this.kind, 'end', this.x, this.y, this.radius, 1, this.rebel ? [this.parent, this.rebel] : [this.parent]);
      return false;
    }
    return true;
  }

  /** The province breaks away. False when the parent no longer holds the region. */
  private erupt(env: EventEnv): boolean {
    const g = env.g;
    const p = g.player(this.parent);
    if (!p || !p.alive || p.tiles < 300) return false;
    let seed = this.seed;
    if (g.ownerOf(seed) !== p.id) {
      seed = -1;
      for (let k = 0; k < 40 && seed < 0; k++) {
        const a = env.rng.next() * Math.PI * 2, r = env.rng.next() * 20;
        const t = Math.floor(this.y + Math.sin(a) * r) * MAP_W + (((Math.floor(this.x + Math.cos(a) * r)) % MAP_W) + MAP_W) % MAP_W;
        if (t >= 0 && t < g.world.terrain.length && g.ownerOf(t) === p.id) seed = t;
      }
      if (seed < 0) return false;
    }
    // Bigger empires lose bigger provinces (a sprawling superpower can lose a whole region).
    const size = Math.round(Math.max(150, Math.min(Math.max(5000, Math.min(12_000, p.tiles * 0.1)), p.tiles * (0.07 + env.rng.next() * 0.07))));
    const region = growRegion(g, p.id, seed, size, p.capitalTile);
    if (region.length < 60) return false;

    const countryIdx = g.world.country[seed];
    const country = countryIdx > 0 ? g.world.countries[countryIdx] : undefined;
    const name = country ? `${country.nameEs} Libre` : `${p.name} Libre`;
    // DESIGN_V2 §10.2: the parent's hue rotated 25°, lightness 0.64 (never a dark grey successor state).
    const color = rebelColor(p.color);
    const rid = g.addPlayer({ name, kind: 'rebel', personality: 'conqueror', color, countryIndex: 0 });
    if (rid <= 0) return false;
    // The local garrison defects (with interest: the province rises as one), the uprising has momentum for a
    // while and the rebels dig in hard on their own ground.
    const share = region.length / Math.max(1, p.tiles);
    const defectors = p.troops * Math.max(0.2, Math.min(0.3, share * 3));
    g.addTroops(p.id, -defectors);
    g.transferTiles(region, rid);
    const density = p.troops / Math.max(1, p.tiles);
    const army = defectors * 1.5 + region.length * Math.max(60, density * 0.5) + 30_000;
    g.addTroops(rid, army);
    // A province in arms fields far more soldiers than its land would normally feed: lift the troop cap for a few
    // minutes (otherwise the surplus would bleed away), after which the rebel state lives on its own means.
    const naturalCap = (BALANCE.troopCapBase + Math.pow(region.length, 0.6) * BALANCE.troopCapPerTile) * 0.6;
    g.setModifier(rid, 'maxTroops', Math.max(1, Math.min(25, army / Math.max(1, naturalCap))), 1200);
    g.addGold(rid, Math.min(p.gold * share, 3_000_000) + 250_000);
    g.setModifier(rid, 'defensePower', 2.2, 1500);
    g.setModifier(rid, 'attackPower', 1.15, 600);
    // The loyalist army is demoralised for a while.
    g.setModifier(p.id, 'troopGrowth', 0.85, 1200);
    g.setModifier(p.id, 'attackPower', 0.9, 900);
    this.rebel = rid;
    // Visual extent of the province.
    let maxD = 0;
    for (let i = 0; i < region.length; i += 7) {
      const t = region[i];
      let dx = Math.abs(cx(t) - this.x);
      if (dx > MAP_W / 2) dx = MAP_W - dx;
      const d = Math.hypot(dx, cy(t) - this.y);
      if (d > maxD) maxD = d;
    }
    this.radius = Math.max(6, maxD);
    emitStage(env, this.id, this.kind, 'start', this.x, this.y, this.radius, region.length, [this.parent, rid]);
    return true;
  }
}

/** Breadth-first blob of `owner`'s tiles around `seed` (never within 8 tiles of the capital). */
function growRegion(g: SimGame, owner: number, seed: number, size: number, capital: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>([seed]);
  const queue = [seed];
  const capX = capital >= 0 ? capital % MAP_W : -1e9, capY = capital >= 0 ? (capital / MAP_W) | 0 : -1e9;
  for (let head = 0; head < queue.length && out.length < size; head++) {
    const t = queue[head];
    out.push(t);
    const x = t % MAP_W;
    const nb = [x === 0 ? t + MAP_W - 1 : t - 1, x === MAP_W - 1 ? t - MAP_W + 1 : t + 1, t - MAP_W, t + MAP_W];
    for (const n of nb) {
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
    // Far from the capital, and preferably on the coast (a province with sea access cannot simply be encircled).
    let score = cap >= 0 ? distTiles(t, cap) : env.rng.next() * 100;
    if (g.isShore(t)) score *= 1.6;
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
