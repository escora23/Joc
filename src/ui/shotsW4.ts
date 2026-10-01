// FRONT ULTRA — W4 shots (DESIGN_V2 §16.5): the Fuerzas panel, the unit and structure cards, order previews, structure
// levels, grounded structures in the Pyrenees, a CAP circle, a blockade and an air raid. Every stager builds its scene
// from sim debug actions and real player commands (no hand-drawn UI), pauses, and frames it.

import * as THREE from 'three';
import { getHud } from './index';
import { enemyNear } from '../render/units/shots';
import type { GameContext } from '../shared/api';
import { HUMAN_ID, MAP_H, MAP_W, STRUCTURE_DEFS } from '../shared/constants';
import { formatNumber, t } from '../shared/i18n';
import { isLandTerrain } from '../shared/terrain';
import { latLonToTile, latLonToVec3, worldTimeForSubsolarLon } from '../shared/geo';
import { registerShot, type ShotContext } from '../shared/shots';
import { StructureType as S, UnitType as U, type UnitView } from '../shared/types';

const at = (lat: number, lon: number) => latLonToTile(lat, lon);

/** Client px of a lat/lon on the globe surface (for staged hovers). */
function screenOf(ctx: GameContext, lat: number, lon: number): { x: number; y: number } {
  const v = latLonToVec3(lat, lon, ctx.globe.surfaceRadiusAt(lat, lon), new THREE.Vector3()).project(ctx.camera);
  const r = ctx.canvas.getBoundingClientRect();
  return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
}

async function until(s: ShotContext, cond: () => boolean, ms = 6000): Promise<boolean> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (cond()) return true;
    await s.wait(100);
  }
  return cond();
}

const own = (ctx: GameContext, type: U): UnitView[] => [...ctx.sim.view.units.values()].filter((u) => u.owner === HUMAN_ID && u.type === type).sort((a, b) => a.id - b.id);

/**
 * Spain at war with its northern neighbour across the Pyrenees: army base, airbase, naval yard, port, radar and SAM;
 * two divisions attached to the front, one moving by road, docked fighters, a bomber and a drone swarm, a fighter
 * patrol over the front, a warship off Barcelona and a division in production. Returns the enemy id.
 */
async function stageForces(s: ShotContext, runTicks = 40): Promise<number> {
  const { ctx } = s;
  await ctx.app.startScriptedGame({ ticks: 200, speed: 0, nukes: false, autopilot: false, worldEvents: false, worldTimeSec: worldTimeForSubsolarLon(-20) });
  const sim = ctx.sim;
  const enemy = enemyNear(ctx, 45.5, 1.5);
  sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: at(40.6, -2.5), radius: 20 });
  sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: at(42.0, -0.5), radius: 9 });
  sim.debug({ type: 'conquer', playerId: enemy, centerTile: at(44.3, 1.2), radius: 11 });
  sim.debug({ type: 'war', a: HUMAN_ID, b: enemy, mobilizeTicks: 0 });
  sim.debug({ type: 'addGold', playerId: HUMAN_ID, amount: 20_000_000 });
  const put = (structure: S, lat: number, lon: number, level: number, owner = HUMAN_ID) => sim.debug({ type: 'spawnStructure', structure, owner, tile: at(lat, lon), level });
  put(S.City, 40.42, -3.7, 6);
  put(S.City, 41.65, -0.88, 3);
  put(S.ArmyBase, 41.5, -1.3, 2);
  put(S.Airbase, 40.5, -3.3, 2);
  put(S.Radar, 41.2, -2.2, 2);
  put(S.SamSite, 40.3, -3.9, 2);
  put(S.Factory, 40.9, -2.6, 2);
  put(S.Airbase, 44.8, 0.6, 1, enemy);
  const spawn = (unit: U, lat: number, lon: number, owner = HUMAN_ID, tLat?: number, tLon?: number) =>
    sim.debug({ type: 'spawnUnit', unit, owner, tile: at(lat, lon), targetTile: tLat === undefined ? -1 : at(tLat, tLon!) });
  spawn(U.ArmoredDivision, 42.3, -1.5);
  spawn(U.ArmoredDivision, 42.2, -0.2);
  spawn(U.ArmoredDivision, 40.6, -3.4);
  spawn(U.FighterSquadron, 40.5, -3.3);
  spawn(U.FighterSquadron, 40.5, -3.3);
  spawn(U.Bomber, 40.5, -3.3);
  spawn(U.DroneSwarm, 40.5, -3.3);
  spawn(U.Warship, 41.0, 2.6);
  // The spawned units arrive with the next sim update (seconds apart on a loaded software renderer).
  await until(s, () => own(ctx, U.Warship).length > 0 && own(ctx, U.ArmoredDivision).length >= 3 && own(ctx, U.FighterSquadron).length >= 2, 90000);
  const divs = own(ctx, U.ArmoredDivision);
  const front = at(42.95, -0.6);
  sim.send({ type: 'unitOrder', unitIds: [divs[0].id, divs[1].id], order: 'attach', tile: front, targetId: 0 });
  sim.send({ type: 'unitOrder', unitIds: [divs[2].id], order: 'move', tile: at(41.7, -0.9), targetId: 0 });
  const fighters = own(ctx, U.FighterSquadron);
  sim.send({ type: 'unitOrder', unitIds: [fighters[0].id], order: 'cap', tile: at(42.6, -0.9), targetId: 0 });
  const ws = own(ctx, U.Warship)[0];
  if (ws) sim.send({ type: 'unitOrder', unitIds: [ws.id], order: 'patrol', tile: at(41.2, 2.9), targetId: 0 });
  sim.send({ type: 'buildUnit', unit: U.ArmoredDivision, structureId: -1 });
  sim.send({ type: 'buildUnit', unit: U.FighterSquadron, structureId: -1 });
  // A few game hours so the orders are under way (marching, on patrol, rail/road ETA).
  sim.setSpeed(1);
  await until(s, () => ctx.sim.view.tick >= 200 + runTicks, 20000);
  sim.setSpeed(0);
  await s.waitFrames(4);
  return enemy;
}

registerShot('forces-panel', 'ui', 'Fuerzas panel (U): every own unit grouped by what it does, with place, state and ETA, integrity, production and capacity (§7.5)', async (s) => {
  const { ctx, waitFrames, wait } = s;
  await stageForces(s);
  ctx.cameraRig.setState({ lat: 41.4, lon: -1.2, altitudeKm: 1400, tilt: 0.35, heading: 0 });
  getHud()?.shared.toggleForces(true);
  await waitFrames(10);
  await wait(1200);
}, 10);

registerShot('unit-card', 'ui', 'Unit card (§7.6): an armored division on the Pyrenees front with role, speed, reach, current effect and endurance', async (s) => {
  const { ctx, waitFrames, wait } = s;
  await stageForces(s, 60);
  const d = own(ctx, U.ArmoredDivision)[0];
  const hud = getHud();
  if (hud && d) hud.shared.select({ kind: 'unit', id: d.id });
  const lat = d ? 90 - (d.y / 800) * 180 : 42.5, lon = d ? (d.x / 1600) * 360 - 180 : -1;
  ctx.cameraRig.setState({ lat, lon, altitudeKm: 700, tilt: 0.5, heading: 0 });
  await waitFrames(10);
  await wait(1500);
}, 10);

registerShot('structure-card-upgrade', 'ui', 'Structure card (§7.6): an airbase with its hosted aircraft, current and next-level effects, the upgrade cost and «Te faltan … de oro»', async (s) => {
  const { ctx, waitFrames, wait } = s;
  await stageForces(s, 20);
  // Spend down to 150,000 gold: the upgrade (L2 -> L3) cannot be paid, the card says by how much.
  const gold = ctx.sim.view.human?.gold ?? 0;
  ctx.sim.debug({ type: 'addGold', playerId: HUMAN_ID, amount: -(gold - 150_000) });
  const base = [...ctx.sim.view.structures.values()].find((x) => x.owner === HUMAN_ID && x.type === S.Airbase);
  const hud = getHud();
  if (hud && base) hud.shared.select({ kind: 'structure', id: base.id });
  ctx.cameraRig.setState({ lat: 40.5, lon: -3.3, altitudeKm: 90, tilt: 0.9, heading: 0.4 });
  await until(s, () => (ctx.sim.view.human?.gold ?? 1e9) < 400_000, 4000);
  await waitFrames(10);
  await wait(1500);
}, 10);

registerShot('orders-preview', 'ui', 'Order preview (§7.3, §7.4): several units selected, the cursor chip with order, distance, ETA and «n de m», one line per unit', async (s) => {
  const { ctx, waitFrames, wait } = s;
  await stageForces(s, 20);
  ctx.cameraRig.setState({ lat: 42.0, lon: -1.0, altitudeKm: 1300, tilt: 0.3, heading: 0 });
  await waitFrames(8);
  const hud = getHud();
  const ids = [...own(ctx, U.ArmoredDivision).map((u) => u.id), own(ctx, U.Warship)[0]?.id ?? -1].filter((id) => id > 0);
  if (hud) {
    hud.shared.select({ kind: 'units', ids });
    const p = screenOf(ctx, 43.3, -0.4);
    const tile = at(43.3, -0.4);
    hud.shared.setHover({ button: -1, tile, lat: 43.3, lon: -0.4, unitId: -1, structureId: -1, clientX: p.x, clientY: p.y, shift: false, ctrl: false, alt: false });
  }
  await waitFrames(12);
  await wait(1500);
}, 10);

registerShot('cap-circle', 'units', 'A fighter patrol (CAP) over the Pyrenees front: its 150 km circle stays drawn while it patrols; selected, with its reach from base', async (s) => {
  const { ctx, waitFrames, wait } = s;
  await stageForces(s, 40);
  const f = own(ctx, U.FighterSquadron).find((u) => u.mode === 8);
  const hud = getHud();
  if (hud && f) hud.shared.select({ kind: 'unit', id: f.id });
  ctx.cameraRig.setState({ lat: 42.2, lon: -1.6, altitudeKm: 1600, tilt: 0.3, heading: 0 });
  await waitFrames(10);
  await wait(1200);
}, 10);

registerShot('blockade', 'units', 'A warship blockading the enemy coast off Marseille: its 150 km zone drawn, an enemy trade ship being captured', async (s) => {
  const { ctx, waitFrames, wait } = s;
  const enemy = await stageForces(s, 10);
  const sim = ctx.sim;
  sim.debug({ type: 'conquer', playerId: enemy, centerTile: at(43.6, 5.0), radius: 7 });
  const ws = own(ctx, U.Warship)[0];
  if (ws) sim.send({ type: 'unitOrder', unitIds: [ws.id], order: 'blockade', tile: at(42.7, 4.9), targetId: 0 });
  sim.setSpeed(2);
  await until(s, () => {
    const w = ctx.sim.view.units.get(ws?.id ?? -1);
    return !!w && w.mode === 13 && w.etaTicks <= 0;
  }, 40000);
  sim.debug({ type: 'spawnUnit', unit: U.TradeShip, owner: enemy, tile: at(42.2, 6.2), targetTile: at(42.9, 3.6) });
  await wait(1500);
  sim.setSpeed(0);
  const hud = getHud();
  if (hud && ws) hud.shared.select({ kind: 'unit', id: ws.id });
  ctx.cameraRig.setState({ lat: 42.7, lon: 4.9, altitudeKm: 900, tilt: 0.3, heading: 0 });
  await waitFrames(10);
  await wait(1200);
}, 10);

registerShot('air-raid', 'ui', 'An air raid announced at take-off (our radar covers the enemy airbase): the alert, the sortie line and the ETA (§8.2)', async (s) => {
  const { ctx, waitFrames, wait } = s;
  const enemy = await stageForces(s, 10);
  const sim = ctx.sim;
  // Our radar at the Pyrenees covers the enemy airbase near Toulouse (level 3: 900 km).
  sim.debug({ type: 'spawnStructure', structure: S.Radar, owner: HUMAN_ID, tile: at(42.4, -0.8), level: 3 });
  sim.debug({ type: 'spawnUnit', unit: U.Bomber, owner: enemy, tile: at(44.8, 0.6), targetTile: -1 });
  await until(s, () => [...ctx.sim.view.units.values()].some((u) => u.owner === enemy && u.type === U.Bomber));
  const b = [...ctx.sim.view.units.values()].find((u) => u.owner === enemy && u.type === U.Bomber);
  const target = [...ctx.sim.view.structures.values()].find((x) => x.owner === HUMAN_ID && x.type === S.ArmyBase);
  if (b && target) {
    // The enemy strikes with its own orders (escalation L1 first, as its war plan would).
    sim.debug({ type: 'escalate', by: enemy, against: HUMAN_ID, level: 1 });
    sim.debug({ type: 'command', playerId: enemy, cmd: { type: 'unitOrder', unitIds: [b.id], order: 'strike', tile: target.tile, targetId: target.id } });
  }
  sim.setSpeed(1);
  await wait(2500);
  sim.setSpeed(0);
  ctx.cameraRig.setState({ lat: 43.1, lon: -0.2, altitudeKm: 1500, tilt: 0.3, heading: 0 });
  await waitFrames(10);
  await wait(1200);
}, 10);

/**
 * structures-levels (§6.5): the structure level as the player reads it on the strategic map — every type at L1 / L2 /
 * L3 (cities 1 / 5 / 10) on Castilian land at an icon zoom where the icons (with their 1-3 level dots) float over the
 * models, and the Factory L2 card open with its ●●○ pips. The geometry itself is compared up close in the gallery
 * frames structures-levels-1 … -10 below (one type each).
 */
registerShot('structures-levels', 'units', 'Every structure type at levels 1, 2 and 3 (cities 1, 5, 10) at icon zoom: level dots under every icon and the Factory L2 card with its pips (§6.5)', async (s) => {
  const { ctx, waitFrames, wait, params } = s;
  await ctx.app.startScriptedGame({ ticks: 100, speed: 0, nukes: false, autopilot: false, worldEvents: false, worldTimeSec: worldTimeForSubsolarLon(-30) });
  const sim = ctx.sim;
  sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: at(39.2, -3.2), radius: 16 });
  const types = [S.City, S.Port, S.Factory, S.DefensePost, S.SamSite, S.MissileSilo, S.Airbase, S.ArmyBase, S.NavalYard, S.Radar];
  // One tile apart (a tile holds one structure): two types per row, L1 / L2 / L3 left to right.
  // Two tiles apart (a tile holds one structure; the icons must not touch): two types per row, L1 / L2 / L3 left to right.
  const lat0 = 40.3, lon0 = -4.9, TILE = 0.225;
  types.forEach((type, i) => {
    const r = Math.floor(i / 2), c0 = (i % 2) * 8;
    [1, 2, 3].forEach((L, c) => {
      const level = type === S.City ? [1, 5, 10][c] : L;
      sim.debug({ type: 'spawnStructure', structure: type, owner: HUMAN_ID, tile: at(lat0 - r * 2 * TILE, lon0 + (c0 + 2 * c) * TILE), level });
    });
  });
  // The spawns reach the view on a later sim tick (slow under load): wait for all 30.
  const findFactory = () => [...ctx.sim.view.structures.values()].find((x) => x.owner === HUMAN_ID && x.type === S.Factory && x.level === 2);
  await until(s, () => ctx.sim.view.structures.size >= types.length * 3 && !!findFactory(), 60000);
  let factory = findFactory();
  getHud()?.shared.select(factory ? { kind: 'structure', id: factory.id } : { kind: 'none' });
  ctx.cameraRig.setState({
    lat: Number(params.get('lat') ?? lat0 - 4 * TILE + 0.06), lon: Number(params.get('lon') ?? lon0 + 6.2 * TILE),
    altitudeKm: Number(params.get('alt') ?? 385), tilt: Number(params.get('tilt') ?? 0.15), heading: 0,
  });
  await waitFrames(12);
  // The card slides in on the HUD's own frame loop (slow under software GL), and the HUD's game-start reset can land
  // after the stager's first select: (re)select until the card has stayed in for 3 s.
  let held = 0;
  const t0 = performance.now();
  while (held < 3000 && performance.now() - t0 < 90000) {
    const hs = getHud()?.shared;
    factory ??= findFactory();
    const ok = !!factory && hs?.selection.kind === 'structure' && hs.selection.id === factory.id && !!document.querySelector('.fu-sel.is-in .fu-sel-head');
    if (!ok && hs && factory && !(hs.selection.kind === 'structure' && hs.selection.id === factory.id)) hs.select({ kind: 'structure', id: factory.id });
    held = ok ? held + 250 : 0;
    await wait(250);
  }
  await wait(1500);
}, 10);

/**
 * Gallery frames of the structure models by level (§6.5; verify:W4 criterion 10): ONE type per frame, its L1 / L2 /
 * L3 (cities 1 / 5 / 10) on three neighbouring tiles (19 km apart) left to right, the camera framed so the three fill
 * the width (32-40 km, as a player zoomed in), the HUD hidden and a caption under each model with the type, «Nivel
 * n/3» and the pips, as on the structure card. Airbases carry their docked squadrons (3 / 6 / 9: the level's
 * capacity). No enlargement: what the player sees in play. Ports and naval yards stand on the straight Portuguese
 * coast, a north-south line (25 km apart) seen from the sea.
 */
interface LevelFrame { type: S; alt: number; coast?: boolean }
const LEVEL_FRAMES: LevelFrame[] = [
  { type: S.City, alt: 38 },
  { type: S.Port, alt: 44, coast: true },
  { type: S.Factory, alt: 36 },
  { type: S.DefensePost, alt: 34 },
  { type: S.SamSite, alt: 34 },
  { type: S.MissileSilo, alt: 34 },
  { type: S.Airbase, alt: 40 },
  { type: S.ArmyBase, alt: 36 },
  { type: S.NavalYard, alt: 44, coast: true },
  { type: S.Radar, alt: 34 },
];
const STRUCT_KEYS = ['city', 'port', 'factory', 'defensePost', 'samSite', 'missileSilo', 'airbase', 'armyBase', 'navalYard', 'radar'];

/** The westernmost land tile of the row at `lat` whose western neighbour is sea (the Atlantic coast of Portugal). */
function coastTile(ctx: GameContext, lat: number): number {
  const w = ctx.world;
  const t0 = at(lat, -7.6);
  if (!w) return t0;
  const y = Math.floor(t0 / MAP_W);
  for (let x = t0 % MAP_W; x > (t0 % MAP_W) - 20; x--) {
    const t = y * MAP_W + x;
    if (isLandTerrain(w.terrain[t]) && !isLandTerrain(w.terrain[t - 1])) return t;
  }
  return t0;
}

const tileLat = (t: number) => 90 - (Math.floor(t / MAP_W) + 0.5) * (180 / MAP_H);
const tileLon = (t: number) => ((t % MAP_W) + 0.5) * (360 / MAP_W) - 180;

LEVEL_FRAMES.forEach((frame, fi) => {
  const name = STRUCT_KEYS[frame.type];
  registerShot(`structures-levels-${fi + 1}`, 'units', `Structure models by level at real size (gallery ${fi + 1}/${LEVEL_FRAMES.length}: ${name} L1 / L2 / L3), camera at ${frame.alt} km, HUD hidden, captions with the level pips (§6.5)`, async (s) => {
    const { ctx, waitFrames, wait, params } = s;
    await ctx.app.startScriptedGame({ ticks: 100, speed: 0, nukes: false, autopilot: false, worldEvents: false, worldTimeSec: worldTimeForSubsolarLon(-45) });
    const sim = ctx.sim;
    const placed: { type: S; level: number; tile: number }[] = [];
    if (frame.coast) {
      const TILE = 180 / MAP_H;
      sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: at(40.1, -8.3), radius: 9 });
      [40.1 + TILE, 40.1, 40.1 - TILE].forEach((lat, c) => placed.push({ type: frame.type, level: c + 1, tile: coastTile(ctx, lat) }));
    } else {
      sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: at(39.4, -3.2), radius: 12 });
      // Three neighbouring tiles of one row (tile indices, not rounded lat/lon: exactly one tile apart).
      const t0 = at(39.5, -3.45);
      [1, 2, 3].forEach((L, c) => placed.push({ type: frame.type, level: frame.type === S.City ? [1, 5, 10][c] : L, tile: t0 + c }));
    }
    for (const p of placed) sim.debug({ type: 'spawnStructure', structure: p.type, owner: HUMAN_ID, tile: p.tile, level: p.level });
    s.setUiVisible(false);
    await until(s, () => placed.every((p) => [...ctx.sim.view.structures.values()].some((x) => x.tile === p.tile)), 60000);
    if (frame.type === S.Airbase) {
      // Docked squadrons up to each level's capacity (3 / 6 / 9): fighters, bombers and drones on the apron.
      for (const p of placed) {
        const base = [...ctx.sim.view.structures.values()].find((x) => x.tile === p.tile);
        if (!base) continue;
        for (let i = 0; i < 3 * p.level; i++) {
          sim.debug({ type: 'spawnUnit', unit: i % 3 === 1 ? U.Bomber : i % 3 === 2 ? U.DroneSwarm : U.FighterSquadron, owner: HUMAN_ID, tile: p.tile, targetTile: -1 });
        }
      }
      await until(s, () => [...ctx.sim.view.units.values()].filter((u) => u.owner === HUMAN_ID).length >= 18, 30000);
    }
    const alt = Number(params.get('alt') ?? frame.alt);
    const units = (window as unknown as { __units?: { sizeOf(k: 'struct', id: number): { px: number; w: number; h: number } | null; anchorOf(t: number): { lat: number; lon: number } | null } }).__units;
    // Where the models are drawn (ports and yards slide onto the shoreline): frame and caption those points.
    await waitFrames(4);
    const where = placed.map((p) => units?.anchorOf(p.tile) ?? { lat: tileLat(p.tile), lon: tileLon(p.tile) });
    const lat = (Math.min(...where.map((w) => w.lat)) + Math.max(...where.map((w) => w.lat))) / 2;
    const lon = (Math.min(...where.map((w) => w.lon)) + Math.max(...where.map((w) => w.lon))) / 2;
    if (frame.coast) {
      // Seen from the sea (looking east): the north-south line of models runs left to right.
      ctx.cameraRig.setState({ lat, lon, altitudeKm: alt, tilt: Number(params.get('tilt') ?? 0.62), heading: Math.PI / 2 });
    } else {
      ctx.cameraRig.setState({ lat: Number(params.get('lat') ?? lat), lon: Number(params.get('lon') ?? lon), altitudeKm: alt, tilt: Number(params.get('tilt') ?? 0.55), heading: 0 });
    }
    await waitFrames(14);
    await wait(800);
    // Captions: the type, «Nivel n/max» and the pips, just under each model's drawn box (the structure card wording).
    document.getElementById('fu-levels-captions')?.remove();
    const box = document.createElement('div');
    box.id = 'fu-levels-captions';
    box.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:50;font:600 14px/1.25 "JetBrains Mono",ui-monospace,monospace;color:#f3ead8;';
    const title = document.createElement('div');
    title.textContent = t('shot.levels.real', { km: formatNumber(alt) });
    title.style.cssText = 'position:absolute;left:24px;top:18px;padding:6px 12px;background:rgba(18,16,12,.78);border:1px solid rgba(255,200,120,.35);border-radius:4px;letter-spacing:.04em;';
    box.append(title);
    placed.forEach((p, i) => {
      const sp = screenOf(ctx, where[i].lat, where[i].lon);
      const size = units?.sizeOf('struct', p.tile);
      const max = STRUCTURE_DEFS[p.type].maxLevel;
      const pips = max > 3 ? '' : ' ' + '●'.repeat(p.level) + '○'.repeat(3 - p.level);
      const cap = document.createElement('div');
      cap.textContent = `${t(`structure.${STRUCT_KEYS[p.type]}`)} · ${t('card.levelN', { n: p.level, max })}${pips}`;
      const dy = Number(params.get('capdy') ?? (size ? size.h * 0.55 + 10 : 60));
      cap.style.cssText = `position:absolute;left:${sp.x}px;top:${Math.min(sp.y + dy, innerHeight - 34)}px;transform:translateX(-50%);white-space:nowrap;padding:3px 8px;background:rgba(18,16,12,.72);border-radius:3px;`;
      box.append(cap);
    });
    document.body.append(box);
    await waitFrames(4);
  }, 10);
});

/** Structures on steep relief in the Pyrenees at 40 km (grounding, §10.7). */
async function stagePyrenees(s: ShotContext, type: S, level: number): Promise<void> {
  const { ctx, waitFrames, wait, params } = s;
  await ctx.app.startScriptedGame({ ticks: 100, speed: 0, nukes: false, autopilot: false, worldEvents: false, worldTimeSec: worldTimeForSubsolarLon(-35) });
  const sim = ctx.sim;
  sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: at(42.6, 0.6), radius: 5 });
  const lat = Number(params.get('lat') ?? 42.65), lon = Number(params.get('lon') ?? 0.65);
  sim.debug({ type: 'spawnStructure', structure: type, owner: HUMAN_ID, tile: at(lat, lon), level });
  if (type === S.Airbase) {
    for (let i = 0; i < 6; i++) sim.debug({ type: 'spawnUnit', unit: i % 3 === 0 ? U.Bomber : i % 3 === 1 ? U.FighterSquadron : U.DroneSwarm, owner: HUMAN_ID, tile: at(lat, lon), targetTile: -1 });
  }
  await wait(800);
  ctx.cameraRig.setState({ lat: lat - 0.12, lon, altitudeKm: Number(params.get('alt') ?? 40), tilt: Number(params.get('tilt') ?? 1.05), heading: Number(params.get('heading') ?? 0.3) });
  await waitFrames(14);
  await wait(800);
}

registerShot('pyr-city-40', 'units', 'A level-6 city on Pyrenean relief at 40 km: grounded on the fitted relief with its foundation pad (§10.7)', async (s) => {
  await stagePyrenees(s, S.City, 6);
}, 10);

registerShot('pyr-air-40', 'units', 'A level-3 airbase on Pyrenean relief at 40 km with its aircraft parked: grounded, nothing floats or sinks (§10.7)', async (s) => {
  await stagePyrenees(s, S.Airbase, 3);
}, 10);
