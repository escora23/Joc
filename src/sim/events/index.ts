// FRONT ULTRA — world events director (owner: sim-ai). Runs inside the sim worker, deterministic (game.rng only).
//
// "There is always something happening": every few minutes the director picks an event that fits the moment and
// the real geography, and runs it through its lifecycle (warning -> start -> end SimEvents with a location, so
// the news ticker can report it and the camera can fly there; a renderable WorldEventView via
// game.setWorldEventState while it lasts):
//   * earthquake   — Ring of Fire / Alpide belt; collapses structures, kills troops, aftershocks (earthquake.ts)
//   * hurricane    — forms in a real cyclone basin, tracks and recurves, sinks ships, wrecks coasts (hurricane.ts)
//   * rebellion    — an overextended empire loses a province to a new rebel nation (rebellion.ts)
//   * gold rush    — a historic gold field pays whoever holds it; armies converge (goldrush.ts)
//   * pandemic     — spreads along borders and trade links; embargoes quarantine (pandemic.ts)
//   * doomsday     — the late-game clock that escalates nuclear tension (doomsday.ts)
// `force(kind, tile)` starts an event immediately at a tile (SimDebugAction 'worldEvent', used by shots).

import { HUMAN_ID } from '../../shared/constants';
import type { SimEvent } from '../../shared/protocol';
import type { SimGame, WorldEventDirector } from '../../shared/simapi';
import { tileToLatLon } from '../../shared/geo';
import { StructureType, UnitType, type WorldEventKind } from '../../shared/types';
import { cx, cy, nearestLand, placeTile, type ActiveEvent, type EventEnv } from './common';
import { DoomsdayClock } from './doomsday';
import { Earthquake } from './earthquake';
import { GoldRush } from './goldrush';
import { Hurricane } from './hurricane';
import { Pandemic } from './pandemic';
import { CYCLONE_BASINS, GOLD_FIELDS, SEISMIC } from './places';
import { Rebellion, rebellionSeed, unrest } from './rebellion';

/** Classes of the running world events (the save registry needs them). */
export const EVENT_CLASSES = [Earthquake, Hurricane, GoldRush, Pandemic, Rebellion, DoomsdayClock] as const;

/** v2 (T26): the first event after >= 6,000 ticks (25 days), then >= 4,800 ticks (20 days) apart. */
const FIRST_EVENT = 6000;
const GAP_MIN = 4800;
const GAP_RAND = 1200;
const MAX_CONCURRENT = 2;

const HUMAN_REBELLION_WEIGHT = { easy: 0.3, normal: 0.65, hard: 0.9, insane: 1 } as const;

export interface ForcibleWorldEventDirector extends WorldEventDirector {
  force(kind: WorldEventKind, tile: number): void;
}

export function createWorldEventDirector(game: SimGame): ForcibleWorldEventDirector {
  // `let`: a save restores these objects wholesale (restoreState), keeping every internal reference consistent.
  let rng = game.rng.fork('world-events');
  let env: EventEnv = { g: game, rng, pastTiles: new Map(), nuked: new Map(), lastRebellion: new Map() };
  let active: ActiveEvent[] = [];
  let clock = new DoomsdayClock();
  let snapshots: Map<number, number>[] = [];
  let nextAt = FIRST_EVENT + rng.int(600);
  /** Tick of the last event that broke out (its `start`), for the T26 spacing. */
  let lastStart = -1_000_000;
  /** Shuffled bag of kinds so every kind shows up over a game (drawn in order, skipping kinds that do not fit). */
  let bag: WorldEventKind[] = [];

  function snapshot(): void {
    const m = new Map<number, number>();
    for (const p of game.players()) if (p.alive) m.set(p.id, p.tiles);
    snapshots.push(m);
    if (snapshots.length > 4) snapshots.shift();
    env.pastTiles = snapshots[0];
  }

  // --- event factories ------------------------------------------------------------------------------
  function earthquake(tile: number | null, warn: boolean): ActiveEvent | null {
    let t = tile ?? -1;
    if (t < 0) {
      // Weighted by the fault's activity and by what stands there (quakes that hit nobody are not news).
      let best = -1, bs = 0;
      for (let k = 0; k < 10; k++) {
        const [lat, lon, w] = rng.pickWeighted(SEISMIC, (s) => s[2]);
        const c = placeTile(lat, lon, rng, 1.5);
        const land = nearestLand(game, cx(c), cy(c), 12);
        if (land < 0) continue;
        const owned = game.ownerOf(land) > 0 ? 1 : 0;
        const structs = game.structuresNear(cx(land), cy(land), 18).length;
        const s = w * (0.4 + owned + Math.min(3, structs * 0.4)) * (0.6 + rng.next() * 0.8);
        if (s > bs) {
          bs = s;
          best = land;
        }
      }
      t = best;
    }
    if (t < 0) return null;
    const magnitude = Math.round((6.6 + Math.pow(rng.next(), 1.6) * 2.3) * 10) / 10;
    return new Earthquake(game.nextEventId(), t, magnitude, warn);
  }

  function hurricane(tile: number | null): ActiveEvent | null {
    let x = -1, y = -1, heading = -1.3;
    if (tile !== null && tile >= 0) {
      x = cx(tile);
      y = cy(tile);
      const lat = tileToLatLon(tile).lat;
      heading = lat >= 0 ? -1.3 : -2.0;
    } else {
      for (let k = 0; k < 12 && x < 0; k++) {
        const [lat, lon, h] = rng.pickWeighted(CYCLONE_BASINS, (b) => b[3]);
        const t = placeTile(lat, lon, rng, 3);
        if (!game.isWater(t)) continue;
        x = cx(t);
        y = cy(t);
        heading = h + (rng.next() - 0.5) * 0.3;
      }
    }
    if (x < 0) return null;
    return new Hurricane(game.nextEventId(), x, y, heading, env);
  }

  function goldRush(tile: number | null, warn: boolean): ActiveEvent | null {
    let t = tile ?? -1;
    if (t < 0) {
      let best = -1, bs = 0;
      for (let k = 0; k < 8; k++) {
        const [lat, lon, w] = rng.pickWeighted(GOLD_FIELDS, (f) => f[2]);
        const c = placeTile(lat, lon, rng, 1);
        const land = nearestLand(game, cx(c), cy(c), 10);
        if (land < 0) continue;
        const s = w * (game.ownerOf(land) > 0 ? 1.5 : 0.6) * (0.5 + rng.next());
        if (s > bs) {
          bs = s;
          best = land;
        }
      }
      t = best;
    }
    if (t < 0) return null;
    return new GoldRush(game.nextEventId(), t, env, warn);
  }

  function pandemic(tile: number | null, warn: boolean): ActiveEvent | null {
    let origin = tile !== null && tile >= 0 ? game.ownerOf(tile) : 0;
    if (origin <= 0) {
      // Populous, connected nations are where outbreaks start.
      const cands = game.players().filter((p) => p.alive && p.spawned && (p.kind === 'nation' || p.kind === 'human') && p.tiles > 500 && p.capitalTile >= 0);
      if (cands.length === 0) return null;
      const pick = rng.pickWeighted(cands, (p) => Math.sqrt(p.tiles) + game.structures(p.id, StructureType.City).length * 8 + p.allies.size * 10);
      origin = pick.id;
    }
    const p = game.player(origin);
    if (!p || !p.alive) return null;
    const at = tile !== null && tile >= 0 ? tile : p.capitalTile;
    if (at < 0) return null;
    return new Pandemic(game.nextEventId(), origin, at, warn);
  }

  function rebellion(tile: number | null, warn: boolean): ActiveEvent | null {
    if (tile !== null && tile >= 0) {
      const o = game.ownerOf(tile);
      const p = game.player(o);
      if (!p || !p.alive || p.tiles < 300 || p.kind === 'tribe') return null;
      return new Rebellion(game.nextEventId(), o, tile, warn);
    }
    const cands = game.players()
      .map((p) => ({ p, u: unrest(env, p) * (p.id === HUMAN_ID ? HUMAN_REBELLION_WEIGHT[game.difficulty] : 1) }))
      .filter((c) => c.u > 0);
    if (cands.length === 0) return null;
    const pick = rng.pickWeighted(cands, (c) => c.u * c.u * c.u);
    const seed = rebellionSeed(env, pick.p);
    if (seed < 0) return null;
    return new Rebellion(game.nextEventId(), pick.p.id, seed, warn);
  }

  function make(kind: WorldEventKind, tile: number | null, warn: boolean): ActiveEvent | null {
    switch (kind) {
      case 'earthquake': return earthquake(tile, warn);
      case 'hurricane': return hurricane(tile);
      case 'goldRush': return goldRush(tile, warn);
      case 'pandemic': return pandemic(tile, warn);
      case 'rebellion': return rebellion(tile, warn);
      case 'doomsday': return null;
    }
  }

  /** Does this kind fit the moment? */
  function fits(kind: WorldEventKind): boolean {
    const t = game.tick;
    for (const a of active) if (a.kind === kind) return false;
    switch (kind) {
      case 'pandemic': return t > 3000;
      case 'rebellion': {
        // v2 (§5.12): only where there is a cause.
        for (const p of game.players()) if (unrest(env, p) > 0) return true;
        return false;
      }
      default: return true;
    }
  }

  /** Land share of the biggest nation. */
  function leaderShare(): number {
    let top = 0;
    for (const p of game.players()) if (p.alive && (p.kind === 'nation' || p.kind === 'human')) top = Math.max(top, p.tiles);
    return top / Math.max(1, game.world.landTiles);
  }

  /** Next kind from the bag (refilled and reshuffled when empty; hurricanes and quakes are the most common). */
  function pickKind(): WorldEventKind | null {
    // Where a rebellion has a cause (occupation, exhaustion, a nuclear strike) it comes first.
    if (fits('rebellion') && rng.next() < 0.5) return 'rebellion';
    if (bag.length === 0) bag = rng.shuffle(['earthquake', 'hurricane', 'goldRush', 'pandemic', 'rebellion', 'earthquake', 'hurricane', 'goldRush', 'rebellion'] as WorldEventKind[]);
    for (let i = 0; i < bag.length; i++) {
      if (fits(bag[i])) return bag.splice(i, 1)[0];
    }
    return null;
  }

  return {
    tick() {
      const t = game.tick;
      if (t % 600 === 0) snapshot();
      clock.step(env);
      for (let i = 0; i < active.length; i++) {
        if (!active[i].step(env)) active.splice(i--, 1);
      }
      // T26: spacing is measured between the moments events break out, so the next one waits for the last start.
      if (t >= nextAt && t >= lastStart + GAP_MIN) {
        nextAt = t + GAP_MIN + rng.int(GAP_RAND);
        if (active.length >= MAX_CONCURRENT) return;
        for (let k = 0; k < 3; k++) {
          const kind = pickKind();
          if (!kind) return;
          const ev = make(kind, null, true);
          if (ev) {
            active.push(ev);
            return;
          }
        }
      }
    },
    onEvent(e: SimEvent) {
      clock.onEvent(e);
      if (e.type === 'worldEvent' && e.stage === 'start' && e.kind !== 'doomsday') lastStart = Math.max(lastStart, e.tick);
      if (e.type === 'nukeDetonated' && e.targetOwner > 0 && e.weapon !== UnitType.CruiseMissile) env.nuked.set(e.targetOwner, { tick: e.tick, tile: e.tile });
    },
    // v2 (§12.8): the director's state for saves.
    snapshotState() {
      return { rng, env, active, clock, snapshots, nextAt, bag, lastStart };
    },
    restoreState(state: unknown) {
      const s = state as { rng: object; env: EventEnv; active: ActiveEvent[]; clock: DoomsdayClock; snapshots: Map<number, number>[]; nextAt: number; bag: WorldEventKind[]; lastStart?: number };
      rng = s.rng as typeof rng;
      env = s.env;
      env.g = game;
      active = s.active;
      clock = s.clock;
      snapshots = s.snapshots;
      nextAt = s.nextAt;
      bag = s.bag;
      lastStart = s.lastStart ?? -1_000_000;
    },
    force(kind: WorldEventKind, tile: number) {
      if (kind === 'doomsday') {
        clock.force(env, 0.85);
        return;
      }
      if (env.pastTiles.size === 0) snapshot();
      const ev = make(kind, tile, false);
      if (!ev) return;
      active.push(ev);
      // Run the first step now so the event is visible immediately (shots freeze the sim right after).
      if (!ev.step(env)) active.pop();
    },
  };
}
