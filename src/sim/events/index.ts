// FRONT ULTRA — world events (owner: sim-ai). Runs inside the sim worker, deterministic (game.rng only).
// STUB by the architect: an occasional "gold rush" so the event plumbing is exercised end to end.
// sim-ai replaces this with earthquakes, hurricanes, rebellions, gold rushes, pandemics and the doomsday clock.
// Keep the export: createWorldEventDirector(game).

import { BALANCE } from '../../shared/constants';
import type { SimEvent } from '../../shared/protocol';
import type { SimGame, WorldEventDirector } from '../../shared/simapi';
import { tileX, tileY } from '../../shared/geo';

export function createWorldEventDirector(game: SimGame): WorldEventDirector {
  const rng = game.rng.fork('world-events');
  let nextAt = BALANCE.worldEventMinIntervalTicks;
  return {
    tick() {
      if (game.tick < nextAt) return;
      nextAt = game.tick + BALANCE.worldEventMinIntervalTicks + rng.int(600);
      const alive = game.players().filter((p) => p.alive && p.spawned && p.tiles > 0);
      if (alive.length === 0) return;
      const p = rng.pick(alive);
      const id = game.nextEventId();
      const gold = 50_000 + rng.int(100_000);
      game.addGold(p.id, gold);
      const x = tileX(p.capitalTile) + 0.5, y = tileY(p.capitalTile) + 0.5;
      game.emit({ type: 'worldEvent', tick: game.tick, id, kind: 'goldRush', stage: 'start', x, y, radius: 10, magnitude: gold, players: [p.id] });
      game.emit({ type: 'goldBonus', tick: game.tick, playerId: p.id, gold, tile: p.capitalTile, reason: 'event' });
    },
    onEvent(_e: SimEvent) {},
  };
}
