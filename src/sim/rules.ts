// FRONT ULTRA — the order rules' view of the simulation (W4, DESIGN_V2 §7.3, §14.1). Owner: sim-core. Worker-only.
// Game implements shared/orders.ts RulesView through this adapter; the client implements the same interface over its
// GameView (sim/rulesView.ts), so the order preview and the sim's validation are one function.

import { TILE_COUNT, TILE_KM } from '../shared/constants';
import { landComponents, type FrontLike, type RulesView, type StructureLike, type UnitLike } from '../shared/orders';
import { UnitMode, type PairState, type PlayerKind, type TreatyKind } from '../shared/types';
import type { Game } from './game';
import type { Unit } from './state';

export interface SimRules extends RulesView {
  /** The published mode of a unit (the same value the client reads from UF.mode). */
  modeOf(u: Unit): UnitMode;
}

export function createSimRules(g: Game): SimRules {
  let comps: Int32Array | null = null;
  const like = (u: Unit): UnitLike => ({
    id: u.id, type: u.type, owner: u.owner, x: u.x, y: u.y, state: u.state, mode: g.unitSys.publicMode(u), home: u.home,
    etaTicks: u.eta,
  });
  return {
    get tick() {
      return g.tick;
    },
    modeOf: (u) => g.unitSys.publicMode(u),
    ownerOf: (t) => g.owner[t],
    terrainOf: (t) => g.terrain[t],
    playable: (t) => t >= 0 && t < TILE_COUNT && g.playable[t] === 1,
    kindOf: (p): PlayerKind | null => g.playerById[p]?.kind ?? null,
    pairState: (a, b): PairState => g.war.pairState(a, b),
    hasTreaty(a, b, kind: TreatyKind) {
      if (a === b) return false;
      if (kind === 'alliance' && g.isAllied(a, b)) return true;
      // W3's DiplomacySystem answers the other treaties once it lands (open borders, trade agreements, NAPs).
      const d = g.diplomacy as unknown as { hasTreaty?: (a: number, b: number, k: TreatyKind) => boolean };
      return typeof d.hasTreaty === 'function' ? d.hasTreaty(a, b, kind) : false;
    },
    escalation: (a, b) => g.war.escalation(a, b),
    mobilizeUntil: (a, b) => g.war.mobilizingUntil(a, b),
    unit(id) {
      const u = g.unitMap.get(id);
      return u && !u.dead ? like(u) : null;
    },
    structure: (id): StructureLike | null => g.structureMap.get(id) ?? null,
    structureAt(tile) {
      const id = tile >= 0 && tile < TILE_COUNT ? g.structAt[tile] : 0;
      return id ? g.structureMap.get(id) ?? null : null;
    },
    structuresOf: (owner) => g.structByOwner.get(owner) ?? [],
    *unitsOf(owner) {
      for (const u of g.unitsByOwner.get(owner) ?? []) if (!u.dead) yield like(u);
    },
    hostedAt: (id) => g.unitSys.hostedAt(id),
    *frontsOf(owner): Iterable<FrontLike> {
      for (const f of g.fronts.frontsOf(owner)) {
        yield {
          key: f.key, a: f.a, b: f.b, x: f.x, y: f.y, samples: Float32Array.from(f.samples),
          garrisonA: g.fronts.garrison(f, f.a), garrisonB: g.fronts.garrison(f, f.b),
        };
      }
    },
    homeTroops: (p) => g.playerById[p]?.troops ?? 0,
    sharesBorder: (a, b) => g.sharesBorder(a, b),
    landComponent(tile) {
      if (!comps) comps = landComponents(g.terrain, (t) => g.playable[t] === 1);
      return tile >= 0 && tile < TILE_COUNT ? comps[tile] : -1;
    },
    railLinks: () => g.economy.railPairs(),
  };
}

/** Km per tile along a meridian (ranges in tiles are converted with it). */
export const KM_PER_TILE = TILE_KM;
