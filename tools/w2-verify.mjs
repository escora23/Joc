// FRONT ULTRA — W2 map-readability acceptance checks that need the live page (DESIGN_V2 §16.3, criteria 4-8, 13, 15).
// Each check loads its staged shot, reads the debug hooks (__labels, __units, __islands, __trails, __post, __front)
// and measures independently where it can (own projection of every unit and structure, pairwise geometry). Writes one
// JSON per check to --out and prints a PASS/FAIL line per criterion.
//
//   node tools/w2-verify.mjs --url http://127.0.0.1:5312/ [--checks labels,icons,click,islands,routes,historical]
//        [--out shots/W2-map-readability/verify]
//
// Use a dev server without HMR (tools/vite.nowatch.config.mjs) when other agents edit files: a reload mid-check
// destroys the page.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5312/';
const out = args.out || 'shots/W2-map-readability/verify';
const checks = (args.checks || 'labels,icons,click,islands,routes,historical').split(',');
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

const verdicts = [];
function verdict(name, pass, detail) {
  verdicts.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

async function open(shot, params = '') {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`${base}?shot=${shot}${params}`, { waitUntil: 'load', timeout: 300000 });
  await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 900000, polling: 500 });
  await page.waitForTimeout(2500);
  return page;
}

/** Wait until the renderer has drawn `n` more frames. */
async function frames(page, n = 4) {
  const f0 = await page.evaluate(() => window.__front?.ctx.frame.frame ?? 0);
  await page.waitForFunction((f) => (window.__front?.ctx.frame.frame ?? 0) > f, f0 + n, { timeout: 120000, polling: 100 });
}

function save(name, data) {
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(data, null, 2));
}

// In-page: every live unit and structure projected with the camera, horizon-tested (independent of the icon layer).
const PROJECT_ALL = `(() => {
  const ctx = window.__front.ctx, cam = ctx.camera, view = ctx.sim.view;
  const V = cam.position.constructor;
  const W = innerWidth, H = innerHeight, c = cam.position;
  const MAP_W = view.world ? view.world.width : 2000, MAP_H = view.world ? view.world.height : 1000;
  const vis = (lat, lon) => {
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
    const p = new V(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
    const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z, dd = dx * dx + dy * dy + dz * dz;
    const t = Math.min(1, Math.max(0, -(c.x * dx + c.y * dy + c.z * dz) / dd));
    if (t < 0.999) { const qx = c.x + dx * t, qy = c.y + dy * t, qz = c.z + dz * t; if (qx * qx + qy * qy + qz * qz < 0.997) return null; }
    const s = p.clone().project(cam);
    if (s.z > 1) return null;
    const x = (s.x * 0.5 + 0.5) * W, y = (0.5 - s.y * 0.5) * H;
    return x >= 0 && x <= W && y >= 0 && y <= H ? { x, y } : null;
  };
  const ll = (fx, fy) => ({ lon: (((fx % MAP_W) + MAP_W) % MAP_W) / MAP_W * 360 - 180, lat: 90 - fy / MAP_H * 180 });
  const units = [], structures = [];
  for (const u of view.units.values()) { const a = ll(u.x, u.y); const s = vis(a.lat, a.lon); if (s) units.push({ id: u.id, type: u.type, owner: u.owner, ...s }); }
  for (const st of view.structures.values()) { const t = st.tile; const a = ll(t % MAP_W + 0.5, Math.floor(t / MAP_W) + 0.5); const s = vis(a.lat, a.lon); if (s) structures.push({ id: st.id, type: st.type, owner: st.owner, ...s }); }
  return { units, structures };
})()`;

// -------------------------------------------------------------------------------------------------
// 4. Labels
// -------------------------------------------------------------------------------------------------
async function checkLabels() {
  const page = await open('labels-world', '&freeze=1');
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => {
    const placed = window.__labels.placed();
    const occ = window.__front.ctx.ui.getOccludedRects().map((d) => ({ x0: d.left, y0: d.top, x1: d.right, y1: d.bottom }));
    return { placed, occ, ca: window.__post?.ca?.() ?? null, mode: window.__front.ctx.cameraRig.mode ?? null };
  });
  const inter = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  const overlaps = [], limb = [], hud = [];
  for (let i = 0; i < r.placed.length; i++) {
    const a = r.placed[i];
    if (a.limbDot < 0.35) limb.push(a.name);
    for (const o of r.occ) if (inter(a, o)) hud.push(a.name);
    for (let j = i + 1; j < r.placed.length; j++) if (inter(a, r.placed[j])) overlaps.push([a.name, r.placed[j].name]);
  }
  save('labels', { ...r, overlaps, limb, hud });
  await page.screenshot({ path: path.join(out, 'labels-world.png') });
  verdict('4 labels: no overlaps / limb / HUD', r.placed.length > 5 && !overlaps.length && !limb.length && !hud.length,
    { placed: r.placed.length, overlaps: overlaps.length, limb: limb.length, hud: hud.length, occludedRects: r.occ.length });
  verdict('4 labels: chromatic aberration 0 in the strategic view', r.ca === 0, { ca: r.ca });
  await page.close();
}

// -------------------------------------------------------------------------------------------------
// 5 + 15. Icons and LOD
// -------------------------------------------------------------------------------------------------
async function checkIcons() {
  const res = {};
  for (const alt of [6000, 1500, 400]) {
    const page = await open('icons-europe', `&freeze=1&alt=${alt}`);
    await frames(page, 4);
    const r = await page.evaluate(`(() => { const st = window.__units.stats(); const icons = window.__units.icons(); const proj = ${PROJECT_ALL}; return { st, icons, proj }; })()`);
    // Every projected unit/structure must be an icon head or a cluster member.
    const repU = new Set(), repS = new Set();
    for (const h of r.icons) for (const m of (h.kind === 'cluster' ? h.members : [h.id])) (h.structure ? repS : repU).add(m);
    const missU = r.proj.units.filter((u) => !repU.has(u.id));
    const missS = r.proj.structures.filter((s) => !repS.has(s.id));
    // Same-owner, same-category single icons closer than 26 px would have to be clustered (DESIGN_V2 §10.7: owner and
    // category; a warship next to a trade ship stays a separate icon).
    const singles = r.icons.filter((h) => h.kind === 'single');
    let unclustered = 0;
    for (let i = 0; i < singles.length; i++) for (let j = i + 1; j < singles.length; j++) {
      const a = singles[i], b = singles[j];
      if (a.owner === b.owner && a.structure === b.structure && a.cat === b.cat && !a.selected && !b.selected && a.half > 7 && b.half > 7 && Math.hypot(a.x - b.x, a.y - b.y) < 26 - 0.5) unclustered++;
    }
    const clusters = r.icons.filter((h) => h.kind === 'cluster');
    res[alt] = { stats: r.st, projectedUnits: r.proj.units.length, projectedStructures: r.proj.structures.length, missingUnits: missU.slice(0, 20), missingStructures: missS.slice(0, 20), unclusteredPairs: unclustered, clusters: clusters.length };
    await page.screenshot({ path: path.join(out, `icons-${alt}.png`) });
    await page.close();
  }
  save('icons', res);
  const hi = [res[6000], res[1500]];
  verdict('5 icons: 0 unit models at >= 1500 km', hi.every((x) => x.stats.unitModels === 0), hi.map((x) => x.stats.unitModels));
  verdict('5 icons: one icon or cluster membership per unit/structure in view (>= 1500 km)',
    hi.every((x) => x.missingUnits.length === 0 && x.missingStructures.length === 0 && x.projectedUnits + x.projectedStructures > 0),
    hi.map((x) => ({ units: x.projectedUnits, structures: x.projectedStructures, missU: x.missingUnits.length, missS: x.missingStructures.length })));
  verdict('5 icons: unit models drawn below 600 km', res[400].stats.unitModels > 0, { unitModels: res[400].stats.unitModels });
  verdict('5 icons: same-owner icons within 26 px are clustered', hi.every((x) => x.unclusteredPairs === 0) && hi.some((x) => x.clusters > 0),
    hi.map((x) => ({ clusters: x.clusters, unclustered: x.unclusteredPairs })));
  verdict('15 icons: <= 2 draw calls', [6000, 1500, 400].every((a) => res[a].stats.drawCalls <= 2), [6000, 1500, 400].map((a) => res[a].stats.drawCalls));
}

// -------------------------------------------------------------------------------------------------
// 6. Clicking icons at 6,000 km
// -------------------------------------------------------------------------------------------------
async function checkClick() {
  const page = await open('icons-europe', '&alt=6000');
  await page.evaluate(() => {
    window.__sel = [];
    window.__front.ctx.bus.on('selectionChanged', (e) => window.__sel.push(e));
    window.__front.ctx.app.goto?.('playing');
  });
  await frames(page, 4);
  const occ = await page.evaluate(() => window.__front.ctx.ui.getOccludedRects().map((d) => [d.left, d.top, d.right, d.bottom]));
  const inHud = (x, y) => occ.some(([a, b, c, d]) => x >= a - 4 && x <= c + 4 && y >= b - 4 && y <= d + 4);
  const icons = (await page.evaluate(() => window.__units.icons())).filter((h) => h.kind === 'single' && !h.structure && !inHud(h.x, h.y));
  // Prefer icons with no other icon within 30 px (a click near two icons is legitimately ambiguous) and spread owners.
  const iso = icons.filter((a) => !icons.some((b) => b !== a && Math.hypot(a.x - b.x, a.y - b.y) < 30));
  const pick = (iso.length >= 20 ? iso : icons).slice(0, 20);
  const trials = [];
  for (const h of pick) {
    await page.evaluate(() => { window.__sel.length = 0; window.__front.ctx.bus.emit('selectionChanged', { unitIds: [], structureId: -1 }); });
    // Re-read the icon position this frame (the camera is still, but ships move if the sim runs).
    const now = (await page.evaluate(() => window.__units.icons())).find((x) => x.id === h.id && !x.structure) ?? h;
    await page.mouse.move(now.x, now.y);
    await page.waitForTimeout(150);
    await page.mouse.down();
    await page.waitForTimeout(60);
    await page.mouse.up();
    await page.waitForTimeout(700);
    const sel = await page.evaluate(() => window.__sel.slice());
    const ok = sel.some((e) => e.unitIds.includes(h.id));
    trials.push({ id: h.id, owner: h.owner, x: Math.round(now.x), y: Math.round(now.y), ok, sel: sel.map((e) => e.unitIds) });
  }
  save('click', { candidates: icons.length, isolated: iso.length, trials });
  const n = trials.filter((t) => t.ok).length;
  verdict('6 click icon at 6000 km selects the unit (20/20)', trials.length === 20 && n === 20, `${n}/${trials.length}`);
  await page.close();
}

// -------------------------------------------------------------------------------------------------
// 7. Islands
// -------------------------------------------------------------------------------------------------
async function checkIslands() {
  for (const shot of ['islands-caribbean', 'islands-aegean']) {
    const page = await open(shot, '&freeze=1');
    await frames(page, 4);
    const r = await page.evaluate(() => ({ visible: window.__islands.visible(), details: window.__islands.details() }));
    await page.screenshot({ path: path.join(out, `${shot}.png`) });
    // Hover the first marker: the tooltip must name the owner (or «libre»).
    let tip = null;
    const m = r.details.markers.find((x) => x.x > 40 && x.y > 120 && x.x < 1200 && x.y < 700);
    if (m) {
      await page.evaluate(() => window.__front.ctx.app.goto?.('playing'));
      for (let k = 0; k < 3 && !tip; k++) {
        await page.mouse.move(m.x + k, m.y);
        await page.waitForTimeout(2500);
        tip = await page.evaluate(() => {
          const el = document.querySelector('.fu-tt');
          return el && !el.classList.contains('fu-hidden') ? el.textContent : null;
        });
      }
    }
    save(shot, { ...r, hoverTip: tip });
    const v = r.visible;
    verdict(`7 ${shot}: markers = components <= 20 tiles in view, each >= 8 px`,
      r.details.inView >= 1 && v === r.details.inView && r.details.minDiameterPx >= 8,
      { visible: v, componentsInView: r.details.inView, marked: r.details.marked, selfVisible: r.details.selfVisible, minDiameterPx: r.details.minDiameterPx });
    verdict(`7 ${shot}: hover names the owner`, !!tip && /·/.test(tip), { tip });
    await page.close();
  }
}

// -------------------------------------------------------------------------------------------------
// 8. Routes
// -------------------------------------------------------------------------------------------------
async function checkRoutes() {
  // Sail from Lisbon at 4x and follow the convoy's own line (__trails.route(id)) every second, then 25 s past arrival.
  const page = await open('routes-atlantic', '&ff=0&speed=4');
  const id = await page.evaluate(() => {
    const ships = [...window.__front.ctx.sim.view.units.values()].filter((u) => u.owner === 1 && u.type === 0);
    // The staged convoy is bound for New York (tile x ~473, y ~220 on the 1600 x 800 grid).
    ships.sort((a, b) => Math.hypot(a.targetX - 473, a.targetY - 220) - Math.hypot(b.targetX - 473, b.targetY - 220));
    return ships.length ? ships[0].id : -1;
  });
  const samples = [];
  const t0 = Date.now();
  let endedAt = null;
  for (let i = 0; i < 600 && id >= 0; i++) {
    const s = await page.evaluate((uid) => ({ r: window.__trails.route(uid), st: window.__trails.stats() }), id);
    const t = (Date.now() - t0) / 1000;
    samples.push({ t, ...s });
    if (s.r.state !== 'live' && endedAt === null) endedAt = t;
    if (endedAt !== null && t - endedAt > 26) break;
    if (i === 10) await page.screenshot({ path: path.join(out, 'routes-atlantic-sailing.png') });
    await page.waitForTimeout(1000);
  }
  save('routes', { id, endedAt, samples });
  const live = samples.filter((s) => s.r.state === 'live');
  const ending = samples.filter((s) => s.r.state === 'ending');
  const lastDrawnAge = Math.max(0, ...ending.filter((s) => s.r.drawn).map((s) => s.r.age));
  const goneBy = samples.find((s, i) => i > 0 && s.r.state === 'none' && samples[i - 1].r.state !== 'live');
  verdict('8 routes: the convoy line is drawn from departure for the whole trip', id >= 0 && live.length > 3 && live.every((s) => s.r.drawn),
    { id, samples: live.length, missing: live.filter((s) => !s.r.drawn).length });
  verdict('8 routes: kept >= 15 real s after arrival, gone within 5 s after that', endedAt !== null && lastDrawnAge >= 15 && lastDrawnAge <= 20.5 && !!goneBy,
    { endedAt, lastDrawnAge, fullOpacityUntil: Math.max(0, ...ending.filter((s) => s.r.opacity >= 0.999).map((s) => s.r.age)) });
  verdict('8 routes: the human routes never evicted with 100 trade ships and 10 warships in view', samples.every((s) => s.st.humanSuppressed === 0 && s.st.evicted.human === 0),
    samples[Math.min(5, samples.length - 1)]?.st);
  await page.close();
}

// -------------------------------------------------------------------------------------------------
// 13. Historical borders
// -------------------------------------------------------------------------------------------------
async function checkHistorical() {
  const page = await open('borders-close', '&freeze=1&alt=600');
  const r = await page.evaluate(async () => {
    const ctx = window.__front.ctx;
    const def = ctx.settings.get().historicalBorders;
    const u = () => window.__globeDebug?.historical?.() ?? null;
    const frames = async (n) => { const f0 = ctx.frame.frame; while (ctx.frame.frame < f0 + n) await new Promise((res) => setTimeout(res, 200)); };
    await frames(4);
    const a0 = u();
    ctx.settings.set({ historicalBorders: true });
    await frames(8);
    const b = u();
    const st = ctx.cameraRig.getState();
    ctx.cameraRig.setState({ lat: st.lat, lon: st.lon, tilt: st.tilt, heading: st.heading, altitudeKm: 1400 });
    await frames(8);
    const c = u();
    const altAfter = ctx.cameraRig.getState().altitudeKm;
    ctx.settings.set({ historicalBorders: false });
    return { defaultOn: def, offAt600: a0, onAt600: b, onAt1400: c, altAfter };
  });
  save('historical', r);
  verdict('13 historical borders off by default, drawn only below 1000 km when on', r.defaultOn === false && r.offAt600 === 0 && r.onAt600 > 0.9 && r.onAt1400 === 0, r);
  await page.close();
}

const t0 = Date.now();
for (const c of checks) {
  const fn = { labels: checkLabels, icons: checkIcons, click: checkClick, islands: checkIslands, routes: checkRoutes, historical: checkHistorical }[c];
  if (!fn) { console.log('unknown check', c); continue; }
  try { await fn(); } catch (e) { verdict(`${c}: error`, false, String(e).slice(0, 400)); }
}
fs.writeFileSync(path.join(out, 'verdicts.json'), JSON.stringify({ seconds: (Date.now() - t0) / 1000, verdicts }, null, 2));
await browser.close();
