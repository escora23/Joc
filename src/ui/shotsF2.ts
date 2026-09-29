// FRONT ULTRA — shots of the owner's feedback #2 round (FEEDBACK-1 item 25: air missions). Owner: ui.
//   air-front   a real war across the Pyrenees (the human's offensive north), both sides with an airbase and
//               aircraft; the Guerra y frentes panel open on the front, ready for «Apoyo aéreo». Real play drives the
//               rest (tools/f2-verify.mjs): the panel's buttons, the right-click chips, time running.
// Params: the stageFrontWar ones, plus &air=0 (no aircraft) and &panel=0 (panel closed).

import { HUMAN_ID } from '../shared/constants';
import { latLonToTile } from '../shared/geo';
import { registerShot } from '../shared/shots';
import { StructureType, UnitType } from '../shared/types';
import { frameFront, stageFrontWar } from '../render/battle/shotsFronts';

registerShot('air-front', 'ui', 'Feedback #2 item 25: a real war with aircraft on both sides and the Guerra y frentes panel open on the front (Apoyo aéreo)', async (s) => {
  const { ctx, params } = s;
  const st = await stageFrontWar(s, { attacker: (params.get('attacker') as 'enemy' | 'human' | null) ?? 'human' });
  if (params.get('air') !== '0') {
    const ab = latLonToTile(40.9, -3.3), eab = latLonToTile(46.2, 0.8);
    ctx.sim.debug({ type: 'spawnStructure', structure: StructureType.Airbase, owner: HUMAN_ID, tile: ab, level: 3 });
    ctx.sim.debug({ type: 'spawnStructure', structure: StructureType.Airbase, owner: st.enemy, tile: eab, level: 3 });
    ctx.sim.debug({ type: 'spawnStructure', structure: StructureType.City, owner: HUMAN_ID, tile: latLonToTile(41.65, -0.88), level: 2 });
    for (const u of [UnitType.FighterSquadron, UnitType.FighterSquadron, UnitType.DroneSwarm, UnitType.Bomber]) {
      ctx.sim.debug({ type: 'spawnUnit', unit: u, owner: HUMAN_ID, tile: ab, targetTile: -1 });
    }
    for (const u of [UnitType.Bomber, UnitType.Bomber, UnitType.FighterSquadron]) {
      ctx.sim.debug({ type: 'spawnUnit', unit: u, owner: st.enemy, tile: eab, targetTile: -1 });
    }
    await ctx.sim.fastForward(1);
  }
  frameFront(s, st.front, 2500);
  if (st.front && params.get('panel') !== '0') ctx.bus.emit('frontSelected', { key: st.front.key, fly: false });
  await s.waitFrames(30);
}, 10);
