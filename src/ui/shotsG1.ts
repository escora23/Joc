// FRONT ULTRA — shots of the gauntlet round 1 UI fixes (owner: ui). Each stager leaves what it read on
// window.__g1Texts so tools/g1-verify.mjs can compare the numbers of the hover, the dialog and the panel.
//
//   g1-offensive  — our offensive across the Pyrenees: the hover on enemy land, the Guerra panel row and the offensive
//                   dialog (reinforcement) read one forecast; the dialog stays open for the picture.
//   g1-war-alerts — a war declared on us with auto-pause on, several alerts and a refused box order: the banner (one
//                   headline, one action line, its buttons on a row), the feed capped at four with «+n», the folded
//                   entry the banner tells, the advisor and ticker stepped aside, the leaderboard of nations.

import { registerShot, type ShotContext } from '../shared/shots';
import { getHud } from './index';
import { stageFrontWar } from '../render/battle/shotsFronts';
import { openOffensiveDialog } from './hud/offensiveDialog';
import { HUMAN_ID, MAP_W } from '../shared/constants';
import { UnitType } from '../shared/types';

type G1 = Record<string, unknown>;
const out = (): G1 => ((window as unknown as { __g1Texts?: G1 }).__g1Texts ??= {});
const text = (sel: string): string => (document.querySelector(sel) as HTMLElement | null)?.innerText ?? '';

/** An enemy tile just across the front from its contact vertex `k`. */
function acrossFront(s: ShotContext, enemy: number, k: number): number {
  const view = s.ctx.sim.view;
  const f = view.fronts.find((q) => (q.a === HUMAN_ID && q.b === enemy) || (q.b === HUMAN_ID && q.a === enemy));
  if (!f) return -1;
  const n = f.samples.length >> 1;
  const v = Math.max(0, Math.min(n - 1, k < 0 ? Math.floor(n / 2) : k));
  const x0 = f.samples[v * 2], y0 = f.samples[v * 2 + 1];
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const t = Math.floor(y0 + dy) * MAP_W + (((Math.floor(x0 + dx)) % MAP_W) + MAP_W) % MAP_W;
        if (view.owner[t] === enemy) return t;
      }
    }
  }
  return -1;
}

registerShot('g1-offensive', 'ui', 'Gauntlet 29a: hover, Guerra panel and offensive dialog of one front read one forecast (Pyrenees, mountain-limited)', async (s) => {
  const { ctx, wait } = s;
  const st = await stageFrontWar(s, { attacker: 'human', run: 220, minKmh: 0.5 });
  const hud = getHud();
  if (!hud) return;
  const view = ctx.sim.view;
  const a = view.attacks.find((q) => q.attacker === HUMAN_ID && q.defender === st.enemy && q.id > 0);
  const tile = a && a.contactX >= 0 ? acrossFront(s, st.enemy, -1) : acrossFront(s, st.enemy, -1);
  const o = out();
  o.attack = a ? { troops: a.troops, ratio: a.ratio, kmh: a.advanceKmh, plan: a.planKmh, state: a.state, frontage: a.frontageTiles } : null;
  // Camera over the front, the hover on enemy land across it.
  const f = st.front;
  if (f) {
    const n = f.samples.length >> 1;
    const ll = { x: f.samples[(n >> 1) * 2], y: f.samples[(n >> 1) * 2 + 1] };
    const lat = 90 - (ll.y / (MAP_W / 2)) * 180, lon = (ll.x / MAP_W) * 360 - 180;
    ctx.cameraRig.setState({ lat, lon, altitudeKm: 1800, tilt: 0.15, heading: 0 });
  }
  await s.waitFrames(10);
  hud.shared.setAttackRatio(0.5);
  hud.shared.setHover({ button: -1, tile, lat: 0, lon: 0, unitId: -1, structureId: -1, clientX: window.innerWidth * 0.5, clientY: window.innerHeight * 0.5, shift: false, ctrl: false, alt: false });
  await wait(900);
  o.hover = text('.fu-tt-action');
  if (f) ctx.bus.emit('frontSelected', { key: f.key, fly: false });
  await wait(1200);
  o.panel = [...document.querySelectorAll('.fu-war-own')].map((e) => (e as HTMLElement).innerText).filter((x) => x.includes(':')).slice(0, 3);
  openOffensiveDialog(hud.shared, st.enemy, tile, { sendTroops: true });
  await wait(1200);
  o.dialog = text('.fu-offdlg');
});

registerShot('g1-war-alerts', 'ui', 'Gauntlet items 3 and 7: auto-pause banner, feed capped at four, folded entries, leaderboard of nations', async (s) => {
  const { ctx, wait } = s;
  await ctx.app.startScriptedGame({ ticks: 1500, speed: 0 });
  ctx.cameraRig.setState({ lat: 44, lon: 6, altitudeKm: 4200, tilt: 0.25, heading: 0 });
  await s.waitFrames(10);
  const hud = getHud();
  if (!hud) return;
  const view = ctx.sim.view;
  hud.debug.showTutorial('expand');
  const nations = view.playerList.filter((p) => p.id !== HUMAN_ID && p.kind === 'nation' && p.alive).sort((a, b) => b.tiles - a.tiles);
  // Some ordinary news first (they fold to one line after a few seconds).
  for (let i = 0; i < 4; i++) ctx.bus.emit('toast', { text: `Aviso de prueba ${i + 1}: un informe rutinario del Estado Mayor`, kind: 'info', durationMs: 60_000 });
  // A box order that every unit refuses (divisions sent into the sea): one folded line, not a card per unit.
  const cap = view.human?.capitalTile ?? 0;
  for (let k = 0; k < 4; k++) ctx.sim.debug({ type: 'spawnUnit', unit: UnitType.ArmoredDivision, owner: HUMAN_ID, tile: cap + k, targetTile: -1 });
  await ctx.sim.fastForward(2);
  const ids = [...view.units.values()].filter((u) => u.owner === HUMAN_ID && u.type === UnitType.ArmoredDivision).map((u) => u.id);
  let sea = -1;
  for (let i = 1; i < 400 && sea < 0; i++) if (view.world && (view.world.terrain[cap + i] & 0x0f) <= 1) sea = cap + i;
  // The acks of a box order every unit refused (as the sim answers a box of divisions sent into the sea: one command per
  // group, possibly several in one tick): the UI must tell them in ONE line.
  for (const id of ids) {
    ctx.bus.emit('orderAck', { type: 'orderAck', tick: view.tick, owner: HUMAN_ID, order: 'move', unitIds: [id], accepted: [], tile: sea, errorKey: 'order.err.divisionWater', refusedKey: 'order.err.divisionWater' } as never);
  }
  await ctx.sim.fastForward(2);
  await wait(600);
  // The war declared on us, with its auto-pause.
  ctx.settings.set({ autoPause: { ...ctx.settings.get().autoPause, warOnYou: true } });
  ctx.sim.setSpeed(1);
  ctx.sim.debug({ type: 'war', a: nations[0].id, b: HUMAN_ID, mobilizeTicks: 240 });
  const t0 = performance.now();
  while (performance.now() - t0 < 20_000 && !document.querySelector('.fu-autopause:not(.fu-hidden)')) await wait(200);
  await wait(1500);
  const o = out();
  o.banner = text('.fu-autopause');
  o.bannerBox = (() => {
    const r = document.querySelector('.fu-autopause')?.getBoundingClientRect();
    return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
  })();
  o.feedVisible = [...document.querySelectorAll('.fu-alerts-list > .fu-alert:not(.is-over)')].map((e) => (e as HTMLElement).innerText.split('\n')[0]);
  o.feedFolded = document.querySelectorAll('.fu-alerts-list > .fu-alert.is-folded:not(.is-over)').length;
  o.more = text('.fu-alerts-more');
  o.alerts = ((window as unknown as { __fuAlerts?: { list(): { title: string; severity: string; inFeed: boolean }[] } }).__fuAlerts?.list() ?? []).map((a) => `${a.severity}${a.inFeed ? '' : ' (gone)'}: ${a.title}`);
  o.units = ids.length;
  o.sea = sea;
  o.advisorShown = !!document.querySelector('.fu-tut:not(.fu-hidden)') && getComputedStyle(document.querySelector('.fu-tut')!).display !== 'none';
  o.leaderboard = [...document.querySelectorAll('.fu-lb-row')].filter((e) => (e as HTMLElement).style.display !== 'none').map((e) => (e as HTMLElement).innerText.replace(/\n/g, ' '));
  o.rank = text('.fu-tb-rank') || text('[class*="rank"]');
});

/**
 * App-integration gauntlet (29a in real play): the critic's case, the staged Spain–Switzerland war (f3-missions'
 * stage) run on for `&run=` ticks at 1x, then at ONE moment the hover across our offensive's contact, the Guerra
 * panel row and the reinforcement dialog are read. All three must name the same ratio, width and speed.
 */
registerShot('g1-offensive-swiss', 'ui', 'Gauntlet 29a: one forecast for hover, Guerra panel and dialog on the staged Swiss war after it ran at 1x', async (s) => {
  const { ctx, wait, params } = s;
  const { stageWar } = await import('./shotsF3');
  const enemy = await stageWar(s, Number(params.get('run') ?? 120));
  const hud = getHud();
  if (!hud) return;
  const view = ctx.sim.view;
  const a = view.attacks.find((q) => q.attacker === HUMAN_ID && q.defender === enemy && q.id > 0 && !q.naval);
  const o = out();
  o.attack = a ? { troops: Math.round(a.troops), ratio: a.ratio, kmh: a.advanceKmh, state: a.state, frontage: a.frontageTiles, breakthrough: (a as unknown as { breakthrough?: boolean }).breakthrough ?? null } : null;
  // The enemy tile just across our offensive's contact (where a player would point to reinforce it).
  let tile = -1;
  if (a && a.contactX >= 0) {
    for (let r = 1; r <= 5 && tile < 0; r++) {
      for (let dy = -r; dy <= r && tile < 0; dy++) {
        for (let dx = -r; dx <= r && tile < 0; dx++) {
          const tt = Math.floor(a.contactY + dy) * MAP_W + ((Math.floor(a.contactX + dx) % MAP_W) + MAP_W) % MAP_W;
          if (view.owner[tt] === enemy) tile = tt;
        }
      }
    }
  }
  if (tile < 0) tile = acrossFront(s, enemy, -1);
  const lat = 90 - ((Math.floor(tile / MAP_W) + 0.5) / (MAP_W / 2)) * 180, lon = (((tile % MAP_W) + 0.5) / MAP_W) * 360 - 180;
  ctx.cameraRig.setState({ lat, lon, altitudeKm: 1400, tilt: 0.2, heading: 0 });
  await s.waitFrames(8);
  hud.shared.setAttackRatio(0.5);
  hud.shared.setHover({ button: -1, tile, lat, lon, unitId: -1, structureId: -1, clientX: window.innerWidth * 0.5, clientY: window.innerHeight * 0.5, shift: false, ctrl: false, alt: false });
  await wait(900);
  o.hover = text('.fu-tt-action');
  if (a) ctx.bus.emit('frontSelected', { key: a.frontKey, fly: false });
  await wait(1200);
  o.panel = [...document.querySelectorAll('.fu-war-own')].map((e) => (e as HTMLElement).innerText).filter((x) => x.includes(':')).slice(0, 3);
  openOffensiveDialog(hud.shared, enemy, tile, { sendTroops: true });
  await wait(1200);
  o.dialog = text('.fu-offdlg');
});
