// FRONT ULTRA — automated end-to-end playthrough (owner: app).
// Drives the REAL game like a player, through the actual UI: loading -> "press any key" -> main menu ->
// skirmish setup -> START -> spawn click on the globe -> playing at 4x -> attacks at several ratios, every
// structure type through the build-bar hotkeys, a transport invasion (B), an atom bomb (Z) and a hydrogen bomb
// (X), an alliance request through the right-click radial menu, an armored division bought in the Arsenal tab and
// taken over with TOMAR EL CONTROL (command-mode round trip), then the end screen and back to the menu.
//
// The only non-UI calls are (a) moving the camera (ctx.cameraRig.setState — what a player does by dragging) so
// click targets are on screen, (b) reading ctx.sim.view to choose valid targets and verify results, (c) a
// gold/troop grant through the sim's debug action so the arsenal is affordable inside a short test, and (d) the
// final `endGame` debug action to reach the victory screen.
//
// Usage: node tools/playtest.mjs [--url http://127.0.0.1:5190/] [--out shots/playtest]
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
const shot = async (name) => {
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  log(`  shot ${name}.png`);
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
async function step(name, fn) {
  if (results.length >= stopAfter) throw new Error('stopped (--steps)');
  const s = Date.now();
  log(`STEP ${name}`);
  try {
    if (results.length >= 7) {
      await resetUi();
      await reinforce();
    }
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? '', sec: (Date.now() - s) / 1000 });
    log(`  ok ${detail ?? ''}`);
    return true;
  } catch (err) {
    results.push({ name, ok: false, detail: err.message.split('\n')[0], sec: (Date.now() - s) / 1000 });
    log(`  FAIL ${err.message}`);
    const recent = await page.evaluate(() => (window.__pt?.events ?? []).filter((e) => e.attacker === 1 || e.owner === 1 || e.playerId === 1 || e.from === 1).slice(-8)).catch(() => []);
    for (const e of recent) log(`     recent: ${JSON.stringify(e).slice(0, 220)}`);
    await shot(`fail-${name.replace(/[^a-z0-9]+/gi, '-')}`).catch(() => {});
    return false;
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
    }));
    if (st.modal) await page.locator('.fu-close').last().click().catch(() => {});
    else if (st.chip || st.radial) await page.keyboard.press('Escape');
    else return;
    await sleep(400);
  }
}
/** Debug top-up between scripted actions so the short test survives the AI at 4x (see header). */
const reinforce = () => page.evaluate(() => {
  const s = window.__front.ctx.sim;
  if (!s.view.human?.alive) return;
  s.debug({ type: 'addTroops', playerId: 1, amount: Math.max(0, s.view.human.maxTroops - s.view.human.troops) });
  if (s.view.human.gold < 20_000_000) s.debug({ type: 'addGold', playerId: 1, amount: 30_000_000 });
});
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
    await page.locator('.fu-menu-item.is-primary').click();
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
    const cap = await page.evaluate(() => window.__front.ctx.sim.view.human?.capitalTile ?? -1);
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
    await sleep(300);
    await page.keyboard.press('Equal');
    const sp = await until(() => window.__front.ctx.sim.view.speed === 4, null, 10000);
    check(sp, `speed is ${await page.evaluate(() => window.__front.ctx.sim.view.speed)}`);
    await sleep(3000);
    await shot('04-speed-4x');
    // The headless harness acts ~10x slower than a player (software WebGL), so the scripted actions run at 1x
    // (the 1x button) to keep the game clock in step with what a player would do in the same number of moves.
    await page.locator('.fu-time-seg button').nth(1).click();
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



  // ---------------------------------------------------------------------------------------------- build all
  const STRUCTS = [
    ['1', 0, 'City', false], ['2', 1, 'Port', true], ['3', 2, 'Factory', false], ['4', 3, 'DefensePost', false],
    ['5', 4, 'SamSite', false], ['6', 5, 'MissileSilo', false], ['7', 6, 'Airbase', false], ['8', 7, 'ArmyBase', false],
    ['9', 8, 'NavalYard', true], ['0', 9, 'Radar', false],
  ];
  for (const [key, type, name, coastal] of STRUCTS) {
    await step(`build ${name} (key ${key})`, async () => {
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
  }
  await page.evaluate(() => window.__front.ctx.sim.debug({ type: 'addGold', playerId: 1, amount: 40_000_000 }));
  {
    const cap = await page.evaluate(() => window.__pt.tileLL(window.__front.ctx.sim.view.human.capitalTile));
    await lookAt(cap.lat - 1.5, cap.lon, 500, 0.6);
    await sleep(6000);
    await shot('05-structures');
  }

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
    await sleep(7000);
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
    await page.keyboard.press('Escape');
    await waitState('playing', 120000);
    const ev = await lastEvent('commandResultApplied', null, n0, 20000);
    check(ev, 'no commandResultApplied');
    await sleep(5000);
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
  await step('alliance request via right-click radial', async () => {
    const tgt = await page.evaluate(() => {
      const v = window.__front.ctx.sim.view, pt = window.__pt;
      const at = (p) => Math.floor(p.labelY) * 1600 + Math.floor(p.labelX);
      const cands = v.playerList.filter((p) => p.alive && p.id !== 1 && p.kind === 'nation' && !v.human.allies.includes(p.id) && p.tiles > 40);
      cands.sort((a, b) => pt.dist(v.human.capitalTile, at(a)) - pt.dist(v.human.capitalTile, at(b)));
      for (const p of cands) if (v.owner[at(p)] === p.id) return { id: p.id, tile: at(p) };
      return null;
    });
    check(tgt, 'no nation to ally with');
    const ll = await tileLL(tgt.tile);
    await lookAt(ll.lat, ll.lon, 2500);
    await clickTile(tgt.tile, 'right');
    await page.waitForSelector('.fu-radial:not(.fu-hidden) .fu-wedge', { timeout: 10000 });
    await sleep(900);
    await shot('09-radial');
    const n0 = await countEvents('allianceRequested', 'e.from === 1');
    await page.locator('.fu-radial .fu-wedge').nth(1).click({ force: true });
    const ev = await lastEvent('allianceRequested', 'e.from === 1', n0, 10000);
    check(ev, 'no allianceRequested from the human');
    const reply = await until((to) => window.__pt.events.find((e) => (e.type === 'allianceFormed' && (e.a === to || e.b === to) && (e.a === 1 || e.b === 1)) || (e.type === 'allianceRejected' && ((e.to === 1 && e.from === to) || (e.from === 1 && e.to === to)))), ev.to, 30000);
    return `request to ${ev.to}: ${reply ? reply.type : 'no reply within 30 s'}`;
  });

  for (const ratio of ['50', '75']) {
    await step(`attack a neighbouring nation at ${ratio}%`, async () => {
      await page.locator('.fu-ar-tick', { hasText: new RegExp(`^${ratio}$`) }).click();
      // Closest foreign-owned (nation or tribe) tile that touches our land.
      const find = () => page.evaluate(() => {
        const v = window.__front.ctx.sim.view, pt = window.__pt;
        const cap = v.human.capitalTile;
        let best = -1, bd = 1e9;
        for (const t of pt.humanTiles()) {
          for (const n of [t - 1, t + 1, t - 1600, t + 1600]) {
            const o = v.owner[n];
            if (o && o !== 1 && pt.playable(n) && !v.human.allies.includes(o)) {
              const d = pt.dist(n, cap);
              if (d < bd) { bd = d; best = n; }
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
      await clickTile(target);
      const ev = await lastEvent('attackStarted', 'e.attacker === 1', n0);
      check(ev, 'no attackStarted');
      return `vs player ${ev.defender}: ${ev.troops} troops (${((ev.troops / troops0) * 100).toFixed(0)}% of ${troops0})`;
    });
  }
  await sleep(4000);
  await shot('14-war');

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
} catch (err) {
  errors.push(`[playtest] ${err.message}`);
  await shot('99-failure').catch(() => {});
}

const counts = await page.evaluate(() => window.__pt?.counts ?? {}).catch(() => ({}));
const messages = await page.evaluate(() => (window.__pt?.events ?? []).filter((e) => e.type === 'message' && e.playerId === 1).map((e) => e.key)).catch(() => []);
await browser.close();

console.log('\n================ PLAYTEST REPORT ================');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(52)} ${r.sec.toFixed(0).padStart(4)}s  ${r.detail}`);
console.log(`\nevents: ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')}`);
if (messages.length) console.log(`sim messages to the human: ${[...new Set(messages)].join(', ')}`);
const realErrors = errors.filter((e) => !/favicon/i.test(e));
console.log(`console errors: ${realErrors.length}`);
for (const e of realErrors.slice(0, 40)) console.log('   ', e.slice(0, 600));
if (warnings.length) console.log(`console warnings: ${warnings.length} (first: ${warnings.slice(0, 3).map((w) => w.slice(0, 160)).join(' | ')})`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} steps passed, total ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(failed || realErrors.length ? 1 : 0);
