// FRONT ULTRA — ground-level war near active fronts (owner: battle).
// STUB by the architect: reports inactive. The battle owner implements the instanced infantry / tanks /
// artillery on terrain built from real elevation, muzzle flashes, tracers, explosions, smoke, craters and
// burning cities, with density driven by FrontView troop numbers, fading in below BATTLE_LAYER_ALT_KM.
// Keep the export: createBattleRenderer(ctx): BattleApi.

import * as THREE from 'three';
import type { BattleApi, FrameInfo, GameContext } from '../../shared/api';

export function createBattleRenderer(ctx: GameContext): BattleApi {
  const root = new THREE.Group();
  root.name = 'battle';
  ctx.scene.add(root);
  let active = false;
  return {
    get active() {
      return active;
    },
    get intensity() {
      return 0;
    },
    async init(progress) {
      progress(1);
    },
    onGameEnd() {
      active = false;
    },
    update(_frame: FrameInfo) {
      active = false;
    },
  };
}
