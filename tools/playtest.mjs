// FRONT ULTRA — automated end-to-end playthrough (owner: app; stage-2 flow by W3, DESIGN_V2 §16.4 row J01).
// Drives the REAL game like a player, through the actual UI.
//
// Stage 2 (the v2 loop): loading -> "press any key" -> main menu -> skirmish setup (Easy) -> the spawn phase waits for
// the human and explains a click on a nation's land -> spawn click -> expansion -> a city -> a proposal from the
// nations drawer («estudiando…», then an answer with reasons) -> a war declared through the §4.2 dialog -> a nation
// declares war on us (critical alert, minimap ping, globe marker, warHorn, auto-pause banner) -> [Reanudar] -> click
// the alert and the camera flies there -> Guardar from the pause menu, quit, «Continuar» restores the game.
// Extended (skipped with --stage2): every other structure, the arsenal, both nukes, attacks, command mode, a transport
// invasion, the radial's proposal, pause/resume and the end screen.
//
// Every step is survivable (a failure is recorded, the run goes on), bounded to 240 s, and takes its screenshots
// inside the step. The only non-UI calls are (a) moving the camera (ctx.cameraRig.setState — what a player does by
// dragging), (b) reading ctx.sim.view to choose valid targets and verify results, (c) gold/troop/land grants through
// the sim's debug actions so a short test survives the AI, (d) the staged AI declaration on the human (debug `war`),
// and (e) the final `endGame` debug action.
//
// Usage: node tools/playtest.mjs [--url http://127.0.0.1:5190/] [--out shots/playtest] [--stage2]
// Exit code 0 when every step passed and the console had no errors.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5190/';
const out = args.out || 'shots/playtest';
const W = Number(args.w || 1600), H = Number(args.h || 900);
fs.mkdirSync(out, { recursive: true });

// Same launch flags as tools/capture.mjs.
const browser = await chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
const warnings = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
  else if (m.type() === 'warning') warnings.push(m.text());
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

const t0 = Date.now();
const results = [];
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${msg}`);
const sleep = (ms) => page.waitForTimeout(ms);
const state = () => page.evaluate(() => window.__front?.app.state ?? 'boot');
const waitState = (s, timeout = 120000) => page.waitForFunction((want) => window.__front?.app.state === want, s, { timeout, polling: 250 });
/** Screenshots never fail a step: the software renderer can take a long time on a busy frame. */
const shot = async (name) => {
  try {
    await page.screenshot({ path: path.join(out, `${name}.png`), timeout: 90000 });
    log(`  shot ${name}.png`);
  } catch (err) {
    log(`  (shot ${name} skipped: ${String(err.message).split('\n')[0]})`);
  }
};
/** Polls fn() in the page until truthy; returns its value, or null on timeout. */
async function until(fn, arg, timeout = 30000, poll = 400) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await page.evaluate(fn, arg).catch(() => null);
    if (v) return v;
    await sleep(poll);
  }
  return null;
}
const stopAfter = Number(args.steps || 1e9);
/** Only the stage-2 steps (DESIGN_V2 §16.4 row J01): spawn, expansion, city, proposal, war via the dialog, auto-pause,
 * alert click-to-fly, save/continue. Without it the v1 feature tour (every structure, nukes, command mode, invasion,
 * radial, end screen) runs afterwards as "extended" steps. */
const STAGE2_ONLY = args.stage2 === 'true';
const STEP_TIMEOUT_MS = 240_000;
let stage = 'stage2';
/**
 * One step: survivable (a failure is recorded and the run goes on), bounded (240 s), and its screenshots are taken
 * inside it so a failing shot cannot abort the run.
 */
async function step(name, fn) {
  if (results.length >= stopAfter) throw new Error('stopped (--steps)');
  const s = Date.now();
  log(`STEP ${name}`);
  let timer = null;
  try {
    if (results.length >= 7) {
      await resetUi();
      await reinforce();
    }
    const detail = await Promise.race([
      fn(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout after ${STEP_TIMEOUT_MS / 1000} s`)), STEP_TIMEOUT_MS); }),
    ]);
    results.push({ name, stage, ok: true, detail: detail ?? '', sec: (Date.now() - s) / 1000 });
    log(`  ok ${detail ?? ''}`);
    return true;
  } catch (err) {
    results.push({ name, stage, ok: false, detail: String(err?.message ?? err).split('\n')[0], sec: (Date.now() - s) / 1000 });
    log(`  FAIL ${err?.message ?? err}`);
    const recent = await page.evaluate(() => (window.__pt?.events ?? []).filter((e) => e.attacker === 1 || e.owner === 1 || e.playerId === 1 || e.from === 1).slice(-8)).catch(() => []);
    for (const e of recent) log(`     recent: ${JSON.stringify(e).slice(0, 220)}`);
    await shot(`fail-${name.replace(/[^a-z0-9]+/gi, '-')}`).catch(() => {});
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const check = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// In-page helpers: event recorder, projection, target finders. Installed once the app exists.
async function installHelpers() {
  await page.evaluate(() => {
    const { ctx } = window.__front;
    const MAP_W = 1600, MAP_H = 800;
    const pt = {
      events: [],
      counts: {},
      tileLL(tile) {
        const x = tile % MAP_W, y = Math.floor(tile / MAP_W);
        return { lat: 90 - ((y + 0.5) / MAP_H) * 180, lon: ((x + 0.5) / MAP_W) * 360 - 180 };
      },
      tileOf(lat, lon) {
        const x = Math.floor(((lon + 180) / 360) * MAP_W) % MAP_W;
        const y = Math.min(MAP_H - 1, Math.max(0, Math.floor(((90 - lat) / 180) * MAP_H)));
        return y * MAP_W + x;
      },
      project(lat, lon) {
        const cam = ctx.camera;
        const r = ctx.globe.surfaceRadiusAt(lat, lon);
        const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
        const p = cam.position.clone().set(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
        const toCam = cam.position.clone().sub(p);
        const facing = toCam.dot(p) > 0;
        p.project(cam);
        const x = ((p.x + 1) / 2) * innerWidth, y = ((1 - p.y) / 2) * innerHeight;
        return { x, y, ok: facing && p.z < 1 && x > 20 && x < innerWidth - 20 && y > 20 && y < innerHeight - 20 };
      },
      dist(a, b) {
        let dx = Math.abs((a % MAP_W) - (b % MAP_W));
        if (dx > MAP_W / 2) dx = MAP_W - dx;
        const dy = Math.floor(a / MAP_W) - Math.floor(b / MAP_W);
        return Math.hypot(dx, dy);
      },
      navigable(tile) {
        return (ctx.sim.view.world.terrain[tile] & 0x20) !== 0;
      },
      playable(tile) {
        const cls = ctx.sim.view.world.terrain[tile] & 0x0f;
        return cls >= 2 && cls <= 4;
      },
      coastal(tile) {
        // Same rule as the sim: 4-adjacent to navigable open water.
        const x = tile % MAP_W, y = Math.floor(tile / MAP_W);
        const nav = (t) => pt.navigable(t) && (ctx.sim.view.world.terrain[t] & 0x0f) <= 1;
        return nav(y * MAP_W + ((x + MAP_W - 1) % MAP_W)) || nav(y * MAP_W + ((x + 1) % MAP_W)) || (y > 0 && nav(tile - MAP_W)) || (y < MAP_H - 1 && nav(tile + MAP_W));
      },
      humanTiles() {
        const o = ctx.sim.view.owner, list = [];
        for (let i = 0; i < o.length; i++) if (o[i] === 1) list.push(i);
        return list;
      },
      /** A tile where a structure can go (own land, spacing, coast), as close to the capital as possible. */
      buildTile(coastalNeeded, skip) {
        const view = ctx.sim.view;
        const cap = view.human.capitalTile;
        const tiles = pt.humanTiles().filter((t) => !skip.includes(t) && pt.playable(t) && (!coastalNeeded || pt.coastal(t)));
        tiles.sort((a, b) => pt.dist(a, cap) - pt.dist(b, cap));
        const structs = [...view.structures.values()];
        const scars = view.scars;
        for (const t of tiles) {
          if (!coastalNeeded) {
            // Interior tiles (8 neighbours ours) so a border shift during the click cannot invalidate it.
            let interior = true;
            const x = t % MAP_W, y = Math.floor(t / MAP_W);
            for (let dy = -1; dy <= 1 && interior; dy++) for (let dx = -1; dx <= 1; dx++) {
              if (view.owner[(y + dy) * MAP_W + ((x + dx + MAP_W) % MAP_W)] !== 1) { interior = false; break; }
            }
            if (!interior) continue;
          }
          const x = (t % MAP_W) + 0.5, y = Math.floor(t / MAP_W) + 0.5;
          if (scars.some((s) => s.strength > 0.05 && (s.x - x) ** 2 + (s.y - y) ** 2 < s.radius * s.radius)) continue;
          if (structs.every((s) => pt.dist(s.tile, t) >= 4.3)) return t;
        }
        return -1;
      },
      record(type, p) {
        pt.counts[type] = (pt.counts[type] ?? 0) + 1;
        if (pt.events.length >= 30000) return;
        let copy = {};
        if (p && typeof p === 'object' && !ArrayBuffer.isView(p)) {
          try { copy = JSON.parse(JSON.stringify(p, (k, v) => (ArrayBuffer.isView(v) || (k === 'params' && typeof v === 'object' && v && 'quality' in v) ? undefined : v))); } catch { copy = {}; }
        }
        pt.events.push({ ...copy, type });
      },
      last(type, pred, n0) {
        const l = pt.events.filter((e) => e.type === type && (!pred || pred(e)));
        return l.length > (n0 ?? -1) ? l[l.length - 1] ?? null : null;
      },
      count(type, pred) {
        return pt.events.filter((e) => e.type === type && (!pred || pred(e))).length;
      },
    };
    const SKIP = new Set(['simTick', 'tilesChanged', 'cameraMoved', 'worldHover', 'combat', 'uiSound', 'resize', 'goldBonus', 'tradeCompleted', 'unitSpawned', 'unitDestroyed', 'emote']);
    const orig = ctx.bus.emit.bind(ctx.bus);
    ctx.bus.emit = (type, payload) => {
      if (SKIP.has(type)) pt.counts[type] = (pt.counts[type] ?? 0) + 1;
      else pt.record(type, payload);
      orig(type, payload);
    };
    ctx.bus.on('worldHover', (e) => { window.__lastHover = e.tile; });
    window.__pt = pt;
  });
}

/** Points the camera at lat/lon (what a player does by dragging) and waits a few frames for matrices. */
async function lookAt(lat, lon, altitudeKm, tilt = 0) {
  await page.evaluate(({ lat, lon, altitudeKm, tilt }) => window.__front.ctx.cameraRig.setState({ lat, lon, altitudeKm, tilt, heading: 0 }), { lat, lon, altitudeKm, tilt });
  const f0 = await page.evaluate(() => window.__front.ctx.frame.frame);
  await page.waitForFunction((f) => window.__front.ctx.frame.frame >= f + 3, f0, { timeout: 60000, polling: 100 });
}
const tileLL = (tile) => page.evaluate((t) => window.__pt.tileLL(t), tile);
async function screenOfTile(tile) {
  return page.evaluate((t) => { const ll = window.__pt.tileLL(t); return window.__pt.project(ll.lat, ll.lon); }, tile);
}
/** Moves the mouse onto a tile and waits for the UI hover to resolve to it (±1.5 tiles). */
async function hoverTile(tile) {
  const p = await screenOfTile(tile);
  check(p.ok, `tile ${tile} not on screen`);
  await page.mouse.move(p.x - 4, p.y - 3);
  await page.mouse.move(p.x, p.y, { steps: 2 });
  await until((t) => window.__lastHover !== undefined && window.__lastHover >= 0 && window.__pt.dist(window.__lastHover, t) <= 1.5, tile, 8000, 150);
  return p;
}
async function clickTile(tile, button = 'left') {
  const p = await hoverTile(tile);
  await page.mouse.click(p.x, p.y, { button, delay: 40 });
  return p;
}
/** Returns the HUD to a neutral state like a player would: close dialogs, cancel a pending build/target mode. */
async function resetUi() {
  for (let i = 0; i < 3; i++) {
    const st = await page.evaluate(() => ({
      modal: !!document.querySelector('.fu-modal-head'),
      chip: !!document.querySelector('.fu-chip:not(.fu-hidden)'),
      radial: !!document.querySelector('.fu-radial:not(.fu-hidden)'),
      nations: !!document.querySelector('.fu-nations:not(.fu-hidden)'),
    }));
    if (st.modal) await page.locator('.fu-modal .fu-close').last().click().catch(() => {});
    else if (st.nations) await page.locator('.fu-nations .fu-close').click().catch(() => {});
    else if (st.chip || st.radial) await page.keyboard.press('Escape');
    else return;
    await sleep(400);
  }
}
/** Debug top-up between scripted actions so the short test survives the AI at 4x (see header). */
let landGrants = 0;
const reinforce = () => page.evaluate(() => {
  const s = window.__front.ctx.sim;
  if (!s.view.human?.alive) return false;
  let granted = false;
  const home = s.view.human.capitalTile >= 0 && s.view.owner[s.view.human.capitalTile] === 1 ? s.view.human.capitalTile : window.__ptHome;
  if (s.view.human.tiles < 400 && home >= 0) {
    // A passive scripted player gets overrun; give it back a foothold so the remaining features can be exercised.
    s.debug({ type: 'conquer', playerId: 1, centerTile: home, radius: 14 });
    granted = true;
  }
  s.debug({ type: 'addTroops', playerId: 1, amount: Math.max(0, s.view.human.maxTroops - s.view.human.troops) });
  if (s.view.human.gold < 20_000_000) s.debug({ type: 'addGold', playerId: 1, amount: 30_000_000 });
  return granted;
}).then((g) => { if (g) { landGrants++; log('  (emergency land grant: the human had < 400 tiles)'); } });
const humanStats = () => page.evaluate(() => {
  const h = window.__front.ctx.sim.view.human;
  return h ? { tiles: h.tiles, troops: Math.round(h.troops), gold: Math.round(h.gold), alive: h.alive } : null;
});
const lastEvent = (type, predSrc, n0, timeout = 15000) =>
  until(({ type, predSrc, n0 }) => window.__pt.last(type, predSrc ? new Function('e', `return ${predSrc}`) : null, n0), { type, predSrc, n0 }, timeout, 300);
const countEvents = (type, predSrc) => page.evaluate(({ type, predSrc }) => window.__pt.count(type, predSrc ? new Function('e', `return ${predSrc}`) : null), { type, predSrc });

// =================================================================================================
try {
  await step('boot + loading screen', async () => {
    await page.goto(base, { waitUntil: 'load', timeout: 120000 });
    await sleep(2500);
    await shot('00-loading');
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
    await installHelpers();
    return `ready after ${((Date.now() - t0) / 1000).toFixed(0)}s`;
  });

  await step('press any key -> menu', async () => {
    await page.keyboard.press('Enter');
    await waitState('menu', 60000);
    await sleep(3500);
    await shot('01-menu');
    const audio = await page.evaluate(() => window.__fuAudio?.stats?.() ?? null);
    return audio ? `audio context ${audio.state ?? audio.context ?? '?'}, mood ${audio.mood ?? '?'}` : '';
  });

  await step('menu -> setup', async () => {
    await page.locator('.fu-menu-item.is-primary:not(.fu-menu-continue)').first().click();
    await waitState('setup', 20000);
    await sleep(1500);
    await shot('02-setup');
  });

  await step('setup: Easy difficulty -> START -> spawn phase', async () => {
    await page.locator('.fu-diff--easy').click();
    await sleep(300);
    await page.locator('.fu-setup-start').click();
    await waitState('spawn', 120000);
    await sleep(2000);
    const n = await page.evaluate(() => window.__front.ctx.sim.view.playerList.filter((p) => p.spawned).length);
    check(n > 5, `only ${n} spawned players`);
    return `${n} players spawned`;
  });

  await step('spawn waits for the human; a click on a nation\'s land is explained', async () => {
    // Single player: nothing runs until the capital is placed (§12.6).
    const tick0 = await page.evaluate(() => window.__front.ctx.sim.view.tick);
    await sleep(6000);
    const st = await page.evaluate(() => ({ state: window.__front.app.state, spawned: !!window.__front.ctx.sim.view.human?.spawned, tick: window.__front.ctx.sim.view.tick, suggest: !!document.querySelector('.fu-sp-suggest') }));
    check(st.state === 'spawn' && !st.spawned, `spawn phase did not wait (${JSON.stringify(st)})`);
    check(st.suggest, 'no «Sugerir un lugar» button in the spawn briefing');
    // A click on an AI nation's land: refused with a toast that says whose land it is.
    const ai = await page.evaluate(() => {
      const v = window.__front.ctx.sim.view;
      // The biggest nation; the owned tile nearest its label, in the middle of its land (8 neighbours its own).
      const p = v.playerList.filter((q) => q.kind === 'nation' && q.id !== 1 && q.tiles > 20).sort((a, b) => b.tiles - a.tiles)[0];
      if (!p) return null;
      let best = -1, bd = Infinity;
      for (let t = 1600; t < v.owner.length - 1600; t++) {
        if (v.owner[t] !== p.id) continue;
        if (v.owner[t - 1] !== p.id || v.owner[t + 1] !== p.id || v.owner[t - 1600] !== p.id || v.owner[t + 1600] !== p.id) continue;
        const d = Math.hypot((t % 1600) - p.labelX, Math.floor(t / 1600) - p.labelY);
        if (d < bd) { bd = d; best = t; }
      }
      return best >= 0 ? { id: p.id, tile: best } : null;
    });
    check(ai, 'no AI land to click');
    const ll = await tileLL(ai.tile);
    await lookAt(ll.lat, ll.lon, 5000);
    await sleep(1500);
    const n0 = await countEvents('toast');
    await clickTile(ai.tile);
    const toast = await lastEvent('toast', null, n0, 8000);
    check(toast && /\S/.test(toast.text ?? ''), 'no explanatory toast after clicking AI land');
    check(await page.evaluate(() => !window.__front.ctx.sim.view.human?.spawned), 'the human spawned on AI land');
    await shot('03a-spawn-refused');
    return `waited ${((st.tick - tick0))} ticks while unplaced; toast: «${toast.text.slice(0, 90)}»`;
  });


  await step('spawn: click on free land to found the capital', async () => {
    // Coastal Mediterranean candidates: neighbours by land and by sea, room to build.
    const cands = [[39.6, -0.6], [41.8, 2.4], [43.6, 4.2], [40.6, 16.4], [37.5, 14.2], [38.0, -4.5], [44.5, 0.5], [42.5, 12.8], [36.8, 10.0], [45.5, 9.5], [42.0, 19.5], [37.5, 22.0], [38.5, 27.5], [36.5, 3.0], [35.5, -5.5], [47.0, 2.5], [44.0, 22.0], [33.5, 3.0]];
    const tile = await page.evaluate((cands) => {
      // Like a sensible player: free land, as far as possible from every AI capital already placed.
      const v = window.__front.ctx.sim.view;
      const caps = v.playerList.filter((p) => p.id !== 1 && p.capitalTile >= 0).map((p) => p.capitalTile);
      let best = -1, bd = -1;
      for (const [lat, lon] of cands) {
        const t = window.__pt.tileOf(lat, lon);
        let free = true;
        const x = t % 1600, y = Math.floor(t / 1600);
        for (let dy = -6; dy <= 6 && free; dy++) for (let dx = -6; dx <= 6; dx++) if (v.owner[(y + dy) * 1600 + x + dx] !== 0) { free = false; break; }
        if (!free || !window.__pt.playable(t)) continue;
        const d = Math.min(...caps.map((c) => window.__pt.dist(c, t)));
        if (d > bd) { bd = d; best = t; }
      }
      return best;
    }, cands);
    check(tile >= 0, 'no free candidate spawn tile');
    const ll = await tileLL(tile);
    await lookAt(ll.lat, ll.lon, 5000);
    await sleep(2500);
    await shot('03-spawn');
    for (let i = 0; i < 4 && (await state()) === 'spawn'; i++) {
      await clickTile(tile);
      if (await until(() => window.__front.ctx.sim.view.human?.spawned, null, 15000)) break;
    }
    const cap = await page.evaluate(() => (window.__ptHome = window.__front.ctx.sim.view.human?.capitalTile ?? -1));
    check(cap >= 0, 'human did not spawn');
    await waitState('playing', 120000);
    await sleep(2500);
    return `capital tile ${cap} (${ll.lat.toFixed(1)}, ${ll.lon.toFixed(1)})`;
  });

  await step('expand into neutral land (25%, then 60% via the slider)', async () => {
    const cap = await page.evaluate(() => window.__pt.tileLL(window.__front.ctx.sim.view.human.capitalTile));
    await lookAt(cap.lat, cap.lon, 2200);
    const findNeutral = (minD) => page.evaluate((minD) => {
      const v = window.__front.ctx.sim.view, pt = window.__pt;
      const mine = pt.humanTiles();
      // Neutral land touching our border, farthest from the capital first (grow outward).
      const cap = v.human.capitalTile;
      let best = -1, bd = -1;
      for (const t of mine) for (const n of [t - 1, t + 1, t - 1600, t + 1600, t - 2, t + 2, t - 3200, t + 3200]) {
        if (v.owner[n] !== 0 || !pt.playable(n)) continue;
        const d = pt.dist(n, cap) + Math.random() * 6;
        if (d > minD && d > bd) { bd = d; best = n; }
      }
      return best;
    }, minD);
    const details = [];
    for (const [i, ratio] of [[0, '25'], [1, '60'], [2, '60'], [3, '60']]) {
      if (ratio === '25') await page.locator('.fu-ar-tick', { hasText: /^25$/ }).click();
      else await page.locator('.fu-ar input[type=range]').fill(ratio);
      const target = await findNeutral(2);
      if (target < 0) break;
      const ll = await tileLL(target);
      await lookAt(ll.lat, ll.lon, 2200);
      const n0 = await countEvents('attackStarted', 'e.attacker === 1');
      const troops0 = (await humanStats()).troops;
      await clickTile(target);
      const ev = await lastEvent('attackStarted', 'e.attacker === 1 && e.defender === 0', n0, 12000);
      if (i === 0) check(ev, 'no attackStarted into neutral land');
      if (ev) details.push(`${ratio}%: ${ev.troops}/${troops0}`);
      await sleep(2500);
    }
    await until(() => (window.__front.ctx.sim.view.human?.tiles ?? 0) > 260, null, 45000, 1000);
    const st = await humanStats();
    return `${details.join(', ')} -> ${st.tiles} tiles`;
  });

  await step('speed 4x (+ key), then 1x (button)', async () => {
    await page.keyboard.press('Equal');
    await sleep(250);
    await page.keyboard.press('Equal');
    const sp = await until(() => window.__front.ctx.sim.view.speed === 4, null, 10000);
    check(sp, `speed is ${await page.evaluate(() => window.__front.ctx.sim.view.speed)}`);
    await sleep(3000);
    await shot('04-speed-4x');
    // The headless harness acts ~10x slower than a player (software WebGL), so the scripted actions run at 1x
    // (the 1x button) to keep the game clock in step with what a player would do in the same number of moves.
    await page.locator('.fu-time-seg button').nth(2).click(); // [pause, 0.5x, 1x, 2x, 4x]
    check(await until(() => window.__front.ctx.sim.view.speed === 1, null, 10000), '1x button did not work');
    // Short test on a slow software renderer: grant the treasury the arsenal needs, troops, and a ring of land
    // around the capital (debug actions, like the scripted shots' head start) so ten structures fit.
    await page.evaluate(() => {
      const s = window.__front.ctx.sim;
      const cap = s.view.human.capitalTile;
      s.debug({ type: 'conquer', playerId: 1, centerTile: cap, radius: 28 });
      s.debug({ type: 'addGold', playerId: 1, amount: 60_000_000 });
      s.debug({ type: 'addTroops', playerId: 1, amount: 400_000 });
    });
    await until(() => window.__front.ctx.sim.view.human.tiles > 300, null, 15000);
    return JSON.stringify(await humanStats());
  });

  // ---------------------------------------------------------------------------------------------- build (city)
  const STRUCTS = [
    ['1', 0, 'City', false], ['2', 1, 'Port', true], ['3', 2, 'Factory', false], ['4', 3, 'DefensePost', false],
    ['5', 4, 'SamSite', false], ['6', 5, 'MissileSilo', false], ['7', 6, 'Airbase', false], ['8', 7, 'ArmyBase', false],
    ['9', 8, 'NavalYard', true], ['0', 9, 'Radar', false],
  ];
  const buildStep = (key, type, name, coastal) => step(`build ${name} (key ${key})`, async () => {
    const skip = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const tile = await page.evaluate(({ coastal, skip }) => window.__pt.buildTile(coastal, skip), { coastal, skip });
      check(tile >= 0, 'no valid build tile in our territory');
      skip.push(tile);
      const ll = await tileLL(tile);
      await lookAt(ll.lat, ll.lon, 900);
      const before = await page.evaluate((type) => [...window.__front.ctx.sim.view.structures.values()].filter((s) => s.owner === 1 && s.type === type).length, type);
      await hoverTile(tile);
      await page.keyboard.press(key);
      await sleep(300);
      await clickTile(tile);
      const ok = await until(({ type, before }) => [...window.__front.ctx.sim.view.structures.values()].filter((s) => s.owner === 1 && s.type === type).length > before, { type, before }, 12000);
      if (ok) return `tile ${tile} (attempt ${attempt + 1})`;
      await resetUi();
    }
    throw new Error('structure never appeared');
  });
  await buildStep(...STRUCTS[0]);

  // ---------------------------------------------------------------------------------------------- diplomacy: proposal
  /** Player-facing text must never show a raw key, a missing parameter or a gendered «(a)» (acceptance 18). */
  const BAD_TEXT = /\(a\)|\{[a-zA-Z]+\}|\b[a-z]+\.[a-z]+[A-Za-z.]*\b/;
  await step('proposal from the nations drawer (N): «estudiando…» at once, then an answer with reasons', async () => {
    await resetUi();
    await page.keyboard.press('n');
    await page.waitForSelector('.fu-nations:not(.fu-hidden) .fu-nt-row', { timeout: 20000 });
    await sleep(800);
    await shot('14a-nations');
    const rows = page.locator('.fu-nations .fu-nt-row');
    const nRows = await rows.count();
    let sent = null;
    for (let i = 0; i < Math.min(nRows, 10) && !sent; i++) {
      await rows.nth(i).click();
      await sleep(900);
      // First proposal button that is shown and enabled (alliance, else NAP, trade, open borders), with 5 % of the
      // treasury as a sweetener.
      const btn = page.locator('.fu-nd-actions .fu-nd-grid').first().locator('button:not(.fu-hidden):not(.is-disabled)').first();
      if (!(await btn.count())) {
        await page.locator('.fu-nd-top .fu-btn').first().click();
        await sleep(500);
        continue;
      }
      await page.locator('.fu-goldfield button').nth(1).click().catch(() => {});
      await sleep(300);
      const p0 = await page.evaluate(() => Math.max(0, ...[...window.__front.ctx.sim.view.proposals.values()].map((p) => p.id)));
      await btn.click();
      sent = await until((p0) => [...window.__front.ctx.sim.view.proposals.values()].find((p) => p.from === 1 && p.id > p0) ?? null, p0, 10000, 200);
      if (!sent) {
        await page.locator('.fu-nd-top .fu-btn').first().click();
        await sleep(500);
      }
    }
    check(sent, 'no proposal was sent from the nations drawer');
    // «X está estudiando tu propuesta…» as a feed entry right away.
    const studying = await until((id) => window.__fuAlerts.list().find((a) => a.groupKey === `prop:${id}` && a.kind === 'proposalSent') ?? null, sent.id, 6000, 200);
    check(studying && /estudiando|considering/.test(studying.title), `no «estudiando» alert (${JSON.stringify(studying)})`);
    await shot('14b-proposal-studying');
    // The answer: 120–240 ticks later, one sentence with at least one reason.
    const ans = await until((id) => {
      const p = window.__front.ctx.sim.view.proposals.get(id);
      if (!p || p.status === 'considering' || p.status === 'pending') return null;
      const a = window.__fuAlerts.list().filter((x) => x.groupKey === `prop:${id}` && x.kind !== 'proposalSent').pop();
      return a ? { status: p.status, delay: p.resolvedTick - p.createdTick, reasons: p.reasons?.length ?? 0, title: a.title, body: a.body, gold: p.gold } : null;
    }, sent.id, 200000, 1000);
    check(ans, 'no answer to the proposal');
    check(ans.reasons >= 1 && ans.body.length > 3, `answer without a reason (${JSON.stringify(ans)})`);
    check(!BAD_TEXT.test(`${ans.title} ${ans.body}`), `raw text in the answer: ${ans.title} / ${ans.body}`);
    await shot('14c-proposal-answer');
    await resetUi();
    return `${sent.kind} to ${sent.to} (gold ${sent.gold}): ${ans.status} after ${ans.delay} ticks — «${ans.title}» ${ans.body}`;
  });

  // ---------------------------------------------------------------------------------------------- war via the dialog
  let warTarget = -1;
  await step('declare war through the §4.2 dialog (left click on a neighbour)', async () => {
    await resetUi();
    const find = () => page.evaluate(() => {
      const v = window.__front.ctx.sim.view, pt = window.__pt;
      const cap = v.human.capitalTile;
      let best = -1, bd = 1e9;
      for (const t of pt.humanTiles()) {
        for (const dir of [-1, 1, -1600, 1600]) {
          const n2 = t + 2 * dir, n3 = t + 3 * dir, n = t + dir;
          const o = v.owner[n];
          const p = v.players[o];
          if (o && o !== 1 && p && p.kind === 'nation' && v.owner[n2] === o && v.owner[n3] === o && pt.playable(n2) && !v.human.allies.includes(o) && v.pairState(1, o) !== 'war') {
            const d = pt.dist(n2, cap);
            if (d < bd) { bd = d; best = n2; }
          }
        }
      }
      return best;
    });
    let target = await find();
    if (target < 0) {
      // Nobody borders us by land: declare on the nearest nation across the sea (the dialog then speaks of a landing).
      target = await page.evaluate(() => {
        const v = window.__front.ctx.sim.view, pt = window.__pt;
        const cap = v.human.capitalTile;
        let best = -1, bd = Infinity;
        for (let t = 1600; t < v.owner.length - 1600; t++) {
          const o = v.owner[t];
          if (!o || o === 1 || v.players[o]?.kind !== 'nation' || v.pairState(1, o) === 'war' || v.human.allies.includes(o)) continue;
          if (v.owner[t - 1] !== o || v.owner[t + 1] !== o || v.owner[t - 1600] !== o || v.owner[t + 1600] !== o) continue;
          const d = pt.dist(t, cap);
          if (d < bd) { bd = d; best = t; }
        }
        return best;
      });
    }
    check(target >= 0, 'no nation to declare war on');
    const ll = await tileLL(target);
    await lookAt(ll.lat, ll.lon, 1800);
    await clickTile(target);
    await page.waitForSelector('.fu-declare-modal', { timeout: 15000 });
    // The dialog fades in: read it once its body is laid out.
    await until(() => /\d+ h/.test(document.querySelector('.fu-declare-modal')?.innerText ?? ''), null, 8000, 200);
    await sleep(500);
    const text = await page.locator('.fu-declare-modal').innerText();
    await shot('15a-declare-dialog');
    check(/podrá empezar en \d+ h|can start in \d+ h/.test(text), `no mobilization line in the dialog: ${text.slice(0, 300)}`);
    check(!BAD_TEXT.test(text.replace(/\s+/g, ' ')), 'raw text in the declaration dialog');
    const defender = await page.evaluate((t) => window.__front.ctx.sim.view.owner[t], target);
    const n0 = await countEvents('warDeclared', 'e.aggressor === 1');
    await page.locator('.fu-declare-modal .fu-btn--danger').click();
    const ev = await lastEvent('warDeclared', 'e.aggressor === 1', n0, 20000);
    check(ev, 'no warDeclared after confirming');
    warTarget = ev.target;
    const mob = await page.evaluate(() => window.__front.ctx.sim.view.tick);
    return `war on ${ev.target} (clicked ${defender}); offensive after tick ${ev.mobilizeUntilTick} (now ${mob}); dialog: «${text.split('\n').find((l) => /empezar|start/.test(l))?.trim()}»`;
  });

  // ---------------------------------------------------------------------------------------------- AI declares on us
  let aiWar = null;
  await step('a nation declares war on us: critical alert, ping, marker, ticker, warHorn and auto-pause banner', async () => {
    await resetUi();
    // Make sure the game runs (auto-pause must be what stops it).
    await page.evaluate(() => { if (window.__front.ctx.sim.view.speed === 0) window.__front.app.setSpeed(1); });
    await until(() => window.__front.ctx.sim.view.speed > 0, null, 8000);
    const aggressor = await page.evaluate((warTarget) => {
      const v = window.__front.ctx.sim.view, pt = window.__pt;
      const cap = v.human.capitalTile;
      const at = (p) => Math.floor(p.labelY) * 1600 + Math.floor(p.labelX);
      const c = v.playerList.filter((p) => p.alive && p.kind === 'nation' && p.id !== 1 && p.id !== warTarget && v.pairState(1, p.id) !== 'war' && !v.human.allies.includes(p.id) && p.tiles > 60);
      c.sort((a, b) => pt.dist(at(a), cap) - pt.dist(at(b), cap));
      return c[0]?.id ?? -1;
    }, warTarget);
    check(aggressor > 0, 'no nation left to declare on us');
    const horn0 = await page.evaluate(() => window.__fuAudio?.stats?.().cues?.warHorn ?? 0);
    const pings0 = await page.evaluate(() => window.__fuAlerts.pings());
    const n0 = await countEvents('warDeclared', 'e.target === 1');
    // The declaration itself is the AI's (staged through the sim's debug war so the playtest does not wait for one).
    await page.evaluate((a) => window.__front.ctx.sim.debug({ type: 'war', a, b: 1, goal: 'border', mobilizeTicks: 240, reasonKey: 'war.reason.border' }), aggressor);
    const ev = await lastEvent('warDeclared', 'e.target === 1', n0, 20000);
    check(ev, 'no warDeclared on the human');
    const got = await until((a) => {
      const al = window.__fuAlerts.list().filter((x) => x.kind === 'warDeclared' && x.severity === 'critical').pop();
      if (!al) return null;
      return {
        alert: al, banner: window.__fuAlerts.banner(), speed: window.__front.ctx.sim.view.speed,
        pings: window.__fuAlerts.pings(), horn: window.__fuAudio?.stats?.().cues?.warHorn ?? 0,
        ticker: (window.__pt.events.filter((e) => e.type === 'tickerItem' || e.type === 'news').length),
      };
    }, aggressor, 15000, 250);
    check(got, 'no critical warDeclared alert');
    check(got.alert.marker, 'the alert has no globe marker');
    check(got.pings > pings0, 'no minimap ping');
    check(got.horn > horn0, 'no warHorn cue');
    check(/\d+ h/.test(got.alert.body) && !BAD_TEXT.test(`${got.alert.title} ${got.alert.body}`), `alert text: ${got.alert.title} / ${got.alert.body}`);
    const banner = got.banner || (await until(() => window.__fuAlerts.banner() || null, null, 6000, 200));
    check(banner, 'no auto-pause banner');
    check(await until(() => window.__front.ctx.sim.view.speed === 0, null, 6000, 200), 'the game did not auto-pause');
    await shot('16a-war-on-us-autopause');
    aiWar = { aggressor, alertId: got.alert.id, lat: got.alert.lat, lon: got.alert.lon };
    return `${aggressor} declared: «${got.alert.title}» — ${got.alert.body.slice(0, 120)}; banner «${banner.replace(/\s+/g, ' ').slice(0, 100)}»`;
  });

  await step('auto-pause banner: [Reanudar] resumes the game', async () => {
    check(aiWar, 'no auto-pause to resume (previous step failed)');
    await page.locator('.fu-autopause .fu-btn--primary').click();
    check(await until(() => window.__front.ctx.sim.view.speed > 0, null, 8000, 200), 'did not resume');
    check(await until(() => !window.__fuAlerts.banner(), null, 5000, 200), 'banner still shown');
    return `speed ${await page.evaluate(() => window.__front.ctx.sim.view.speed)}`;
  });

  await step('click the alert in the feed -> the camera flies to the place', async () => {
    check(aiWar, 'no war alert (previous step failed)');
    check(aiWar.lat !== undefined, 'the alert has no location');
    // Look at the other side of the planet, then click the feed entry.
    await lookAt(-aiWar.lat, aiWar.lon + 180, 9000);
    await sleep(1000);
    const edge = await page.evaluate((id) => window.__fuAlerts.list().find((a) => a.id === id)?.edge ?? false, aiWar.alertId);
    const entry = page.locator('.fu-alerts-list .fu-alert[data-kind="warDeclared"]').first();
    check(await entry.count(), 'the critical alert is not in the feed');
    await entry.click();
    // Flown there: the alert's place is on the visible side of the globe, near the middle of the screen (the camera may
    // tilt, so the camera's own lat/lon is not the point it looks at).
    const ok = await until(({ lat, lon }) => {
      const p = window.__pt.project(lat, lon);
      const dx = Math.abs(p.x - innerWidth / 2) / innerWidth, dy = Math.abs(p.y - innerHeight / 2) / innerHeight;
      return p.ok && dx < 0.25 && dy < 0.3 ? { ...window.__front.ctx.cameraRig.getState(), dx, dy } : null;
    }, { lat: aiWar.lat, lon: aiWar.lon }, 30000, 250);
    check(ok, 'the camera did not fly to the alert');
    await sleep(2500);
    await shot('16b-alert-flown');
    return `edge arrow while away: ${edge}; the alert's place (${aiWar.lat.toFixed(1)}, ${aiWar.lon.toFixed(1)}) now ${(ok.dx * 100).toFixed(0)} % / ${(ok.dy * 100).toFixed(0)} % from the screen centre`;
  });

  // ---------------------------------------------------------------------------------------------- save / continue
  await step('save from the pause menu, quit, «Continuar» restores the game', async () => {
    await resetUi();
    // Esc opens the pause menu (a first Esc may close a panel that is still open).
    for (let i = 0; i < 3 && !(await page.locator('.fu-pause .fu-pause-btn').count()); i++) {
      await page.keyboard.press('Escape');
      await page.waitForSelector('.fu-pause .fu-pause-btn', { timeout: 6000 }).catch(() => {});
    }
    await page.waitForSelector('.fu-pause .fu-pause-btn', { timeout: 15000 });
    await sleep(500);
    await page.locator('.fu-pause .fu-pause-btn').nth(1).click();
    await page.waitForSelector('.fu-save-row', { timeout: 15000 });
    await sleep(600);
    await shot('17a-save-dialog');
    const n0 = await countEvents('saved', "e.key !== 'autosave'");
    const before = await page.evaluate(() => {
      const v = window.__front.ctx.sim.view;
      return { tick: v.tick, tiles: v.human.tiles, treaties: v.treaties?.length ?? 0, proposals: v.proposals.size, opinions: v.opinions.size, wars: v.wars.length };
    });
    await page.locator('.fu-save-row').first().click();
    // An occupied slot asks before overwriting.
    await sleep(800);
    if (await page.locator('.fu-modal .fu-btn--primary', { hasText: /Sobrescribir|Overwrite/ }).count()) await page.locator('.fu-modal .fu-btn--primary').last().click();
    // The «Guardado · día N» entry in the alert feed (the save's toast).
    const toast = await until((n0) => {
      const ev = window.__pt.events.filter((e) => e.type === 'saved' && e.key !== 'autosave').slice(n0)[0];
      const al = ev ? window.__fuAlerts.list().filter((a) => a.kind === 'saved').pop() : null;
      return al && /Guardad|Saved/.test(al.title) ? { text: al.title } : null;
    }, n0, 30000, 300);
    check(toast, 'no «Guardado» toast');
    await sleep(800);
    // Quit to the menu (the pause menu may still be open under the save dialog).
    if (!(await page.locator('.fu-pause').count())) {
      await page.keyboard.press('Escape');
      await page.waitForSelector('.fu-pause .fu-pause-btn', { timeout: 15000 });
    }
    await page.locator('.fu-pause .fu-btn--danger').last().click();
    await sleep(600);
    await page.locator('.fu-modal .fu-btn--danger').last().click();
    await waitState('menu', 60000);
    await page.waitForSelector('.fu-menu-continue:not(.fu-hidden)', { timeout: 20000 });
    await sleep(1500);
    await shot('17b-menu-continue');
    await page.locator('.fu-menu-continue').click();
    await waitState('playing', 180000);
    await sleep(3000);
    const after = await page.evaluate(() => {
      const v = window.__front.ctx.sim.view;
      return { tick: v.tick, tiles: v.human.tiles, treaties: v.treaties?.length ?? 0, proposals: v.proposals.size, opinions: v.opinions.size, wars: v.wars.length };
    });
    await shot('17c-continued');
    check(after.tick >= before.tick && after.tick < before.tick + 400, `tick ${before.tick} -> ${after.tick}`);
    check(Math.abs(after.tiles - before.tiles) <= Math.max(30, before.tiles * 0.1), `tiles ${before.tiles} -> ${after.tiles}`);
    check(after.wars === before.wars && after.treaties === before.treaties, `wars/treaties ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    return `«${toast.text}»; before ${JSON.stringify(before)} after ${JSON.stringify(after)}`;
  });

  // ============================================================================================== extended (v1 tour)
  if (!STAGE2_ONLY) {
    stage = 'extended';
    for (const s of STRUCTS.slice(1)) await buildStep(...s);
    await page.evaluate(() => window.__front.ctx.sim.debug({ type: 'addGold', playerId: 1, amount: 40_000_000 }));
    await step('structures overview', async () => {
      const cap = await page.evaluate(() => window.__pt.tileLL(window.__front.ctx.sim.view.human.capitalTile));
      await lookAt(cap.lat - 1.5, cap.lon, 500, 0.6);
      await sleep(6000);
      await shot('05-structures');
    });

    // ---------------------------------------------------------------------------------------------- command mode
    let tankId = -1;
    await step('buy an armored division (Arsenal tab)', async () => {
      await page.locator('.fu-bb-tab').nth(1).click({ force: true });
      await sleep(500);
      const n0 = await page.evaluate(() => [...window.__front.ctx.sim.view.units.values()].filter((u) => u.owner === 1 && u.type === 3).length);
      await page.locator('.fu-bb-slot.is-unit').nth(1).click({ force: true });
      tankId = (await until((n0) => { const l = [...window.__front.ctx.sim.view.units.values()].filter((u) => u.owner === 1 && u.type === 3); return l.length > n0 ? l[l.length - 1].id : null; }, n0, 30000)) ?? -1;
      check(tankId >= 0, 'no armored division appeared');
      return `unit ${tankId}`;
    });

    // ---------------------------------------------------------------------------------------------- nukes
    await until(() => [...window.__front.ctx.sim.view.structures.values()].some((s) => s.owner === 1 && s.type === 5 && s.built >= 1), null, 90000);
    const nukeTarget = (minDist) => page.evaluate((minDist) => {
      const v = window.__front.ctx.sim.view, pt = window.__pt;
      const cap = v.human.capitalTile;
      // The biggest non-allied nation whose label anchor is far enough from our capital and that does not border us
      // (a neighbour answers a nuke by marching straight into our silo).
      const neighbours = new Set();
      for (const t of pt.humanTiles()) for (const n of [t - 1, t + 1, t - 1600, t + 1600]) if (v.owner[n] !== 1) neighbours.add(v.owner[n]);
      const cands = v.playerList.filter((p) => p.alive && p.id !== 1 && p.kind === 'nation' && !v.human.allies.includes(p.id) && p.tiles > 150 && !neighbours.has(p.id));
      let best = null;
      for (const p of cands) {
        const t = Math.floor(p.labelY) * 1600 + Math.floor(p.labelX);
        if (v.owner[t] !== p.id) continue;
        const d = pt.dist(t, cap);
        if (d < minDist || d > 450) continue;
        if (!best || p.tiles > best.tiles) best = { id: p.id, tile: t, tiles: p.tiles, d };
      }
      return best;
    }, minDist);

    for (const [key, weapon, name, minDist, shotName] of [['z', 'AtomBomb', 'atom bomb', 50, '07-atom'], ['x', 'HydrogenBomb', 'hydrogen bomb', 90, '08-hydrogen']]) {
      await step(`launch ${name} (${key.toUpperCase()} key)`, async () => {
        const tgt = await nukeTarget(minDist);
        check(tgt, 'no nuke target');
        const ll = await tileLL(tgt.tile);
        await lookAt(ll.lat, ll.lon, 2500);
        const n0 = await countEvents('nukeLaunched', 'e.owner === 1');
        await hoverTile(tgt.tile);
        await page.keyboard.press(key);
        await sleep(400);
        await clickTile(tgt.tile);
        const ev = await lastEvent('nukeLaunched', 'e.owner === 1', n0);
        check(ev, 'no nukeLaunched (see sim messages in the report)');
        // Follow it down: frame the target at an oblique angle and wait for detonation or interception.
        await lookAt(ll.lat - 4, ll.lon, 1500, 0.95);
        const end = await until((id) => window.__pt.events.find((e) => (e.type === 'nukeDetonated' || e.type === 'nukeIntercepted') && e.unitId === id), ev.unitId, 120000, 250);
        check(end, 'nuke neither detonated nor was intercepted');
        await sleep(end.type === 'nukeDetonated' ? 12000 : 500);
        await shot(shotName);
        return `${weapon} on player ${tgt.id} (${tgt.d.toFixed(0)} tiles away): ${end.type}${end.casualties ? `, ${end.casualties} casualties` : ''}`;
      });
    }

    for (const ratio of ['50', '75']) {
      await step(`attack a neighbouring nation at ${ratio}%`, async () => {
        await page.locator('.fu-ar-tick', { hasText: new RegExp(`^${ratio}$`) }).click();
        // Closest foreign-owned (nation or tribe) tile that touches our land.
        const find = () => page.evaluate(() => {
          const v = window.__front.ctx.sim.view, pt = window.__pt;
          const cap = v.human.capitalTile;
          let best = -1, bd = 1e9;
          for (const t of pt.humanTiles()) {
            for (const dir of [-1, 1, -1600, 1600]) {
              // Two tiles deep into the neighbour, so a click that resolves one tile off still lands on it.
              const n = t + dir, n2 = t + 2 * dir, n3 = t + 3 * dir;
              const o = v.owner[n];
              if (o && o !== 1 && v.owner[n2] === o && v.owner[n3] === o && pt.playable(n2) && !v.human.allies.includes(o)) {
                const d = pt.dist(n2, cap);
                if (d < bd) { bd = d; best = n2; }
              }
            }
          }
          return best;
        });
        let target = await find();
        for (let i = 0; i < 20 && target < 0; i++) {
          await sleep(3000);
          target = await find();
        }
        check(target >= 0, 'no land neighbour to attack');
        const ll = await tileLL(target);
        await lookAt(ll.lat, ll.lon, 1800);
        const n0 = await countEvents('attackStarted', 'e.attacker === 1');
        const troops0 = (await humanStats()).troops;
        const defender = await page.evaluate((t) => window.__front.ctx.sim.view.owner[t], target);
        const sent0 = await page.evaluate((d) => window.__front.ctx.sim.view.attacks.filter((a) => a.attacker === 1 && a.defender === d).reduce((s, a) => s + a.troops, 0), defender);
        const w0 = await countEvents('warDeclared', 'e.aggressor === 1');
        await clickTile(target);
        // A nation we are not at war with: the click opens the declaration dialog (§4.2); the offensive then waits for
        // the mobilization.
        if (await page.waitForSelector('.fu-declare-modal', { timeout: 2500 }).catch(() => null)) {
          await page.locator('.fu-declare-modal .fu-btn--danger').click();
          const w = await lastEvent('warDeclared', 'e.aggressor === 1', w0, 15000);
          check(w, 'declaration confirmed but no warDeclared');
          return `declared war on ${w.target} first; offensive queued until tick ${w.mobilizeUntilTick}`;
        }
        const ev = await lastEvent('attackStarted', 'e.attacker === 1', n0);
        if (ev) return `vs player ${ev.defender}: ${ev.troops} troops (${((ev.troops / troops0) * 100).toFixed(0)}% of ${troops0})`;
        // Clicking a nation we are already attacking reinforces that attack instead of opening a new one.
        const sent1 = await page.evaluate((d) => window.__front.ctx.sim.view.attacks.filter((a) => a.attacker === 1 && a.defender === d).reduce((s, a) => s + a.troops, 0), defender);
        check(sent1 > sent0 + troops0 * 0.2, 'no attackStarted and no reinforcement');
        return `reinforced the attack on player ${defender}: +${Math.round(sent1 - sent0)} troops`;
      });
    }
    await step('war overview', async () => {
      await sleep(4000);
      await shot('09-war');
    });

    await step('select the tank and TAKE CONTROL -> command mode', async () => {
      const u = await page.evaluate((id) => { const u = window.__front.ctx.sim.view.units.get(id); return u && { x: u.x, y: u.y }; }, tankId);
      check(u, 'tank vanished');
      const lat = 90 - (u.y / 800) * 180, lon = (u.x / 1600) * 360 - 180;
      await lookAt(lat, lon, 400);
      await sleep(1500);
      // Click the rendered tank (units renderer picking).
      let selected = false;
      for (let i = 0; i < 3 && !selected; i++) {
        const p = await page.evaluate((id) => {
          const ctx = window.__front.ctx;
          const v = ctx.camera.position.clone();
          if (!ctx.units.getUnitWorldPosition(id, v)) return null;
          v.project(ctx.camera);
          return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight };
        }, tankId);
        check(p, 'tank has no rendered position');
        await page.mouse.move(p.x, p.y, { steps: 2 });
        await sleep(600);
        await page.mouse.click(p.x, p.y, { delay: 40 });
        selected = !!(await page.waitForSelector('.fu-take-control', { timeout: 8000 }).catch(() => null));
      }
      check(selected, 'selection panel with TAKE CONTROL did not open');
      await sleep(800);
      await shot('10-selected-tank');
      await page.locator('.fu-take-control').click();
      await waitState('command', 180000);
      await sleep(3000);
      await shot('11-command-intro');
      // The dive-in intro (letterboxed title card) runs ~3 s of game frames; wait until the player has control.
      await page.waitForFunction(() => !document.querySelector('.fu-cmd-cine'), null, { timeout: 120000, polling: 500 }).catch(() => {});
      await sleep(3000);
      await shot('11-command-tank');
      // Drive and shoot a little.
      await page.keyboard.down('w');
      await sleep(2500);
      await page.mouse.move(W / 2 + 120, H / 2 - 20, { steps: 4 });
      await page.mouse.down();
      await sleep(150);
      await page.mouse.up();
      await sleep(2500);
      await page.keyboard.up('w');
      await shot('12-command-driving');
      return 'in command mode';
    });

    await step('exit command mode (Esc) -> result applied', async () => {
      const n0 = await countEvents('commandResultApplied');
      // First Esc ends the fight and shows the combat report; the second leaves right away.
      await page.keyboard.press('Escape');
      await sleep(6000);
      await shot('12b-command-debrief');
      if ((await state()) === 'command') await page.keyboard.press('Escape');
      await waitState('playing', 120000);
      const ev = await lastEvent('commandResultApplied', null, n0, 20000);
      check(ev, 'no commandResultApplied');
      // Cinematic climb back to orbit.
      await until(() => window.__front.ctx.cameraRig.getState().altitudeKm > 2000, null, 90000, 500);
      await sleep(3000);
      await shot('13-back-to-orbit');
      return `killed ${ev.troopsKilled} troops, unitLost=${ev.unitLost}`;
    });

    // ---------------------------------------------------------------------------------------------- invasion
    await step('transport-ship invasion (B key over a foreign coast)', async () => {
      const targets = await page.evaluate(() => {
        const v = window.__front.ctx.sim.view, pt = window.__pt;
        const myCoast = pt.humanTiles().filter((t) => pt.coastal(t));
        if (!myCoast.length) return [];
        const outList = [];
        // Coastal land 12..70 tiles from our coast (prefer unclaimed land, then weak owners).
        const cap = v.human.capitalTile;
        const cx = cap % 1600, cy = Math.floor(cap / 1600);
        for (let dy = -90; dy <= 90; dy++) for (let dx = -90; dx <= 90; dx++) {
          const y = cy + dy;
          if (y < 0 || y >= 800) continue;
          const i = y * 1600 + ((cx + dx + 1600) % 1600);
          const o = v.owner[i];
          if (o === 1 || !pt.playable(i) || !pt.coastal(i)) continue;
          if (o && v.human.allies.includes(o)) continue;
          let dmin = 1e9;
          for (let k = 0; k < myCoast.length; k += 3) dmin = Math.min(dmin, pt.dist(myCoast[k], i));
          if (dmin > 12 && dmin < 70) outList.push([dmin + (o === 0 ? -30 : 0), i]);
        }
        outList.sort((a, b) => a[0] - b[0]);
        return outList.filter((_, k) => k % 25 === 0).slice(0, 8).map((x) => x[1]);
      });
      check(targets.length > 0, 'no coast across the water');
      for (const tile of targets) {
        const ll = await tileLL(tile);
        await lookAt(ll.lat, ll.lon, 2500);
        const n0 = await countEvents('boatLaunched', 'e.owner === 1');
        await hoverTile(tile);
        await page.keyboard.press('b');
        const ev = await lastEvent('boatLaunched', 'e.owner === 1', n0, 10000);
        if (ev) {
          const from = await tileLL(ev.fromTile);
          await lookAt((from.lat + ll.lat) / 2 - 2, (from.lon + ll.lon) / 2, 1500, 0.6);
          await sleep(6000);
          await shot('06-invasion');
          return `boat ${ev.unitId} with ${ev.troops} troops -> tile ${ev.toTile}`;
        }
      }
      throw new Error(`no boatLaunched for ${targets.length} targets`);
    });

    // ---------------------------------------------------------------------------------------------- diplomacy
    await step('proposal via the right-click radial (Proponer -> alliance)', async () => {
      await resetUi();
      const tgt = await page.evaluate(() => {
        const v = window.__front.ctx.sim.view, pt = window.__pt;
        const at = (p) => Math.floor(p.labelY) * 1600 + Math.floor(p.labelX);
        const cands = v.playerList.filter((p) => p.alive && p.id !== 1 && p.kind === 'nation' && !v.human.allies.includes(p.id) && v.pairState(1, p.id) !== 'war' && p.tiles > 40);
        cands.sort((a, b) => pt.dist(v.human.capitalTile, at(a)) - pt.dist(v.human.capitalTile, at(b)));
        for (const p of cands) if (v.owner[at(p)] === p.id) return { id: p.id, tile: at(p) };
        return null;
      });
      check(tgt, 'no nation to propose to');
      const ll = await tileLL(tgt.tile);
      await lookAt(ll.lat, ll.lon, 2500);
      await clickTile(tgt.tile, 'right');
      await page.waitForSelector('.fu-radial:not(.fu-hidden) .fu-wedge', { timeout: 10000 });
      await sleep(900);
      await shot('14d-radial');
      const p0 = await page.evaluate(() => Math.max(0, ...[...window.__front.ctx.sim.view.proposals.values()].map((p) => p.id)));
      await page.locator('.fu-radial .fu-wedge').nth(1).click({ force: true });
      await sleep(600);
      await page.locator('.fu-radial .fu-wedge').nth(0).click({ force: true });
      const sent = await until((p0) => [...window.__front.ctx.sim.view.proposals.values()].find((p) => p.from === 1 && p.id > p0) ?? null, p0, 10000, 200);
      check(sent, 'no proposal from the radial');
      return `${sent.kind} proposed to ${sent.to} (status ${sent.status})`;
    });

    await step('pause/resume (Space)', async () => {
      await page.keyboard.press('Space');
      check(await until(() => window.__front.ctx.sim.view.speed === 0, null, 8000), 'did not pause');
      await page.keyboard.press('Space');
      check(await until(() => window.__front.ctx.sim.view.speed > 0, null, 8000), 'did not resume');
    });

    await step('mid-game overview', async () => {
      const cap = await page.evaluate(() => window.__pt.tileLL(window.__front.ctx.sim.view.human.capitalTile));
      await lookAt(cap.lat, cap.lon + 5, 5000, 0.2);
      await sleep(6000);
      await shot('15-overview');
      return JSON.stringify(await humanStats());
    });

    await step('end screen (victory) -> back to menu', async () => {
      await page.evaluate(() => window.__front.ctx.sim.debug({ type: 'endGame', winner: 1, reason: 'domination' }));
      await waitState('ended', 60000);
      await sleep(6000);
      await shot('16-end');
      await page.locator('.fu-end-actions .fu-btn--ghost').last().click();
      await waitState('menu', 60000);
      await sleep(3000);
      await shot('17-menu-again');
    });
  }
} catch (err) {
  errors.push(`[playtest] ${err.message}`);
  await shot('99-failure').catch(() => {});
}

const counts = await page.evaluate(() => window.__pt?.counts ?? {}).catch(() => ({}));
const messages = await page.evaluate(() => (window.__pt?.events ?? []).filter((e) => e.type === 'message' && e.playerId === 1).map((e) => e.key)).catch(() => []);
const cues = await page.evaluate(() => window.__fuAudio?.stats?.().cues ?? null).catch(() => null);
await browser.close();

console.log('\n================ PLAYTEST REPORT ================');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  [${r.stage}] ${r.name.padEnd(60)} ${r.sec.toFixed(0).padStart(4)}s  ${r.detail}`);
console.log(`\nevents: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')}`);
if (cues) console.log(`audio cues: ${Object.entries(cues).map(([k, v]) => `${k}=${v}`).join(' ')}`);
if (messages.length) console.log(`sim messages to the human: ${[...new Set(messages)].join(', ')}`);
const realErrors = errors.filter((e) => !/favicon/i.test(e));
console.log(`emergency land grants: ${landGrants}`);
console.log(`console errors: ${realErrors.length}`);
for (const e of realErrors.slice(0, 40)) console.log('   ', e.slice(0, 600));
if (warnings.length) console.log(`console warnings: ${warnings.length} (first: ${warnings.slice(0, 3).map((w) => w.slice(0, 160)).join(' | ')})`);
const failed2 = results.filter((r) => !r.ok && r.stage === 'stage2').length;
const n2 = results.filter((r) => r.stage === 'stage2').length;
const failedX = results.filter((r) => !r.ok && r.stage !== 'stage2').length;
console.log(`\nstage 2: ${n2 - failed2}/${n2} steps passed; extended: ${results.length - n2 - failedX}/${results.length - n2}; total ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(failed2 || failedX || realErrors.length ? 1 : 0);
