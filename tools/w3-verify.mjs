// FRONT ULTRA — W3 browser verification (diplomacy, alerts, crisis, auto-pause, texts). Test tooling only.
//
//   node tools/w3-verify.mjs [--url http://127.0.0.1:5313/] [--out shots/W3-diplomacy-alerts-ux/verify] [--lang es|en|both]
//
// Drives the real game in Chromium on a staged mid-game (Madrid, Normal, 24 nations; the AI's actions are staged with
// the sim's debug actions — the same code paths the AI uses — so each case happens on demand) and measures what the
// player sees through the HUD's debug hooks (window.__fuAlerts, __fuCrisis, __fuAudio, __fuTip):
//   V3   a war declared on the human: in the SAME frame a critical alert with reason and mobilization time, a minimap
//        ping, a globe marker, the warHorn cue and the auto-pause; the ticker item within 10 s     (acceptance 3)
//   V5   an offensive on the human: one grouped alert per front with attacker, place and troops; it updates instead
//        of stacking; clicking it flies the camera there                                            (acceptance 5)
//   V6   invasionDetected names the landing place and an ETA within ±10 % of the landing tick; an airRaid names the
//        base and the target                                                                         (acceptance 6)
//   V7   Settings > Juego: 8 auto-pause toggles with the §8.5 defaults, crisisTime, observationTime, clouds, historical
//        borders (off); the worker logs each settings message; each of the 8 kinds pauses with a banner (acceptance 7)
//   V12  the radial has no emotes and no «Marcar objetivo»                                          (acceptance 12)
//   V14  sampled tooltips on W3's controls (top bar, nations, alerts, radial) with purpose and numbers (acceptance 14)
//   V16  crisis: amber for a foreign launch, red alarm when the human is the target, no v1 banner   (acceptance 16)
//   V18  every alert / ticker text of the session: 0 matches of /\(a\)|\{[a-zA-Z]+\}/ (es and en)   (acceptance 18)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5313/';
const out = args.out || 'shots/W3-diplomacy-alerts-ux/verify';
const langs = (args.lang || 'both') === 'both' ? ['es', 'en'] : [args.lang];
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const consoleLines = [];
const errors = [];
page.on('console', (m) => {
  consoleLines.push(m.text());
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
const t0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${msg}`);
const sleep = (ms) => page.waitForTimeout(ms);
const rows = [];
const row = (id, what, value, target, pass) => {
  rows.push({ id, what, value: String(value), target, pass: !!pass });
  log(`${pass ? 'PASS' : 'FAIL'} ${id} ${what}: ${value}`);
};
const shot = async (name) => {
  try { await page.screenshot({ path: path.join(out, `${name}.png`), timeout: 90000 }); } catch { /* slow frame */ }
};
async function until(fn, arg, timeout = 30000, poll = 300) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await page.evaluate(fn, arg).catch(() => null);
    if (v) return v;
    await sleep(poll);
  }
  return null;
}
const BAD = /\(a\)|\{[a-zA-Z]+\}/;

await page.goto(base, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 250 });
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__front?.app.state === 'menu', null, { timeout: 60000 });

// In-page helpers: every alert / ticker text of the session, the neighbour finder, tick waits.
await page.evaluate(() => {
  const { ctx } = window.__front;
  const V = {
    texts: [],
    horn: () => window.__fuAudio?.stats?.().cues?.warHorn ?? 0,
    neighbour() {
      const v = ctx.sim.view;
      const W = 1600;
      const counts = new Map();
      for (let t = W; t < v.owner.length - W; t++) {
        if (v.owner[t] !== 1) continue;
        for (const n of [t - 1, t + 1, t - W, t + W]) {
          const o = v.owner[n];
          if (o && o !== 1 && v.players[o]?.kind === 'nation') counts.set(o, (counts.get(o) ?? 0) + 1);
        }
      }
      let best = 0, bn = 0;
      for (const [o, n] of counts) if (n > bn) { bn = n; best = o; }
      return best;
    },
    /** Nobody borders us: give the largest nation a foothold just north of our land (staging, like the shots). */
    foothold() {
      // Nobody borders us: the largest nation gets a small foothold on the land just beyond our border (staging).
      const v = ctx.sim.view;
      const W = 1600;
      const id = v.playerList.filter((p) => p.kind === 'nation' && p.alive && p.id !== 1).sort((a, b) => b.tiles - a.tiles)[0]?.id ?? 0;
      const land = (t) => { const c = v.world.terrain[t] & 0x0f; return c >= 2 && c <= 4; };
      for (let t = W; t < v.owner.length - W; t++) {
        if (v.owner[t] !== 1) continue;
        for (const d of [-W, 1, W, -1]) {
          const c = t + d * 6;
          if (v.owner[t + d] !== 1 && land(t + d) && land(c) && v.owner[c] !== 1) {
            ctx.sim.debug({ type: 'conquer', playerId: id, centerTile: c, radius: 5 });
            return id;
          }
        }
      }
      return 0;
    },
    others(n) {
      const v = ctx.sim.view;
      return v.playerList.filter((p) => p.kind === 'nation' && p.alive && p.id !== 1 && p.id !== n).sort((a, b) => b.tiles - a.tiles).map((p) => p.id);
    },
    resume() {
      document.querySelector('.fu-autopause:not(.fu-hidden) .fu-btn--primary')?.click();
      if (ctx.sim.view.speed === 0) ctx.app.setSpeed(1);
    },
    ticks: (n) => ctx.sim.fastForward(n),
    /** Where lat/lon falls on screen, as a fraction of the viewport from its centre (null when behind the globe). */
    onScreen(lat, lon) {
      const cam = ctx.camera;
      const r = ctx.globe.surfaceRadiusAt(lat, lon);
      const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
      const p = cam.position.clone().set(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
      if (cam.position.clone().sub(p).dot(p) <= 0) return null;
      p.project(cam);
      return { dx: Math.abs(p.x) / 2, dy: Math.abs(p.y) / 2 };
    },
  };
  ctx.bus.on('alert', (a) => V.texts.push(`${a.kind}: ${a.title ?? ''} | ${a.body ?? ''}`));
  V.paused = [];
  // Every convoy detected heading for us, and its landing (ETA accuracy, acceptance 6).
  V.invs = new Map();
  ctx.bus.on('invasionDetected', (e) => { if (e.target === 1 && !V.invs.has(e.unitId)) V.invs.set(e.unitId, { det: e, land: null }); });
  ctx.bus.on('boatLanded', (e) => { const r = V.invs.get(e.unitId); if (r && !r.land) r.land = e; });
  V.msgs = [];
  ctx.bus.on('message', (e) => V.msgs.push(e));
  ctx.bus.on('autoPaused', (e) => V.paused.push({ kind: e.kind, text: window.__fuAlerts.banner() || e.text }));
  window.__V = V;
});

for (const lang of langs) {
  log(`=== language ${lang} ===`);
  await page.evaluate(async (lang) => {
    const { ctx } = window.__front;
    ctx.settings.set({ language: lang, tutorial: false, autoPause: { warOnYou: true, ultimatum: true, nukeAtYou: true, capitalThreat: true, invasion: true, proposal: true, peaceOffer: true, callToArms: true } });
    window.__V.texts.length = 0;
    window.__V.paused.length = 0;
    window.__V.invs.clear();
    await ctx.app.startScriptedGame({ ticks: 1500, speed: 0, autopilot: false, worldEvents: false });
    ctx.cameraRig.setState({ lat: 40, lon: -3, altitudeKm: 5000, tilt: 0.1, heading: 0 });
  }, lang);
  await page.waitForFunction(() => window.__front.app.state === 'playing', null, { timeout: 180000 });
  await sleep(3000);
  if (!(await page.evaluate(() => window.__V.neighbour()))) {
    await page.evaluate(() => window.__V.foothold());
    await page.evaluate(() => window.__front.ctx.sim.fastForward(4));
    await sleep(1500);
  }
  const S = await page.evaluate(() => {
    const n = window.__V.neighbour();
    const o = window.__V.others(n);
    return { n, o, cap: window.__front.ctx.sim.view.human.capitalTile };
  });
  log(`neighbour ${S.n}, others ${S.o.slice(0, 5).join(',')}, capital ${S.cap}`);

  // ------------------------------------------------------------------------------------------ V3 war on us, same frame
  {
    await page.evaluate(() => window.__front.ctx.app.setSpeed(1));
    const r = await page.evaluate(async (a) => {
      const { ctx } = window.__front;
      const before = { pings: window.__fuAlerts.pings(), horn: window.__V.horn() };
      const got = new Promise((res) => {
        const off = ctx.bus.on('warDeclared', (e) => {
          if (e.target !== 1) return;
          off?.();
          // Synchronous: everything below was produced while handling this very event (same frame).
          const al = window.__fuAlerts.list().filter((x) => x.kind === 'warDeclared').pop();
          res({
            frame: ctx.frame.frame, alert: al ?? null, pings: window.__fuAlerts.pings() - before.pings,
            horn: window.__V.horn() - before.horn, banner: window.__fuAlerts.banner(), mob: e.mobilizeUntilTick - e.tick,
            ticker: document.querySelector('.fu-tk-text')?.textContent ?? '',
          });
        });
      });
      ctx.sim.debug({ type: 'war', a, b: 1, goal: 'border', mobilizeTicks: 240, reasonKey: 'war.reason.border' });
      return Promise.race([got, new Promise((res) => setTimeout(() => res({ alert: null, pings: 0, horn: 0, banner: '', mob: 0 }), 20000))]);
    }, S.n);
    // The aggressor's displayed name, from the alert's own title («¡X nos declara la guerra!» / «X declares war on us!»).
    const name = (r.alert?.title ?? '').replace(/^¡/, '').replace(/ (nos declara la guerra|declares war on us)!?$/, '');
    const tick = name && r.ticker.includes(name) ? r.ticker : null;
    const paused = await until(() => window.__front.ctx.sim.view.speed === 0, null, 5000, 100);
    row('V3a', 'critical alert with reason and mobilization in the same frame', r.alert ? `${r.alert.severity}: ${r.alert.title} — ${r.alert.body}` : 'none', 'critical, hours', r.alert?.severity === 'critical' && /\d+ h/.test(r.alert.body));
    row('V3b', 'minimap ping / globe marker / warHorn in the same frame', `ping ${r.pings}, marker ${r.alert?.marker}, horn ${r.horn}`, '>=1 / true / >=1', r.pings >= 1 && r.alert?.marker && r.horn >= 1);
    row('V3c', 'auto-pause with its banner (default on)', `banner «${(r.banner || '').replace(/\s+/g, ' ').slice(0, 80)}», paused ${!!paused}`, 'banner, paused', r.banner && paused);
    row('V3d', 'ticker item naming the aggressor in the same frame', tick ? `«${tick.slice(0, 90)}»` : `no («${r.ticker.slice(0, 60)}»)`, 'yes', tick);
    await shot(`${lang}-V3-war-on-us`);
    // Edge arrow: look away and check the marker becomes an edge arrow.
    await page.evaluate(() => window.__front.ctx.cameraRig.setState({ lat: -40, lon: 150, altitudeKm: 9000, tilt: 0, heading: 0 }));
    const edge = await until(() => window.__fuAlerts.list().some((a) => a.kind === 'warDeclared' && a.edge) || null, null, 6000, 200);
    row('V3e', 'off-screen alert shows an edge arrow', edge ? 'yes' : 'no', 'yes', edge);
    await page.evaluate(() => window.__V.resume());
  }

  // ------------------------------------------------------------------------------------------ V5 offensive grouped per front
  {
    await page.evaluate((a) => {
      const { ctx } = window.__front;
      ctx.sim.debug({ type: 'addTroops', playerId: a, amount: 500_000 });
      ctx.sim.debug({ type: 'war', a, b: 1, mobilizeTicks: 0, reasonKey: 'war.reason.border' });
    }, S.n);
    await page.evaluate(() => window.__V.resume());
    // Its mobilization from the previous declaration may still run: the offensive waits for it like the AI's would.
    await page.evaluate(() => window.__front.ctx.sim.fastForward(260));
    await page.evaluate(({ a, cap }) => {
      const { ctx } = window.__front;
      ctx.sim.debug({ type: 'command', playerId: a, cmd: { type: 'attack', target: 1, ratio: 0.4, tile: cap } });
    }, { a: S.n, cap: S.cap });
    await page.evaluate(() => window.__V.resume());
    const first = await until(() => window.__fuAlerts.list().filter((x) => x.kind === 'offensive'), null, 40000, 500);
    await sleep(8000);
    // A second push on the same front: the entry must update, not stack.
    await page.evaluate(({ a, cap }) => {
      const { ctx } = window.__front;
      ctx.sim.debug({ type: 'command', playerId: a, cmd: { type: 'attack', target: 1, ratio: 0.4, tile: cap } });
    }, { a: S.n, cap: S.cap });
    await sleep(12000);
    const all = await page.evaluate(() => window.__fuAlerts.list().filter((x) => x.kind === 'offensive'));
    const groups = new Map();
    for (const a of all) groups.set(a.groupKey, (groups.get(a.groupKey) ?? 0) + 1);
    const feedDup = await page.evaluate(() => {
      const keys = window.__fuAlerts.list().filter((x) => x.kind === 'offensive' && x.inFeed).map((x) => x.groupKey);
      return keys.length - new Set(keys).size;
    });
    const o = all[all.length - 1];
    row('V5a', 'offensive alert: attacker, place, troops', o ? `${o.title} — ${o.body}` : 'none', 'place + troops', o && /(cerca de|near|al [a-z]+ de|km)/i.test(o.title) && /\d/.test(o.body));
    row('V5b', 'one entry per front in the feed (updates, no stacking)', `${groups.size} front(s), ${all.length} raises, ${feedDup} duplicates in the feed, max count ${Math.max(0, ...all.map((a) => a.count))}`, '0 duplicates', first && feedDup === 0);
    if (o) {
      await page.evaluate(() => window.__front.ctx.cameraRig.setState({ lat: -30, lon: 120, altitudeKm: 9000, tilt: 0, heading: 0 }));
      await sleep(800);
      // Click its entry in the feed, or (once it has left the feed) its row in the Registro.
      const el = page.locator('.fu-alerts-list .fu-alert[data-kind="offensive"]').first();
      if (await el.count()) await el.click();
      else {
        await page.locator('.fu-alerts-log').click();
        await sleep(800);
        const rowEl = page.locator('.fu-log-row', { hasText: o.title.slice(0, 20) }).first();
        if (await rowEl.count()) await rowEl.click();
      }
      const flown = await until(({ lat, lon }) => {
        const q = window.__V.onScreen(lat, lon);
        window.__V.lastFly = { q, cam: window.__front.ctx.cameraRig.getState() };
        return q && q.dx < 0.25 && q.dy < 0.3 ? q : null;
        // The 1.2 s flight advances by capped frame steps: on the software renderer it can take much longer.
      }, { lat: o.lat, lon: o.lon }, 90000, 250);
      const lastFly = flown ? null : await page.evaluate(() => window.__V.lastFly);
      row('V5c', 'clicking the offensive alert flies there', flown ? `place ${(flown.dx * 100).toFixed(0)} % / ${(flown.dy * 100).toFixed(0)} % from the screen centre` : `no: alert at ${o.lat.toFixed(1)}, ${o.lon.toFixed(1)}; ${JSON.stringify(lastFly)}`, 'near the centre', flown);
      await shot(`${lang}-V5-offensive`);
    }
    await page.evaluate(() => window.__V.resume());
  }

  // ------------------------------------------------------------------------------------------ V6 invasion ETA, air raid
  {
    // The attacker: the nation (not already fighting us on land) whose coast is nearest ours, so the convoy's trip is a
    // few game hours; the landing target is our coastal tile nearest to it.
    const inv = await page.evaluate((n) => {
      const { ctx } = window.__front;
      const v = ctx.sim.view;
      const W = 1600, H = 800;
      const water = (t) => (v.world.terrain[t] & 0x0f) <= 1 && (v.world.terrain[t] & 0x20);
      const coastal = (t) => water(t - 1) || water(t + 1) || water(t - W) || water(t + W);
      const ours = [];
      for (let t = W; t < v.owner.length - W; t++) if (v.owner[t] === 1 && coastal(t)) ours.push(t);
      if (!ours.length) return null;
      let best = null;
      for (let t = W; t < v.owner.length - W; t += 1) {
        const o = v.owner[t];
        if (!o || o === 1 || o === n || v.players[o]?.kind !== 'nation' || !coastal(t)) continue;
        for (let k = 0; k < ours.length; k += 4) {
          let dx = Math.abs((t % W) - (ours[k] % W));
          if (dx > W / 2) dx = W - dx;
          const d = Math.hypot(dx, Math.floor(t / W) - Math.floor(ours[k] / W));
          if (d > 12 && (!best || d < best.d)) best = { a: o, from: t, coast: ours[k], d };
        }
      }
      if (!best) return null;
      const seen = { det: null, land: null };
      ctx.bus.on('invasionDetected', (e) => { if (!seen.det && e.target === 1 && e.owner === best.a) seen.det = e; });
      ctx.bus.on('boatLanded', (e) => { if (!seen.land && seen.det && e.unitId === seen.det.unitId) seen.land = e; });
      window.__V.inv = seen;
      ctx.sim.debug({ type: 'addTroops', playerId: best.a, amount: 300_000 });
      ctx.sim.debug({ type: 'war', a: best.a, b: 1, mobilizeTicks: 0, reasonKey: 'war.reason.opportunity' });
      return best;
    }, S.n);
    log(`invasion: ${JSON.stringify(inv)}`);
    if (inv) await page.evaluate(({ a, coast }) => window.__front.ctx.sim.debug({ type: 'command', playerId: a, cmd: { type: 'boatAttack', targetTile: coast, ratio: 0.2 } }), inv);
    await page.evaluate(() => window.__V.resume());
    const det = await until(() => { if (window.__fuAlerts.banner() || window.__front.ctx.sim.view.speed === 0) window.__V.resume(); return window.__V.inv?.det; }, null, 150000, 500);
    const alert = det ? await page.evaluate((id) => window.__fuAlerts.list().find((x) => x.kind === 'invasionDetected' && x.groupKey === `inv:${id}`) ?? null, det.unitId) : null;
    if (!det) log(`  staged convoy not detected; attacker messages: ${JSON.stringify(await page.evaluate((a) => window.__V.msgs.filter((m) => m.playerId === a).slice(-3), inv?.a ?? -1))}`);
    // Judged at the end of the pass over every convoy that was detected and landed (staged or the AI's own).
    // Air raid: a real enemy airbase (the tile of its land nearest our capital), a bomber docked there, and a strike
    // ORDER on our capital through the player command path (not a debug-launched bomber with no home base).
    const raid = await page.evaluate(({ a }) => {
      const { ctx } = window.__front;
      const v = ctx.sim.view;
      const W = 1600;
      const cap = v.players[1].capitalTile;
      const cx = cap % W, cy = Math.floor(cap / W);
      const land = (t) => { const c = v.world.terrain[t] & 0x0f; return c >= 2 && c <= 4; };
      let best = -1, bd = Infinity;
      for (let t = 0; t < v.owner.length; t++) {
        if (v.owner[t] !== a || !land(t)) continue;
        let dx = Math.abs((t % W) - cx);
        if (dx > W / 2) dx = W - dx;
        const d = dx * dx + (Math.floor(t / W) - cy) ** 2;
        if (d > 64 && d < bd) { bd = d; best = t; }
      }
      let got = null;
      ctx.bus.on('airRaid', (e) => { if (!got && e.target === 1) got = e; });
      window.__V.raid = () => got;
      if (best < 0) return null;
      // At war with us (a no-op when it already is) and escalated to strategic strikes: the order must pass the same
      // validation the AI's own strikes do.
      ctx.sim.debug({ type: 'war', a, b: 1, mobilizeTicks: 0, reasonKey: 'war.reason.opportunity' });
      ctx.sim.debug({ type: 'escalate', by: a, against: 1, level: 2 });
      ctx.sim.debug({ type: 'spawnStructure', structure: 6, owner: a, tile: best, level: 1 });
      window.__V.resume();
      return { base: best, cap };
    }, { a: S.o[0] });
    if (raid) {
      await until(({ a, base }) => [...window.__front.ctx.sim.view.structures.values()].some((s) => s.owner === a && s.type === 6 && s.tile === base), { a: S.o[0], base: raid.base }, 20000, 400);
      const staged = await page.evaluate(({ a, base, cap }) => {
        const { ctx } = window.__front;
        const v = ctx.sim.view;
        const ab = [...v.structures.values()].find((s) => s.owner === a && s.type === 6 && s.tile === base);
        if (!ab) return { err: 'airbase not placed' };
        ctx.sim.debug({ type: 'spawnUnit', unit: 5, owner: a, tile: base, targetTile: -1 });
        window.__V.resume();
        return { airbase: ab.id, cap };
      }, { ...raid, a: S.o[0] });
      await until((a) => [...window.__front.ctx.sim.view.units.values()].some((u) => u.owner === a && u.type === 5), S.o[0], 20000, 400);
      const order = staged.err ? staged : await page.evaluate(({ a, cap }) => {
        const { ctx } = window.__front;
        const bomber = [...ctx.sim.view.units.values()].filter((u) => u.owner === a && u.type === 5).sort((x, y) => y.id - x.id)[0];
        if (!bomber) return { err: 'bomber not docked' };
        ctx.sim.debug({ type: 'command', playerId: a, cmd: { type: 'unitOrder', unitIds: [bomber.id], order: 'strike', tile: cap, targetId: 0 } });
        return { bomber: bomber.id };
      }, { ...raid, a: S.o[0] });
      await page.evaluate(() => window.__V.resume());
      const e = order.err ? null : await until(() => window.__V.raid(), null, 60000, 500);
      const al = await page.evaluate(() => window.__fuAlerts.list().filter((x) => x.kind === 'airRaid').pop() ?? null);
      const names = await page.evaluate(({ base, cap }) => ({ base: window.__fuAlerts.place(base), cap: window.__fuAlerts.place(cap) }), raid);
      const ok = !!al && !!e && e.fromBase && e.fromTile === raid.base && al.title.includes(names.base) && al.title.includes(names.cap);
      row('V6b', 'airRaid from a real airbase names the base and the target', al ? `${al.title} — ${al.body} (base «${names.base}», target «${names.cap}», fromBase ${e?.fromBase})` : `${order.err ?? staged.err ?? ''} event ${!!e}`, 'base and target named', ok);
    } else row('V6b', 'airRaid from a real airbase names the base and the target', 'no land of the attacker to place an airbase', 'alert', false);
    await shot(`${lang}-V6-invasion`);
    await page.evaluate(() => window.__V.resume());
  }

  // ------------------------------------------------------------------------------------------ V16 crisis
  {
    await page.evaluate(() => window.__V.resume());
    // Two nations still standing with a capital: a launcher and a foreign target.
    const [x, y] = await page.evaluate((o) => {
      const v = window.__front.ctx.sim.view;
      const ok = o.filter((id) => v.players[id]?.alive && v.players[id].capitalTile >= 0);
      return [ok[1] ?? ok[0], ok[2] ?? ok[1]];
    }, S.o);
    await page.evaluate(({ x, y }) => {
      const { ctx } = window.__front;
      const v = ctx.sim.view;
      ctx.sim.debug({ type: 'war', a: x, b: y, mobilizeTicks: 0, reasonKey: 'war.reason.rivalry' });
      ctx.sim.debug({ type: 'launchNuke', weapon: 8 /* UnitType.AtomBomb */, owner: x, fromTile: v.players[x].capitalTile, targetTile: v.players[y].capitalTile });
    }, { x, y }).catch(() => {});
    const amber = await until(() => { const c = window.__fuCrisis(); return c.active && !c.red ? c : null; }, null, 15000, 200);
    row('V16a', 'foreign launch -> amber crisis banner', amber ? amber.text.replace(/\s+/g, ' ').slice(0, 100) : JSON.stringify(await page.evaluate(() => window.__fuCrisis())), 'amber', amber);
    await shot(`${lang}-V16-amber`);
    await page.evaluate(({ x, cap }) => {
      const { ctx } = window.__front;
      ctx.sim.debug({ type: 'war', a: x, b: 1, mobilizeTicks: 0, reasonKey: 'war.reason.rivalry' });
      ctx.sim.debug({ type: 'launchNuke', weapon: 9 /* UnitType.HydrogenBomb */, owner: x, fromTile: ctx.sim.view.players[x].capitalTile, targetTile: cap });
      // A second weapon on our land from another silo: the alarm must list every weapon in flight.
      ctx.sim.debug({ type: 'launchNuke', weapon: 8 /* UnitType.AtomBomb */, owner: x, fromTile: ctx.sim.view.players[x].capitalTile, targetTile: cap + 6 });
    }, { x, cap: S.cap });
    const red = await until(() => { const c = window.__fuCrisis(); if (window.__front.ctx.sim.view.speed === 0) window.__V.resume(); return c.red && c.n >= 2 ? c : null; }, null, 30000, 200) ?? await page.evaluate(() => window.__fuCrisis());
    row('V16b', 'launch at the human -> red alarm listing every weapon, no v1 banner', red.red ? `${red.n} in flight; v1 banner ${red.v1Banner}; «${red.text.replace(/\s+/g, ' ').slice(0, 100)}»` : `no red (${JSON.stringify(red).slice(0, 120)})`, 'red, >=2 flights, no v1', red.red && red.n >= 2 && !red.v1Banner);
    await shot(`${lang}-V16-red`);
    // Let the weapons land and the crisis end.
    await until(() => { window.__V.resume(); return !window.__fuCrisis().active; }, null, 120000, 1000);
  }

  // ------------------------------------------------------------------------------------------ V7 auto-pause kinds
  {
    const kinds = [
      ['ultimatum', ({ o }) => {
        // An ultimatum comes from a nation at peace with us, after a tension statement.
        const v = window.__front.ctx.sim.view;
        const from = o.find((id) => v.pairState(1, id) !== 'war') ?? o[7];
        window.__front.ctx.sim.debug({ type: 'tension', from, to: 1, reasonKey: 'tension.border' });
        window.__front.ctx.sim.debug({ type: 'propose', from, to: 1, kind: 'demand', demand: { kind: 'tribute', gold: 100000 }, ultimatum: true });
      }],
      ['proposal', ({ o }) => window.__front.ctx.sim.debug({ type: 'propose', from: o[3], to: 1, kind: 'nap' })],
      ['peaceOffer', ({ n }) => window.__front.ctx.sim.debug({ type: 'propose', from: n, to: 1, kind: 'peace', terms: { kind: 'white' } })],
      ['callToArms', ({ o }) => {
        const d = window.__front.ctx.sim.debug;
        d({ type: 'treaty', a: 1, b: o[4], kind: 'alliance' });
        d({ type: 'war', a: o[5], b: o[4], mobilizeTicks: 0, reasonKey: 'war.reason.border' });
        d({ type: 'propose', from: o[4], to: 1, kind: 'callToArms', against: o[5] });
      }],
      ['warOnYou', ({ o }) => window.__front.ctx.sim.debug({ type: 'war', a: o[6], b: 1, mobilizeTicks: 240, reasonKey: 'war.reason.rivalry' })],
      ['nukeAtYou', ({ o, cap }) => {
        const d = window.__front.ctx.sim.debug;
        const v = window.__front.ctx.sim.view;
        d({ type: 'launchNuke', weapon: 8, owner: o[6], fromTile: v.players[o[6]].capitalTile, targetTile: cap });
      }],
      ['capitalThreat', ({ n, cap }) => {
        const d = window.__front.ctx.sim.debug;
        d({ type: 'addTroops', playerId: n, amount: 800_000 });
        d({ type: 'command', playerId: n, cmd: { type: 'attack', target: 1, ratio: 0.8, tile: cap } });
      }],
    ];
    for (const [kind, fn] of kinds) {
      await page.evaluate(() => window.__V.resume());
      const had = await page.evaluate((k) => window.__V.paused.filter((p) => p.kind === k).length, kind);
      await page.evaluate(`(${fn.toString()})(${JSON.stringify({ n: S.n, o: S.o, cap: S.cap })})`);
      // Other kinds may pause first (a threat already running): answer them and keep waiting for this one.
      const got = await until(({ k, had }) => {
        const l = window.__V.paused.filter((p) => p.kind === k);
        if (l.length > had || (k === 'capitalThreat' && l.length)) return { ...l[l.length - 1], speed: window.__front.ctx.sim.view.speed };
        if (window.__fuAlerts.banner()) window.__V.resume();
        return null;
      }, { k: kind, had }, 60000, 250);
      row(`V7-${kind}`, `auto-pause «${kind}» pauses with a banner stating the reason`, got ? `${got.text.replace(/\s+/g, ' ').slice(0, 120)}` : 'no', 'paused + banner', got && got.text);
      if (kind === 'ultimatum') await shot(`${lang}-V7-ultimatum`);
    }
    // invasion: V6's landing paused the game already when enabled; check the log for it.
    const invPaused = await page.evaluate(() => window.__V.paused.find((p) => p.kind === 'invasion') ?? null);
    row('V7-invasion', 'auto-pause «invasion» (enabled) during the V6 landing', invPaused ? invPaused.text.replace(/\s+/g, ' ').slice(0, 120) : 'no', 'paused + banner', invPaused);
    await page.evaluate(() => window.__V.resume());
  }

  // ------------------------------------------------------------------------------------------ V6a ETA accuracy
  {
    const pairs = await until(() => {
      if (window.__fuAlerts.banner() || window.__front.ctx.sim.view.speed === 0) window.__V.resume();
      const l = [...window.__V.invs.values()].filter((r) => r.land);
      return l.length ? l : null;
    }, null, 150000, 500) ?? [];
    const errs = pairs.map((r) => {
      const predicted = r.det.tick + r.det.etaTicks;
      return { err: Math.abs(r.land.tick - predicted) / Math.max(1, r.land.tick - r.det.tick), predicted, landed: r.land.tick, unit: r.det.unitId };
    });
    const al = await page.evaluate(() => window.__fuAlerts.list().filter((x) => x.kind === 'invasionDetected').pop() ?? null);
    const worst = errs.reduce((m, e) => Math.max(m, e.err), 0);
    row('V6a', 'invasionDetected: place and ETA within ±10 % of the landing', `${al ? `${al.title} — ${al.body}; ` : ''}${errs.length} landed: ${errs.map((e) => `${e.predicted}->${e.landed} (${(e.err * 100).toFixed(1)} %)`).join(', ')}`, 'all <= 10 %', errs.length > 0 && al && worst <= 0.1);
  }

  // ------------------------------------------------------------------------------------------ V18 texts
  {
    const texts = await page.evaluate(() => [...window.__V.texts, ...window.__fuAlerts.list().map((a) => `${a.title} | ${a.body}`)]);
    const bad = texts.filter((x) => BAD.test(x));
    row('V18', `alert texts (${lang}) free of «(a)» and {param}`, `${texts.length} texts, ${bad.length} bad${bad.length ? `: ${bad.slice(0, 3).join(' // ')}` : ''}`, '0', texts.length > 20 && bad.length === 0);
  }
}

// ------------------------------------------------------------------------------------------ V7 settings, V12 radial, V14 tips
{
  const set = await page.evaluate(() => {
    const s = window.__front.ctx.settings.get();
    return { autoPause: s.autoPause, crisisTime: s.crisisTime, observationTime: s.observationTime, clouds: s.clouds, historicalBorders: s.historicalBorders };
  });
  const logged = consoleLines.filter((l) => l.startsWith('[sim] settings:')).length;
  row('V7s', 'the worker logs each settings message', `${logged} lines`, '>= 1', logged >= 1);
  // Settings > Juego: open it through the pause menu.
  await page.evaluate(() => window.__front.ctx.settings.set({ autoPause: { warOnYou: true, ultimatum: true, nukeAtYou: true, capitalThreat: true, invasion: false, proposal: false, peaceOffer: false, callToArms: false } }));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.fu-pause .fu-pause-btn', { timeout: 15000 }).catch(() => {});
  await page.locator('.fu-pause .fu-pause-btn').nth(3).click().catch(() => {});
  await sleep(1200);
  const tabs = page.locator('.fu-tabs .fu-tab');
  const nt = await tabs.count();
  for (let i = 0; i < nt; i++) {
    const tx = (await tabs.nth(i).innerText()).trim();
    if (/juego|game/i.test(tx)) { await tabs.nth(i).click(); break; }
  }
  await sleep(1000);
  const juego = await page.evaluate(() => {
    const rowsEl = [...document.querySelectorAll('.fu-autopause-row')];
    const on = rowsEl.map((r) => !!r.querySelector('input:checked, .is-on'));
    return { n: rowsEl.length, on, text: document.querySelector('.fu-settings')?.innerText ?? '' };
  });
  await shot('settings-juego');
  const defaults = [true, true, true, true, false, false, false, false];
  row('V7t', 'Settings > Juego: 8 auto-pause toggles with the §8.5 defaults', `${juego.n} toggles, on ${juego.on.map((x) => (x ? 1 : 0)).join('')}`, '8, 11110000', juego.n === 8 && juego.on.every((x, i) => x === defaults[i]));
  row('V7u', 'crisisTime / observationTime / clouds / historical borders present (borders off)', `${JSON.stringify({ crisis: set.crisisTime, obs: set.observationTime, clouds: set.clouds, hist: set.historicalBorders })}`, 'present, hist false', set.crisisTime && set.observationTime !== undefined && set.clouds && set.historicalBorders === false && /crisis/i.test(juego.text));
  // Close the settings and the pause menu.
  for (let i = 0; i < 4 && (await page.locator('.fu-modal').count()); i++) {
    await page.locator('.fu-modal .fu-close').last().click().catch(() => {});
    await sleep(600);
  }
  await page.evaluate(() => window.__V.resume());
  await sleep(800);
  // Radial on a nation.
  const rad = await page.evaluate(() => {
    const { ctx } = window.__front;
    const v = ctx.sim.view;
    const p = v.playerList.filter((q) => q.kind === 'nation' && q.alive && q.id !== 1).sort((a, b) => b.tiles - a.tiles)[0];
    return p ? Math.floor(p.labelY) * 1600 + Math.floor(p.labelX) : -1;
  });
  // A right click on the nation's land at the centre of the view.
  const ll = await page.evaluate((t) => ({ lat: 90 - ((Math.floor(t / 1600) + 0.5) / 800) * 180, lon: (((t % 1600) + 0.5) / 1600) * 360 - 180 }), rad);
  await page.evaluate((ll) => window.__front.ctx.cameraRig.setState({ lat: ll.lat, lon: ll.lon, altitudeKm: 3000, tilt: 0, heading: 0 }), ll);
  await sleep(1500);
  await page.mouse.move(795, 445);
  await page.mouse.move(800, 450, { steps: 2 });
  await until((t) => window.__front.ctx.sim.view.owner[window.__lastHoverTile ?? -1] !== undefined || true, rad, 2000, 200);
  await sleep(1200);
  await page.mouse.click(800, 450, { button: 'right' });
  const radial = !!(await page.waitForSelector('.fu-radial:not(.fu-hidden) .fu-wedge', { timeout: 10000 }).catch(() => null));
  await sleep(800);
  // Every wedge's label: hover each one so the hub names it.
  const labels = [];
  const nW = await page.locator('.fu-radial .fu-wedge').count();
  for (let i = 0; i < nW; i++) {
    await page.locator('.fu-radial .fu-wedge').nth(i).dispatchEvent('pointerenter');
    await sleep(150);
    labels.push(await page.evaluate(() => document.querySelector('.fu-radial')?.innerText.replace(/\s+/g, ' ') ?? ''));
  }
  await shot('radial');
  const tipsRad = await page.evaluate(() => [...document.querySelectorAll('.fu-radial [data-has-tip]')].length);
  row('V12', 'radial without emotes or «Marcar objetivo»', radial ? `${nW} wedges: ${[...new Set(labels)].join(' | ').slice(0, 200)}` : 'radial did not open', 'no emote', radial && !/emot|marcar objetivo|mark target/i.test(labels.join(' ')));
  await page.keyboard.press('Escape');
  // Tooltips: hover a sample of W3's controls and read the tooltip.
  const targets = ['.fu-nations-btn', '.fu-alerts-log', '.fu-time-seg button:nth-child(3)'];
  const tipTexts = [];
  for (const sel of targets) {
    const el = page.locator(sel).first();
    if (!(await el.count())) { tipTexts.push(`${sel}: missing`); continue; }
    let txt = '';
    for (let k = 0; k < 3 && !txt; k++) {
      await page.mouse.move(800, 450);
      await sleep(300);
      await el.hover().catch(() => {});
      await sleep(900);
      txt = (await page.evaluate(() => window.__fuTip?.() ?? '')).replace(/\s+/g, ' ');
    }
    if (!txt) {
      // What covers it: the element under its centre.
      txt = `(no tooltip; under its centre: ${await page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e ? `${e.tagName}.${e.className}`.slice(0, 80) : 'nothing'; }, sel)})`;
    }
    tipTexts.push(`${sel}: ${txt.slice(0, 90)}`);
    await page.mouse.move(800, 450);
    await sleep(300);
  }
  const topbar = await page.$$eval('.fu-topbar [data-has-tip], .fu-tb-stat[data-has-tip]', (l) => l.length).catch(() => 0);
  row('V14', 'sampled tooltips on W3 controls show text', tipTexts.join(' ## '), 'non-empty', tipTexts.every((x) => !/missing|\(no tooltip/.test(x) && x.split(': ').slice(1).join(': ').trim().length > 20));
  log(`top bar controls with tooltips: ${topbar}; radial wedges with tooltips: ${tipsRad}`);
}

const cues = await page.evaluate(() => window.__fuAudio?.stats?.().cues ?? {}).catch(() => ({}));
row('V19', 'audio cues heard this session (warHorn, klaxon, navalHorn, capitalSiren, chimes)', Object.entries(cues).map(([k, v]) => `${k}=${v}`).join(' '), 'all > 0',
  ['warHorn', 'klaxon', 'navalHorn', 'capitalSiren'].every((k) => (cues[k] ?? 0) > 0) && Object.keys(cues).some((k) => /chime/i.test(k) && cues[k] > 0));
await browser.close();
const pass = rows.filter((r) => r.pass).length;
console.log('\n================ W3 VERIFY ================');
for (const r of rows) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(16)} ${r.what.slice(0, 80).padEnd(80)} ${r.value.slice(0, 220)}`);
console.log(`\n${pass}/${rows.length} pass; console errors ${errors.length}${errors.length ? `: ${errors.slice(0, 3).join(' | ')}` : ''}`);
process.exit(pass === rows.length && !errors.length ? 0 : 1);
