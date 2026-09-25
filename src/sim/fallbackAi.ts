// FRONT ULTRA — fallback AI director (owner: sim-core). v2 (DESIGN_V2 §1.3, CM§24): reduced to a no-op that logs.
//
// v1 shipped a second, complete AI here that ignored every v2 rule (wars without declarations, unprovoked nukes). If
// sim-ai's director fails to load or keeps throwing, the game now goes on without AI decisions and the fault is
// reported once through the game's error channel, instead of silently switching to a different rule set.

import type { AiDirector, SimGame } from '../shared/simapi';

/** @param switched true when replacing a director that failed mid-game (the report says so). */
export function createFallbackAi(game: SimGame, switched: boolean): AiDirector {
  let logged = false;
  const log = () => {
    if (logged) return;
    logged = true;
    const onError = (game as unknown as { onError?: ((m: string) => void) | null }).onError;
    const msg = switched ? 'AI director disabled after repeated errors: AI nations stand still' : 'AI director unavailable: AI nations stand still';
    if (onError) onError(msg);
    else console.warn(`[sim] ${msg}`);
  };
  return {
    setup() {
      log();
    },
    tick() {
      log();
    },
    onEvent() {},
  };
}
