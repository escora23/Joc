// FRONT ULTRA — AI economy: build orders and placement (owner: sim-ai). Worker-only.
//
// Every build tick a nation scores each structure family by need x personality weight and builds the best one it
// can afford (or upgrades a city). Needs are driven by the situation: cities for troop cap and income, ports and
// factories for trade, defense posts on threatened fronts, SAM sites + radar when hostile silos are in range or
// nukes are flying, army bases / airbases / naval yards once the economy can sustain a modern military, and silos
// for the nuclear-minded late game. Placement: cities and silos deep inside, ports on the coast, posts on fronts.

import { STRUCTURE_DEFS } from '../../shared/constants';
import type { SimPlayer, SimStructure } from '../../shared/simapi';
import { StructureType } from '../../shared/types';
import { alive, home, landShare, type AiContext } from './context';
import { depthOf, dist2, ownTileNear, sampleSet } from './mapindex';
import type { Brain } from './state';

type S = StructureType;

interface Want {
  type: S;
  score: number;
}

const wants: Want[] = [];

export function thinkBuild(ctx: AiContext, b: Brain, p: SimPlayer): void {
  const g = ctx.g;
  const rng = ctx.rng;
  const diff = b.diff, w = b.prof.build;
  if (rng.next() < diff.sloppiness) return;
  const mine = g.structures(p.id);
  const count = new Int32Array(10);
  let cityLevels = 0;
  for (const s of mine) {
    count[s.type]++;
    if (s.type === StructureType.City) cityLevels += s.level;
  }
  const tiles = p.tiles;
  const gold = p.gold;
  const tick = g.tick;
  const center = home(ctx, b, p);
  if (center < 0) return;
  const hasCoast = b.front.shoreSample.length > 0 || ctx.g.isShore(center);
  const threat = threatLevel(ctx, b, p);
  const nukeThreat = nuclearThreat(ctx, b, p);
  const late = tick > 6000;

  wants.length = 0;
  const add = (type: S, score: number) => {
    if (score > 0) wants.push({ type, score });
  };
  const nCity = count[StructureType.City];
  // Cities: the backbone (troop cap + income). Strong desire for the first few, then one per ~1200 tiles.
  const wantCities = 1 + tiles / 1200;
  add(StructureType.City, w.city * (nCity < 3 ? 2.6 : nCity < wantCities ? 1.6 : 0.3));
  if (hasCoast) add(StructureType.Port, w.port * (count[StructureType.Port] < 1 + tiles / 3000 ? 1.5 : 0.15));
  if (tiles > 600) add(StructureType.Factory, w.factory * (count[StructureType.Factory] < tiles / 2500 ? 1.2 : 0.12));
  // Defense posts where the front is hot.
  if (threat > 0.2) add(StructureType.DefensePost, w.defense * threat * (count[StructureType.DefensePost] < 2 + tiles / 1500 ? 1.8 : 0.2));
  // Modern military once the economy is up.
  if (tiles > 1200 && tick > 1800) {
    add(StructureType.ArmyBase, w.armyBase * (count[StructureType.ArmyBase] < 1 + tiles / 9000 ? 1.1 : 0.05));
    add(StructureType.Airbase, w.airbase * (count[StructureType.Airbase] < (tiles > 5000 ? 2 : 1) ? (tick > 3600 ? 1.0 : 0.5) : 0.05));
    if (hasCoast) add(StructureType.NavalYard, w.navalYard * (count[StructureType.NavalYard] < 1 ? 0.8 : 0.03));
  }
  // Air defense when silos are pointed at us.
  if (nukeThreat > 0) {
    add(StructureType.SamSite, w.sam * nukeThreat * (count[StructureType.SamSite] < 1 + cityLevels / 8 ? 2.4 : 0.3));
    if (count[StructureType.SamSite] > 0) add(StructureType.Radar, w.radar * (count[StructureType.Radar] < 1 ? 1.2 : 0));
  }
  // Nukes (v2 §5.10): silos only for the nuclear-minded (personality nukes >= 0.3) or when an enemy at war owns silos
  // (no more "every large nation builds silos").
  if (g.config.nukes && tiles > 800) {
    let enemySilos = false;
    for (const e of g.war.enemiesOf(p.id)) {
      if (g.structures(e, StructureType.MissileSilo).length > 0) {
        enemySilos = true;
        break;
      }
    }
    if (b.prof.nukes >= 0.3 || enemySilos) {
      const siloTick = diff.nukeTick * b.prof.nukeDelay * 0.75 * (1 - ctx.world.doomsday * 0.5);
      const nSilo = count[StructureType.MissileSilo];
      const maxSilos = (b.personality === 'nuker' && tiles > 4000 ? 2 : 1) + (tiles > 20000 ? 1 : 0);
      if (tick > siloTick || enemySilos) add(StructureType.MissileSilo, Math.max(w.silo, enemySilos ? 0.8 : 0) * (nSilo < maxSilos ? (late ? 2.2 : 1.2) : 0));
    }
  }
  if (wants.length === 0) return;

  // Rich nations build several things per pass; each pick halves the desire for more of the same.
  const passes = Math.min(8, 1 + Math.floor(gold / 1_000_000));
  for (let pass = 0; pass < passes; pass++) {
    wants.sort((a, c) => c.score - a.score);
    const top = wants[0];
    if (!top || top.score < 0.1) return;
    // Upgrading a city is often better than a new one once we have a few.
    if (top.type === StructureType.City && nCity >= 3 && rng.next() < 0.5 && tryUpgrade(ctx, p, mine, StructureType.City)) {
      top.score *= 0.6;
      continue;
    }
    let built = false;
    for (let i = 0; i < Math.min(3, wants.length) && !built; i++) {
      const wt = wants[i];
      const cost = g.structureCost(p.id, wt.type);
      if (p.gold < cost) {
        // Save up for the top priority instead of frittering gold on the next item (efficient AIs only).
        if (i === 0 && rng.next() < diff.efficiency * 0.6) return;
        continue;
      }
      const tile = placeFor(ctx, b, p, wt.type);
      if (tile >= 0 && g.issue(p.id, { type: 'build', structure: wt.type, tile })) {
        wt.score *= 0.5;
        built = true;
      } else wt.score *= 0.3;
    }
    if (!built) {
      // Nothing new: upgrade something useful.
      if (p.gold > g.structureCost(p.id, StructureType.City) * 1.3) {
        if (tryUpgrade(ctx, p, mine, StructureType.City) || tryUpgrade(ctx, p, mine, StructureType.Factory) || tryUpgrade(ctx, p, mine, StructureType.Port)
          || (nukeThreat > 0.5 && tryUpgrade(ctx, p, mine, StructureType.SamSite)) || (late && tryUpgrade(ctx, p, mine, StructureType.MissileSilo))) continue;
      }
      return;
    }
  }
}

function tryUpgrade(ctx: AiContext, p: SimPlayer, mine: readonly SimStructure[], type: S): boolean {
  let best: SimStructure | null = null;
  for (const s of mine) {
    if (s.type !== type || s.built < 1 || s.level >= STRUCTURE_DEFS[type].maxLevel) continue;
    if (!best || s.level < best.level) best = s;
  }
  if (!best || p.gold < ctx.g.structureCost(p.id, type)) return false;
  return ctx.g.issue(p.id, { type: 'upgrade', structureId: best.id });
}

/** 0..1: how much fighting is happening on our fronts. */
export function threatLevel(ctx: AiContext, b: Brain, p: SimPlayer): number {
  const g = ctx.g;
  let inc = 0;
  for (const a of g.incomingAttacks(p.id)) if (a.attacker > 0) inc += a.troops;
  let t = Math.min(1, inc / Math.max(1, p.troops));
  // Big hostile neighbours are a threat even when quiet.
  for (const [id, c] of b.front.contact) {
    if (id === 0 || c < 4) continue;
    const q = g.player(id);
    if (!alive(q) || g.isAllied(p.id, id) || q.kind === 'tribe') continue;
    if (q.troops > p.troops * 1.3) t = Math.max(t, Math.min(1, 0.3 + (q.troops / Math.max(1, p.troops) - 1.3) * 0.3));
  }
  return t;
}

/** 0..1: hostile missile silos in range, nukes launched at us, the doomsday clock. */
export function nuclearThreat(ctx: AiContext, b: Brain, p: SimPlayer): number {
  const g = ctx.g;
  if (!g.config.nukes) return 0;
  let t = ctx.world.doomsday * 0.6;
  const r = b.relations;
  for (const rel of r.values()) if (g.tick - rel.nukedTick < 6000) t = 1;
  if (t >= 1 || b.homeTile < 0) return Math.min(1, t);
  for (const s of g.structures(undefined, StructureType.MissileSilo)) {
    if (s.owner === p.id || g.isAllied(p.id, s.owner)) continue;
    const d2 = dist2(s.tile, b.homeTile);
    if (d2 < 600 * 600) t = Math.max(t, d2 < 250 * 250 ? 0.9 : 0.55);
  }
  if (ctx.world.detonations > 0) t = Math.max(t, 0.4);
  return Math.min(1, t);
}

const tmpSample: number[] = [];

/** Pick a tile for a new structure of `type`, or -1. */
export function placeFor(ctx: AiContext, b: Brain, p: SimPlayer, type: S): number {
  const g = ctx.g;
  const rng = ctx.rng;
  const center = home(ctx, b, p);
  if (center < 0) return -1;
  const radius = Math.max(4, Math.min(90, Math.sqrt(p.tiles) * 0.75));
  const def = STRUCTURE_DEFS[type];
  if (def.coastal) {
    // Coastal: shore tiles from the front scan, else random own tiles that happen to be coastal.
    for (const t of b.front.shoreSample) if (g.canBuild(p.id, type, t)) return t;
    for (let k = 0; k < 40; k++) {
      const t = ownTileNear(g, p.id, center, radius * 1.4, rng, 6);
      if (t >= 0 && g.isShore(t) && g.canBuild(p.id, type, t)) return t;
    }
    // Last resort: walk the border set for coastal tiles.
    sampleSet(g.borderTiles(p.id), 80, rng, tmpSample);
    for (const t of tmpSample) if (g.isShore(t) && g.canBuild(p.id, type, t)) return t;
    return -1;
  }
  if (type === StructureType.DefensePost) {
    // On the most threatened front: our side of the contact with the strongest hostile neighbour.
    let bestId = -1, bestT = 0;
    for (const [id, c] of b.front.contact) {
      if (id === 0 || c < 3) continue;
      const q = g.player(id);
      if (!alive(q) || g.isAllied(p.id, id) || q.kind === 'tribe') continue;
      let score = q.troops * Math.min(1, c / 20);
      for (const a of g.incomingAttacks(p.id)) if (a.attacker === id) score += a.troops * 3;
      if (score > bestT) {
        bestT = score;
        bestId = id;
      }
    }
    const anchor = bestId >= 0 ? b.front.ours.get(bestId) ?? -1 : -1;
    if (anchor >= 0) {
      for (let k = 0; k < 16; k++) {
        const t = ownTileNear(g, p.id, anchor, 3 + k * 0.5, rng, 4);
        if (t >= 0 && g.canBuild(p.id, type, t)) return t;
      }
    }
    return -1;
  }
  // Interior structures: the deepest of a few candidates (silos, SAMs, cities, bases).
  const wantDeep = type === StructureType.MissileSilo || type === StructureType.Airbase || type === StructureType.ArmyBase || type === StructureType.Radar;
  let best = -1, bestScore = -Infinity;
  const tries = wantDeep ? 14 : 10;
  for (let k = 0; k < tries; k++) {
    const t = ownTileNear(g, p.id, center, radius, rng, 8);
    if (t < 0 || !g.canBuild(p.id, type, t)) continue;
    let score = depthOf(g, p.id, t) + rng.next() * 2;
    if (type === StructureType.City) score += spread(ctx, p.id, t, StructureType.City);
    if (type === StructureType.SamSite) score -= Math.sqrt(dist2(t, center)) * 0.05; // cover the heartland
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/** Bonus for keeping same-type structures apart (cities spread over the territory). */
function spread(ctx: AiContext, pid: number, t: number, type: S): number {
  let near = 0;
  for (const s of ctx.g.structuresNear(t % 1600, (t / 1600) | 0, 14)) if (s.owner === pid && s.type === type) near++;
  return -near * 3;
}

/** Share of the world this nation holds (used by the director for pacing). */
export function share(ctx: AiContext, p: SimPlayer): number {
  return landShare(ctx, p);
}
