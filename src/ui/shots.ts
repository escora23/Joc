// FRONT ULTRA — UI shots (owner: ui). Deterministic stagers for the loading screen, menu, setup, spawn phase,
// the full mid-game HUD (selection with TAKE CONTROL, leaderboard, ticker, toasts, tutorial), the radial
// diplomacy menu, the nuclear alarm, settings, how-to-play and the end screens.

import { openHowTo, openSettings } from './dialogs';
import { getHud } from './index';
import { HUMAN_ID } from '../shared/constants';
import { tileToLatLon, worldTimeForSubsolarLon } from '../shared/geo';
import { playerName, t } from '../shared/i18n';
import { registerShot, type ShotContext } from '../shared/shots';
import { UnitType } from '../shared/types';

const sound = () => undefined;

/** Biggest AI nation (by tiles) other than the human. */
function topRival(ctx: ShotContext['ctx']): number {
  let best = 0, bt = -1;
  for (const p of ctx.sim.view.playerList) if (p.id !== HUMAN_ID && p.kind === 'nation' && p.alive && p.tiles > bt) { bt = p.tiles; best = p.id; }
  return best;
}

/** A screen point over land owned by `owner`, searched around the screen centre. */
function screenPointOf(ctx: ShotContext['ctx'], owner: number): { x: number; y: number; tile: number } | null {
  const W = window.innerWidth, H = window.innerHeight;
  for (let r = 0; r < 420; r += 12) {
    for (let a = 0; a < Math.PI * 2; a += 0.35) {
      const x = W * 0.56 + Math.cos(a) * r, y = H * 0.45 + Math.sin(a) * r * 0.7;
      const tile = ctx.globe.pickTile(x, y);
      if (tile >= 0 && ctx.sim.view.owner[tile] === owner) return { x, y, tile };
    }
  }
  return null;
}

/** A foreign nation visible on screen (the biggest one first). */
function visibleRival(ctx: ShotContext['ctx']): { id: number; x: number; y: number; tile: number } | null {
  const list = ctx.sim.view.playerList.filter((p) => p.id !== HUMAN_ID && p.kind === 'nation' && p.alive).sort((a, b) => b.tiles - a.tiles);
  for (const p of list) {
    const pt = screenPointOf(ctx, p.id);
    if (pt) return { id: p.id, ...pt };
  }
  return null;
}

registerShot('loading', 'ui', 'Cinematic loading screen frozen at ~62%', async ({ ctx, wait }) => {
  const l = ctx.ui.showLoading();
  l.setProgress(0.3, 'data.water');
  await wait(200);
  l.setProgress(0.45, 'data.countries');
  await wait(200);
  l.setProgress(0.62, 'loading.shaders');
  await wait(2600);
}, 20);

registerShot('menu', 'ui', 'Main menu over the slowly rotating Earth', async ({ wait }) => {
  await wait(2600);
}, 20);

registerShot('setup', 'ui', 'Skirmish setup screen', async ({ ctx, wait }) => {
  ctx.app.goto('setup');
  await wait(1200);
}, 20);

registerShot('settings', 'ui', 'Settings modal over the menu', async ({ wait, ctx }) => {
  await wait(800);
  openSettings(ctx, sound);
  await wait(900);
}, 10);

registerShot('howto', 'ui', 'How-to-play modal', async ({ wait }) => {
  await wait(800);
  openHowTo(sound);
  await wait(1200);
}, 10);

registerShot('spawn', 'ui', 'Spawn phase: AI nations placed and labelled, human choosing a capital (DESIGN_V2 §10.13 view)', async ({ ctx, waitFrames, wait }) => {
  // The spawn view of §10.13: Europe and Africa from 12,000 km at noon there.
  await ctx.app.startScriptedGame({ humanSpawn: null, stayInSpawn: true, worldTimeSec: worldTimeForSubsolarLon(15) });
  ctx.cameraRig.setState({ lat: 35, lon: 15, altitudeKm: 12_000, tilt: 0, heading: 0 });
  await waitFrames(20);
  // Hover the reticle over Iberia so the spawn preview marker shows up.
  const hud = getHud();
  if (hud) {
    const x = window.innerWidth * 0.43, y = window.innerHeight * 0.56;
    const tile = ctx.globe.pickTile(x, y);
    hud.shared.setHover({ button: -1, tile, lat: 0, lon: 0, unitId: -1, structureId: -1, clientX: x, clientY: y, shift: false, ctrl: false, alt: false });
  }
  await wait(1200);
});

async function stageMidgame(s: ShotContext): Promise<void> {
  const { ctx, waitFrames } = s;
  await ctx.app.startScriptedGame({ ticks: 1500, speed: 0 });
  ctx.cameraRig.setState({ lat: 44, lon: 6, altitudeKm: 4200, tilt: 0.25, heading: 0 });
  await waitFrames(10);
}

registerShot('hud', 'ui', 'Full in-game HUD mid-game (selection, leaderboard, ticker, toasts, tutorial)', async (s) => {
  const { ctx, waitFrames, wait } = s;
  await stageMidgame(s);
  const view = ctx.sim.view;
  const me = view.human!;
  const cap = me.capitalTile;
  // A controllable armored division next to the capital, selected.
  ctx.sim.debug({ type: 'spawnUnit', unit: UnitType.ArmoredDivision, owner: HUMAN_ID, tile: cap + 2, targetTile: -1 });
  const got = await Promise.race([
    ctx.bus.wait('simTick', () => [...view.units.values()].some((u) => u.owner === HUMAN_ID && u.type === UnitType.ArmoredDivision)).then(() => true),
    wait(4000).then(() => false),
  ]);
  const hud = getHud();
  if (!hud) return;
  if (got) {
    const tank = [...view.units.values()].find((u) => u.owner === HUMAN_ID && u.type === UnitType.ArmoredDivision)!;
    hud.shared.select({ kind: 'unit', id: tank.id });
  }
  const vis = visibleRival(ctx);
  const rival = vis?.id ?? topRival(ctx);
  const second = view.playerList.filter((p) => p.kind === 'nation' && p.alive && p.id !== rival).sort((a, b) => b.tiles - a.tiles)[0]?.id ?? rival;
  const rn = (id: number) => playerName(view.players[id]!, view.world);
  const capLL = tileToLatLon(cap);
  ctx.bus.emit('news', { text: t('news.detonation', { a: rn(rival), w: t('news.art.hydrogenBomb'), place: t('news.capitalOf', { name: rn(second) }) }), severity: 'critical', lat: capLL.lat, lon: capLL.lon });
  ctx.bus.emit('allianceRequested', { type: 'allianceRequested', tick: view.tick, from: second, to: HUMAN_ID });
  ctx.bus.emit('toast', { text: t('toast.underAttack', { name: rn(rival), n: '48K' }), kind: 'danger', durationMs: 60_000 });
  hud.debug.showTutorial();
  if (vis) hud.shared.setHover({ button: -1, tile: vis.tile, lat: 0, lon: 0, unitId: -1, structureId: -1, clientX: vis.x, clientY: vis.y, shift: false, ctrl: false, alt: false });
  await waitFrames(20);
  await wait(1500);
});

registerShot('radial', 'ui', 'Right-click diplomacy radial menu on a rival nation', async (s) => {
  const { ctx, wait } = s;
  await stageMidgame(s);
  const hud = getHud();
  const vis = visibleRival(ctx);
  if (hud && vis) hud.debug.openRadial(vis.x, vis.y, vis.tile);
  await wait(400);
  // Hover the ATTACK wedge so the hub shows its label and troop count.
  document.querySelector('.fu-wedge')?.dispatchEvent(new PointerEvent('pointerenter'));
  await wait(800);
});

registerShot('nuke-alarm', 'ui', 'Nuclear alarm banner: hydrogen bomb inbound on the player', async (s) => {
  const { ctx, wait } = s;
  await stageMidgame(s);
  const rival = topRival(ctx);
  const from = ctx.sim.view.players[rival]?.capitalTile ?? 0;
  const target = ctx.sim.view.human?.capitalTile ?? 0;
  ctx.sim.debug({ type: 'launchNuke', weapon: UnitType.HydrogenBomb, owner: rival, fromTile: from, targetTile: target });
  await wait(900);
  // The sim client raises 'nukeAlarm' itself; re-emit so the banner shows even if the flight was not flagged yet.
  const u = [...ctx.sim.view.units.values()].find((x) => x.type === UnitType.HydrogenBomb);
  if (u) ctx.bus.emit('nukeAlarm', { unitId: u.id, targetTile: target, etaSec: 14, weapon: UnitType.HydrogenBomb });
  await wait(1200);
});

registerShot('end', 'ui', 'Victory screen with stats, territory graph and timelapse', async ({ ctx, wait }) => {
  await ctx.app.startScriptedGame({ ticks: 1500 });
  const ended = ctx.app.state === 'ended' ? Promise.resolve() : ctx.bus.wait('appState', (e) => e.state === 'ended');
  ctx.sim.debug({ type: 'endGame', winner: HUMAN_ID, reason: 'domination' });
  await ended;
  await wait(3500);
});

registerShot('defeat', 'ui', 'Defeat screen', async ({ ctx, wait }) => {
  await ctx.app.startScriptedGame({ ticks: 1500 });
  const ended = ctx.app.state === 'ended' ? Promise.resolve() : ctx.bus.wait('appState', (e) => e.state === 'ended');
  ctx.sim.debug({ type: 'endGame', winner: topRival(ctx), reason: 'domination' });
  await ended;
  await wait(3500);
});
