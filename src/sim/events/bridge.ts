// FRONT ULTRA — state shared between the world-event director and the AI director of the same game (owner:
// sim-ai). Worker-only. Both directors live in sim-ai, so they may share facts that are not worth a SimEvent
// (e.g. which nations are currently sick, so AI neighbours can quarantine them).

import type { SimGame } from '../../shared/simapi';

export interface SharedEventState {
  /** Player id -> tick until which they are infected by a pandemic. */
  infected: Map<number, number>;
}

const states = new WeakMap<SimGame, SharedEventState>();

export function sharedEventState(game: SimGame): SharedEventState {
  let s = states.get(game);
  if (!s) {
    s = { infected: new Map() };
    states.set(game, s);
  }
  return s;
}
