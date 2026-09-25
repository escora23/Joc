// FRONT ULTRA — sim-core fallback AI (owner: sim-core). Used only when sim-ai's director (src/sim/ai) fails to
// load or keeps throwing, and by the headless harness with --ai=fallback. It plays through the public SimGame API
// exactly like the real AI: nations spawn at real capitals (named after their countries), tribes fill empty land,
// and everybody expands, fights the weakest neighbour, builds an economy, invades by sea and (nukers) nukes.

import { HUMAN_ID, MAP_H, MAP_W, TILE_COUNT } from '../shared/constants';
import { AIRCRAFT_STRIKE_RANGE, CRUISE_RANGE } from './balance';
import { hslToHex } from '../shared/color';
import { latLonToTile } from '../shared/geo';
import type { SimEvent } from '../shared/protocol';
import type { AiDirector, SimGame, SimPlayer } from '../shared/simapi';
import { EMOTES, PERSONALITIES, StructureType, UnitState, UnitType, type Personality, type WeaponType } from '../shared/types';

/** Used when the world data carries no capitals: [English name, lat, lon, weight]. */
const BUILTIN_NATIONS: [string, number, number, number][] = [
  ['United States of America', 38.9, -77.0, 1], ['China', 39.9, 116.4, 1], ['Russia', 55.75, 37.6, 0.9],
  ['India', 28.6, 77.2, 0.9], ['Brazil', -15.8, -47.9, 0.8], ['Germany', 52.5, 13.4, 0.8], ['France', 48.86, 2.35, 0.8],
  ['United Kingdom', 51.5, -0.13, 0.8], ['Japan', 35.7, 139.7, 0.8], ['Italy', 41.9, 12.5, 0.7], ['Canada', 45.4, -75.7, 0.7],
  ['Australia', -35.3, 149.1, 0.7], ['Mexico', 19.4, -99.1, 0.6], ['Indonesia', -6.2, 106.8, 0.6], ['Turkey', 39.9, 32.9, 0.6],
  ['Saudi Arabia', 24.7, 46.7, 0.6], ['Argentina', -34.6, -58.4, 0.5], ['South Africa', -25.7, 28.2, 0.5],
  ['Egypt', 30.0, 31.2, 0.5], ['Iran', 35.7, 51.4, 0.5], ['Nigeria', 9.1, 7.5, 0.5], ['Spain', 40.4, -3.7, 0.6],
  ['Poland', 52.2, 21.0, 0.5], ['Ukraine', 50.45, 30.5, 0.4], ['Pakistan', 33.7, 73.0, 0.5], ['Kazakhstan', 51.2, 71.4, 0.4],
  ['Ethiopia', 9.0, 38.75, 0.4], ['Colombia', 4.7, -74.1, 0.4], ['Peru', -12.05, -77.0, 0.35], ['Algeria', 36.75, 3.06, 0.4],
  ['Sweden', 59.3, 18.07, 0.4], ['Mongolia', 47.9, 106.9, 0.25], ['Thailand', 13.75, 100.5, 0.45], ['Vietnam', 21.0, 105.85, 0.4],
  ['Chile', -33.45, -70.67, 0.35], ['Venezuela', 10.5, -66.9, 0.3], ['Democratic Republic of the Congo', -4.3, 15.3, 0.35],
  ['Kenya', -1.3, 36.8, 0.3], ['Norway', 59.9, 10.75, 0.4], ['Finland', 60.17, 24.94, 0.3], ['Libya', 32.9, 13.2, 0.25],
  ['Sudan', 15.5, 32.5, 0.25], ['Angola', -8.8, 13.2, 0.25], ['Mali', 12.65, -8.0, 0.2], ['Madagascar', -18.9, 47.5, 0.2],
  ['Bolivia', -16.5, -68.15, 0.2], ['Myanmar', 19.75, 96.1, 0.25], ['Afghanistan', 34.5, 69.2, 0.2], ['Iraq', 33.3, 44.4, 0.3],
  ['New Zealand', -41.3, 174.8, 0.3], ['Greece', 37.98, 23.73, 0.35], ['Romania', 44.43, 26.1, 0.3], ['Morocco', 34.0, -6.85, 0.3],
  ['Philippines', 14.6, 121.0, 0.4], ['South Korea', 37.57, 126.98, 0.6], ['Portugal', 38.72, -9.14, 0.35], ['Cuba', 23.1, -82.4, 0.2],
  ['Tanzania', -6.2, 35.75, 0.25], ['Zambia', -15.4, 28.3, 0.2], ['Niger', 13.5, 2.1, 0.15], ['Chad', 12.1, 15.05, 0.15],
  ['Uzbekistan', 41.3, 69.25, 0.25], ['Greenland', 64.2, -51.7, 0.1], ['Papua New Guinea', -9.45, 147.2, 0.15],
];

const TRIBE_SYL = ['Ka', 'Tor', 'Mel', 'Ur', 'Van', 'Sha', 'Dro', 'Ki', 'Ol', 'Zan', 'Ber', 'Tu', 'Rha', 'Gor', 'Ne', 'Isk', 'Ama', 'Hal'];
const TRIBE_SUFFIX = ['Clans', 'Horde', 'Tribes', 'Confederacy', 'Kin', 'Nomads', 'Free Folk', 'League'];

interface Brain {
  id: number;
  personality: Personality;
  nextThink: number;
  nextBuild: number;
  nextNaval: number;
  nextNuke: number;
  nextMilitary: number;
  nextDiplomacy: number;
  /** Current war target (the neighbour we attack most), 0 = none. */
  enemy: number;
  aggression: number;
}

/**
 * @param adopt true when taking over a game whose players were already created by another director: the existing
 *              AI players are adopted instead of creating new ones.
 */
export function createFallbackAi(game: SimGame, adopt: boolean): AiDirector {
  const rng = game.rng.fork('fallback-ai');
  const brains = new Map<number, Brain>();

  function brainFor(p: SimPlayer): Brain {
    let b = brains.get(p.id);
    if (!b) {
      const personality = p.personality ?? PERSONALITIES[p.id % PERSONALITIES.length];
      b = {
        id: p.id, personality, nextThink: game.tick + rng.int(30), nextBuild: game.tick + 40 + rng.int(60),
        nextNaval: game.tick + 300 + rng.int(300), nextNuke: game.tick + 2400 + rng.int(2400),
        nextMilitary: game.tick + 600 + rng.int(600), nextDiplomacy: game.tick + 900 + rng.int(900), enemy: 0,
        aggression: personality === 'conqueror' ? 1.3 : personality === 'turtle' ? 0.6 : personality === 'opportunist' ? 1.1 : 0.9,
      };
      brains.set(p.id, b);
    }
    return b;
  }

  function freeLandNear(tile: number, maxR: number): number {
    if (tile >= 0 && game.isPlayable(tile) && game.ownerOf(tile) === 0) return tile;
    const cx = tile % MAP_W, cy = (tile / MAP_W) | 0;
    for (let r = 1; r <= maxR; r++) {
      for (let k = 0; k < 8 * r; k++) {
        const a = (k / (8 * r)) * Math.PI * 2;
        const y = Math.round(cy + Math.sin(a) * r);
        if (y < 0 || y >= MAP_H) continue;
        const t = y * MAP_W + ((Math.round(cx + Math.cos(a) * r) % MAP_W) + MAP_W) % MAP_W;
        if (game.isPlayable(t) && game.ownerOf(t) === 0) return t;
      }
    }
    return -1;
  }

  function nationColor(i: number): number {
    const hue = (i * 137.508 + 20) % 360;
    const light = [0.5, 0.42, 0.58][i % 3];
    return hslToHex(hue, 0.68, light);
  }

  function setupNations(): void {
    const w = game.world;
    const count = Math.max(0, Math.min(64, game.config.aiCount));
    const withCapital = w.countries.filter((c) => c.index > 0 && (c.capital.lat !== 0 || c.capital.lon !== 0) && c.tiles > 0);
    type Pick = { name: string; country: number; lat: number; lon: number };
    const picks: Pick[] = [];
    if (withCapital.length >= count) {
      // Weighted choice among real countries: big powers almost always play.
      const pool = withCapital.slice().sort((a, b) => b.weight - a.weight || a.index - b.index);
      const chosen = new Set<number>();
      while (picks.length < count && chosen.size < pool.length) {
        const c = rng.pickWeighted(pool.filter((x) => !chosen.has(x.index)), (x) => 0.05 + x.weight * x.weight * 4 + Math.min(1, x.tiles / 4000));
        chosen.add(c.index);
        picks.push({ name: c.nameEn, country: c.index, lat: c.capital.lat, lon: c.capital.lon });
      }
    } else {
      const list = BUILTIN_NATIONS.slice().sort((a, b) => b[3] - a[3]);
      for (const [name, lat, lon] of list.slice(0, count)) {
        const country = w.countries.findIndex((c) => c.nameEn === name);
        picks.push({ name, country: Math.max(0, country), lat, lon });
      }
    }
    picks.forEach((pk, i) => {
      const personality = PERSONALITIES[(i * 3 + rng.int(5)) % PERSONALITIES.length];
      const id = game.addPlayer({ name: pk.name, kind: 'nation', personality, color: nationColor(i), countryIndex: pk.country });
      const tile = freeLandNear(latLonToTile(pk.lat, pk.lon), 40);
      if (id > 0 && tile >= 0) game.issue(id, { type: 'spawn', tile });
    });
  }

  function setupTribes(): void {
    const n = Math.max(0, Math.min(120, game.config.tribeCount));
    for (let i = 0; i < n; i++) {
      let tile = -1;
      for (let k = 0; k < 400 && tile < 0; k++) {
        const t = rng.int(TILE_COUNT);
        const lat = 90 - (((t / MAP_W) | 0) + 0.5) * (180 / MAP_H);
        if (lat > 70 || lat < -50 || !game.isPlayable(t) || game.ownerOf(t) !== 0) continue;
        // Keep tribes away from everyone's spawn discs.
        let clear = true;
        for (const p of game.players()) {
          if (p.capitalTile >= 0 && game.distance(p.capitalTile, t) < 12) {
            clear = false;
            break;
          }
        }
        if (clear) tile = t;
      }
      if (tile < 0) continue;
      const name = `${rng.pick(TRIBE_SYL)}${rng.pick(TRIBE_SYL).toLowerCase()} ${rng.pick(TRIBE_SUFFIX)}`;
      const color = hslToHex(20 + rng.int(40), 0.18 + rng.next() * 0.12, 0.38 + rng.next() * 0.14);
      const id = game.addPlayer({ name, kind: 'tribe', personality: null, color, countryIndex: 0 });
      if (id > 0) game.issue(id, { type: 'spawn', tile });
    }
  }

  function randomOwnTile(p: SimPlayer, near: number, radius: number): number {
    const cx = near % MAP_W, cy = (near / MAP_W) | 0;
    for (let k = 0; k < 30; k++) {
      const y = cy + rng.intRange(-radius, radius);
      if (y < 0 || y >= MAP_H) continue;
      const t = y * MAP_W + ((cx + rng.intRange(-radius, radius)) % MAP_W + MAP_W) % MAP_W;
      if (game.ownerOf(t) === p.id) return t;
    }
    return -1;
  }

  function tryBuild(p: SimPlayer, type: StructureType, coastal: boolean): boolean {
    const cost = game.structureCost(p.id, type);
    if (p.gold < cost) return false;
    const center = p.capitalTile >= 0 ? p.capitalTile : -1;
    if (center < 0) return false;
    const radius = Math.max(3, Math.min(60, Math.round(Math.sqrt(p.tiles) * 0.6)));
    for (let k = 0; k < 24; k++) {
      let t: number;
      if (coastal) {
        const border = [...game.borderTiles(p.id)];
        t = -1;
        for (let j = 0; j < 12 && t < 0; j++) {
          const c = randomOwnTile(p, center, radius * 2);
          if (c >= 0 && game.isShore(c)) t = c;
        }
        if (t < 0 && border.length) t = border[rng.int(border.length)];
      } else t = randomOwnTile(p, center, radius);
      if (t >= 0 && game.canBuild(p.id, type, t)) return game.issue(p.id, { type: 'build', structure: type, tile: t });
    }
    return false;
  }

  function economy(p: SimPlayer, b: Brain): void {
    const own = (type: StructureType) => game.structures(p.id, type).length;
    const cities = own(StructureType.City);
    const wantCities = 1 + Math.floor(p.tiles / 900);
    if (cities < wantCities && tryBuild(p, StructureType.City, false)) return;
    if (own(StructureType.Port) < 1 + Math.floor(p.tiles / 4000) && tryBuild(p, StructureType.Port, true)) return;
    if (p.tiles > 1500 && own(StructureType.Factory) < 1 + Math.floor(p.tiles / 5000) && tryBuild(p, StructureType.Factory, false)) return;
    if (b.personality === 'turtle' && own(StructureType.DefensePost) < 2 + Math.floor(p.tiles / 2000) && tryBuild(p, StructureType.DefensePost, false)) return;
    if (p.tiles > 3000 && own(StructureType.ArmyBase) < 1 && tryBuild(p, StructureType.ArmyBase, false)) return;
    if (p.tiles > 4000 && own(StructureType.SamSite) < 1 && tryBuild(p, StructureType.SamSite, false)) return;
    if (game.config.nukes && p.tiles > 5000 && own(StructureType.MissileSilo) < 1 && (b.personality === 'nuker' || b.personality === 'conqueror')) {
      if (tryBuild(p, StructureType.MissileSilo, false)) return;
    }
    if (p.tiles > 6000 && own(StructureType.Airbase) < 1 && tryBuild(p, StructureType.Airbase, false)) return;
    // Units.
    if (own(StructureType.ArmyBase) > 0 && game.units(p.id, UnitType.ArmoredDivision).length < 2 && p.gold > game.unitCost(p.id, UnitType.ArmoredDivision) * 2) {
      game.issue(p.id, { type: 'buildUnit', unit: UnitType.ArmoredDivision, structureId: -1 });
    }
    if (cities > 0 && p.gold > game.structureCost(p.id, StructureType.City) * 1.5) {
      const c = game.structures(p.id, StructureType.City).find((s) => s.built >= 1 && s.level < 4);
      if (c) game.issue(p.id, { type: 'upgrade', structureId: c.id });
    }
  }

  function war(p: SimPlayer, b: Brain): void {
    const neighbors = game.neighborsOf(p.id);
    const reserve = p.troops / Math.max(1, p.maxTroops);
    if (neighbors.includes(0) && reserve > 0.22) {
      const border = game.borderTiles(p.id);
      let click = p.capitalTile;
      let k = rng.int(Math.max(1, border.size));
      for (const t of border) if (k-- <= 0) { click = t; break; }
      game.issue(p.id, { type: 'attack', target: 0, ratio: 0.3 + 0.15 * rng.next(), tile: click });
      return;
    }
    if (reserve < 0.45 / b.aggression) return;
    let best: SimPlayer | null = null, bestScore = 0;
    for (const n of neighbors) {
      if (n === 0 || game.isAllied(p.id, n)) continue;
      const q = game.player(n);
      if (!q || !q.alive) continue;
      const density = q.troops / Math.max(1, q.tiles);
      const myDensity = p.troops / Math.max(1, p.tiles);
      let score = (myDensity / Math.max(1, density)) * b.aggression;
      if (q.kind === 'tribe') score *= 1.6;
      if (q.id === HUMAN_ID) score *= game.difficulty === 'easy' ? 0.6 : game.difficulty === 'insane' ? 1.4 : 1;
      if (q.traitorUntilTick > game.tick) score *= 1.5;
      if (score > bestScore) {
        bestScore = score;
        best = q;
      }
    }
    if (best && bestScore > 0.9 && p.troops > best.troops * 0.35) {
      b.enemy = best.id;
      game.issue(p.id, { type: 'attack', target: best.id, ratio: 0.28 + 0.12 * b.aggression, tile: best.capitalTile });
      // Armor joins the offensive.
      for (const u of game.units(p.id, UnitType.ArmoredDivision)) {
        if (u.state === 0) game.issue(p.id, { type: 'deployArmor', unitId: u.id, targetTile: best.capitalTile });
      }
    }
  }

  function naval(p: SimPlayer): void {
    if (p.troops < p.maxTroops * 0.5 || p.tiles < 30) return;
    // Look for reachable foreign coast (neutral preferred) within ~250 tiles of the capital.
    const cx = p.capitalTile % MAP_W, cy = (p.capitalTile / MAP_W) | 0;
    let best = -1, bestScore = -Infinity;
    for (let k = 0; k < 60; k++) {
      const a = rng.next() * Math.PI * 2, r = 20 + rng.next() * 230;
      const y = Math.round(cy + Math.sin(a) * r * 0.6);
      if (y < 0 || y >= MAP_H) continue;
      const t = y * MAP_W + ((Math.round(cx + Math.cos(a) * r) % MAP_W) + MAP_W) % MAP_W;
      if (!game.isPlayable(t) || !game.isShore(t)) continue;
      const o = game.ownerOf(t);
      if (o === p.id || (o !== 0 && game.isAllied(p.id, o))) continue;
      const q = o === 0 ? null : game.player(o);
      const score = (o === 0 ? 2 : 1) - r / 300 - (q ? q.troops / Math.max(1, p.troops) : 0);
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    if (best >= 0) game.issue(p.id, { type: 'boatAttack', targetTile: best, ratio: 0.25 });
  }

  function nukes(p: SimPlayer, b: Brain): void {
    if (!game.config.nukes) return;
    const eager = b.personality === 'nuker' || b.personality === 'conqueror';
    const silos = game.structures(p.id, StructureType.MissileSilo).filter((s) => s.built >= 1 && s.cooldownTicks <= 0);
    if (silos.length === 0) return;
    // Everyone goes nuclear once rich enough; nukers and conquerors much earlier.
    const threshold = eager ? 1.2 : 4;
    if (p.gold < game.unitCost(p.id, UnitType.AtomBomb) * threshold) return;
    let target: SimPlayer | null = b.enemy ? game.player(b.enemy) ?? null : null;
    if (!target || !target.alive || game.isAllied(p.id, target.id)) {
      target = null;
      for (const n of game.neighborsOf(p.id)) {
        if (n === 0 || game.isAllied(p.id, n)) continue;
        const q = game.player(n);
        if (q && q.alive && q.kind !== 'tribe' && (!target || q.troops > target.troops)) target = q;
      }
    }
    if (!target || target.tiles < 400) return;
    // Aim at the biggest city (or a silo that threatens us), else the capital.
    const structs = game.structures(target.id).filter((s) => s.type === StructureType.City || s.type === StructureType.MissileSilo);
    structs.sort((a, c) => c.level - a.level || a.id - c.id);
    const tile = structs.length ? structs[Math.min(structs.length - 1, rng.int(3))].tile : target.capitalTile;
    if (tile < 0) return;
    let weapon: WeaponType = UnitType.AtomBomb;
    if (p.gold > game.unitCost(p.id, UnitType.Mirv) * 1.2 && target.tiles > 8000) weapon = UnitType.Mirv;
    else if (p.gold > game.unitCost(p.id, UnitType.HydrogenBomb) * 1.4) weapon = UnitType.HydrogenBomb;
    // Keep the blast away from our own land.
    if (weapon !== UnitType.Mirv && game.distance(tile, p.capitalTile) < (weapon === UnitType.HydrogenBomb ? 70 : 30)) weapon = UnitType.AtomBomb;
    if (game.distance(tile, p.capitalTile) < 26) return;
    game.issue(p.id, { type: 'launch', weapon, targetTile: tile, siloId: -1 });
  }

  /** Navy, air force, missiles and defenses once a nation is big enough to afford them. */
  function military(p: SimPlayer, b: Brain): void {
    const own = (type: StructureType) => game.structures(p.id, type).length;
    const units = (type: UnitType) => game.units(p.id, type);
    const coastal = game.structures(p.id, StructureType.Port).length > 0;
    // Build the military infrastructure.
    if (coastal && p.tiles > 2500 && own(StructureType.NavalYard) < 1 && tryBuild(p, StructureType.NavalYard, true)) return;
    if (p.tiles > 3500 && own(StructureType.Airbase) < 1 + Math.floor(p.tiles / 20000) && tryBuild(p, StructureType.Airbase, false)) return;
    if (p.tiles > 5000 && own(StructureType.Radar) < 1 && tryBuild(p, StructureType.Radar, false)) return;
    if (p.tiles > 7000 && own(StructureType.SamSite) < 1 + Math.floor(p.tiles / 15000) && tryBuild(p, StructureType.SamSite, false)) return;
    if (game.config.nukes && p.tiles > 6000 && own(StructureType.MissileSilo) < 1 + (b.personality === 'nuker' ? 1 : 0) && tryBuild(p, StructureType.MissileSilo, false)) return;
    const rich = (type: UnitType, k: number) => p.gold > game.unitCost(p.id, type) * k;
    // Produce units.
    if (own(StructureType.NavalYard) > 0 && units(UnitType.Warship).length < Math.min(4, 1 + Math.floor(p.tiles / 8000)) && rich(UnitType.Warship, 1.5)) {
      game.issue(p.id, { type: 'buildUnit', unit: UnitType.Warship, structureId: -1 });
    }
    if (own(StructureType.Airbase) > 0) {
      if (units(UnitType.FighterSquadron).length < 2 && rich(UnitType.FighterSquadron, 1.5)) game.issue(p.id, { type: 'buildUnit', unit: UnitType.FighterSquadron, structureId: -1 });
      else if (units(UnitType.Bomber).length < 2 && rich(UnitType.Bomber, 1.8)) game.issue(p.id, { type: 'buildUnit', unit: UnitType.Bomber, structureId: -1 });
      else if (units(UnitType.DroneSwarm).length < 1 && rich(UnitType.DroneSwarm, 2)) game.issue(p.id, { type: 'buildUnit', unit: UnitType.DroneSwarm, structureId: -1 });
    }
    // Use them against the current enemy.
    const enemy = b.enemy ? game.player(b.enemy) : undefined;
    if (!enemy || !enemy.alive || game.isAllied(p.id, enemy.id)) return;
    const targets = game.structures(enemy.id).filter((s) => s.built >= 1);
    for (const u of [...units(UnitType.Bomber), ...units(UnitType.DroneSwarm)]) {
      if (u.state !== UnitState.Docked && u.state !== UnitState.Idle) continue;
      const range = AIRCRAFT_STRIKE_RANGE[u.type] ?? 150;
      let best = -1, bestD = range;
      for (const s of targets) {
        const d = game.distance(Math.floor(u.y) * MAP_W + Math.floor(u.x), s.tile);
        const prio = s.type === StructureType.SamSite ? 0.5 : s.type === StructureType.MissileSilo || s.type === StructureType.Airbase ? 0.7 : 1;
        if (d * prio < bestD) {
          bestD = d * prio;
          best = s.tile;
        }
      }
      if (best < 0) {
        // No structure in range: bomb the troops at the front.
        for (const t of game.borderTiles(enemy.id)) {
          if (game.distance(Math.floor(u.y) * MAP_W + Math.floor(u.x), t) < range * 0.8) {
            best = t;
            break;
          }
        }
      }
      if (best >= 0) game.issue(p.id, { type: 'airStrike', unitId: u.id, targetTile: best });
    }
    for (const u of units(UnitType.Warship)) {
      if (u.state !== UnitState.Moving && u.state !== UnitState.Idle) continue;
      if (rng.next() < 0.5) continue;
      // Patrol off the enemy's coast (the warship shells it and hunts its shipping).
      for (const t of game.borderTiles(enemy.id)) {
        if (game.isShore(t) && game.distance(t, Math.floor(u.y) * MAP_W + Math.floor(u.x)) < 250) {
          game.issue(p.id, { type: 'moveUnit', unitId: u.id, tile: t });
          break;
        }
      }
    }
    // Cruise missiles on the enemy's air defenses and silos.
    {
      const silo = game.structures(p.id, StructureType.MissileSilo).find((s) => s.built >= 1 && s.cooldownTicks <= 0);
      if (silo && rich(UnitType.CruiseMissile, 3)) {
        const hv = targets.find((s) => (s.type === StructureType.SamSite || s.type === StructureType.MissileSilo || s.type === StructureType.Airbase) && game.distance(s.tile, silo.tile) < CRUISE_RANGE);
        if (hv) game.issue(p.id, { type: 'launch', weapon: UnitType.CruiseMissile, targetTile: hv.tile, siloId: silo.id });
      }
    }
  }

  function diplomacy(p: SimPlayer, b: Brain): void {
    // Seek an ally among strong nations that are not our current enemy (trade & safety).
    if (p.allies.size < 2 && rng.next() < (b.personality === 'trader' ? 0.8 : b.personality === 'turtle' ? 0.6 : 0.3)) {
      const cands = game.players().filter((q) => q.alive && q.kind === 'nation' && q.id !== p.id && q.id !== b.enemy && !game.isAllied(p.id, q.id));
      if (cands.length) {
        const q = cands[rng.int(cands.length)];
        game.issue(p.id, { type: 'allianceRequest', target: q.id });
      }
    }
    // Opportunists stab allies in the back when the ally is weak and next door.
    if (b.personality === 'opportunist') {
      for (const a of p.allies) {
        const q = game.player(a);
        if (q && game.sharesBorder(p.id, a) && q.troops < p.troops * 0.35 && rng.next() < 0.4) {
          game.issue(p.id, { type: 'breakAlliance', target: a });
          b.enemy = a;
          game.issue(p.id, { type: 'emote', target: a, emote: 'clown' });
          break;
        }
      }
    }
    // Embargo the enemy; taunt it now and then.
    if (b.enemy && !game.hasEmbargo(p.id, b.enemy) && game.player(b.enemy)?.kind === 'nation') {
      game.issue(p.id, { type: 'embargo', target: b.enemy, active: true });
    }
    if (b.enemy && rng.next() < 0.15) game.issue(p.id, { type: 'emote', target: b.enemy, emote: EMOTES[rng.int(EMOTES.length)] });
  }

  function think(p: SimPlayer): void {
    const b = brainFor(p);
    if (game.tick < b.nextThink) return;
    b.nextThink = game.tick + (p.kind === 'tribe' ? 30 : 15) + rng.int(10);
    war(p, b);
    if (p.kind === 'tribe') return;
    if (game.tick >= b.nextBuild) {
      b.nextBuild = game.tick + 40 + rng.int(40);
      economy(p, b);
    }
    if (game.tick >= b.nextNaval) {
      b.nextNaval = game.tick + 450 + rng.int(450);
      naval(p);
    }
    if (game.tick >= b.nextMilitary) {
      b.nextMilitary = game.tick + 120 + rng.int(120);
      military(p, b);
    }
    if (game.tick >= b.nextNuke) {
      b.nextNuke = game.tick + 900 + rng.int(1200);
      nukes(p, b);
    }
    if (game.tick >= b.nextDiplomacy) {
      b.nextDiplomacy = game.tick + 900 + rng.int(900);
      if (p.id !== HUMAN_ID) diplomacy(p, b);
    }
  }

  return {
    setup() {
      if (adopt && game.players().some((p) => p.kind === 'nation' || p.kind === 'tribe')) {
        for (const p of game.players()) {
          if ((p.kind === 'nation' || p.kind === 'tribe') && !p.spawned && game.phase === 'spawn') {
            const t = freeLandNear(rng.int(TILE_COUNT), 60);
            if (t >= 0) game.issue(p.id, { type: 'spawn', tile: t });
          }
        }
        return;
      }
      setupNations();
      setupTribes();
    },
    tick() {
      if (game.phase !== 'playing') return;
      for (const p of game.players()) {
        if (!p.alive || !p.spawned) continue;
        if (p.kind === 'human' && !game.config.humanAutopilot) continue;
        if (p.kind === 'rebel') continue;
        think(p);
      }
    },
    onEvent(e: SimEvent) {
      if (e.type === 'allianceRequested') {
        const to = game.player(e.to);
        const from = game.player(e.from);
        if (!to || !from || to.kind !== 'nation') return;
        const trusted = from.traitorUntilTick <= game.tick;
        const accept = trusted && rng.next() < (from.troops > to.troops * 1.5 ? 0.7 : 0.35);
        game.issue(e.to, { type: 'allianceReply', from: e.from, accept });
      }
    },
  };
}
