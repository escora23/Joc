// FRONT ULTRA — who is at war with whom, as the renderers see it (owner: globe, shared by every renderer).
// One per game context, refreshed at most 4 times a second from ctx.sim.view. The territory shader (war-border
// cores, relation flags in the palette), the icon layer (NATO frames by relation) and the nation labels (crossed
// swords, handshake) all read it, so they always agree.
//
// "At war" is the sim's pair state (W1's WarSystem, view.wars: declared wars, call-to-arms wars included). W1 landed
// it in stage 1, so the v1-hostility stub the design planned for W4 to replace is not needed. Independent
// territories are outside pair states (they can be attacked without a declaration): a player with an active
// offensive against one, or the other way round, counts as hostile to it.

import type { GameContext } from '../shared/api';
import { HUMAN_ID } from '../shared/constants';

/** Relation of a player to the viewer (the human). */
export type Relation = 'own' | 'ally' | 'war' | 'other';

export interface Relations {
  /** Refresh if stale (cheap to call every frame). Returns true when the pair set changed. */
  refresh(now: number): boolean;
  /** Relation of `id` to the human. */
  relationTo(id: number): Relation;
  /** Are `a` and `b` at war with each other? */
  atWar(a: number, b: number): boolean;
  /** Every pair at war, as [a, b] with a < b (for textures). */
  readonly pairs: ReadonlyArray<readonly [number, number]>;
  /** Bumped whenever the set of pairs changes. */
  readonly rev: number;
}

const registry = new WeakMap<object, Relations>();

export function relationsFor(ctx: GameContext): Relations {
  let r = registry.get(ctx);
  if (!r) {
    r = createRelations(ctx);
    registry.set(ctx, r);
  }
  return r;
}

function createRelations(ctx: GameContext): Relations {
  const keys = new Set<number>();
  const next = new Set<number>();
  const pairs: [number, number][] = [];
  let rev = 0;
  let last = -1e9;
  const key = (a: number, b: number) => (a < b ? a * 65536 + b : b * 65536 + a);

  function rebuildPairs(): boolean {
    const view = ctx.sim.view;
    next.clear();
    const add = (a: number, b: number) => {
      if (a > 0 && b > 0 && a !== b) next.add(key(a, b));
    };
    for (const w of view.wars ?? []) add(w.aggressor, w.target);
    for (const a of view.attacks) {
      const pa = view.players[a.attacker], pd = view.players[a.defender];
      if (pa?.kind === 'tribe' || pd?.kind === 'tribe') add(a.attacker, a.defender);
    }
    // Allies are never at war with each other.
    for (const k of next) {
      const a = Math.floor(k / 65536), b = k % 65536;
      if (view.players[a]?.allies.includes(b)) next.delete(k);
    }
    let changed = next.size !== keys.size;
    if (!changed) for (const k of next) if (!keys.has(k)) { changed = true; break; }
    if (!changed) return false;
    keys.clear();
    pairs.length = 0;
    for (const k of next) {
      keys.add(k);
      pairs.push([Math.floor(k / 65536), k % 65536]);
    }
    rev++;
    return true;
  }

  return {
    get pairs() {
      return pairs;
    },
    get rev() {
      return rev;
    },
    refresh(now) {
      const view = ctx.sim.view;
      if (view.phase === 'none') {
        if (keys.size) {
          keys.clear();
          pairs.length = 0;
          rev++;
          return true;
        }
        return false;
      }
      // 4 Hz is plenty: attacks, fronts and embargoes only change with sim updates.
      if (now - last < 0.25) return false;
      last = now;
      return rebuildPairs();
    },
    relationTo(id) {
      if (id === HUMAN_ID) return 'own';
      const h = ctx.sim.view.human;
      if (h && h.allies.includes(id)) return 'ally';
      if (keys.has(key(HUMAN_ID, id))) return 'war';
      return 'other';
    },
    atWar(a, b) {
      return keys.has(key(a, b));
    },
  };
}
