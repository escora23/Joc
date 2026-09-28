// FRONT ULTRA — debug hook for the shared local forces (DESIGN_V2 §14.11). Never used by gameplay code.
//
//   __localForces(40.4, -3.7)                  what the sim really has within 30 km of Madrid, seen by the human
//   __localForces(48.8, 2.3, 50, 7)            within 50 km of Paris, seen by player 7
//   __localForces.at(x, y, radiusKm, viewer)   the same at continuous tile coords
//   __localForces.split(forces, 60)            visibleSplit(): soldiers per side for a budget of 60
//   __localForces.text(side)                   the side's «source» line in the current language

import type { GameContext } from '../shared/api';
import { HUMAN_ID } from '../shared/constants';
import { deriveLocalForces, deriveLocalForcesAt, visibleSplit, type LocalForces, type LocalForceSide } from '../shared/localForces';
import { localSideText } from '../shared/localForcesText';

export function installLocalForcesProbe(ctx: GameContext): void {
  const alpha = (): number => ctx.frame.simAlpha ?? 1;
  const hook = (lat: number, lon: number, radiusKm = 30, viewer = HUMAN_ID): LocalForces =>
    deriveLocalForcesAt(ctx.sim.view, lat, lon, radiusKm, viewer, { alpha: alpha() });
  hook.at = (x: number, y: number, radiusKm = 30, viewer = HUMAN_ID): LocalForces =>
    deriveLocalForces(ctx.sim.view, x, y, radiusKm, viewer, { alpha: alpha() });
  hook.split = (f: LocalForces, budget: number): number[] => visibleSplit(f, budget);
  hook.text = (s: LocalForceSide): string => localSideText(s);
  (window as unknown as { __localForces: typeof hook }).__localForces = hook;
}
