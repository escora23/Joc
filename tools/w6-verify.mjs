// W6 browser verifier (DESIGN_V2 §16.7 acceptance). Drives the real game in Chromium (SwiftShader) on staged but REAL
// wars (the ?shot= stagers only issue sim commands and run real ticks) and measures each criterion.
//   node tools/w6-verify.mjs [--url http://127.0.0.1:5440/] [--out shots/W6-battle-clarity/verify] [--only orbit,mob,600,plume,ground,obs]
// Headless sim criteria (A2 momentum reversal, A4 priority/T34/retreat, A5 key stability) are in src/sim/test/w6-audit.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5440/';
const out = args.out || 'shots/W6-battle-clarity/verify';
const only = args.only ? new Set(args.only.split(',')) : null;
fs.mkdirSync(out, { recursive: true });
const results = [];
const row = (id, what, value, pass) => {
  results.push({ id, what, value, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${what} :: ${value}`);
};
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
let errors = 0;
async function open(shot, params = '') {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => { errors++; console.log(`[pageerror] ${e.message}`); });
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('[w6]')) console.log(`   ${t.slice(0, 600)}`); });
  await page.goto(`${base}?shot=${shot}${params}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__shotReady === true || window.__shotError, null, { timeout: 1_800_000 });
  await page.waitForTimeout(1500);
  return page;
}
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`), timeout: 300000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------------
// V1 / V13 / V4 / V12: orbit overlay, badge, Guerra panel, audio caps
// ---------------------------------------------------------------------------------------------------------------
if (!only || only.has('orbit')) {
  const page = await open('front-orbit', '&audio=1');
  await shot(page, 'front-orbit');
  const o = await page.evaluate(() => {
    const v = __front.ctx.sim.view;
    const st = window.__frontOverlay.stats();
    const f = v.fronts.find((q) => !q.quiet && (q.a === 1 || q.b === 1));
    const atk = f ? v.attacks.find((a) => a.frontKey === f.key) : null;
    const badges = [...document.querySelectorAll('.fu-fb')].filter((e) => e.style.display !== 'none').map((e) => ({ text: e.textContent, key: +e.dataset.key, share: +e.dataset.share, gaining: +e.dataset.gaining, att: +e.dataset.att, def: +e.dataset.def }));
    const iso = (id) => (id === 1 ? 'TÚ' : v.world.countries[v.players[id].countryIndex]?.iso3);
    return { st, f: f && { key: f.key, a: f.a, b: f.b, m: f.momentum, kmh: f.advanceKmh, pa: f.pa, pd: f.pd }, atk: atk && { id: atk.id, fr: atk.frontageTiles, attacker: atk.attacker }, badges, isoA: f && iso(f.a), isoB: f && iso(f.b), calls: __front.ctx.renderer.info.render.calls };
  });
  const b = o.badges.find((x) => o.f && x.key === o.f.key);
  row('V1a', 'band in both colours with chevrons toward the side losing ground', o.f ? `front ${o.f.key} momentum ${o.f.m} chevron ${JSON.stringify(o.st.chevrons[o.f.key])}` : 'no front', !!o.f && o.st.fronts > 0 && o.st.chevrons[o.f.key]?.dir === Math.sign(o.f.m) && Math.abs(o.f.m) > 0.1);
  const arrow = o.atk ? o.st.arrows.find((a) => a.attackId === o.atk.id) : null;
  row('V1b', 'operational arrow as wide as the corridor (±15 %)', arrow ? `${Math.round(arrow.widthKm)} km vs corridor ${Math.round(o.atk.fr * 25)} km, ${arrow.lengthKm} km long` : 'none', !!arrow && Math.abs(arrow.widthKm / (o.atk.fr * 25) - 1) <= 0.15);
  row('V1c', 'badge: both ISO3 codes, tug-of-war bar Pa/(Pa+Pd), measured km/h', b ? `${b.text} share ${b.share} (Pa/(Pa+Pd) ${(o.f.pa / (o.f.pa + o.f.pd)).toFixed(3)})` : 'no badge', !!b && b.text.includes(o.isoA) && b.text.includes(o.isoB) && /km\/h/.test(b.text) && Math.abs(b.share - o.f.pa / (o.f.pa + o.f.pd)) < 0.02);
  row('V13', 'overlay draw calls / allocation (2 batches, preallocated)', `${o.st.drawCalls} draw calls, ${o.st.bandVerts}+${o.st.arrowVerts} vertices, ${o.st.rebuilds} rebuilds`, o.st.drawCalls <= 4);
  // Guerra panel: G opens it; rows with garrisons; Ir; Prioridad alta; Proponer paz; Pedir ayuda; Retirar.
  await page.evaluate(() => { __front.ctx.app.setSpeed(0); });
  await page.mouse.move(800, 450);
  await page.keyboard.press('g');
  await page.waitForTimeout(1500);
  const panel = await page.evaluate(() => {
    const el = document.querySelector('.fu-warpanel');
    return { open: !!el && !el.classList.contains('fu-hidden'), text: el?.textContent ?? '', rows: window.__fuFronts?.rows() ?? [] };
  });
  row('V4a', 'G opens the Guerra panel listing the war and its fronts with both garrisons, km/h, divisions, tiles, time', `${panel.rows.length} front rows; ${panel.text.slice(0, 260)}`, panel.open && panel.rows.length > 0 && /Guarnición: tú/.test(panel.text) && /km\/h/.test(panel.text) && /Divisiones/.test(panel.text) && /casillas/.test(panel.text));
  await shot(page, 'fronts-panel');
  const cam0 = await page.evaluate(() => __front.ctx.cameraRig.getState());
  await page.click('.fu-war-front .fu-war-actions button:first-child');
  let cam1 = cam0;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(1000);
    cam1 = await page.evaluate(() => __front.ctx.cameraRig.getState());
    if (cam1.altitudeKm < 1500) break;
  }
  row('V4b', 'Ir flies to the front', `alt ${Math.round(cam0.altitudeKm)} -> ${Math.round(cam1.altitudeKm)} km`, Math.abs(cam1.altitudeKm - cam0.altitudeKm) > 200);
  // A second front (a landing-sized pocket of the enemy on our southern coast), so priority has troops to move.
  await page.evaluate(() => {
    const v = __front.ctx.sim.view;
    const w = v.wars.find((x) => x.aggressor === 1 || x.target === 1);
    const enemy = w.aggressor === 1 ? w.target : w.aggressor;
    __front.ctx.sim.debug({ type: 'conquer', playerId: enemy, centerTile: Math.floor((90 - 38.2) / 180 * 800) * 1600 + Math.floor((-3.2 + 180) / 360 * 1600), radius: 3 });
    __front.ctx.app.setSpeed(4);
  });
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (await page.evaluate(() => __front.ctx.sim.view.fronts.filter((f) => f.a === 1 || f.b === 1).length >= 2)) break;
  }
  await page.evaluate(() => __front.ctx.app.setSpeed(0));
  await sleep(2000);
  const before = await page.evaluate(() => { const k = window.__fuFronts.rows()[0]; const f = __front.ctx.sim.view.frontByKey.get(k); const s = f.a === 1 ? 'A' : 'B'; return { k, s, t: f['targetShare' + s], p: f['priority' + s], g: f['garrison' + s] }; });
  await page.click('.fu-war-front .fu-war-prio button[data-prio="2"]');
  await page.evaluate(() => __front.ctx.app.setSpeed(1));
  const t0 = await page.evaluate(() => __front.ctx.sim.view.tick);
  let after = null;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    after = await page.evaluate((b) => { const v = __front.ctx.sim.view; const f = v.frontByKey.get(b.k); return f ? { tick: v.tick, t: f['targetShare' + b.s], p: f['priority' + b.s], g: f['garrison' + b.s] } : null; }, before);
    if (after && after.tick - t0 >= 60) break;
  }
  await page.evaluate(() => __front.ctx.app.setSpeed(0));
  const nFronts = await page.evaluate(() => __front.ctx.sim.view.fronts.filter((f) => f.a === 1 || f.b === 1).length);
  row('V4c', `Prioridad alta raises the target share and Gf over ~60 ticks (${nFronts} fronts of ours)`, after ? `priority ${before.p} -> ${after.p}, target ${before.t} -> ${after.t}, Gf ${before.g} -> ${after.g} after ${after.tick - t0} ticks` : 'front gone', !!after && after.p === 2 && (nFronts < 2 ? true : after.t > before.t));
  await page.click('.fu-war-card .fu-war-actions .fu-btn--success');
  await page.waitForTimeout(1500);
  const peace = await page.evaluate(() => !!document.querySelector('.fu-peace-modal'));
  row('V4d', 'Proponer paz opens the W3 peace-terms dialog', peace ? 'dialog open' : 'no dialog', peace);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  const help = await page.evaluate(() => {
    const v = __front.ctx.sim.view;
    const w = v.wars.find((x) => x.aggressor === 1 || x.target === 1);
    const enemy = w.aggressor === 1 ? w.target : w.aggressor;
    const ally = v.playerList.find((p) => p.alive && p.kind === 'nation' && p.id !== enemy && p.id !== 1 && v.pairState(p.id, enemy) !== 'war');
    __front.ctx.sim.debug({ type: 'treaty', a: 1, b: ally.id, kind: 'alliance' });
    return { ally: ally.id, enemy };
  });
  await page.waitForTimeout(2500);
  const helpBtn = await page.$('.fu-war-card .fu-war-actions button:nth-child(2)');
  await helpBtn.click();
  await page.waitForTimeout(2500);
  const asked = await page.evaluate((h) => [...__front.ctx.sim.view.proposals.values()].some((p) => p.from === 1 && p.to === h.ally && p.kind === 'callToArms'), help);
  row('V4e', 'Pedir ayuda sends a call to arms to the allies (W3 proposal flow)', asked ? `callToArms to ${help.ally}` : 'none', asked);
  // Contraofensiva then Retirar: our own offensive on this front, ended with a 10 % loss.
  await page.click('.fu-war-front .fu-btn--amber');
  await page.evaluate(() => __front.ctx.app.setSpeed(1));
  await page.waitForTimeout(8000);
  const own = await page.evaluate(() => { const a = __front.ctx.sim.view.attacks.find((x) => x.attacker === 1 && x.defender > 0); return a ? { id: a.id, troops: a.troops } : null; });
  await page.evaluate(() => __front.ctx.app.setSpeed(0));
  await page.waitForTimeout(1500);
  const retreatVisible = await page.evaluate(() => { const b = document.querySelector('.fu-war-front .fu-btn--danger'); return !!b && !b.classList.contains('fu-hidden'); });
  if (retreatVisible) await page.click('.fu-war-front .fu-btn--danger');
  await page.waitForTimeout(1500);
  const state = await page.evaluate((o) => __front.ctx.sim.view.attacks.find((a) => o && a.id === o.id)?.state ?? 'gone', own);
  row('V4f', 'Contraofensiva launches ours; Retirar ends it (troops come home in 2 h, 10 % loss: w6-audit A4e)', `offensive ${own ? own.id : 'none'} -> ${state}`, !!own && retreatVisible && (state === 'retreating' || state === 'gone'));
  // Audio caps near a busy front: 60 real seconds at 300 km, running.
  await page.keyboard.press('g');
  await page.evaluate(() => { const v = __front.ctx.sim.view; const f = v.fronts.find((q) => !q.quiet); const s = f.samples; const m = (s.length >> 2) << 1; const x = s[m], y = s[m + 1]; __front.ctx.cameraRig.setState({ lat: 90 - y / 800 * 180, lon: x / 1600 * 360 - 180, altitudeKm: 300, tilt: 0.4 }); __front.ctx.app.setSpeed(4); });
  await page.evaluate(() => __front.ctx.audio.unlock());
  await sleep(1500);
  const a0 = await page.evaluate(() => window.__fuAudio.stats().combat);
  await sleep(60000);
  const a1 = await page.evaluate(() => window.__fuAudio.stats().combat);
  row('V12', 'combat cues over 60 s near a busy front: <= 2/s per front, <= 6/s in total', `played ${a1.played - a0.played}, dropped ${a1.dropped - a0.dropped}, max ${a1.maxPerSecond}/s total, ${a1.maxFrontPerSecond}/s per front`, a1.played - a0.played > 0 && a1.maxPerSecond <= 6 && a1.maxFrontPerSecond <= 2);
  await page.close();
}

// ---------------------------------------------------------------------------------------------------------------
// V3: mobilization arrows and dashed quiet fronts
// ---------------------------------------------------------------------------------------------------------------
if (!only || only.has('mob')) {
  const page = await open('front-mobilization');
  await shot(page, 'front-mobilization');
  const m = await page.evaluate(() => { const v = __front.ctx.sim.view; const w = v.wars.find((x) => x.target === 1 || x.aggressor === 1); return { st: window.__frontOverlay.stats(), tick: v.tick, until: w?.mobilizeUntilTick, quiet: v.fronts.filter((f) => f.quiet && (f.a === 1 || f.b === 1)).length }; });
  row('V3a', 'during the mobilization: pulsing arrows on the aggressor side; the quiet front dashed', `${m.st.mobilization} arrows, ${m.st.quiet} quiet fronts drawn dashed, tick ${m.tick} < ${m.until}`, m.st.mobilization > 0 && m.st.quiet > 0 && m.tick < m.until);
  await page.evaluate(() => __front.ctx.app.setSpeed(4));
  for (let i = 0; i < 400; i++) {
    await sleep(1000);
    const done = await page.evaluate(() => { const v = __front.ctx.sim.view; const w = v.wars.find((x) => x.target === 1 || x.aggressor === 1); return !w || v.tick > w.mobilizeUntilTick + 3; });
    if (done) break;
  }
  await page.evaluate(() => __front.ctx.app.setSpeed(0));
  await sleep(2500);
  const m2 = await page.evaluate(() => ({ st: window.__frontOverlay.stats(), tick: __front.ctx.sim.view.tick }));
  row('V3b', 'the mobilization arrows disappear at mobilizeUntilTick', `${m2.st.mobilization} arrows at tick ${m2.tick}`, m2.st.mobilization === 0);
  await page.close();
}

// ---------------------------------------------------------------------------------------------------------------
// V6: front-600 smoke coverage and flashes inside the band
// ---------------------------------------------------------------------------------------------------------------
if (!only || only.has('600')) {
  const page = await open('front-600', '&clouds=hidden&freeze=1&hud=0');
  await page.evaluate(() => __front.ctx.app.setSpeed(1));
  await sleep(20000);
  await page.evaluate(() => __front.ctx.app.setSpeed(0));
  await sleep(1500);
  const withP = path.join(out, 'front-600.png');
  await page.screenshot({ path: withP, timeout: 300000 });
  await page.evaluate(() => window.__battleDebug.setLayerVisible(false));
  await sleep(2500);
  const noP = path.join(out, 'front-600-nobattle.png');
  await page.screenshot({ path: noP, timeout: 300000 });
  await page.evaluate(() => window.__battleDebug.setLayerVisible(true));
  const far = await page.evaluate(() => window.__battleDebug.farStats());
  // Pixel whiteness: pixels at least 25 luma brighter and lower in saturation with the battle layer than without.
  const cov = await page.evaluate(async ([a, b]) => {
    const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height;
    const g = c.getContext('2d');
    g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, c.width, c.height).data;
    g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < da.length; i += 4) {
      const la = 0.3 * da[i] + 0.59 * da[i + 1] + 0.11 * da[i + 2], lb = 0.3 * db[i] + 0.59 * db[i + 1] + 0.11 * db[i + 2];
      const sa = Math.max(da[i], da[i + 1], da[i + 2]) - Math.min(da[i], da[i + 1], da[i + 2]);
      if (la - lb > 25 && sa < 60) n++;
    }
    return n / (da.length / 4);
  }, ['data:image/png;base64,' + fs.readFileSync(withP).toString('base64'), 'data:image/png;base64,' + fs.readFileSync(noP).toString('base64')]);
  row('V6a', 'front-600 (clouds hidden, frozen): smoke and haze cover <= 25 % of the screen', `${(cov * 100).toFixed(1)} % whiter pixels; columns per front ${JSON.stringify(far?.columns)}`, cov <= 0.25 && Object.values(far?.columns ?? {}).every((c) => c <= 6));
  row('V6b', 'flashes only within 1.5 tiles of the front line', `${far?.flashes} flashes, farthest ${far?.maxLineDistTiles.toFixed(2)} tiles`, (far?.flashes ?? 0) > 0 && far.maxLineDistTiles <= 1.5);
  await page.close();
}

// ---------------------------------------------------------------------------------------------------------------
// V7: plume-zoom
// ---------------------------------------------------------------------------------------------------------------
if (!only || only.has('plume')) {
  const page = await open('plume-zoom');
  await shot(page, 'plume-zoom');
  const z = await page.evaluate(() => window.__plumeZoom);
  const all = (z ?? []).flatMap((s) => s.plumes.map((p) => ({ alt: s.alt, ...p })));
  row('V7', 'plume at 700 km and 200 km: <= 8 % of the screen height, world size <= 20 km', all.map((p) => `${p.alt} km: ${(p.screenFrac * 100).toFixed(1)} % (${p.heightPx} px), world ${p.worldKm} km drawn ${p.drawnKm}`).join('; ') || 'no plume', all.length >= 2 && all.every((p) => p.screenFrac <= 0.08 && p.worldKm <= 20));
  await page.close();
}

// ---------------------------------------------------------------------------------------------------------------
// V8 / V11: the ground battle from real data, banners and the strip (es and en)
// ---------------------------------------------------------------------------------------------------------------
if (!only || only.has('ground')) {
  const page = await open('front-ground-real', '&quality=medium');
  await shot(page, 'front-ground-real');
  const g = await page.evaluate(() => {
    const d = window.__battleDebug.shown();
    const v = __front.ctx.sim.view;
    const units = d ? d.divisions : [];
    return { d, units, strip: document.querySelector('.fu-bstrip')?.textContent ?? '', stripOn: !!document.querySelector('.fu-bstrip:not(.fu-hidden)'), banners: [...document.querySelectorAll('.fu-bbanner')].filter((e) => e.style.display !== 'none').map((e) => e.textContent), divReal: [...v.units.values()].filter((u) => u.type === 3).length };
  });
  const d = g.d;
  if (d) {
    const errA = d.split[0] ? Math.abs(d.infantry[0] / d.split[0] - 1) : (d.infantry[0] === 0 ? 0 : 1);
    const errB = d.split[1] ? Math.abs(d.infantry[1] / d.split[1] - 1) : (d.infantry[1] === 0 ? 0 : 1);
    row('V8a', 'visible infantry per side within ±10 % of visibleSplit()', `deployed ${d.infantry.join('/')} vs split ${d.split.join('/')}`, errA <= 0.1 && errB <= 0.1 && d.infantry[0] + d.infantry[1] > 0);
    const posErr = Math.max(0, ...d.divisions.map((x) => Math.hypot(x.drawnX - x.realX, x.drawnZ - x.realZ)));
    row('V8b', 'every real division within 50 km: 1 tank per 25 % integrity + 2 IFVs at its real position', `${d.divisions.length} divisions (${d.divisions.map((x) => `#${x.unitId} ${x.tanks}T+${x.ifvs}`).join(', ')}), max centroid offset ${Math.round(posErr)} m`, d.divisions.length > 0 && d.divisions.every((x) => x.ifvs === 2 && x.tanks >= 1 && x.tanks <= 4) && posErr < 300);
    row('V8c', 'the local line lies within 2 km of the sub-tile front position', `shown ${Math.round(d.lineShift)} m vs sim ${Math.round(d.simShift)} m (sub-tile ${d.subTile})`, Math.abs(d.lineShift - d.simShift) <= 2000);
  } else row('V8', 'ground battle built', 'no battle', false);
  row('V11a', 'nation banners above each side and the HUD strip (es): name, sides, troops, advance, days', `${g.banners.join(' | ')} || ${g.strip}`, g.banners.length === 2 && g.stripOn && /ataca/.test(g.strip) && /día de combate/.test(g.strip) && /avance/.test(g.strip));
  await page.evaluate(() => __front.ctx.settings.set({ language: 'en' }));
  await sleep(20000);
  const en = await page.evaluate(() => ({ strip: document.querySelector('.fu-bstrip')?.textContent ?? '', banners: [...document.querySelectorAll('.fu-bbanner')].map((e) => e.textContent) }));
  row('V11b', 'the strip and banners in English', `${en.banners.join(' | ')} || ${en.strip}`, /attacking/.test(en.strip) && /day of fighting/.test(en.strip) && /advance/.test(en.strip));
  await shot(page, 'front-ground-real-en');
  await page.close();
}

// ---------------------------------------------------------------------------------------------------------------
// V9 / V10: observation time moves the line continuously at advanceKmh × rate / 3600; animation clock on real time
// ---------------------------------------------------------------------------------------------------------------
if (!only || only.has('obs')) {
  const page = await open('front-observation', '&quality=low&observe=4000');
  const samples = [];
  for (let i = 0; i < 40; i++) {
    const s = await page.evaluate(() => ({ t: performance.now() / 1000, d: window.__battleDebug.shown(), mode: __front.ctx.sim.view.clock.mode, rate: __front.ctx.sim.view.clock.rate }));
    samples.push(s);
    await sleep(1000);
  }
  await shot(page, 'front-observation');
  const ok = samples.filter((s) => s.d && s.d.subTile);
  console.log('   V9 series', JSON.stringify(samples.map((s) => s.d && [+s.t.toFixed(1), Math.round(s.d.lineShift), Math.round(s.d.simShift), +s.d.expectedSpeed.toFixed(1), s.d.subTile ? 1 : 0, s.d.frontKey])));
  let jumps = 0;
  for (let i = 1; i < ok.length; i++) if (Math.abs(ok[i].d.lineShift - ok[i - 1].d.lineShift) > 5000) jumps++;
  // Least-squares slope of the displayed line offset over real time (m per real second).
  const slope = (pts) => {
    const n = pts.length;
    if (n < 2) return 0;
    const mt = pts.reduce((a, p) => a + p[0], 0) / n, mv = pts.reduce((a, p) => a + p[1], 0) / n;
    let num = 0, den = 0;
    for (const [t, v] of pts) { num += (t - mt) * (v - mv); den += (t - mt) ** 2; }
    return den > 0 ? num / den : 0;
  };
  const measured = slope(ok.map((s) => [s.t, s.d.lineShift]));
  const simSpeed = slope(ok.map((s) => [s.t, s.d.simShift]));
  const exp = ok.filter((s) => s.d.expectedSpeed !== 0);
  const expected = exp.length ? exp.reduce((a, s) => a + s.d.expectedSpeed, 0) / exp.length : 0;
  const last = samples[samples.length - 1];
  row('V9', 'observation: clock observation, line speed = advanceKmh × rate / 3600 (±15 %), no 25 km jumps', `mode ${last?.mode} rate ${last?.rate}; shown ${measured.toFixed(1)} m/s vs advanceKmh×rate/3.6 ${expected.toFixed(1)} m/s (sim sub-tile line ${simSpeed.toFixed(1)} m/s) over ${ok.length} samples; jumps ${jumps}`, last?.mode === 'observation' && expected !== 0 && Math.abs(measured / expected - 1) <= 0.15 && jumps === 0);
  // V10: battle animation clock per real second at 0.5x and 4x and paused.
  const rate = async (speed) => {
    await page.evaluate((sp) => __front.ctx.app.setSpeed(sp), speed);
    await sleep(1500);
    const a = await page.evaluate(() => ({ c: window.__battleDebug.clock, t: performance.now() / 1000, f: __front.ctx.frame.frame }));
    await sleep(6000);
    const b = await page.evaluate(() => ({ c: window.__battleDebug.clock, t: performance.now() / 1000, f: __front.ctx.frame.frame }));
    return { perS: (b.c - a.c) / (b.t - a.t), fps: (b.f - a.f) / (b.t - a.t) };
  };
  const r05 = await rate(0.5), r4 = await rate(4), r0 = await rate(0);
  row('V10', 'battle animation per real second equal at 0.5x and 4x (±15 %), frozen on pause', `0.5x ${r05.perS.toFixed(3)}/s (${r05.fps.toFixed(1)} fps), 4x ${r4.perS.toFixed(3)}/s (${r4.fps.toFixed(1)} fps), paused ${r0.perS.toFixed(3)}/s`, Math.abs(r05.perS / r4.perS - 1) <= 0.15 && r0.perS === 0);
  await page.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass).length;
console.log(`--- ${results.length - failed}/${results.length} pass, ${errors} page errors`);
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
