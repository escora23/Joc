// FRONT ULTRA — the one forecast of an offensive (gauntlet round 1, owner item 29a). Owner: ui.
//
// The hover card on enemy land, the offensive dialog and the Guerra panel row used to compute the same front three
// ways (troops sent alone vs the running offensive plus the reinforcement vs the sim's ratio; the front nearest by its
// centre vs by its contact line; plains speed vs measured speed), so one front read «31 : 1 · 8 km/h» on hover, «72 : 1
// · 3,3 km/h» in the dialog and «59,5 : 1» in the panel. Everything now comes from forecastOffensive():
//
//   * the front: the human's front with that enemy whose CONTACT LINE is nearest the click (the sim's frontAt rule);
//   * the ratio: a running offensive's own R (the sim's Pa / Pd, the number the panel shows) scaled by the troops the
//     change adds; a new offensive: the troops against the garrison of that front (+ half of an enemy offensive on it,
//     as the two-sided battle weighs it, §4.8), with the assault and drone multipliers the sim applies;
//   * the width: frontageTiles(total troops, front length), the corridor the sim will draw;
//   * the speed: a running offensive starts from its measured km/h (offensiveOutlook, the badge's number); a new one
//     from the model's speed × the ground on that stretch of the front (mean of 1 / terrain time over the enemy tiles
//     on the contact inside the corridor: mountains 2,6×, hills 1,6×, rivers and high ground ×1,5 more), so the hover
//     no longer promises a plains figure in the Pyrenees;
//   * the cap: once R passes 3 : 1 the model is at its 8 km/h ceiling and the terrain decides; `saturated` says so and
//     the dialog explains why more troops add width and spare casualties, not speed;
//   * casualties per day: the sim's engagement (§4.6) with terrain defense, the enemy's capped by the troops actually on
//     that front (it cannot lose more men in a day than it has there).

import {
  ADVANCE_FULL_RATIO, ADVANCE_MAX_KMH, AIR_DENIAL_ADVANCE_MUL, AIR_SUPERIORITY_ADVANCE_MUL, DRONE_ADVANCE_MUL,
  DRONE_ENEMY_ADVANCE_MUL, ENGAGEMENT_RATE, HUMAN_ID, MAP_H, MAP_W, OFFENSIVE_CONTACT_TICKS, TERRAIN_DEF, TERRAIN_TIME,
  TICKS_PER_GAME_DAY, TILE_KM,
} from '../../shared/constants';
import { advanceKmh, frontageTiles, offensiveOutlook, predictOffensive, tileKm } from '../../shared/orders';
import { TerrainClass, TerrainFlag, TERRAIN_CLASS_MASK, type AttackView, type FrontView, type OffensiveIntensity } from '../../shared/types';
import type { GameView } from '../../shared/api';
import { viewRules } from '../../sim/rulesView';
import { outlookOf } from './forcesInfo';
import { offensiveKmh } from './frontsInfo';

const ASSAULT_POWER = 1.25, ASSAULT_OWN_LOSS = 1.6, ASSAULT_ENEMY_LOSS = 1.2, HOLD_ENGAGEMENT = 0.25;

export type GroundKind = 'plains' | 'hills' | 'mountains' | 'river' | 'high';

export interface OffensiveForecast {
  front: FrontView | null;
  /** Our running offensive on that front (not retreating), if any. */
  running: AttackView | null;
  /** Troops this order sends and the offensive's total after it. */
  send: number;
  troops: number;
  /** Troops of the enemy facing it on that front: its garrison (+ half of its own offensive there). */
  garrison: number;
  ratio: number;
  /** Front length (tiles) and the corridor the troops buy on it (tiles, km). */
  frontTiles: number;
  corridorTiles: number;
  corridorKm: number;
  /** Expected depth speed after the order (km/h, terrain included) and the measured one now (-1 for a new offensive). */
  kmh: number;
  nowKmh: number;
  /** The most this stretch of ground allows at full superiority (km/h). */
  capKmh: number;
  /** The ratio is past the model's ceiling: more troops buy width and spare casualties, not speed. */
  saturated: boolean;
  /** The ground that sets the cap: the most common class on the contact inside the corridor. */
  ground: GroundKind;
  /** Mean 1 / terrain time on that stretch (1 on open plains). */
  groundMul: number;
  ownLossDay: number;
  enemyLossDay: number;
  verdict: 'advance' | 'grind' | 'stall' | 'hold';
  startsInTicks: number;
  /** The sky over that front (1 ours, -1 theirs, 0 contested / none) and the drone swarms supporting each side. */
  air: number;
  casOwn: number;
  casTheir: number;
}

/** The human's front with `enemy` whose contact line passes nearest to `tile` (the sim's frontAt rule). */
export function frontNearTile(view: GameView, enemy: number, tile: number): FrontView | null {
  const tx0 = (tile % MAP_W) + 0.5, ty0 = Math.floor(tile / MAP_W) + 0.5;
  let best: FrontView | null = null, bd = Infinity;
  for (const f of view.fronts) {
    if (!((f.a === HUMAN_ID && f.b === enemy) || (f.b === HUMAN_ID && f.a === enemy))) continue;
    const s = f.samples;
    for (let i = 0; i < s.length >> 1; i++) {
      const d = tileKm(tx0, ty0, s[i * 2], s[i * 2 + 1]);
      if (d < bd) {
        bd = d;
        best = f;
      }
    }
  }
  return best;
}

/** Our running offensive against `enemy` on front `f` (any front when f is null), not retreating. */
export function runningOffensive(view: GameView, f: FrontView | null, enemy: number): AttackView | null {
  return view.attacks.find((a) => a.attacker === HUMAN_ID && a.defender === enemy && a.id > 0 && !a.naval && a.state !== 'retreating'
    && (f ? a.frontKey === f.key : true)) ?? null;
}

/**
 * The ground under the stretch of front an offensive at `tile` would push on: the enemy tiles touching the contact
 * line within half the corridor of the point of the line nearest the click.
 */
export function groundOnFront(view: GameView, f: FrontView, enemy: number, tile: number, corridorTiles: number): { mul: number; def: number; kind: GroundKind } {
  const world = view.world;
  const s = f.samples, n = s.length >> 1;
  if (!world || n === 0) return { mul: 1, def: 1, kind: 'plains' };
  const tx0 = (tile % MAP_W) + 0.5, ty0 = Math.floor(tile / MAP_W) + 0.5;
  let k0 = 0, bd = Infinity;
  for (let i = 0; i < n; i++) {
    const d = tileKm(tx0, ty0, s[i * 2], s[i * 2 + 1]);
    if (d < bd) {
      bd = d;
      k0 = i;
    }
  }
  const half = Math.max(1.5, corridorTiles / 2) * TILE_KM;
  const cx = s[k0 * 2], cy = s[k0 * 2 + 1];
  const seen = new Set<number>();
  let sumInv = 0, sumDef = 0, cnt = 0;
  const count: Record<GroundKind, number> = { plains: 0, hills: 0, mountains: 0, river: 0, high: 0 };
  for (let i = 0; i < n; i++) {
    const x = s[i * 2], y = s[i * 2 + 1];
    if (tileKm(cx, cy, x, y) > half) continue;
    for (let dy = -1; dy <= 1; dy++) {
      const ty = Math.floor(y + dy * 0.5);
      if (ty < 0 || ty >= MAP_H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const tx = ((Math.floor(x + dx * 0.5) % MAP_W) + MAP_W) % MAP_W;
        const t = ty * MAP_W + tx;
        if (seen.has(t) || view.owner[t] !== enemy) continue;
        seen.add(t);
        const tr = world.terrain[t];
        const c = tr & TERRAIN_CLASS_MASK;
        let m: number = c === TerrainClass.Mountains ? TERRAIN_TIME.mountains : c === TerrainClass.Hills ? TERRAIN_TIME.hills : TERRAIN_TIME.plains;
        let kind: GroundKind = c === TerrainClass.Mountains ? 'mountains' : c === TerrainClass.Hills ? 'hills' : 'plains';
        if (world.elevation[t] > 3000) {
          m *= TERRAIN_TIME.high;
          kind = 'high';
        }
        if (tr & TerrainFlag.River) {
          m *= TERRAIN_TIME.river;
          if (kind === 'plains') kind = 'river';
        }
        count[kind]++;
        sumInv += 1 / m;
        sumDef += c === TerrainClass.Mountains ? TERRAIN_DEF.mountains : c === TerrainClass.Hills ? TERRAIN_DEF.hills : TERRAIN_DEF.plains;
        cnt++;
      }
    }
  }
  if (cnt === 0) return { mul: 1, def: 1, kind: 'plains' };
  let kind: GroundKind = 'plains';
  for (const k of Object.keys(count) as GroundKind[]) if (count[k] > count[kind]) kind = k;
  return { mul: sumInv / cnt, def: sumDef / cnt, kind };
}

/**
 * What an order of `send` more troops (0 = no new troops, e.g. an intensity change) at `intensity` against `enemy`
 * toward `tile` would make of the offensive there: the single source of the hover card, the offensive dialog and the
 * Guerra panel row. `intensity` defaults to the running offensive's (or sustained).
 */
export function forecastOffensive(view: GameView, enemy: number, tile: number, send: number, intensity?: OffensiveIntensity, front?: FrontView): OffensiveForecast {
  const f = front ?? frontNearTile(view, enemy, tile);
  const cur = runningOffensive(view, f, enemy);
  const int: OffensiveIntensity = intensity ?? (cur ? cur.intensity : 1);
  const troops = Math.max(1, (cur ? cur.troops : 0) + Math.max(0, send));
  const side = f ? (f.a === HUMAN_ID ? 0 : 1) : 0;
  const pr = predictOffensive(viewRules(view), HUMAN_ID, enemy, troops, tile);
  // The enemy on that front: its garrison there, plus half of its own offensive on that front (§4.8).
  let garrison = f ? (side === 0 ? f.garrisonB : f.garrisonA) : pr.garrison;
  if (f) {
    const theirs = view.attacks.find((a) => a.attacker === enemy && a.defender === HUMAN_ID && a.frontKey === f.key && a.state !== 'retreating');
    if (theirs) garrison += theirs.troops * 0.5;
  }
  const G = Math.max(1, garrison);
  const frontTiles = f ? f.length : Infinity;
  const corridorTiles = frontageTiles(troops, false, frontTiles);
  const airOwn = f ? (side === 0 ? f.airA : f.airB) ?? 0 : 0, airTheir = f ? (side === 0 ? f.airB : f.airA) ?? 0 : 0;
  const air = airOwn > airTheir ? 1 : airTheir > airOwn ? -1 : 0;
  const casOwn = f && air >= 0 ? (side === 0 ? f.casA : f.casB) ?? 0 : 0;
  const casTheir = f && air <= 0 ? (side === 0 ? f.casB : f.casA) ?? 0 : 0;
  const ground = f ? groundOnFront(view, f, enemy, tile, corridorTiles) : { mul: 1, def: 1, kind: 'plains' as GroundKind };
  // Support multipliers the sim applies to the speed (never above the cap before terrain).
  let support = 1;
  if (casOwn > 0) support *= DRONE_ADVANCE_MUL;
  if (casTheir > 0) support *= DRONE_ENEMY_ADVANCE_MUL;
  if (air > 0) support *= AIR_SUPERIORITY_ADVANCE_MUL;
  if (air < 0) support *= AIR_DENIAL_ADVANCE_MUL;

  let ratio: number, kmh: number, nowKmh = -1, capKmh: number, saturated: boolean;
  const measured = cur && cur.ratio > 0 && cur.state !== 'contact' && cur.state !== 'mobilizing';
  if (cur && measured) {
    // The running offensive: the sim's own R and measured km/h, scaled by what the order changes.
    nowKmh = offensiveKmh(view, cur);
    const o = offensiveOutlook(outlookOf(cur, nowKmh), { troopsMul: troops / Math.max(1, cur.troops), intensity: int });
    ratio = o.ratio;
    kmh = int === 0 ? 0 : o.kmh;
    const plan0 = cur.planKmh ?? advanceKmh(cur.ratio);
    // At the model's ceiling the measured speed is what this ground (and the logistics) allow.
    saturated = cur.ratio >= ADVANCE_FULL_RATIO && plan0 >= ADVANCE_MAX_KMH * 0.98 * Math.min(1, support);
    capKmh = saturated && nowKmh > 0.05 ? Math.max(nowKmh, kmh) : ADVANCE_MAX_KMH * support * ground.mul;
  } else {
    ratio = (troops / G) * (int === 2 ? ASSAULT_POWER : 1) * (casOwn > 0 ? DRONE_ADVANCE_MUL : 1);
    capKmh = ADVANCE_MAX_KMH * support * ground.mul;
    kmh = int === 0 ? 0 : advanceKmh(ratio) * support * ground.mul;
    saturated = ratio >= ADVANCE_FULL_RATIO;
  }
  // Casualties per tick (§4.6) in garrison-equivalent power: E = rate × min(Pa, Pd); the attacker loses E·√(Pd/Pa) ×
  // the ground's defense, the defender E·√(Pa/Pd). The enemy cannot lose more in a day than it has on that front.
  const Pd = G, Pa = ratio * G;
  const E = ENGAGEMENT_RATE * Math.min(Pa, Pd) * (int === 0 ? HOLD_ENGAGEMENT : 1);
  const ownPow = E * Math.sqrt(Pd / Math.max(1, Pa)) * ground.def * (int === 2 ? ASSAULT_OWN_LOSS : 1);
  const enemyPow = E * Math.sqrt(Pa / Pd) * (int === 2 ? ASSAULT_ENEMY_LOSS : 1);
  const ownLossDay = Math.min(troops, ((ownPow * troops) / Math.max(1, Pa)) * TICKS_PER_GAME_DAY);
  const enemyLossDay = Math.min(G, enemyPow * TICKS_PER_GAME_DAY);
  const verdict = int === 0 ? 'hold' : ratio >= 1.7 ? 'advance' : ratio >= 1 ? 'grind' : 'stall';
  return {
    front: f, running: cur, send: Math.max(0, send), troops, garrison, ratio, frontTiles: Number.isFinite(frontTiles) ? frontTiles : corridorTiles,
    corridorTiles, corridorKm: corridorTiles * TILE_KM, kmh, nowKmh, capKmh, saturated, ground: ground.kind, groundMul: ground.mul,
    ownLossDay, enemyLossDay, verdict, startsInTicks: cur ? (cur.state === 'mobilizing' || cur.state === 'contact' ? Math.max(0, cur.etaTicks) : 0) : pr.startsInTicks || OFFENSIVE_CONTACT_TICKS, air, casOwn, casTheir,
  };
}
