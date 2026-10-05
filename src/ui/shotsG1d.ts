// FRONT ULTRA — shots of the gauntlet round 1 AI and diplomacy fixes (owner: ui). Each stager leaves the texts it read
// on window.__g1dTexts.
//
//   g1d-threat — the first tension from a stronger land neighbour: the game pauses («Amenaza de una nación más fuerte»)
//                and the alert says how many hours the warning runs.
//   g1d-peace  — a neighbour at war with us occupies part of our land, then capitulates to a third nation: the peace
//                alert says we signed nothing, why the war ended, and that the occupied tiles come back.

import { registerShot, type ShotContext } from '../shared/shots';
import { HUMAN_ID, MAP_W } from '../shared/constants';

type Texts = Record<string, unknown>;
const out = (): Texts => ((window as unknown as { __g1dTexts?: Texts }).__g1dTexts ??= {});
const text = (sel: string): string => (document.querySelector(sel) as HTMLElement | null)?.innerText ?? '';
const alertsList = () => ((window as unknown as { __fuAlerts?: { list(): { title: string; body?: string; severity: string; inFeed: boolean }[] } }).__fuAlerts?.list() ?? []);

/** The nations nearest to our capital (by capital distance, wrapping in x). */
function nearestNations(s: ShotContext): { id: number; troops: number }[] {
  const view = s.ctx.sim.view;
  const cap = view.human?.capitalTile ?? 0;
  const cx = cap % MAP_W, cy = Math.floor(cap / MAP_W);
  const d = (t: number) => {
    let dx = Math.abs((t % MAP_W) - cx);
    dx = Math.min(dx, MAP_W - dx);
    const dy = Math.floor(t / MAP_W) - cy;
    return dx * dx + dy * dy;
  };
  return view.playerList.filter((p) => p.id !== HUMAN_ID && p.kind === 'nation' && p.alive && p.capitalTile >= 0).sort((a, b) => d(a.capitalTile) - d(b.capitalTile));
}

async function start(s: ShotContext): Promise<void> {
  await s.ctx.app.startScriptedGame({ ticks: 1500, speed: 0 });
  s.ctx.cameraRig.setState({ lat: 41, lon: -2, altitudeKm: 3800, tilt: 0.2, heading: 0 });
  await s.waitFrames(10);
}

registerShot('g1d-threat', 'ui', 'Gauntlet round 1 (ai-diplomacy): the first tension from a stronger neighbour pauses the game and states the warning hours', async (s) => {
  const { ctx, wait } = s;
  await start(s);
  const n = nearestNations(s)[0];
  if (!n) return;
  ctx.settings.set({ autoPause: { ...ctx.settings.get().autoPause, threat: true } });
  ctx.sim.debug({ type: 'addTroops', playerId: n.id, amount: 2_000_000 });
  ctx.sim.setSpeed(1);
  await wait(600);
  ctx.sim.debug({ type: 'tension', from: n.id, to: HUMAN_ID, reasonKey: 'tension.weak' });
  const t0 = performance.now();
  while (performance.now() - t0 < 15_000 && !document.querySelector('.fu-autopause:not(.fu-hidden)')) await wait(200);
  await wait(800);
  const o = out();
  o.banner = text('.fu-autopause');
  o.paused = ctx.sim.view.speed === 0;
  o.alerts = alertsList().map((a) => `${a.severity}: ${a.title} — ${a.body ?? ''}`);
});

registerShot('g1d-peace', 'ui', 'Gauntlet round 1 (ai-diplomacy): an enemy that occupied our land capitulates elsewhere; the peace alert explains it and the land comes back', async (s) => {
  const { ctx, wait } = s;
  await start(s);
  const near = nearestNations(s);
  const [n, third] = near;
  if (!n || !third) return;
  const view = ctx.sim.view;
  const cap = view.human?.capitalTile ?? 0;
  ctx.settings.set({ autoPause: { ...ctx.settings.get().autoPause, warOnYou: false } });
  ctx.sim.debug({ type: 'war', a: n.id, b: HUMAN_ID, mobilizeTicks: 0, reasonKey: 'war.reason.weakNeighbour' });
  ctx.sim.debug({ type: 'war', a: third.id, b: n.id, mobilizeTicks: 0 });
  await ctx.sim.fastForward(2);
  const before = view.human?.tiles ?? 0;
  // The enemy occupies a band of our land 3 tiles off the capital.
  ctx.sim.debug({ type: 'conquer', playerId: n.id, centerTile: cap + 3, radius: 2 });
  await ctx.sim.fastForward(4);
  const occupied = view.human?.tiles ?? 0;
  ctx.sim.debug({ type: 'capitulate', loser: n.id, winner: third.id });
  await ctx.sim.fastForward(30);
  await wait(1500);
  const o = out();
  o.tiles = { before, occupied, after: view.human?.tiles ?? 0 };
  o.alerts = alertsList().map((a) => `${a.severity}: ${a.title} — ${a.body ?? ''}`);
  o.feed = [...document.querySelectorAll('.fu-alerts-list > .fu-alert')].map((e) => (e as HTMLElement).innerText);
});
