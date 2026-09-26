// FRONT ULTRA — the order rules' view of the world on the main thread (W4, DESIGN_V2 §7.3). Owner: sim-core.
// An adapter over the client's GameView implementing shared/orders.ts RulesView, so the cursor chip and the Fuerzas
// panel call exactly the rules the simulation enforces. Cheap per-call lookups; the per-tick indexes (structures by
// tile, units by owner, hosted counts) are rebuilt lazily once per applied update.

import type { GameView } from '../shared/api';
import { MAP_W, TILE_COUNT } from '../shared/constants';
import { landComponents, type FrontLike, type RulesView, type StructureLike, type UnitLike } from '../shared/orders';
import { isPlayableTerrain } from '../shared/terrain';
import { UnitState, type PairState, type PlayerKind, type StructureView, type TreatyKind, type UnitView } from '../shared/types';

interface TreatyLike { a: number; b: number; kind: string }

export interface ClientRules extends RulesView {
  /** Force the indexes to rebuild (after a staged change within the same tick). */
  invalidate(): void;
}

const cache = new WeakMap<GameView, ClientRules>();

/** The RulesView of a GameView (one per view, reused). */
export function viewRules(view: GameView): ClientRules {
  let r = cache.get(view);
  if (!r) {
    r = createRules(view);
    cache.set(view, r);
  }
  return r;
}

function createRules(view: GameView): ClientRules {
  let builtTick = -1, builtUnits = -1, builtStructs = -1, builtProd = -1;
  const structAt = new Map<number, StructureView>();
  const byOwner = new Map<number, StructureView[]>();
  const unitsByOwner = new Map<number, UnitView[]>();
  const hosted = new Map<number, number>();
  const border = new Map<number, boolean>();
  let comps: Int32Array | null = null;
  let compsWorld: unknown = null;

  function index(): void {
    if (builtTick === view.tick && builtUnits === view.units.size && builtStructs === view.structures.size && builtProd === view.production.length) return;
    builtTick = view.tick;
    builtUnits = view.units.size;
    builtStructs = view.structures.size;
    builtProd = view.production.length;
    structAt.clear();
    byOwner.clear();
    unitsByOwner.clear();
    hosted.clear();
    border.clear();
    for (const s of view.structures.values()) {
      structAt.set(s.tile, s);
      let l = byOwner.get(s.owner);
      if (!l) byOwner.set(s.owner, (l = []));
      l.push(s);
    }
    for (const u of view.units.values()) {
      if (u.state === UnitState.Destroyed) continue;
      let l = unitsByOwner.get(u.owner);
      if (!l) unitsByOwner.set(u.owner, (l = []));
      l.push(u);
      if (u.home > 0) hosted.set(u.home, (hosted.get(u.home) ?? 0) + 1);
    }
    for (const q of view.production) hosted.set(q.structureId, (hosted.get(q.structureId) ?? 0) + 1);
  }

  const asStruct = (s: StructureView | undefined): StructureLike | null => s ?? null;
  const asUnit = (u: UnitView | undefined): UnitLike | null => (u && u.state !== UnitState.Destroyed ? u : null);

  const r: ClientRules = {
    get tick() {
      return view.tick;
    },
    invalidate() {
      builtTick = -1;
    },
    ownerOf: (t) => view.owner[t] ?? 0,
    terrainOf: (t) => view.world?.terrain[t] ?? 0,
    playable: (t) => !!view.world && t >= 0 && t < TILE_COUNT && isPlayableTerrain(view.world.terrain[t]),
    kindOf: (p): PlayerKind | null => view.players[p]?.kind ?? null,
    pairState: (a, b): PairState => view.pairState(a, b),
    hasTreaty(a, b, kind: TreatyKind) {
      if (a === b) return false;
      if (kind === 'alliance' && view.players[a]?.allies.includes(b)) return true;
      // W3 publishes every treaty in force (TickUpdate.treaties); until then alliances are the only treaty.
      const tr = (view as unknown as { treaties?: readonly TreatyLike[] }).treaties;
      if (tr) for (const x of tr) if (x.kind === kind && ((x.a === a && x.b === b) || (x.a === b && x.b === a))) return true;
      return false;
    },
    escalation(a, b) {
      const w = view.warBetween(a, b);
      if (!w) return 0;
      return w.aggressor === a ? w.escalationA : w.escalationB;
    },
    mobilizeUntil(a, b) {
      const w = view.warBetween(a, b);
      if (!w || w.aggressor !== a) return 0;
      return w.mobilizeUntilTick > view.tick ? w.mobilizeUntilTick : 0;
    },
    unit: (id) => asUnit(view.units.get(id)),
    structure: (id) => asStruct(view.structures.get(id)),
    structureAt(tile) {
      index();
      return asStruct(structAt.get(tile));
    },
    structuresOf(owner) {
      index();
      return byOwner.get(owner) ?? [];
    },
    unitsOf(owner) {
      index();
      return unitsByOwner.get(owner) ?? [];
    },
    hostedAt(id) {
      index();
      return hosted.get(id) ?? 0;
    },
    frontsOf(owner): Iterable<FrontLike> {
      return view.fronts.filter((f) => f.a === owner || f.b === owner);
    },
    homeTroops: (p) => view.players[p]?.troops ?? 0,
    sharesBorder(a, b) {
      index();
      const k = a * 65536 + b;
      const c = border.get(k);
      if (c !== undefined) return c;
      const own = view.owner;
      const W = MAP_W, N = TILE_COUNT;
      let v = false;
      for (let i = 0; i < N && !v; i++) {
        if (own[i] !== a) continue;
        const x = i % W;
        if (own[x === 0 ? i + W - 1 : i - 1] === b || own[x === W - 1 ? i - W + 1 : i + 1] === b
          || (i >= W && own[i - W] === b) || (i + W < N && own[i + W] === b)) v = true;
      }
      border.set(k, v);
      return v;
    },
    landComponent(tile) {
      const w = view.world;
      if (!w || tile < 0 || tile >= TILE_COUNT) return -1;
      if (!comps || compsWorld !== w) {
        comps = landComponents(w.terrain, (t) => isPlayableTerrain(w.terrain[t]));
        compsWorld = w;
      }
      return comps[tile];
    },
    railLinks: () => view.rail,
  };
  return r;
}
