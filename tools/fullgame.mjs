// FRONT ULTRA — one full game to its natural end, through the real UI (release QA, no debug grants, no endGame).
//
// Loading -> any key -> menu -> setup (Easy, «Corta») -> «Sugerir un lugar» -> the first game days at 1x with a few
// expansions into neutral land -> 4x until the sim itself ends the game (domination, hegemony, the time limit or the
// human's defeat). A scripted player reads each auto-pause banner and resumes it after 3 s, closes dialogs it does not
// answer, and keeps pushing into free land when there is some. Then: the end screen, «Volver al menú», the menu.
//
// The only non-UI calls read state (ctx.sim.view) to choose targets and log progress, and move the camera
// (ctx.cameraRig.setState, what a player does by dragging).
//
// Usage: node tools/fullgame.mjs [--url http://127.0.0.1:5490/] [--out shots/release/fullgame] [--minutes 120]
// Exit code 0 when the game ended by itself, the menu came back and the console had no errors.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5490/';
const out = args.out || 'shots/release/fullgame';
const LIMIT_MS = Number(args.minutes || 120) * 60_000;
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
const origin = new URL(base).origin;
const foreign = [];
page.on('request', (r) => {
  const u = r.url();
  if (!u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith(origin)) foreign.push(u);
});

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s] ${m}`);
const sleep = (ms) => page.waitForTimeout(ms);
const state = () => page.evaluate(() => window.__front?.app.state ?? 'boot');
const waitState = (s, timeout) => page.waitForFunction((w) => window.__front?.app.state === w, s, { timeout, polling: 250 });
const shot = async (name) => {
  try {
    await page.screenshot({ path: path.join(out, `${name}.png`), timeout: 120000 });
    log(`  shot ${name}.png`);
  } catch (e) { log(`  (shot ${name} skipped: ${String(e.message).split('\n')[0]})`); }
};
async function clickEl(selector, timeout = 90000) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: 'visible', timeout });
  const box = await loc.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
const status = () => page.evaluate(() => {
  const v = window.__front.ctx.sim.view;
  const h = v.human;
  const ranked = v.playerList.filter((p) => p.alive && p.kind !== 'bot').sort((a, b) => b.tiles - a.tiles);
  return {
    tick: v.tick, speed: v.speed, day: Math.floor(v.tick / 240) + 1,
    tiles: h?.tiles ?? 0, troops: Math.round(h?.troops ?? 0), gold: Math.round(h?.gold ?? 0), alive: !!h?.alive,
    rank: ranked.findIndex((p) => p.id === 1) + 1, nations: ranked.length,
    leader: ranked[0] ? `${ranked[0].name} ${ranked[0].tiles}` : '',
  };
});

/** A neutral tile next to our land, a few tiles deep, and its screen point when clear of icons, units and the HUD. */
async function expandOnce() {
  const target = await page.evaluate(() => {
    const v = window.__front.ctx.sim.view;
    const W = 1600;
    const cls = (t) => v.world.terrain[t] & 0x0f;
    const cap = v.human.capitalTile;
    const cand = [];
    for (let t = W; t < v.owner.length - W; t++) {
      if (v.owner[t] !== 1) continue;
      for (const d of [-1, 1, -W, W]) {
        let m = -1;
        for (let k = 1; k <= 6; k++) {
          const q = t + d * k;
          if (v.owner[q] !== 0 || cls(q) < 2 || cls(q) > 4) break;
          m = q;
        }
        if (m >= 0 && m !== t + d) cand.push(m);
      }
    }
    if (!cand.length) return null;
    const dist = (a) => Math.hypot((a % W) - (cap % W), Math.floor(a / W) - Math.floor(cap / W));
    cand.sort((a, b) => dist(a) - dist(b));
    return cand[Math.floor(Math.random() * Math.min(cand.length, 40))];
  });
  if (target == null) return 'no free land next to us';
  const ll = await page.evaluate((t) => ({ lat: 90 - (Math.floor(t / 1600) + 0.5) * 180 / 800, lon: ((t % 1600) + 0.5) * 360 / 1600 - 180 }), target);
  await page.evaluate((ll) => window.__front.ctx.cameraRig.setState({ lat: ll.lat, lon: ll.lon, altitudeKm: 2200, tilt: 0, heading: 0 }), ll);
  await sleep(2500);
  const p = await page.evaluate(({ lat, lon }) => {
    const { ctx } = window.__front;
    const cam = ctx.camera;
    const r = ctx.globe.surfaceRadiusAt(lat, lon);
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    const v = cam.position.clone().set(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
    v.project(cam);
    const x = (v.x + 1) / 2 * innerWidth, y = (1 - v.y) / 2 * innerHeight;
    const u = ctx.units;
    for (const [dx, dy] of [[0, 0], [14, 0], [-14, 0], [0, 14], [0, -14]]) {
      if (u.pickUnit(x + dx, y + dy) >= 0 || u.pickStructure(x + dx, y + dy) >= 0 || u.pickIcon?.(x + dx, y + dy) || ctx.globe.pickIsland?.(x + dx, y + dy)) return null;
    }
    return document.elementFromPoint(x, y) === ctx.canvas ? { x, y } : null;
  }, ll);
  if (!p) return 'target not clear';
  await page.mouse.move(p.x - 5, p.y - 4);
  await page.mouse.move(p.x, p.y, { steps: 2 });
  await sleep(600);
  await page.mouse.click(p.x, p.y, { delay: 40 });
  await sleep(800);
  // A click that opened something (a card, a dialog) is closed like a player would.
  if (await page.evaluate(() => !!document.querySelector('.fu-modal-head'))) await page.locator('.fu-modal .fu-close').last().click().catch(() => {});
  return `clicked free land at ${ll.lat.toFixed(1)}, ${ll.lon.toFixed(1)}`;
}

/** Resumes an auto-pause banner after 3 s (the player read it) and closes stray dialogs. */
async function tend(speed) {
  const st = await page.evaluate(() => ({
    banner: !!document.querySelector('.fu-autopause:not(.fu-hidden)'),
    speed: window.__front.ctx.sim.view.speed,
    modal: !!document.querySelector('.fu-modal-head'),
    menu: !!document.querySelector('.fu-pause-menu:not(.fu-hidden), .fu-pausemenu:not(.fu-hidden)'),
  }));
  if (st.modal) await page.locator('.fu-modal .fu-close').last().click().catch(() => {});
  if (st.speed === 0) {
    if (st.banner) await sleep(3000);
    await page.evaluate((sp) => window.__front.app.setSpeed(sp), speed);
    return st.banner ? 'banner' : 'paused';
  }
  if (st.speed !== speed) await page.evaluate((sp) => window.__front.app.setSpeed(sp), speed);
  return '';
}

let ok = false;
let endInfo = null;
try {
  await page.goto(base, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
  log('ready');
  await page.evaluate(() => window.__front.ctx.bus.on('gameEnded', (e) => { window.__fgEnd = e; }));
  await page.keyboard.press('Enter');
  await waitState('menu', 60000);
  await sleep(2000);
  await clickEl('.fu-menu-item.is-primary:not(.fu-menu-continue)');
  await waitState('setup', 20000);
  await sleep(1000);
  await clickEl('.fu-diff--easy');
  await page.locator('.fu-setup button', { hasText: /^(Corta|Short)$/ }).first().click({ force: true });
  await sleep(500);
  const dur = await page.evaluate(() => window.__front.app.makeConfig().duration);
  log(`setup: easy, duration ${dur}`);
  await shot('00-setup');
  await clickEl('.fu-setup-start');
  await waitState('spawn', 180000);
  await sleep(2500);
  await clickEl('.fu-sp-suggest');
  await page.waitForFunction(() => window.__front.ctx.sim.view.human?.spawned, null, { timeout: 60000, polling: 250 });
  await waitState('playing', 180000);
  await sleep(2000);
  const cap = await page.evaluate(() => window.__front.ctx.sim.view.human.capitalTile);
  log(`capital founded on tile ${cap}`);
  await shot('01-start');

  // Days 1-2 at 1x: grow into free land like a careful player.
  await page.evaluate(() => window.__front.app.setSpeed(1));
  for (let i = 0; i < 4; i++) {
    log(`  expand: ${await expandOnce()}`);
    await tend(1);
    await sleep(8000);
  }
  log(`1x opening done: ${JSON.stringify(await status())}`);
  await shot('02-opening');

  // Then 4x until the sim ends the game.
  let lastLog = 0, lastExpand = Date.now(), lastShot = Date.now(), banners = 0, shotN = 3;
  while (Date.now() - t0 < LIMIT_MS) {
    const s = await state();
    if (s === 'ended') break;
    if (s !== 'playing') { await sleep(2000); continue; }
    const r = await tend(4).catch(() => '');
    if (r === 'banner') banners++;
    if (Date.now() - lastExpand > 60_000) {
      lastExpand = Date.now();
      const st = await status();
      if (st.alive && st.troops > 20_000) log(`  expand: ${await expandOnce().catch((e) => e.message)}`);
    }
    if (Date.now() - lastLog > 60_000) { lastLog = Date.now(); log(JSON.stringify(await status())); }
    if (Date.now() - lastShot > 15 * 60_000) {
      lastShot = Date.now();
      const capNow = await page.evaluate(() => window.__front.ctx.sim.view.human?.capitalTile ?? -1);
      if (capNow >= 0) await page.evaluate((t) => window.__front.ctx.cameraRig.setState({ lat: 90 - (Math.floor(t / 1600) + 0.5) * 180 / 800, lon: ((t % 1600) + 0.5) * 360 / 1600 - 180, altitudeKm: 6000, tilt: 0, heading: 0 }), capNow);
      await sleep(3000);
      await shot(`${String(shotN++).padStart(2, '0')}-progress`);
    }
    await sleep(1500);
  }
  if ((await state()) !== 'ended') throw new Error(`the game did not end within ${LIMIT_MS / 60000} minutes (${JSON.stringify(await status())})`);
  endInfo = await page.evaluate(() => {
    const v = window.__front.ctx.sim.view;
    const e = window.__fgEnd ?? {};
    const w = v.playerList.find((p) => p.id === e.winner);
    return { tick: v.tick, day: Math.floor(v.tick / 240) + 1, winner: w ? w.name : e.winner, humanWon: e.humanWon, reason: e.reason, humanTiles: v.human?.tiles ?? 0 };
  });
  log(`GAME OVER after ${banners} auto-pause banners: ${JSON.stringify(endInfo)}`);
  await sleep(6000);
  const headline = await page.evaluate(() => document.querySelector('.fu-end-top')?.innerText?.replace(/\s+/g, ' ').slice(0, 200) ?? '');
  log(`end screen: «${headline}»`);
  await shot('90-end');
  await page.locator('.fu-end-actions .fu-btn--ghost').first().click();
  await waitState('menu', 60000);
  await sleep(3000);
  await shot('91-menu');
  log('back on the menu');
  ok = true;
} catch (e) {
  errors.push(`[fullgame] ${e.message}`);
  log(`FAIL ${e.message}`);
  await shot('99-failure');
}
await browser.close();
console.log(`\nresult: ${ok ? 'PASS' : 'FAIL'}; total ${((Date.now() - t0) / 60000).toFixed(1)} min`);
console.log(`console errors: ${errors.length}`);
for (const e of errors.slice(0, 20)) console.log('   ', e.slice(0, 400));
console.log(`requests outside ${origin}: ${foreign.length}`);
process.exit(ok && !errors.length && !foreign.length ? 0 : 1);
