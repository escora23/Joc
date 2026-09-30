// FRONT ULTRA — shots of the owner's feedback #3 round (FEEDBACK-1 items 27-29, strategic side). Owner: ui.
//   f3-damage        one structure type in every damage state side by side (intact, damaged, heavily damaged, rubble)
//                    at close range, HUD hidden, captions with the state and the function: &type=Factory|SamSite|...
//   f3-city-damage   a level-8 city heavily damaged: collapsed blocks (one reported by command mode), debris, smoke and
//                    fire; &hp=0.3 &alt=18
//   f3-card          the card of a damaged own factory: state, «funciona al 60 %», who hit it, the repair button; the
//                    damage report in the alerts
//   f3-civil         a bomber ordered onto an enemy city: the confirmation with the consequences in numbers
//   f3-missions      Spain at war across the Pyrenees: divisions joining the offensive, one defending a sector, one
//                    assaulting a defence post; the Guerra panel open on the front (support, «Unirse» with the km/h)
//   f3-advisor       the Fuerzas panel with idle units: the mission line of each row and the advisor with «Dar misión»
// Every stager builds its scene from sim debug actions and real player commands, pauses and frames it.

import * as THREE from 'three';
import { getHud } from './index';
import { enemyNear } from '../render/units/shots';
import type { GameContext } from '../shared/api';
import { HUMAN_ID, MAP_H, MAP_W } from '../shared/constants';
import { DAMAGE_IDS, damageState, functionFactor } from '../shared/damage';
import { formatNumber, t } from '../shared/i18n';
import { latLonToTile, latLonToVec3, worldTimeForSubsolarLon } from '../shared/geo';
import { registerShot, type ShotContext } from '../shared/shots';
import { StructureType as S, UnitType as U, type UnitView } from '../shared/types';
import { issueOrders, previewOrders } from './hud/orderCtl';
import { fxInternal } from '../render/fx/index';
import { STRUCT_IDS } from './hud/forcesInfo';

const at = (lat: number, lon: number) => latLonToTile(lat, lon);
const tileLat = (t: number) => 90 - (Math.floor(t / MAP_W) + 0.5) * (180 / MAP_H);
const tileLon = (t: number) => ((t % MAP_W) + 0.5) * (360 / MAP_W) - 180;

function screenOf(ctx: GameContext, lat: number, lon: number): { x: number; y: number } {
  const v = latLonToVec3(lat, lon, ctx.globe.surfaceRadiusAt(lat, lon), new THREE.Vector3()).project(ctx.camera);
  const r = ctx.canvas.getBoundingClientRect();
  return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
}

async function until(s: ShotContext, cond: () => boolean, ms = 8000): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (cond()) return true;
    await s.wait(100);
  }
  return cond();
}

const own = (ctx: GameContext, type: U): UnitView[] => [...ctx.sim.view.units.values()].filter((u) => u.owner === HUMAN_ID && u.type === type).sort((a, b) => a.id - b.id);
const structAt = (ctx: GameContext, tile: number) => [...ctx.sim.view.structures.values()].find((x) => x.tile === tile);

/**
 * Smoke and fire run on the effects clock, which stops while the game is paused: run the clock at 1x for a few real
 * seconds (nothing in these scenes moves: no units, no war) so the columns rise, then pause for the capture.
 */
async function smoke(s: ShotContext): Promise<void> {
  await s.waitFrames(10);
  s.ctx.sim.setSpeed(1);
  await s.wait(Number(s.params.get('smoke') ?? 4000));
  s.ctx.sim.setSpeed(0);
  await s.waitFrames(6);
}

/** Jump the effects clock past the staged hits' blasts (their fireballs would otherwise stay frozen in view). */
async function settleBlasts(s: ShotContext): Promise<void> {
  await s.waitFrames(6);
  const fx = fxInternal(s.ctx);
  if (fx) {
    // Jump the effect clock past the demolition fireballs (no whiteout: quietScreen).
    // Twice: the first jump makes the delayed secondary blasts due; they fire on the next frames and the second jump
    // lets them burn out too.
    fx.quietScreen = true;
    fx.advance(Number(s.params.get('settle') ?? 30));
    await s.waitFrames(8);
    fx.advance(Number(s.params.get('settle') ?? 30));
    fx.quietScreen = false;
  }
  await s.waitFrames(4);
}

const TYPES: Record<string, S> = {
  City: S.City, Port: S.Port, Factory: S.Factory, DefensePost: S.DefensePost, SamSite: S.SamSite, MissileSilo: S.MissileSilo,
  Airbase: S.Airbase, ArmyBase: S.ArmyBase, NavalYard: S.NavalYard, Radar: S.Radar,
};

/** Captions under points of the globe (the shot's reading aid; the same words as the structure card). */
function captions(s: ShotContext, title: string, items: { lat: number; lon: number; text: string; dy?: number }[]): void {
  document.getElementById('fu-f3-captions')?.remove();
  const box = document.createElement('div');
  box.id = 'fu-f3-captions';
  box.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:50;font:600 14px/1.25 "JetBrains Mono",ui-monospace,monospace;color:#f3ead8;';
  const head = document.createElement('div');
  head.textContent = title;
  head.style.cssText = 'position:absolute;left:24px;top:18px;padding:6px 12px;background:rgba(18,16,12,.78);border:1px solid rgba(255,200,120,.35);border-radius:4px;';
  box.append(head);
  for (const it of items) {
    const p = screenOf(s.ctx, it.lat, it.lon);
    const c = document.createElement('div');
    c.textContent = it.text;
    c.style.cssText = `position:absolute;left:${p.x}px;top:${Math.min(p.y + (it.dy ?? 70), innerHeight - 34)}px;transform:translateX(-50%);white-space:nowrap;padding:3px 8px;background:rgba(18,16,12,.72);border-radius:3px;`;
    box.append(c);
  }
  document.body.append(box);
}

registerShot('f3-damage', 'units', 'Feedback #3 item 27: one structure type in every damage state (intact, damaged, heavily damaged, rubble) up close, with captions (&type=Factory|SamSite|ArmyBase|Airbase|…)', async (s) => {
  const { ctx, params, waitFrames, wait } = s;
  await ctx.app.startScriptedGame({ ticks: 100, speed: 0, nukes: false, autopilot: false, worldEvents: false, worldTimeSec: worldTimeForSubsolarLon(-40) });
  const sim = ctx.sim;
  const type = TYPES[params.get('type') ?? 'Factory'] ?? S.Factory;
  const level = Number(params.get('level') ?? (type === S.City ? 4 : 2));
  sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: at(39.4, -3.2), radius: 12 });
  const t0 = at(39.5, -3.5);
  // A 2 × 2 block of neighbouring tiles: 1 2 on the far row, 3 4 on the near one.
  const tiles = [t0, t0 + 1, t0 + MAP_W, t0 + MAP_W + 1];
  for (const tile of tiles) sim.debug({ type: 'spawnStructure', structure: type, owner: HUMAN_ID, tile, level });
  await until(s, () => tiles.every((tl) => structAt(ctx, tl)), 30000);
  // Frame first: the demolition fireball and its fire are sized for the camera that sees them happen.
  const lat = (tileLat(tiles[0]) + tileLat(tiles[3])) / 2, lon = (tileLon(tiles[0]) + tileLon(tiles[3])) / 2;
  const alt = Number(params.get('alt') ?? 24);
  ctx.cameraRig.setState({ lat: lat - Number(params.get('back') ?? 0.13), lon, altitudeKm: alt, tilt: Number(params.get('tilt') ?? 0.85), heading: 0 });
  await waitFrames(6);
  // 1 intact, 2 damaged (0.6), 3 heavily damaged (0.25), 4 destroyed: hit until it is rubble.
  sim.debug({ type: 'damageStructure', tile: tiles[1], amount: 0.4, by: 0 });
  sim.debug({ type: 'damageStructure', tile: tiles[2], amount: 0.75, by: 0 });
  for (let k = 0; k < level + 1; k++) sim.debug({ type: 'damageStructure', tile: tiles[3], amount: 1.2, by: 0 });
  await until(s, () => ctx.sim.view.ruins.some((r) => r.tile === tiles[3]), 20000);
  s.setUiVisible(false);
  await settleBlasts(s);
  await smoke(s);
  const items = tiles.map((tl, i) => {
    const st = structAt(ctx, tl);
    const state = st ? damageState(st.hp) : 3;
    const txt = st ? `${t(`card.dmg.${DAMAGE_IDS[state]}`)} · ${t('card.dmg.fn', { p: Math.round(functionFactor(st.hp) * 100) })} · L${st.level}` : t('aar.dmg.rubble');
    return { lat: tileLat(tl), lon: tileLon(tl), text: `${i + 1}. ${txt}`, dy: 60 };
  });
  captions(s, `${t(`structure.${STRUCT_IDS[type]}`)} — ${t('shot.f3.damage')}`, items);
  await waitFrames(4);
}, 10);

registerShot('f3-city-damage', 'units', 'Feedback #3 item 27: a level-8 city heavily damaged — collapsed blocks (one reported by command mode), debris, smoke and fire', async (s) => {
  const { ctx, params, waitFrames, wait } = s;
  await ctx.app.startScriptedGame({ ticks: 100, speed: 0, nukes: false, autopilot: false, worldEvents: false, worldTimeSec: worldTimeForSubsolarLon(-40) });
  const sim = ctx.sim;
  sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: at(39.4, -3.2), radius: 12 });
  const left = at(39.5, -3.4), right = left + 1;
  sim.debug({ type: 'spawnStructure', structure: S.City, owner: HUMAN_ID, tile: left, level: 8 });
  sim.debug({ type: 'spawnStructure', structure: S.City, owner: HUMAN_ID, tile: right, level: 8 });
  await until(s, () => !!structAt(ctx, left) && !!structAt(ctx, right), 30000);
  const lat = tileLat(left), lon = (tileLon(left) + tileLon(right)) / 2;
  ctx.cameraRig.setState({ lat: lat - Number(params.get('back') ?? 0.0), lon, altitudeKm: Number(params.get('alt') ?? 11), tilt: Number(params.get('tilt') ?? 1.0), heading: 0 });
  await waitFrames(6);
  const hp = Number(params.get('hp') ?? 0.3);
  sim.debug({ type: 'damageStructure', tile: right, amount: 1 - hp, by: 0, block: 5 });
  await until(s, () => (structAt(ctx, right)?.hp ?? 1) < 0.99, 10000);
  s.setUiVisible(false);
  await settleBlasts(s);
  await smoke(s);
  const st = structAt(ctx, right);
  captions(s, t('shot.f3.city'), [
    { lat: tileLat(left), lon: tileLon(left), text: `${t('card.dmg.intact')} · L8`, dy: 150 },
    { lat: tileLat(right), lon: tileLon(right), text: st ? `${t(`card.dmg.${DAMAGE_IDS[damageState(st.hp)]}`)} · ${t('card.dmg.fn', { p: Math.round(functionFactor(st.hp) * 100) })} · L${st.level}` : '', dy: 150 },
  ]);
  await waitFrames(4);
}, 10);

/** Spain at war with its northern neighbour, a human offensive north, units and structures on both sides. */
async function stageWar(s: ShotContext, runTicks = 60): Promise<number> {
  const { ctx } = s;
  await ctx.app.startScriptedGame({ ticks: 200, speed: 0, nukes: false, autopilot: false, worldEvents: false, worldTimeSec: worldTimeForSubsolarLon(-20) });
  const sim = ctx.sim;
  const enemy = enemyNear(ctx, 45.5, 1.5);
  sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: at(40.6, -2.5), radius: 20 });
  sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: at(42.0, -0.5), radius: 9 });
  sim.debug({ type: 'conquer', playerId: enemy, centerTile: at(44.3, 1.2), radius: 11 });
  sim.debug({ type: 'war', a: HUMAN_ID, b: enemy, mobilizeTicks: 0 });
  sim.debug({ type: 'escalate', by: HUMAN_ID, against: enemy, level: 2 });
  sim.debug({ type: 'addGold', playerId: HUMAN_ID, amount: 20_000_000 });
  sim.debug({ type: 'addTroops', playerId: HUMAN_ID, amount: 900_000 });
  const put = (structure: S, lat: number, lon: number, level: number, owner = HUMAN_ID) => sim.debug({ type: 'spawnStructure', structure, owner, tile: at(lat, lon), level });
  put(S.City, 40.42, -3.7, 6);
  put(S.City, 41.65, -0.88, 3);
  put(S.ArmyBase, 41.5, -1.3, 3);
  put(S.Airbase, 40.5, -3.3, 2);
  put(S.Factory, 40.9, -2.6, 2);
  put(S.City, 43.6, 1.44, 5, enemy); // Toulouse
  put(S.DefensePost, 43.2, -0.4, 2, enemy);
  put(S.Airbase, 44.8, 0.6, 1, enemy);
  const spawn = (unit: U, lat: number, lon: number, owner = HUMAN_ID) => sim.debug({ type: 'spawnUnit', unit, owner, tile: at(lat, lon), targetTile: -1 });
  for (const [la, lo] of [[42.3, -1.5], [42.2, -0.2], [41.9, -1.0], [41.4, -2.0]]) spawn(U.ArmoredDivision, la, lo);
  spawn(U.FighterSquadron, 40.5, -3.3);
  spawn(U.FighterSquadron, 40.5, -3.3);
  spawn(U.Bomber, 40.5, -3.3);
  spawn(U.DroneSwarm, 40.5, -3.3);
  spawn(U.Warship, 41.0, 2.6);
  await until(s, () => own(ctx, U.ArmoredDivision).length >= 4 && own(ctx, U.Bomber).length > 0, 20000);
  // The human's offensive north (the dialog's command, 40 % of home troops).
  sim.send({ type: 'attack', target: enemy, ratio: 0.4, tile: at(43.4, 0.2), intensity: 1 });
  sim.setSpeed(1);
  await until(s, () => ctx.sim.view.tick >= 200 + runTicks, 30000);
  sim.setSpeed(0);
  await s.waitFrames(4);
  return enemy;
}

registerShot('f3-missions', 'ui', 'Feedback #3 item 28: division missions on a real war — two join the offensive, one defends a sector, one assaults a defence post; the Guerra panel open on the front', async (s) => {
  const { ctx, params, waitFrames, wait } = s;
  const enemy = await stageWar(s, 30);
  const sim = ctx.sim;
  const off = ctx.sim.view.attacks.find((a) => a.attacker === HUMAN_ID && a.defender === enemy);
  const divs = own(ctx, U.ArmoredDivision);
  const post = [...ctx.sim.view.structures.values()].find((x) => x.owner === enemy && x.type === S.DefensePost);
  if (off) sim.send({ type: 'unitOrder', unitIds: [divs[0].id, divs[1].id], order: 'join', tile: -1, targetId: off.id });
  sim.send({ type: 'unitOrder', unitIds: [divs[3].id], order: 'defend', tile: at(42.5, -1.9), targetId: 0 });
  if (post) sim.send({ type: 'unitOrder', unitIds: [divs[2].id], order: 'assault', tile: post.tile, targetId: post.id });
  sim.setSpeed(1);
  await until(s, () => ctx.sim.view.tick >= 290 + Number(params.get('run') ?? 60), 40000);
  sim.setSpeed(0);
  const hud = getHud();
  if (hud) hud.shared.select({ kind: 'units', ids: divs.map((d) => d.id) });
  ctx.cameraRig.setState({ lat: 42.7, lon: -0.7, altitudeKm: Number(params.get('alt') ?? 900), tilt: 0.35, heading: 0 });
  const fr = off ? ctx.sim.view.attacks.find((a) => a.id === off.id)?.frontKey ?? 0 : 0;
  if (fr && params.get('panel') !== '0') ctx.bus.emit('frontSelected', { key: fr, fly: false });
  await waitFrames(20);
  await wait(1500);
}, 10);

registerShot('f3-card', 'ui', 'Feedback #3 item 27: the card of a damaged own factory (state, function, who hit it, the repair) and the damage report', async (s) => {
  const { ctx, waitFrames, wait } = s;
  const enemy = await stageWar(s, 10);
  const fac = [...ctx.sim.view.structures.values()].find((x) => x.owner === HUMAN_ID && x.type === S.Factory);
  if (fac) ctx.sim.debug({ type: 'damageStructure', tile: fac.tile, amount: 0.45, by: enemy });
  await until(s, () => (fac ? (ctx.sim.view.structures.get(fac.id)?.hp ?? 1) < 0.9 : true), 8000);
  const hud = getHud();
  if (hud && fac) hud.shared.select({ kind: 'structure', id: fac.id });
  ctx.cameraRig.setState({ lat: 40.8, lon: -2.6, altitudeKm: 60, tilt: 0.9, heading: 0.3 });
  await waitFrames(20);
  await wait(3000);
}, 10);

registerShot('f3-civil', 'ui', 'Feedback #3 item 27: a bomber ordered onto an enemy city — the confirmation with the consequences in numbers', async (s) => {
  const { ctx, waitFrames, wait } = s;
  await stageWar(s, 10);
  const b = own(ctx, U.Bomber)[0];
  const city = [...ctx.sim.view.structures.values()].find((x) => x.owner !== HUMAN_ID && x.type === S.City && x.tile === at(43.6, 1.44));
  const hud = getHud();
  ctx.cameraRig.setState({ lat: 42.4, lon: -0.5, altitudeKm: 1500, tilt: 0.3, heading: 0 });
  await waitFrames(6);
  if (hud && b && city) {
    hud.shared.select({ kind: 'unit', id: b.id });
    const pv = previewOrders(hud.shared, [b.id], city.tile, -1, city.id, false);
    if (pv) issueOrders(hud.shared, pv, city.tile);
  }
  await waitFrames(12);
  await wait(1500);
}, 10);

registerShot('f3-advisor', 'ui', 'Feedback #3 item 29c: the Fuerzas panel with the mission of every unit and the advisor pointing at idle units with «Dar misión»', async (s) => {
  const { ctx, waitFrames, wait } = s;
  await stageWar(s, 20);
  const divs = own(ctx, U.ArmoredDivision);
  // Two divisions get a mission; the rest, the docked aircraft and the warship stay idle for the advisor.
  const off = ctx.sim.view.attacks.find((a) => a.attacker === HUMAN_ID);
  if (off) ctx.sim.send({ type: 'unitOrder', unitIds: [divs[0].id], order: 'join', tile: -1, targetId: off.id });
  ctx.sim.send({ type: 'unitOrder', unitIds: [divs[1].id], order: 'defend', tile: at(42.5, -1.9), targetId: 0 });
  await waitFrames(6);
  ctx.cameraRig.setState({ lat: 41.4, lon: -1.2, altitudeKm: 1400, tilt: 0.35, heading: 0 });
  getHud()?.shared.toggleForces(true);
  await waitFrames(10);
  await wait(1500);
}, 10);
