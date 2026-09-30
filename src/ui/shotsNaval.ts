// FRONT ULTRA — owner item 30 shots: the war at sea staged on the real sim (debug staging + real player commands):
//   naval-dialog   our two warships off Cádiz ordered to blockade Gibraltar: the dialog with its live preview
//                  (&who=war|embargo|all, &action=seize|sink)
//   naval-strait   Gibraltar closed to our enemy: the hatched zone, its chip, the enemy's merchants on their detour
//                  (via Suez and the Cape) and a seized prize sailing to our port (&alt=, &run= extra ticks)
//   naval-panel    the Guerra panel on «Mar»: our blockade's ledger and consequences, the enemy's blockade of our
//                  port, the straits
//   naval-port     our port blockaded by the enemy: its card with the trade lost per hour
// World: we are Spain (ports at Barcelona and Valencia, two warships off Cádiz), at war with the North African nation
// (ports at Algiers and Oran); the Italian, British and American nations trade through the strait.

import * as THREE from 'three';
import { getHud } from './index';
import { enemyNear } from '../render/units/shots';
import type { GameContext } from '../shared/api';
import { HUMAN_ID, MAP_H, MAP_W } from '../shared/constants';
import { latLonToTile, latLonToVec3, worldTimeForSubsolarLon } from '../shared/geo';
import { CHOKEPOINTS, chokepointTile, type BlockadeSpec } from '../shared/naval';
import { registerShot, type ShotContext } from '../shared/shots';
import { isLandTerrain } from '../shared/terrain';
import { StructureType as S, UnitType as U, type UnitView } from '../shared/types';
import { issueOrders, previewOrders } from './hud/orderCtl';

const at = (lat: number, lon: number) => latLonToTile(lat, lon);

async function until(s: ShotContext, cond: () => boolean, ms = 6000): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (cond()) return true;
    await s.wait(100);
  }
  return cond();
}

const own = (ctx: GameContext, type: U): UnitView[] => [...ctx.sim.view.units.values()].filter((u) => u.owner === HUMAN_ID && u.type === type).sort((a, b) => a.id - b.id);

/** The coastal land tile nearest to (lat, lon) (a port site). */
function coast(ctx: GameContext, lat: number, lon: number): number {
  const terrain = ctx.world!.terrain;
  const c = at(lat, lon);
  const cx = c % MAP_W, cy = Math.floor(c / MAP_W);
  let best = c, bd = Infinity;
  for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
    const y = cy + dy;
    if (y < 1 || y >= MAP_H - 1) continue;
    const t = y * MAP_W + ((cx + dx + MAP_W) % MAP_W);
    if (!isLandTerrain(terrain[t])) continue;
    const water = [t - 1, t + 1, t - MAP_W, t + MAP_W].some((n) => !isLandTerrain(terrain[n]));
    if (!water) continue;
    const d = dx * dx + dy * dy;
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  return best;
}

/** The water tile nearest to (lat, lon). */
function sea(ctx: GameContext, lat: number, lon: number): number {
  const terrain = ctx.world!.terrain;
  const c = at(lat, lon);
  if (!isLandTerrain(terrain[c])) return c;
  const cx = c % MAP_W, cy = Math.floor(c / MAP_W);
  for (let r = 1; r < 8; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const t = (cy + dy) * MAP_W + ((cx + dx + MAP_W) % MAP_W);
    if (!isLandTerrain(terrain[t])) return t;
  }
  return c;
}

/** Verification helper (tools/naval-verify.mjs): the screen px of a point on the globe. */
function exposeHelpers(ctx: GameContext): void {
  (window as unknown as { __fuNaval?: unknown }).__fuNaval = {
    screen(lat: number, lon: number) {
      const v = latLonToVec3(lat, lon, ctx.globe.surfaceRadiusAt(lat, lon), new THREE.Vector3()).project(ctx.camera);
      const r = ctx.canvas.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    },
  };
}

interface SeaWorld {
  enemy: number;
  italy: number;
  uk: number;
  usa: number;
  gib: number;
}

async function stageSea(s: ShotContext): Promise<SeaWorld> {
  const { ctx } = s;
  exposeHelpers(ctx);
  await ctx.app.startScriptedGame({ ticks: 200, speed: 0, nukes: false, autopilot: false, worldEvents: false, worldTimeSec: worldTimeForSubsolarLon(-10) });
  const sim = ctx.sim;
  const enemy = enemyNear(ctx, 36.4, 3.0);
  const italy = enemyNear(ctx, 41.9, 12.5);
  const uk = enemyNear(ctx, 52.0, -1.0);
  const usa = enemyNear(ctx, 40.0, -76.0);
  const port = (owner: number, lat: number, lon: number, level: number) => {
    const t = coast(ctx, lat, lon);
    sim.debug({ type: 'conquer', playerId: owner, centerTile: t, radius: 3 });
    sim.debug({ type: 'spawnStructure', structure: S.Port, owner, tile: t, level });
  };
  sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: at(40.0, -2.5), radius: 16 });
  port(HUMAN_ID, 41.35, 2.17, 3);
  port(HUMAN_ID, 39.45, -0.33, 2);
  port(HUMAN_ID, 36.53, -6.29, 2);
  sim.debug({ type: 'spawnStructure', structure: S.NavalYard, owner: HUMAN_ID, tile: coast(ctx, 36.72, -4.42), level: 2 });
  port(enemy, 36.77, 3.06, 3);
  port(enemy, 35.7, -0.65, 2);
  port(italy, 40.84, 14.25, 3);
  port(italy, 44.4, 8.9, 2);
  port(uk, 51.45, 0.7, 3);
  port(usa, 40.6, -74.0, 3);
  port(usa, 29.7, -95.0, 2);
  sim.debug({ type: 'war', a: HUMAN_ID, b: enemy, mobilizeTicks: 0 });
  sim.debug({ type: 'addGold', playerId: HUMAN_ID, amount: 20_000_000 });
  sim.debug({ type: 'spawnUnit', unit: U.Warship, owner: HUMAN_ID, tile: sea(ctx, 36.2, -6.9), targetTile: -1 });
  sim.debug({ type: 'spawnUnit', unit: U.Warship, owner: HUMAN_ID, tile: sea(ctx, 36.0, -7.2), targetTile: -1 });
  const cp = CHOKEPOINTS.find((c) => c.key === 'gibraltar')!;
  // Let the merchants sail (the ports send them on their lanes).
  await ctx.sim.fastForward(Number(s.params.get('trade') ?? 240));
  return { enemy, italy, uk, usa, gib: chokepointTile(cp) };
}

/** Our warships blockade Gibraltar with `spec` (the real command), and the sim runs until it is in force. */
async function closeGibraltar(s: ShotContext, w: SeaWorld, spec: BlockadeSpec): Promise<void> {
  const { ctx } = s;
  const ships = own(ctx, U.Warship);
  ctx.sim.send({ type: 'unitOrder', unitIds: ships.map((u) => u.id), order: 'blockade', tile: w.gib, targetId: 0, blockade: spec });
  await ctx.sim.fastForward(30);
  await until(s, () => ctx.sim.view.blockades.some((b) => b.owner === HUMAN_ID && b.active), 20000);
}

function specOf(params: URLSearchParams): BlockadeSpec {
  const who = (params.get('who') ?? 'war') as BlockadeSpec['who'];
  return { who, ships: (params.get('ships') ?? 'all') as BlockadeSpec['ships'], action: (params.get('action') ?? 'seize') as BlockadeSpec['action'] };
}

registerShot('naval-sea', 'ui', 'Owner item 30 (verification staging): the sea world with our two warships off Cádiz selected, paused, the camera over the Strait of Gibraltar', async (s) => {
  const { ctx, waitFrames, wait } = s;
  await stageSea(s);
  const ships = own(ctx, U.Warship);
  getHud()?.shared.select({ kind: 'units', ids: ships.map((u) => u.id) });
  ctx.cameraRig.setState({ lat: 36.5, lon: -4.5, altitudeKm: 2200, tilt: 0.15, heading: 0 });
  await waitFrames(10);
  await wait(800);
}, 10);

registerShot('naval-dialog', 'ui', 'Owner item 30: two warships ordered to blockade the Strait of Gibraltar — the dialog: whom it stops, which ships, board or sink, and the live preview of gains and costs (&who=war|embargo|all, &action=seize|sink)', async (s) => {
  const { ctx, params, waitFrames, wait } = s;
  const w = await stageSea(s);
  const hud = getHud();
  const ships = own(ctx, U.Warship);
  ctx.cameraRig.setState({ lat: 36.5, lon: -4.0, altitudeKm: 2600, tilt: 0.25, heading: 0 });
  await waitFrames(6);
  if (hud && ships.length) {
    hud.shared.select({ kind: 'units', ids: ships.map((u) => u.id) });
    const pv = previewOrders(hud.shared, ships.map((u) => u.id), w.gib, -1, -1, false);
    if (pv) issueOrders(hud.shared, pv, w.gib);
    const probe = (window as unknown as { __fuBlockade?: { current(): { set(x: Partial<BlockadeSpec>): void } | null } }).__fuBlockade?.current();
    if (probe && (params.get('who') || params.get('action'))) probe.set(specOf(params));
  }
  await waitFrames(12);
  await wait(1200);
}, 10);

registerShot('naval-strait', 'units', 'Owner item 30: Gibraltar closed to our enemy — the hatched zone and its chip, the enemy merchants on their detour, a seized prize sailing to our port (&alt=, &run=)', async (s) => {
  const { ctx, params, waitFrames, wait } = s;
  const w = await stageSea(s);
  await closeGibraltar(s, w, specOf(params));
  // An enemy merchant already inside the zone: boarded, it becomes ours and sails to Cádiz.
  ctx.sim.debug({ type: 'spawnUnit', unit: U.TradeShip, owner: w.enemy, tile: sea(ctx, 36.0, -4.9), targetTile: sea(ctx, 40.6, -70) });
  await ctx.sim.fastForward(Number(params.get('run') ?? 120));
  ctx.cameraRig.setState({ lat: Number(params.get('lat') ?? 36.8), lon: Number(params.get('lon') ?? -3.0), altitudeKm: Number(params.get('alt') ?? 2400), tilt: 0.2, heading: 0 });
  await waitFrames(20);
  await wait(2000);
}, 10);

registerShot('naval-panel', 'ui', 'Owner item 30: the Guerra panel on «Mar» — our Gibraltar blockade with its ledger and consequences, the enemy blockade of Barcelona, the straits', async (s) => {
  const { ctx, params, waitFrames, wait } = s;
  const w = await stageSea(s);
  await closeGibraltar(s, w, specOf(params));
  // The enemy closes Barcelona with a warship of its own (a real command of the enemy nation).
  ctx.sim.debug({ type: 'spawnUnit', unit: U.Warship, owner: w.enemy, tile: sea(ctx, 40.9, 3.2), targetTile: -1 });
  await ctx.sim.fastForward(2);
  const ew = [...ctx.sim.view.units.values()].find((u) => u.owner === w.enemy && u.type === U.Warship);
  if (ew) ctx.sim.debug({ type: 'issueAs', playerId: w.enemy, cmd: { type: 'unitOrder', unitIds: [ew.id], order: 'blockade', tile: sea(ctx, 41.2, 2.4), targetId: 0 } });
  await ctx.sim.fastForward(Number(params.get('run') ?? 200));
  ctx.cameraRig.setState({ lat: 38.5, lon: -1.0, altitudeKm: 2800, tilt: 0.2, heading: 0 });
  getHud()?.shared.openSea();
  await waitFrames(20);
  await wait(2000);
}, 10);

registerShot('naval-port', 'ui', 'Owner item 30: our port of Barcelona blockaded by the enemy — its card with the trade lost per hour', async (s) => {
  const { ctx, params, waitFrames, wait } = s;
  const w = await stageSea(s);
  ctx.sim.debug({ type: 'spawnUnit', unit: U.Warship, owner: w.enemy, tile: sea(ctx, 40.9, 3.2), targetTile: -1 });
  await ctx.sim.fastForward(2);
  const ew = [...ctx.sim.view.units.values()].find((u) => u.owner === w.enemy && u.type === U.Warship);
  if (ew) ctx.sim.debug({ type: 'issueAs', playerId: w.enemy, cmd: { type: 'unitOrder', unitIds: [ew.id], order: 'blockade', tile: sea(ctx, 41.2, 2.4), targetId: 0 } });
  await ctx.sim.fastForward(Number(params.get('run') ?? 120));
  const bcn = [...ctx.sim.view.structures.values()].find((x) => x.owner === HUMAN_ID && x.type === S.Port && x.tile === coast(ctx, 41.35, 2.17));
  if (bcn) getHud()?.shared.select({ kind: 'structure', id: bcn.id });
  ctx.cameraRig.setState({ lat: 41.0, lon: 2.4, altitudeKm: Number(params.get('alt') ?? 700), tilt: 0.3, heading: 0 });
  await waitFrames(20);
  await wait(1500);
}, 10);
