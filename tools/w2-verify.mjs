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
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
  return acc;
}, []));
const base = args.url || 'http://127.0.0.1:5312/';
const out = args.out || 'shots/W2-map-readability/verify';
const checks = (args.checks || 'labels,icons,click,islands,routes,routepix,flash,zoom,models,historical').split(',');
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
  // SwiftShader frames can take seconds: screenshots and evaluations get generous timeouts.
  page.setDefaultTimeout(240000);
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
  // World view (FEEDBACK-1 #4): above 8,000 km only the human's and hostile military icons, no trade ships, trains or
  // structures, and no icon over a nation label.
  const wv = await page.evaluate(() => {
    const view = window.__front.ctx.sim.view;
    const icons = window.__units.icons();
    const placed = window.__labels.placed();
    const rows = [];
    for (const h of icons) {
      const ids = h.kind === 'cluster' ? h.members : [h.id];
      const types = h.structure ? [] : ids.map((id) => view.units.get(id)?.type);
      const overLabel = placed.some((l) => h.x + h.half > l.x0 && h.x - h.half < l.x1 && h.y + h.half > l.y0 && h.y - h.half < l.y1);
      rows.push({ id: h.id, owner: h.owner, structure: h.structure, kind: h.kind, types, overLabel });
    }
    return { rows, liveUnits: view.units.size, liveStructures: view.structures.size };
  });
  const bad = wv.rows.filter((x) => x.structure || x.overLabel || x.types.some((t) => t === 1 || t === 13));
  save('worldview', wv);
  verdict('4 world view: no structure / trade / train icons and no icon over a label at 20,000 km', bad.length === 0,
    { icons: wv.rows.length, bad: bad.length, liveUnits: wv.liveUnits, liveStructures: wv.liveStructures });
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
    if (alt === 400) {
      // Below 600 km: look at a moving unit (the staged view may have none under the camera).
      await page.evaluate(() => {
        const ctx = window.__front.ctx, w = ctx.world;
        const u = [...ctx.sim.view.units.values()].find((x) => x.type === 2 || x.type === 3 || x.type === 0);
        if (!u) return;
        const st = ctx.cameraRig.getState();
        ctx.cameraRig.setState({ ...st, lat: 90 - (u.y / w.height) * 180, lon: ((((u.x % w.width) + w.width) % w.width) / w.width) * 360 - 180 });
      });
      await frames(page, 8);
    }
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
  verdict('5 icons: unit models drawn (in view, >= 24 px) below 600 km', res[400].stats.unitModels > 0 && res[400].stats.unitModelMinPx >= 24,
    { unitModelsInView: res[400].stats.unitModels, minPx: res[400].stats.unitModelMinPx, instances: res[400].stats.unitModelInstances });
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
    // Independent count from the terrain grid (DESIGN_V2 §10.6): 4-connected playable tiles (Plains, Hills, Mountains),
    // components of <= 20 tiles touching ocean water (Navigable flag) through a side, centroid on screen and facing
    // the camera. Every one must be marked (a marker within reach of its centroid) or be larger than 16 px itself.
    const ind = await page.evaluate(() => {
      const ctx = window.__front.ctx, cam = ctx.camera, w = ctx.world;
      const MW = w.width, MH = w.height, T = w.terrain;
      const play = (t) => { const c = T[t] & 15; return c === 2 || c === 3 || c === 4; };
      const nav = (t) => (T[t] & 0x20) !== 0;
      const seen = new Uint8Array(MW * MH);
      const rect = ctx.canvas.getBoundingClientRect();
      const W = rect.width, H = rect.height;
      const V = cam.position.constructor, c = cam.position;
      const focal = H / 2 / Math.tan((cam.fov * Math.PI) / 360);
      const out = [];
      const stack = [];
      for (let s0 = 0; s0 < MW * MH; s0++) {
        if (seen[s0] || !play(s0)) continue;
        stack.length = 0; stack.push(s0); seen[s0] = 1;
        const tiles = [];
        let sea = false;
        while (stack.length) {
          const t = stack.pop();
          tiles.push(t);
          const x = t % MW, y = (t / MW) | 0;
          const nb = [y * MW + (x + 1) % MW, y * MW + (x + MW - 1) % MW];
          if (y > 0) nb.push(t - MW);
          if (y < MH - 1) nb.push(t + MW);
          for (const n of nb) {
            if (nav(n)) sea = true;
            if (!seen[n] && play(n)) { seen[n] = 1; stack.push(n); }
          }
          if (tiles.length > 400) { /* large landmass: keep flooding, but it is not a candidate */ }
        }
        if (tiles.length > 20 || !sea) continue;
        const x0 = tiles[0] % MW;
        let sx = 0, sy = 0;
        for (const t of tiles) { let dx = t % MW - x0; if (dx > MW / 2) dx -= MW; else if (dx < -MW / 2) dx += MW; sx += dx + 0.5; sy += ((t / MW) | 0) + 0.5; }
        const cx = x0 + sx / tiles.length, cy = sy / tiles.length;
        let r2 = 0;
        for (const t of tiles) { let dx = (t % MW) + 0.5 - cx; dx -= MW * Math.round(dx / MW); const dy = ((t / MW) | 0) + 0.5 - cy; r2 = Math.max(r2, dx * dx + dy * dy); }
        const lon = ((((cx % MW) + MW) % MW) / MW) * 360 - 180, lat = 90 - (cy / MH) * 180;
        const la = lat * Math.PI / 180, lo = lon * Math.PI / 180;
        const p = new V(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)).multiplyScalar(1.0002);
        if (p.dot(c.clone().sub(p)) <= 0) continue;
        const q = p.clone().project(cam);
        if (q.z > 1) continue;
        const X = (q.x * 0.5 + 0.5) * W, Y = (0.5 - q.y * 0.5) * H;
        if (X < -8 || Y < -8 || X > W + 8 || Y > H + 8) continue;
        const sizePx = ((Math.max(0.5, Math.sqrt(r2) + 0.5) * 2 * (2 * Math.PI / MW))) * focal / p.distanceTo(c);
        out.push({ tiles: tiles.length, x: X + rect.left, y: Y + rect.top, lat: +lat.toFixed(2), lon: +lon.toFixed(2), sizePx: +sizePx.toFixed(1) });
      }
      return out;
    });
    const unmarked = ind.filter((k) => k.sizePx <= 16 && !r.details.markers.some((m) => Math.hypot(m.x - k.x, m.y - k.y) <= m.diameterPx / 2 + 14));
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
    save(shot, { ...r, hoverTip: tip, independent: ind, unmarked });
    const v = r.visible;
    verdict(`7 ${shot}: __islands.visible() = independently counted components <= 20 tiles in view, all marked, each >= 8 px`,
      ind.length >= 1 && v === ind.length && unmarked.length === 0 && r.details.minDiameterPx >= 8,
      { visible: v, independent: ind.length, unmarked: unmarked.length, marked: r.details.marked, selfVisible: r.details.selfVisible, minDiameterPx: r.details.minDiameterPx });
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
  // Opacity at the samples nearest 16, 18 and 20 s after arrival: a visible hold then a fade (1, ~0.6, ~0.2 or gone).
  const near = (a) => { let b = null; for (const s of samples) if (s.r.state !== 'live' && s.r.age !== undefined && (!b || Math.abs(s.r.age - a) < Math.abs(b.r.age - a))) b = s; return b ? { age: b.r.age, opacity: b.r.opacity, drawn: b.r.drawn } : null; };
  const fadeSamples = { at16: near(16), at18: near(18), at20: near(20) };
  const fullOpacityUntil = Math.max(0, ...ending.filter((s) => s.r.opacity >= 0.999).map((s) => s.r.age));
  const fading = ending.filter((s) => s.r.drawn && s.r.opacity < 0.999 && s.r.opacity > 0).length;
  verdict('8 routes: kept >= 15 real s after arrival, faded over the next 5 s and gone by 20 s', endedAt !== null && lastDrawnAge >= 15 && lastDrawnAge <= 20.5 && !!goneBy
    && fullOpacityUntil >= 14 && fullOpacityUntil <= 15.6 && fading >= 2,
    { endedAt, lastDrawnAge, fullOpacityUntil, fadingSamples: fading, ...fadeSamples });
  verdict('8 routes: the human routes never evicted with 100 trade ships and 10 warships in view', samples.every((s) => s.st.humanSuppressed === 0 && s.st.evicted.human === 0),
    samples[Math.min(5, samples.length - 1)]?.st);
  await page.close();
}


// -------------------------------------------------------------------------------------------------
// 8b. Routes, pixel level: the convoy's line is really on screen (not just reported as drawn)
// -------------------------------------------------------------------------------------------------
function srgbLab(r, g, b) {
  const L = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const R = L(r), G = L(g), B = L(b);
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
  const y = f(0.2126729 * R + 0.7151522 * G + 0.072175 * B);
  const z = f((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Samples the rendered frame along the projected polyline of the route (every 3 px, from the departure point to the
 * ship): a sample is covered when an owner-coloured pixel (CIELAB ΔE76 <= 14 from the owner colour) lies within
 * 4 px across the line. Samples off screen, beyond the horizon, under a HUD panel or under an icon (icons draw above
 * routes by design) are skipped.
 */
async function routeCoverage(page, id, file) {
  const geo = await page.evaluate((uid) => {
    const ctx = window.__front.ctx, cam = ctx.camera;
    const r = window.__trails.points(uid);
    if (!r) return null;
    const V = cam.position.constructor;
    const c = cam.position;
    const rect = ctx.canvas.getBoundingClientRect();
    const W = rect.width, H = rect.height;
    const pts = [];
    for (let i = 0; i < r.pts.length; i += 3) {
      const p = new V(r.pts[i], r.pts[i + 1], r.pts[i + 2]);
      const n = p.clone().normalize();
      const vis = n.dot(c.clone().sub(p)) > 0;
      const s = p.clone().project(cam);
      pts.push({ x: (s.x * 0.5 + 0.5) * W + rect.left, y: (0.5 - s.y * 0.5) * H + rect.top, vis: vis && s.z < 1 });
    }
    const occ = ctx.ui.getOccludedRects().map((q) => ({ l: q.left, t: q.top, r: q.right, b: q.bottom }));
    const icons = window.__units.icons().map((h) => ({ l: h.x - h.half - 3, t: h.y - h.half - 3, r: h.x + h.half + 3, b: h.y + h.half + 3 }));
    return { pts, color: r.color, occ, icons, W: innerWidth, H: innerHeight, dpr: devicePixelRatio };
  }, id);
  if (!geo) return { samples: 0, covered: 0, coverage: 0, note: 'no route points' };
  const buf = await page.screenshot({ path: file });
  const png = PNG.sync.read(buf);
  const k = png.width / geo.W;
  const target = srgbLab(parseInt(geo.color.slice(1, 3), 16), parseInt(geo.color.slice(3, 5), 16), parseInt(geo.color.slice(5, 7), 16));
  const inR = (x, y, rs) => rs.some((q) => x >= q.l && x <= q.r && y >= q.t && y <= q.b);
  let samples = 0, covered = 0, firstGap = null;
  const gaps = [];
  for (let i = 1; i < geo.pts.length; i++) {
    const a = geo.pts[i - 1], b = geo.pts[i];
    if (!a.vis || !b.vis) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.floor(len / 3));
    const nx = -(b.y - a.y) / Math.max(len, 1e-6), ny = (b.x - a.x) / Math.max(len, 1e-6);
    for (let j = 0; j < n; j++) {
      const t = j / n, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      if (x < 12 || y < 12 || x > geo.W - 12 || y > geo.H - 12) continue;
      if (inR(x, y, geo.occ) || inR(x, y, geo.icons)) continue;
      samples++;
      let hit = false;
      for (let d = -4; d <= 4 && !hit; d++) {
        const px = Math.round((x + nx * d) * k), py = Math.round((y + ny * d) * k);
        if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue;
        const o = (py * png.width + px) * 4;
        if (dE(srgbLab(png.data[o], png.data[o + 1], png.data[o + 2]), target) <= 14) hit = true;
      }
      if (hit) covered++;
      else if (gaps.length < 12) gaps.push([Math.round(x), Math.round(y)]);
    }
  }
  return { samples, covered, coverage: samples ? +(covered / samples).toFixed(4) : 0, color: geo.color, gaps };
}

async function checkRoutePixels() {
  const results = [];
  for (const clouds of ['', '&clouds=hidden']) {
    const page = await open('routes-atlantic', '&ff=800&speed=0' + clouds);
    const id = await page.evaluate(() => {
      const ships = [...window.__front.ctx.sim.view.units.values()].filter((u) => u.owner === 1 && u.type === 0);
      ships.sort((a, b) => Math.hypot(a.targetX - 473, a.targetY - 220) - Math.hypot(b.targetX - 473, b.targetY - 220));
      return ships.length ? ships[0].id : -1;
    });
    for (const alt of [3500, 1800, 1000, 300]) {
      // Centre the camera on the route behind the ship, so the ship and as much of its line as fits are in view.
      await page.evaluate(({ uid, alt }) => {
        const ctx = window.__front.ctx, cam = ctx.camera;
        const r = window.__trails.points(uid);
        const P = (i) => [r.pts[i * 3], r.pts[i * 3 + 1], r.pts[i * 3 + 2]];
        const n = r.pts.length / 3;
        const widthKm = alt * 2 * Math.tan((cam.fov * Math.PI) / 360) * cam.aspect;
        let want = Math.min(widthKm * 0.3, 1e9), acc = 0, q = P(n - 1);
        for (let i = n - 1; i > 0 && acc < want; i--) {
          const a = P(i), b = P(i - 1);
          const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 6371;
          const f = Math.min(1, (want - acc) / Math.max(d, 1e-6));
          q = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
          acc += d;
        }
        const len = Math.hypot(...q);
        ctx.cameraRig.setState({ lat: Math.asin(q[1] / len) * 180 / Math.PI, lon: Math.atan2(-q[2], q[0]) * 180 / Math.PI, altitudeKm: alt, tilt: 0, heading: 0 });
      }, { uid: id, alt });
      await frames(page, 8);
      await page.waitForTimeout(1500);
      const cov = await routeCoverage(page, id, path.join(out, `routepix-${alt}${clouds ? '-hidden' : ''}.png`));
      results.push({ alt, clouds: clouds ? 'hidden' : 'strategic', ...cov });
      console.log('  routepix', alt, clouds || 'clouds', JSON.stringify(cov));
    }
    await page.close();
  }
  save('routepix', results);
  verdict('8 routes (pixels): owner-colour coverage >= 95% along the line at 3500/1800/1000/300 km, clouds on and hidden',
    results.length === 8 && results.every((r) => r.samples > 50 && r.coverage >= 0.95), results.map((r) => `${r.alt}${r.clouds === 'hidden' ? 'h' : ''}:${r.coverage}/${r.samples}`).join(' '));
}


// -------------------------------------------------------------------------------------------------
// 9. Conquest flash: staged capture held mid-flash, compared with the same frame after the flash
// -------------------------------------------------------------------------------------------------
const toLin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
function linLab(R, G, B) {
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
  const y = f(0.2126729 * R + 0.7151522 * G + 0.072175 * B);
  const z = f((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

async function checkFlash() {
  const results = [];
  for (const alt of [1500, 300]) {
    // No HUD: the live news ticker and counters would add their own differences to the flash signal.
    const page = await open('borders-close', `&flash=1&freeze=1&hud=0&alt=${alt}`);
    await frames(page, 4);
    const fl = await page.evaluate(() => window.__territory.flashing());
    const a = PNG.sync.read(await page.screenshot({ path: path.join(out, `flash-${alt}-mid.png`) }));
    await page.evaluate(() => window.__territory.pinFlash(3));
    await frames(page, 4);
    await page.waitForTimeout(800);
    const b = PNG.sync.read(await page.screenshot({ path: path.join(out, `flash-${alt}-after.png`) }));
    await page.close();
    if (!fl.length) { results.push({ alt, error: 'no flashing tiles' }); continue; }
    const W = a.width, H = a.height;
    // Flash signal per pixel: the added light (linear RGB) between the mid-flash frame and the same frame after it.
    const D = new Float32Array(W * H * 3), Y = new Float32Array(W * H);
    let peak = 0;
    for (let i = 0; i < W * H; i++) {
      for (let c = 0; c < 3; c++) D[i * 3 + c] = Math.max(0, toLin(a.data[i * 4 + c]) - toLin(b.data[i * 4 + c]));
      Y[i] = 0.2126 * D[i * 3] + 0.7152 * D[i * 3 + 1] + 0.0722 * D[i * 3 + 2];
    }
    const sorted = Float32Array.from(Y).sort();
    peak = sorted[Math.floor(sorted.length * 0.999)];
    // Hue: mean added light over the strong flash pixels, scaled to the attacker's luminance, against the attacker.
    const col = fl[0].color, ar = toLin(parseInt(col.slice(1, 3), 16)), ag = toLin(parseInt(col.slice(3, 5), 16)), ab = toLin(parseInt(col.slice(5, 7), 16));
    const aY = 0.2126 * ar + 0.7152 * ag + 0.0722 * ab;
    let sr = 0, sg = 0, sb = 0, n = 0, flashPx = 0;
    for (let i = 0; i < W * H; i++) {
      if (Y[i] > peak * 0.1) flashPx++;
      if (Y[i] < peak * 0.5) continue;
      sr += D[i * 3]; sg += D[i * 3 + 1]; sb += D[i * 3 + 2]; n++;
    }
    const mY = (0.2126 * sr + 0.7152 * sg + 0.0722 * sb) / Math.max(n, 1);
    const k = aY / Math.max(mY * Math.max(n, 1), 1e-9);
    const labF = linLab(sr * k, sg * k, sb * k), labA = linLab(ar, ag, ab);
    const hueDE = Math.hypot(labF[0] - labA[0], labF[1] - labA[1], labF[2] - labA[2]);
    // Edge: the largest step of the flash signal between neighbouring pixels, as a fraction of the peak (a step of
    // at most 1/3 means the flash takes >= 3 px to rise from nothing to full: no hard edge).
    const steps = [];
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (Math.max(Y[i], Y[i + 1], Y[i + W]) < peak * 0.1) continue;
        steps.push(Math.abs(Y[i + 1] - Y[i]) / peak, Math.abs(Y[i + W] - Y[i]) / peak);
      }
    }
    steps.sort((p, q) => p - q);
    const maxStep = steps.length ? steps[steps.length - 1] : 1, p999 = steps.length ? steps[Math.floor(steps.length * 0.999)] : 1;
    results.push({ alt, tiles: fl.length, owner: fl[0].owner, color: col, age: fl[0].age, flashPx, hueDE: +hueDE.toFixed(2), maxStep: +maxStep.toFixed(3), p999Step: +p999.toFixed(3), flashLab: labF.map((v) => +v.toFixed(1)), attackerLab: labA.map((v) => +v.toFixed(1)) });
    console.log('  flash', JSON.stringify(results[results.length - 1]));
  }
  save('flash', results);
  verdict('9 borders-close: the staged conquest flashes in the attacker colour (dE < 10) with no hard edge (steps <= 1/3 of the peak: >= 3 px ramp)',
    results.length === 2 && results.every((r) => r.tiles > 0 && r.flashPx > 200 && r.hueDE < 10 && r.p999Step <= 0.34), results);
}


// -------------------------------------------------------------------------------------------------
// 10. Close zoom outside battles (zoom-40, zoom-8): fill ΔE, fill clipped at the shore, no regular grid
// -------------------------------------------------------------------------------------------------
function fft1(re, im, n, inv) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inv ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k], br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi; re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
function fft2(re, im, n, inv) {
  const r = new Float64Array(n), i2 = new Float64Array(n);
  for (let y = 0; y < n; y++) { for (let x = 0; x < n; x++) { r[x] = re[y * n + x]; i2[x] = im[y * n + x]; } fft1(r, i2, n, inv); for (let x = 0; x < n; x++) { re[y * n + x] = r[x]; im[y * n + x] = i2[x]; } }
  for (let x = 0; x < n; x++) { for (let y = 0; y < n; y++) { r[y] = re[y * n + x]; i2[y] = im[y * n + x]; } fft1(r, i2, n, inv); for (let y = 0; y < n; y++) { re[y * n + x] = r[y]; im[y * n + x] = i2[y]; } }
}
/** Strongest repeat of the high-passed luminance (normalised autocorrelation) at lags of 12-200 px: a tiling grid shows a peak. */
function periodicity(png, x0, y0, n) {
  const L = new Float64Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const o = ((y0 + y) * png.width + x0 + x) * 4;
    L[y * n + x] = 0.2126 * toLin(png.data[o]) + 0.7152 * toLin(png.data[o + 1]) + 0.0722 * toLin(png.data[o + 2]);
  }
  // High-pass: remove a 9 px box blur (lighting gradients), then window (Hann) to avoid edge artefacts.
  const B = new Float64Array(n * n), r = 4;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let s = 0, c = 0;
    for (let dy = -r; dy <= r; dy += 2) for (let dx = -r; dx <= r; dx += 2) {
      const yy = y + dy, xx = x + dx;
      if (yy < 0 || xx < 0 || yy >= n || xx >= n) continue;
      s += L[yy * n + xx]; c++;
    }
    B[y * n + x] = s / c;
  }
  const re = new Float64Array(n * n), im = new Float64Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const w = (0.5 - 0.5 * Math.cos(2 * Math.PI * x / (n - 1))) * (0.5 - 0.5 * Math.cos(2 * Math.PI * y / (n - 1)));
    re[y * n + x] = (L[y * n + x] - B[y * n + x]) * w;
  }
  fft2(re, im, n, false);
  for (let i = 0; i < n * n; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
  fft2(re, im, n, true);
  const z = re[0];
  let best = 0, at = null;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = x < n / 2 ? x : x - n, dy = y < n / 2 ? y : y - n;
    const d = Math.hypot(dx, dy);
    if (d < 12 || d > 200) continue;
    const v = re[y * n + x] / z;
    if (v > best) { best = v; at = [dx, dy]; }
  }
  return { peak: +best.toFixed(3), at };
}

async function checkZoom() {
  const results = [];
  for (const shot of ['zoom-40', 'zoom-8']) {
    const page = await open(shot, '&freeze=1');
    await frames(page, 4);
    const img = {};
    for (const [k, v] of [['base', { territory: true, mask: null }], ['territory', { territory: false, mask: null }], ['mask', { territory: true, mask: 'owner' }]]) {
      await page.evaluate((view) => window.__shotView.set(view), v);
      await frames(page, 4);
      await page.waitForTimeout(1500);
      img[k] = PNG.sync.read(await page.screenshot({ path: path.join(out, `${shot}-${k}.png`) }));
    }
    await page.evaluate(() => window.__shotView.set({ territory: true, mask: null }));
    const occ = await page.evaluate(() => window.__front.ctx.ui.getOccludedRects().map((q) => [q.left, q.top, q.right, q.bottom]));
    await page.close();
    const { base, territory, mask } = img;
    const W = base.width, H = base.height;
    const under = (x, y) => occ.some((q) => x >= q[0] - 2 && x <= q[2] + 2 && y >= q[1] - 2 && y <= q[3] + 2);
    const cls = new Uint8Array(W * H);
    // Exact OWNER_MASK codes only (HUD pixels drawn over the mask never decode as a class): water (0,0,40|60),
    // owned (id, id>>8, 160|180).
    for (let i = 0; i < W * H; i++) {
      const r = mask.data[i * 4], g = mask.data[i * 4 + 1], b = mask.data[i * 4 + 2];
      cls[i] = (b === 40 || b === 60) && r === 0 && g === 0 ? 1 : (b === 160 || b === 180) && (r > 0 || g > 0) ? 4 : 0;
    }
    let oN = 0, oDE = 0, wN = 0, wDE = 0, nearN = 0, nearDE = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (under(x, y)) continue;
      const a = srgbLab(base.data[i * 4], base.data[i * 4 + 1], base.data[i * 4 + 2]);
      const b = srgbLab(territory.data[i * 4], territory.data[i * 4 + 1], territory.data[i * 4 + 2]);
      const d = dE(a, b);
      if (cls[i] === 4) { oN++; oDE += d; }
      else if (cls[i] === 1) {
        wN++; wDE += d;
        // Water within 40 px of owned land: where a fill bleeding into the sea would show.
        let near = false;
        for (let r = 8; r <= 40 && !near; r += 8) for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H && cls[yy * W + xx] === 4) { near = true; break; }
        }
        if (near) { nearN++; nearDE += d; }
      }
    }
    const per = periodicity(base, Math.floor(W / 2) - 256, Math.floor(H / 2) - 256, 512);
    const r = { shot, ownedPx: oN, ownedDE: +(oDE / Math.max(oN, 1)).toFixed(2), waterPx: wN, waterDE: +(wDE / Math.max(wN, 1)).toFixed(2), coastWaterPx: nearN, coastWaterDE: +(nearDE / Math.max(nearN, 1)).toFixed(2), gridPeak: per.peak, gridAt: per.at };
    results.push(r);
    console.log('  zoom', JSON.stringify(r));
  }
  save('zoom', results);
  verdict('10 zoom-40/zoom-8: owned land dE >= 8 vs territory=0, the fill stops at the shore (water dE <= 2), no regular grid (autocorrelation peak < 0.3)',
    results.every((r) => r.ownedPx > 1000 && r.ownedDE >= 8 && (r.waterPx < 1000 || (r.waterDE <= 2 && r.coastWaterDE <= 3)) && r.gridPeak < 0.3), results);
}


// -------------------------------------------------------------------------------------------------
// 5b. Close-up models: each unit type's 3D model in view and >= 24 px at 300 / 100 / 30 km
// -------------------------------------------------------------------------------------------------
async function checkModels() {
  const types = (args.types || 'Warship,TransportShip,TradeShip,ArmoredDivision,FighterSquadron,Bomber,DroneSwarm,Train').split(',');
  const results = [];
  for (const unit of types) {
    const page = await open('unit-closeup', `&unit=${unit}&alt=300`);
    const id = await page.evaluate(() => window.__closeupUnit ?? -1);
    for (const alt of [300, 100, 30]) {
      // Track the unit: the camera looks at where the model is drawn (aircraft fly above the ground point and move),
      // re-centred until the drawn model sits near the middle of the screen.
      let st = null;
      for (let pass = 0; pass < 3; pass++) {
        await page.evaluate(({ id, alt }) => {
          const ctx = window.__front.ctx;
          const u = ctx.sim.view.units.get(id);
          const w = ctx.world, mw = w.width, mh = w.height;
          const cs = ctx.cameraRig.getState();
          const p = ctx.camera.position.clone();
          let lat, lon;
          if (ctx.units.getUnitWorldPosition(id, p)) {
            // Aim at the ground point behind the drawn model along the current view ray (an aircraft flies well above
            // its ground point; with the camera tilted, centring on the ground point below would put it off screen).
            const c = ctx.camera.position, dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
            const A = dx * dx + dy * dy + dz * dz, B = 2 * (c.x * dx + c.y * dy + c.z * dz), C = c.x * c.x + c.y * c.y + c.z * c.z - 1;
            const disc = B * B - 4 * A * C;
            if (disc > 0) {
              const t = (-B - Math.sqrt(disc)) / (2 * A);
              if (t > 0) p.set(c.x + dx * t, c.y + dy * t, c.z + dz * t);
            }
            p.normalize();
            lat = Math.asin(Math.max(-1, Math.min(1, p.y))) * 180 / Math.PI;
            lon = Math.atan2(-p.z, p.x) * 180 / Math.PI;
          } else if (u) {
            lat = 90 - (u.y / mh) * 180;
            lon = ((((u.x % mw) + mw) % mw) / mw) * 360 - 180;
          }
          if (lat !== undefined) ctx.cameraRig.setState({ ...cs, lat, lon, altitudeKm: alt });
        }, { id, alt });
        await frames(page, 6);
        await page.waitForTimeout(800);
        st = await page.evaluate((id) => {
          const s = window.__units.stats();
          return { m: s.unitModelsInView.find((x) => x.id === id) ?? null, inView: s.unitModels, instances: s.unitModelInstances, minPx: s.unitModelMinPx };
        }, id);
        if (st.m && Math.abs(st.m.x - 800) < 300 && Math.abs(st.m.y - 450) < 250) break;
      }
      const shotPath = path.join(out, `closeup-${unit}-${alt}.png`);
      if (st.m) await page.screenshot({ path: shotPath, clip: { x: Math.max(0, st.m.x - 110), y: Math.max(0, st.m.y - 110), width: 220, height: 220 } });
      else await page.screenshot({ path: shotPath });
      results.push({ unit, alt, id, px: st.m ? st.m.px : 0, modelsInView: st.inView, instances: st.instances });
      console.log('  model', unit, alt, JSON.stringify(st.m));
    }
    await page.close();
  }
  save('models', results);
  // px = the projected bounding box of the drawn instances (__units.stats(), not the intended size); crops saved.
  verdict('5 close-up: every unit type drawn as a 3D model in view, >= 24 px at 300/100/30 km',
    results.every((r) => r.id >= 0 && r.px >= 24), results.map((r) => `${r.unit}@${r.alt}:${r.px}`).join(' '));
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
  const fn = { labels: checkLabels, icons: checkIcons, click: checkClick, islands: checkIslands, routes: checkRoutes, routepix: checkRoutePixels, flash: checkFlash, zoom: checkZoom, models: checkModels, historical: checkHistorical }[c];
  if (!fn) { console.log('unknown check', c); continue; }
  try { await fn(); } catch (e) { verdict(`${c}: error`, false, String(e).slice(0, 400)); }
}
fs.writeFileSync(path.join(out, 'verdicts.json'), JSON.stringify({ seconds: (Date.now() - t0) / 1000, verdicts }, null, 2));
await browser.close();
