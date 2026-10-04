// W6 browser verifier (DESIGN_V2 §16.7 acceptance). Drives the real game in Chromium (SwiftShader) on staged but REAL
// wars (the ?shot= stagers only issue sim commands and run real ticks) and measures each criterion.
//   node tools/w6-verify.mjs [--url http://127.0.0.1:5440/] [--out shots/W6-battle-clarity/verify] [--only orbit,mob,600,plume,ground,night,descent,obs,advance]
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
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`), timeout: 300000 }).catch((e) => console.log(`   (screenshot ${name} failed: ${String(e?.message ?? e).split('\n')[0]})`));
const errText = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 220);
/**
 * A real mouse click on a UI element that works on a starved renderer. Under SwiftShader with another browser busy the
 * page can draw one frame every 5-10 s, and a panel still in its 0.3 s slide-in animation then never passes
 * Playwright's "stable" test. So: the normal click first; if the element stays unstable, check that it is visible,
 * enabled and the topmost element at its centre (elementFromPoint, i.e. what a player's click would hit) and click
 * there with the mouse (force skips only the stability wait). `target` is a selector or a Locator.
 */
async function uiClick(page, target, timeout = 20000) {
  const loc = typeof target === 'string' ? page.locator(target).first() : target.first();
  try {
    await loc.click({ timeout: Math.min(timeout, 8000) });
    return;
  } catch (e) {
    if (!/not stable|Timeout/.test(String(e?.message ?? e))) throw e;
  }
  await loc.waitFor({ state: 'visible', timeout });
  const hit = await loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { hits: !!top && (top === el || el.contains(top)), disabled: !!el.disabled, what: top ? `${top.tagName}.${top.className}` : 'nothing' };
  });
  if (hit.disabled) throw new Error('element is disabled');
  if (!hit.hits) throw new Error(`element is covered by ${hit.what}`);
  await loc.click({ force: true, timeout });
}
/**
 * A click that cannot abort the run (W6 final, reproducibility): a missing or covered element (a war that ended, a slow
 * frame) is recorded as a failed row for that step and the run goes on.
 */
async function safeClick(page, sel, id, what, timeout = 20000) {
  try {
    await uiClick(page, sel, timeout);
    return true;
  } catch (e) {
    row(id, what, `step failed: could not click ${sel}: ${errText(e)}`, false);
    return false;
  }
}
/** A whole section guarded: an exception is recorded as a failed row and the next section runs. */
async function section(name, fn) {
  try {
    await fn();
  } catch (e) {
    row(`${name}!`, `section '${name}' aborted`, errText(e), false);
  }
}

// Banners and strip as the player sees them: each banner 'clear' only when displayed, inside the viewport and not
// overlapping any HUD panel (the rects the HUD itself reports) or the strip.
function bannerState() {
  const d = window.__battleDebug.shown();
  const strip = document.querySelector('.fu-bstrip');
  const sr = strip && !strip.classList.contains('fu-hidden') ? strip.getBoundingClientRect() : null;
  const rects = [...__front.ctx.ui.getOccludedRects()];
  if (sr) rects.push(sr);
  const W = window.innerWidth, H = window.innerHeight;
  const banners = [...document.querySelectorAll('.fu-bbanner')].map((e) => {
    const r = e.getBoundingClientRect();
    let state = 'clear';
    if (e.style.display === 'none' || e.closest('.fu-hidden')) state = 'hidden';
    else if (r.left < 0 || r.right > W || r.top < 0 || r.bottom > H) state = 'off-screen';
    else if (rects.some((q) => r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top)) state = 'under a HUD panel';
    return { text: e.textContent, state };
  });
  return { d, strip: strip?.textContent ?? '', stripOn: !!sr, banners };
}

// The sim's line at the battle's anchor, read from the FrontView alone (the verifier's own geometry).
function simLineAtAnchor() {
  const d = window.__battleDebug.shown();
  const v = __front.ctx.sim.view;
  if (!d) return null;
  const f = v.frontByKey.get(d.frontKey);
  if (!f) return null;
  const TILE = (2 * Math.PI * 6371) / 1600;
  const lat = 90 - (d.anchorY / 800) * 180;
  const kmX = TILE * Math.cos((lat * Math.PI) / 180);
  const wdx = (a, b) => { let x = b - a; if (x > 800) x -= 1600; if (x < -800) x += 1600; return x; };
  const nE = Math.sin(d.normalBearing), nN = Math.cos(d.normalBearing);
  const L = f.line;
  if (L) {
    const rE = wdx(d.anchorX, L.x) * kmX, rN = (d.anchorY - L.y) * TILE;
    const along = rE * L.n - rN * L.e;
    if (Math.abs(along) <= L.halfKm + 10) {
      // The published line moves by exactly kmh / 10 km per tick: carried from its reading's tick to the tick the client
      // draws (the readings come every tick at the observation focus, every 5 on the offensive's axis).
      const dt = Math.max(-2, Math.min(L.focus ? 1.5 : 6, v.simTime * 10 - L.tick));
      const off = rE * L.e + rN * L.n + L.depthKm + (L.kmh / 10) * dt;
      const cos = nE * L.e + nN * L.n;
      return { source: `line (tick ${L.tick}, ${L.focus ? 'observation focus' : 'offensive axis'}, ${L.kmh.toFixed(2)} km/h)`, shiftM: (off * 1000) / Math.max(0.5, cos), note: `carried ${dt.toFixed(2)} ticks to the drawn tick` };
    }
  }
  // Tile-level (or per-vertex progress) contact line crossing the battle's normal through the anchor.
  const n = f.samples.length >> 1;
  const aPush = f.offensiveA !== 0, bPush = !aPush && f.offensiveB !== 0;
  const pts = [];
  for (let k = 0; k < n; k++) {
    const p = f.progress ? f.progress[k] / 255 : 0;
    const o = aPush ? 0.5 + p : bPush ? 0.5 - p : 0.5;
    const e = wdx(d.anchorX, f.samples[k * 2] + f.dirX * o) * kmX, nn = (d.anchorY - (f.samples[k * 2 + 1] + f.dirY * o)) * TILE;
    pts.push([e * nN - nn * nE, e * nE + nn * nN]); // (along the line, along the normal)
  }
  let best = Infinity, shift = NaN;
  for (let k = 0; k + 1 < n; k++) {
    const [a0, s0] = pts[k], [a1, s1] = pts[k + 1];
    if (a0 * a1 > 0) continue;
    const t = a0 === a1 ? 0 : a0 / (a0 - a1);
    const sv = s0 + (s1 - s0) * t;
    if (Math.abs(sv) < best) { best = Math.abs(sv); shift = sv; }
  }
  return Number.isFinite(shift) ? { source: f.progress ? 'per-vertex progress' : 'tile-level line', shiftM: shift * 1000, note: '' } : null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Night readability floor (V17): the iter-3 black frame measured mean luma 5 with <1 % lit; the fixed frames 32-42 with 14-38 %. */
const NIGHT_MIN_MEAN = 20, NIGHT_MIN_LIT = 0.08;

/** Screen position (px) of lat/lon on the ground, as the game's camera projects it. */
function projectFn() {
  window.__proj = (lat, lon) => {
    const g = __front.ctx.globe;
    const r = g.surfaceRadiusAt(lat, lon);
    const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
    const cam = __front.ctx.camera;
    const x = r * Math.cos(la) * Math.cos(lo), y = r * Math.sin(la), z = -r * Math.cos(la) * Math.sin(lo);
    const e = cam.matrixWorldInverse.elements, p = cam.projectionMatrix.elements;
    // view then projection (column-major)
    const vx = e[0] * x + e[4] * y + e[8] * z + e[12], vy = e[1] * x + e[5] * y + e[9] * z + e[13], vz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12], cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13], cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
    return { x: ((cx / cw + 1) / 2) * window.innerWidth, y: ((1 - cy / cw) / 2) * window.innerHeight };
  };
}

async function measureArrow(page, arrow) {
  await page.evaluate(projectFn);
  await page.evaluate(() => __front.ctx.app.setSpeed(0));
  // Measure the arrow's own geometry, unoccluded: every layer drawn above it (the bands, icons, labels, markers:
  // renderOrder >= 43) is switched off for these frames (material.visible), then restored.
  await page.evaluate(() => {
    window.__w6hidden = [];
    // (and the DOM HUD: alert markers and badges stand over the map too)
    for (const e of document.querySelectorAll('.fu-hud-root')) e.style.visibility = 'hidden';
    __front.ctx.scene.traverse((o) => {
      if (!(o.renderOrder >= 43) || !o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m.visible) { m.visible = false; window.__w6hidden.push(m); }
      }
    });
  });
  await sleep(1500);
  const shotB64 = async () => (await page.screenshot({ timeout: 300000 })).toString('base64');
  const A = await shotB64();
  await page.evaluate(() => window.__frontOverlay.setArrowsVisible(false));
  await sleep(1500);
  const B = await shotB64();
  await sleep(700);
  const B2 = await shotB64();
  await page.evaluate(() => window.__frontOverlay.setArrowsVisible(true));
  await sleep(1500);
  const C = await shotB64();
  fs.writeFileSync(path.join(out, 'front-orbit-noarrow.png'), Buffer.from(B, 'base64'));
  fs.writeFileSync(path.join(out, 'front-orbit-arrowonly-layers.png'), Buffer.from(A, 'base64'));
  await page.evaluate(() => { for (const m of window.__w6hidden ?? []) m.visible = true; window.__w6hidden = []; for (const e of document.querySelectorAll('.fu-hud-root')) e.style.visibility = ''; });
  return page.evaluate(async ({ A, B, B2, C, arrow }) => {
    const load = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + src; });
    const imgs = await Promise.all([load(A), load(B), load(C), load(B2)]);
    const cv = document.createElement('canvas'); cv.width = imgs[0].width; cv.height = imgs[0].height;
    const g = cv.getContext('2d');
    const px = imgs.map((im) => { g.drawImage(im, 0, 0); return g.getImageData(0, 0, cv.width, cv.height).data; });
    const W = cv.width, H = cv.height, sx = W / window.innerWidth;
    const mask = new Uint8Array(W * H);
    let n = 0;
    for (let i = 0; i < W * H; i++) {
      const k = i * 4;
      const ac = Math.abs(px[0][k] - px[2][k]) + Math.abs(px[0][k + 1] - px[2][k + 1]) + Math.abs(px[0][k + 2] - px[2][k + 2]);
      const ab = Math.abs(px[0][k] - px[1][k]) + Math.abs(px[0][k + 1] - px[1][k + 1]) + Math.abs(px[0][k + 2] - px[1][k + 2]);
      const bb = Math.abs(px[1][k] - px[3][k]) + Math.abs(px[1][k + 1] - px[3][k + 1]) + Math.abs(px[1][k + 2] - px[3][k + 2]);
      if (ac < 12 && bb < 12 && ab > 30) { mask[i] = 1; n++; }
    }
    const P = (ll) => { const p = window.__proj(ll[0], ll[1]); return { x: p.x * sx, y: p.y * sx }; };
    const tail = P(arrow.tail), tip = P(arrow.tip), axis = P(arrow.axis);
    const dx = tip.x - tail.x, dy = tip.y - tail.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? mask[Math.round(y) * W + Math.round(x)] : 0);
    // Shaft width: perpendicular profiles at 40-70 % of the way, the run of arrow pixels through the centre line.
    const widths = [];
    for (const f of [0.4, 0.5, 0.6, 0.7]) {
      const cx = tail.x + dx * f, cy = tail.y + dy * f;
      let best = 0;
      for (let c = -4; c <= 4; c++) {
        if (!at(cx - uy * c, cy + ux * c)) continue;
        let a = c, b = c;
        while (a > -40 && at(cx - uy * (a - 1), cy + ux * (a - 1))) a--;
        while (b < 40 && at(cx - uy * (b + 1), cy + ux * (b + 1))) b++;
        best = Math.max(best, b - a + 1);
      }
      if (best > 0) widths.push(best);
    }
    widths.sort((p, q) => p - q);
    const shaftPx = widths.length ? widths[widths.length >> 1] / sx : 0;
    // Tip: the farthest pixel, along the arrow, of the drawn shaft-and-head stroke (the connected set of arrow pixels
    // grown from the shaft's middle; pulsing icon rings or labels elsewhere are other components).
    let seed = -1;
    for (let r = 0; r <= 6 && seed < 0; r++) {
      for (let c = -r; c <= r && seed < 0; c++) {
        const x = Math.round(tail.x + dx * 0.5 - uy * c), y = Math.round(tail.y + dy * 0.5 + ux * c);
        if (at(x, y)) seed = y * W + x;
      }
    }
    let far = -Infinity, fx = tail.x, fy = tail.y;
    if (seed >= 0) {
      const seen = new Uint8Array(W * H);
      const stack = [seed];
      seen[seed] = 1;
      while (stack.length) {
        const i = stack.pop();
        const x = i % W, y = (i / W) | 0;
        const along = (x - tail.x) * ux + (y - tail.y) * uy;
        if (along > far) { far = along; fx = x; fy = y; }
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const nx = x + ox, ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (!seen[j] && mask[j]) { seen[j] = 1; stack.push(j); }
        }
      }
    }
    const tipErrPx = Math.hypot(fx - axis.x, fy - axis.y) / sx;
    // km per px at the axis point: project a point 50 km north.
    const a2 = P([arrow.axis[0] + 50 / 111.2, arrow.axis[1]]);
    const pxPerKm = Math.hypot(a2.x - axis.x, a2.y - axis.y) / sx / 50;
    // The mask (arrow pixels white) with the projected tail, tip and axis point, for a reviewer.
    const md = g.createImageData(W, H);
    for (let i = 0; i < W * H; i++) { const v = mask[i] ? 255 : 0; md.data[i * 4] = v; md.data[i * 4 + 1] = v; md.data[i * 4 + 2] = v; md.data[i * 4 + 3] = 255; }
    g.putImageData(md, 0, 0);
    for (const [p, c] of [[tail, '#0f0'], [tip, '#ff0'], [axis, '#f00'], [{ x: fx, y: fy }, '#0ff']]) { g.strokeStyle = c; g.lineWidth = 2; g.beginPath(); g.arc(p.x, p.y, 8, 0, 7); g.stroke(); }
    const maskPng = cv.toDataURL('image/png').split(',')[1];
    return { shaftPx, shaftKm: shaftPx / pxPerKm, tipErrPx, tipErrKm: tipErrPx / pxPerKm, cover: n / (W * H), pxPerKm, widths, tail, tip, axis, far: { x: fx, y: fy }, maskPng };
  }, { A, B, B2, C, arrow }).then((r) => {
    fs.writeFileSync(path.join(out, 'front-orbit-arrowmask.png'), Buffer.from(r.maskPng, 'base64'));
    delete r.maskPng;
    console.log(`   V1b geometry ${JSON.stringify(r)}`);
    return r;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// V1 / V13 / V4 / V12: orbit overlay, badge, Guerra panel, audio caps
// ---------------------------------------------------------------------------------------------------------------
if (!only || only.has('orbit')) await section('orbit', async () => {
  let page = await open('front-orbit', '&audio=1');
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
  // V1b measures the DRAWN arrow (owner item #22 overrides «as wide as the corridor»): pixels that change when the
  // arrows batch alone is hidden (A on, B off, C on again: only pixels equal in A and C count, so animation is not the
  // arrow), then the shaft's width across it, where its tip lands against the projected axis point, its share of the
  // screen, the draw order under the bands, and the fade at 1,000 km.
  const geo = arrow ? await measureArrow(page, arrow) : null;
  row('V1b', 'operational arrow (#22): slim shaft, tip on the axis point, corridor <= front, under the bands, faint rails', geo
    ? `shaft ${geo.shaftPx.toFixed(1)} px = ${geo.shaftKm.toFixed(0)} km (corridor ${arrow.corridorKm} km, rails ${arrow.railsKm} km, front ${arrow.frontKm} km); drawn tip ${geo.tipErrPx.toFixed(1)} px / ${geo.tipErrKm.toFixed(0)} km from the axis point; arrow pixels ${(geo.cover * 100).toFixed(2)} % of the screen; order arrows ${o.st.order.arrows} < bands ${o.st.order.bands}`
    : 'none',
  !!geo && geo.shaftPx >= 2.5 && geo.shaftPx <= 9 && geo.shaftKm <= 0.1 * arrow.corridorKm + 5 && geo.tipErrKm <= 30 && arrow.railsKm <= arrow.frontKm + 1
    && o.atk.fr * 25 <= arrow.frontKm + 25 && geo.cover < 0.012 && o.st.order.arrows < o.st.order.bands);
  if (arrow) {
    // Zoomed in to 1,000 km over the same front: the arrow is gone (the band and the borders tell the battle).
    const z = await page.evaluate(async () => {
      const c = __front.ctx.cameraRig.getState();
      __front.ctx.cameraRig.setState({ ...c, altitudeKm: 1000 });
      await new Promise((r) => setTimeout(r, 2500));
      const fade = window.__frontOverlay.arrowFade();
      __front.ctx.cameraRig.setState(c);
      return fade;
    });
    await sleep(2000);
    row('V1d', 'the operational arrow fades out when zoomed in (gone at 1,000 km)', `arrow alpha factor ${z.toFixed(3)} at 1,000 km`, z < 0.01);
  }
  row('V1c', 'badge: both ISO3 codes, tug-of-war bar Pa/(Pa+Pd), measured km/h', b ? `${b.text} share ${b.share} (Pa/(Pa+Pd) ${(o.f.pa / (o.f.pa + o.f.pd)).toFixed(3)})` : 'no badge', !!b && b.text.includes(o.isoA) && b.text.includes(o.isoB) && /km\/h/.test(b.text) && Math.abs(b.share - o.f.pa / (o.f.pa + o.f.pd)) < 0.02);
  // Gauntlet round 1: naval invasion arrows only for real landings (the landing tile's owner is at war with the convoy's
  // owner) of the human or aimed at him or an ally; settlers and peaceful moves have only their route line.
  const nv = await page.evaluate(() => {
    const v = __front.ctx.sim.view, st = window.__frontOverlay.stats();
    const r = { drawn: st.naval, transports: 0, real: 0, expected: 0, neutral: 0, peaceful: 0 };
    for (const u of v.units.values()) {
      if (u.type !== 0 || u.state === 6) continue;
      r.transports++;
      const o = v.owner[Math.floor(u.targetY) * 1600 + Math.floor(u.targetX)];
      if (o === 0) { r.neutral++; continue; }
      if (o === u.owner || v.pairState(u.owner, o) !== 'war') { r.peaceful++; continue; }
      r.real++;
      // (A convoy turning back, UnitState.Returning, has no arrow.)
      if (u.state !== 3 && (u.owner === 1 || o === 1 || v.hasTreaty(1, o, 'alliance'))) r.expected++;
    }
    return r;
  });
  row('V1e', 'naval invasion arrows only for real landings that concern the player', `${nv.drawn} drawn of ${nv.transports} transports (${nv.real} real landings, ${nv.expected} of them the player's or on him/allies; ${nv.neutral} to unclaimed land, ${nv.peaceful} peaceful)`, nv.drawn === nv.expected);
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
  let cam1 = cam0;
  if (await safeClick(page, '.fu-war-front .fu-war-actions button:first-child', 'V4b', 'Ir flies to the front')) {
    // The glide runs on the frame clock (slow under SwiftShader, slower still with another browser on the machine):
    // poll until the camera is down (below 1,500 km) or at rest across rendered frames after moving, up to 4 minutes.
    let prev = null, same = 0;
    const tIr = Date.now();
    while (Date.now() - tIr < 240000) {
      await sleep(1500);
      const c = await page.evaluate(() => ({ s: __front.ctx.cameraRig.getState(), f: __front.ctx.frame.frame }));
      cam1 = c.s;
      if (cam1.altitudeKm < 1500) break;
      if (prev && c.f < prev.f + 2) continue;
      same = prev && Math.abs(c.s.altitudeKm - prev.s.altitudeKm) < 0.5 ? same + 1 : 0;
      prev = c;
      if (same >= 3 && Math.abs(cam1.altitudeKm - cam0.altitudeKm) > 200) break;
    }
    row('V4b', 'Ir flies to the front', `alt ${Math.round(cam0.altitudeKm)} -> ${Math.round(cam1.altitudeKm)} km (${((Date.now() - tIr) / 1000).toFixed(0)} s to land)`, Math.abs(cam1.altitudeKm - cam0.altitudeKm) > 200);
  }
  // V4c: Prioridad alta raises the front's target share and its garrison Gf over ~60 ticks. Measured on a front of ours
  // that no enemy offensive is draining (a landing-sized pocket of the enemy on our southern coast, added here), and
  // against a no-priority baseline: the same front's Gf trend over the 30 ticks before the click, extrapolated.
  // If the staged war ends (another browser slowing the frames lets the AI make peace) the war is staged again.
  const ourFronts = () => page.evaluate(() => { const v = __front.ctx.sim.view; return v.wars.some((x) => x.aggressor === 1 || x.target === 1) ? v.fronts.filter((f) => f.a === 1 || f.b === 1).length : 0; });
  let v4c = null;
  for (let attempt = 1; attempt <= 3 && !v4c; attempt++) {
    if (!(await ourFronts())) {
      console.log(`   V4c: no war front of ours (attempt ${attempt}): staging the war again`);
      await page.close();
      page = await open('front-orbit', '&audio=1');
      await page.evaluate(() => __front.ctx.app.setSpeed(0));
    }
    await page.evaluate(() => {
      const v = __front.ctx.sim.view;
      const w = v.wars.find((x) => x.aggressor === 1 || x.target === 1);
      const enemy = w.aggressor === 1 ? w.target : w.aggressor;
      __front.ctx.sim.debug({ type: 'conquer', playerId: enemy, centerTile: Math.floor((90 - 38.2) / 180 * 800) * 1600 + Math.floor((-3.2 + 180) / 360 * 1600), radius: 3 });
    });
    for (let i = 0; i < 12; i++) {
      await page.evaluate(() => __front.ctx.sim.fastForward(5));
      await sleep(1500);
      if (await page.evaluate(() => __front.ctx.sim.view.fronts.filter((f) => f.a === 1 || f.b === 1).length >= 2)) break;
    }
    if ((await ourFronts()) < 1) continue;
    // Opens the Guerra panel if it closed with a re-stage.
    const readG = (k) => page.evaluate((k) => { const v = __front.ctx.sim.view; const f = v.frontByKey.get(k); if (!f) return null; const s = f.a === 1 ? 'A' : 'B'; return { tick: v.tick, t: f['targetShare' + s], p: f['priority' + s], g: f['garrison' + s], troops: v.human.troops, off: f.a === 1 ? f.offensiveB : f.offensiveA }; }, k);
    const pick = await page.evaluate(() => {
      const v = __front.ctx.sim.view;
      const ours = v.fronts.filter((f) => f.a === 1 || f.b === 1);
      const free = ours.filter((f) => (f.a === 1 ? f.offensiveB : f.offensiveA) === 0);
      const f = (free.length ? free : ours).sort((p, q) => p.length - q.length)[0];
      return { k: f.key, n: ours.length, free: free.length > 0 };
    });
    const g0 = await readG(pick.k);
    await page.evaluate(() => __front.ctx.sim.fastForward(30));
    await sleep(2500);
    const g1 = await readG(pick.k);
    if (!g0 || !g1) continue;
    // The panel row's «Alta» button (the row of that front).
    await page.evaluate(() => { const el = document.querySelector('.fu-warpanel'); if (!el || el.classList.contains('fu-hidden')) window.__fuFronts.panel.open(); });
    await sleep(2500);
    if (!(await safeClick(page, `.fu-war-front[data-key="${pick.k}"] .fu-war-prio button[data-prio="2"]`, 'V4c', 'Prioridad alta button'))) break;
    await sleep(1500);
    let g2 = null;
    for (let i = 0; i < 12; i++) {
      await page.evaluate(() => __front.ctx.sim.fastForward(5));
      await sleep(1200);
      g2 = await readG(pick.k);
      if (!g2 || g2.tick - g1.tick >= 60) break;
    }
    if (!g2) continue;
    const dt = g2.tick - g1.tick;
    // No-priority projection: Gf's own trend before the click (troop losses, redeployment toward the old target),
    // carried over the same number of ticks.
    const base = g1.g + ((g1.g - g0.g) / Math.max(1, g1.tick - g0.tick)) * dt;
    v4c = { pick, g0, g1, g2, dt, base };
  }
  if (v4c) {
    const { pick, g0, g1, g2, dt, base } = v4c;
    row('V4c', `Prioridad alta raises the target share and Gf over ~60 ticks (front ${pick.k} of ${pick.n}, ${pick.free ? 'no enemy offensive on it' : 'UNDER an enemy offensive'})`,
      `priority ${g1.p} -> ${g2.p}; target ${g1.t} -> ${g2.t}; Gf ${Math.round(g1.g)} -> ${Math.round(g2.g)} after ${dt} ticks (no-priority baseline: ${Math.round(g0.g)} -> ${Math.round(g1.g)} over the 30 ticks before, projected ${Math.round(base)}); our troops ${Math.round(g1.troops)} -> ${Math.round(g2.troops)}`,
      g2.p === 2 && dt >= 50 && (pick.n < 2 || g2.t > g1.t) && g2.g > g1.g * 1.05 && g2.g > base * 1.05);
  } else row('V4c', 'Prioridad alta raises the target share and Gf over ~60 ticks', 'front gone in every attempt', false);
  if (!(await ourFronts())) {
    await page.close();
    page = await open('front-orbit', '&audio=1');
    await page.evaluate(() => { __front.ctx.app.setSpeed(0); window.__fuFronts.panel.open(); });
    await sleep(1500);
  }
  await safeClick(page, '.fu-war-card .fu-war-actions .fu-btn--success', 'V4d', 'Proponer paz');
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
  // Wait until the alliance is in the view and the button enabled, then press it.
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    const ready = await page.evaluate((h) => __front.ctx.sim.view.human.allies.includes(h.ally) && !document.querySelector('.fu-war-card .fu-war-actions button:nth-child(2)')?.disabled, help);
    if (ready) break;
  }
  const sentBefore = await page.evaluate(() => [...__front.ctx.sim.view.proposals.values()].length);
  await safeClick(page, '.fu-war-card .fu-war-actions button:nth-child(2)', 'V4e', 'Pedir ayuda');
  let asked = false;
  for (let i = 0; i < 20 && !asked; i++) {
    await page.waitForTimeout(1000);
    asked = await page.evaluate((h) => [...__front.ctx.sim.view.proposals.values()].some((p) => p.from === 1 && p.to === h.ally && p.kind === 'callToArms'), help);
  }
  void sentBefore;
  row('V4e', 'Pedir ayuda sends a call to arms to the allies (W3 proposal flow)', asked ? `callToArms to ${help.ally}` : 'none', asked);
  // Offensive from the panel (#23): «Ofensiva…» opens the dialog, «Lanzar ofensiva» sends one order; the offensive must
  // still be running 40 ticks later with no further click; then «Retirar» brings the troops home with a 10 % loss,
  // measured in the browser on the tick they arrive.
  await page.evaluate(() => { window.__w6msgs = []; __front.ctx.bus.on('message', (e) => window.__w6msgs.push(e.key)); });
  await safeClick(page, '.fu-war-front .fu-btn--amber', 'V4g', 'Ofensiva… opens the dialog');
  const dlg = await page.waitForSelector('.fu-offdlg', { timeout: 15000 }).catch(() => null);
  await sleep(6000);
  const dlgText = dlg ? await page.evaluate(() => document.querySelector('.fu-offdlg')?.textContent ?? '') : '';
  const dlgDiag = await page.evaluate(() => {
    const m = document.querySelector('.fu-offdlg');
    const sc = m?.parentElement;
    if (!m || !sc) return 'none';
    const r = m.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
    return `modal ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} opacity ${getComputedStyle(m).opacity}/${getComputedStyle(sc).opacity} leaving ${sc.classList.contains('is-leaving')} top element ${hit?.className ?? '-'}`;
  });
  console.log(`   V4g dialog: ${dlgDiag}`);
  await shot(page, 'offensive-dialog');
  row('V4g', 'the offensive dialog (#23): troops, intensity, ratio, km/h, casualties per day and a verdict before launching', dlg ? dlgText.slice(0, 300) : 'no dialog', !!dlg && /Relación de fuerzas/.test(dlgText) && /km\/h|sin avance/.test(dlgText) && /Bajas propias por día/.test(dlgText) && /Intensidad/.test(dlgText));
  if (dlg) await safeClick(page, '.fu-offdlg .fu-offdlg-go', 'V4f1', 'Lanzar ofensiva');
  await sleep(1500);
  // (Paused: the order is carried out on the next tick.)
  await page.evaluate(() => __front.ctx.sim.fastForward(2));
  await sleep(2500);
  const own = await page.evaluate(() => { const a = __front.ctx.sim.view.attacks.find((x) => x.attacker === 1 && x.defender > 0 && x.id > 0); return a ? { id: a.id, troops: a.troops, tick: __front.ctx.sim.view.tick } : null; });
  let alive = null;
  if (own) {
    await page.evaluate(() => __front.ctx.sim.fastForward(40));
    await sleep(2500);
    alive = await page.evaluate((o) => { const v = __front.ctx.sim.view; const a = v.attacks.find((x) => x.id === o.id); return a ? { state: a.state, troops: a.troops, ratio: a.ratio, intensity: a.intensity, tick: v.tick } : null; }, own);
  }
  const said = await page.evaluate(() => (window.__w6msgs ?? []).join(','));
  row('V4f1', 'Contraofensiva launches ours and it persists without further clicks (40 ticks later)', own ? `offensive ${own.id} (${own.troops}) at tick ${own.tick} -> ${alive ? `${alive.state}, intensity ${alive.intensity}, ratio ${alive.ratio} at tick ${alive.tick}` : 'gone'}; messages [${said}]` : `none; messages [${said}]`, !!own && !!alive && alive.state !== 'retreating');
  // The panel row manages it: set «Mantener la línea», then Retirar.
  await sleep(1500);
  const holdBtn = await page.$('.fu-war-front .fu-war-int button[data-int="0"]');
  if (holdBtn && await holdBtn.isVisible()) await holdBtn.click();
  await sleep(1500);
  await page.evaluate(() => __front.ctx.sim.fastForward(1));
  await sleep(2000);
  const held = own ? await page.evaluate((o) => __front.ctx.sim.view.attacks.find((x) => x.id === o.id)?.intensity ?? -1, own) : -1;
  row('V4h', 'the panel row changes the offensive\'s intensity (Mantener la línea)', `intensity ${held}`, held === 0);
  const retreatVisible = await page.evaluate(() => { const b = document.querySelector('.fu-war-front .fu-btn--danger'); return !!b && !b.classList.contains('fu-hidden'); });
  let back = null;
  if (retreatVisible && own) {
    await safeClick(page, '.fu-war-front .fu-btn--danger', 'V4f', 'Retirar');
    await sleep(1500);
    // (Paused: the order is carried out on the next tick.)
    await page.evaluate(() => __front.ctx.sim.fastForward(1));
    await sleep(2000);
    back = await page.evaluate(async (o) => {
      const ctx = __front.ctx;
      const find = () => ctx.sim.view.attacks.find((x) => x.id === o.id);
      const st0 = find()?.state ?? 'gone';
      for (let i = 0; i < 30; i++) {
        const a = find();
        if (!a) return { st0, err: 'ended before measuring' };
        const inOff = a.troops, home = ctx.sim.view.human.troops;
        await ctx.sim.fastForward(1);
        await new Promise((r) => setTimeout(r, 300));
        if (!find()) {
          const got = ctx.sim.view.human.troops - home;
          return { st0, inOff, got, loss: 1 - got / Math.max(1, inOff) };
        }
      }
      return { st0, err: 'never came home' };
    }, own);
  }
  row('V4f', 'Retirar ends our offensive: the troops come home 2 h later with a 10 % loss (measured in the browser)', back ? (back.err ? `${back.st0}: ${back.err}` : `${back.st0}; ${Math.round(back.inOff)} in the offensive, ${Math.round(back.got)} back = ${(back.loss * 100).toFixed(1)} % lost`) : `retreat button ${retreatVisible ? 'shown' : 'hidden'}`, !!back && !back.err && back.st0 === 'retreating' && Math.abs(back.loss - 0.1) <= 0.03);
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
});

// ---------------------------------------------------------------------------------------------------------------
// V3: mobilization arrows and dashed quiet fronts
// ---------------------------------------------------------------------------------------------------------------
if (!only || only.has('mob')) await section('mob', async () => {
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
});

// ---------------------------------------------------------------------------------------------------------------
// V6: front-600 smoke coverage and flashes inside the band
// ---------------------------------------------------------------------------------------------------------------
if (!only || only.has('600')) await section('600', async () => {
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
});

// ---------------------------------------------------------------------------------------------------------------
// V7: plume-zoom
// ---------------------------------------------------------------------------------------------------------------
if (!only || only.has('plume')) await section('plume', async () => {
  const page = await open('plume-zoom');
  await shot(page, 'plume-zoom');
  const z = await page.evaluate(() => window.__plumeZoom);
  const all = (z ?? []).flatMap((s) => s.plumes.map((p) => ({ alt: s.alt, ...p })));
  row('V7', 'plume at 700 km and 200 km: <= 8 % of the screen height, world size <= 20 km', all.map((p) => `${p.alt} km: ${(p.screenFrac * 100).toFixed(1)} % (${p.heightPx} px), world ${p.worldKm} km drawn ${p.drawnKm}`).join('; ') || 'no plume', all.length >= 2 && all.every((p) => p.screenFrac <= 0.08 && p.worldKm <= 20));
  await page.close();
});

// ---------------------------------------------------------------------------------------------------------------
// V8 / V11: the ground battle from real data, banners and the strip (es and en)
// ---------------------------------------------------------------------------------------------------------------
if (!only || only.has('ground')) await section('ground', async () => {
  const page = await open('front-ground-real', '&quality=medium');
  await shot(page, 'front-ground-real');
  const g = await page.evaluate(bannerState);
  const d = g.d;
  if (d) {
    const errA = d.split[0] ? Math.abs(d.infantry[0] / d.split[0] - 1) : (d.infantry[0] === 0 ? 0 : 1);
    const errB = d.split[1] ? Math.abs(d.infantry[1] / d.split[1] - 1) : (d.infantry[1] === 0 ? 0 : 1);
    row('V8a', 'visible infantry per side within ±10 % of visibleSplit()', `deployed ${d.infantry.join('/')} vs split ${d.split.join('/')}`, errA <= 0.1 && errB <= 0.1 && d.infantry[0] + d.infantry[1] > 0);
    const posErr = Math.max(0, ...d.divisions.map((x) => Math.hypot(x.drawnX - x.realX, x.drawnZ - x.realZ)));
    // Independent count: the sim's divisions of the two sides within 50 km of the battle's anchor, with 1 tank per 25 %.
    const real = await page.evaluate(() => {
      const a = window.__battleDebug.anchor;
      const v = __front.ctx.sim.view;
      const out = [];
      for (const u of v.units.values()) {
        if (u.type !== 3) continue;
        const la = 90 - (u.y / 800) * 180, lo = (u.x / 1600) * 360 - 180;
        const dl = (la - a.lat) * 111.2, dn = (lo - a.lon) * 111.2 * Math.cos((a.lat * Math.PI) / 180);
        if (Math.hypot(dl, dn) <= 49) out.push({ id: u.id, tanks: Math.max(1, Math.ceil(u.hp * 4 - 1e-6)) });
      }
      return out;
    });
    const allShown = real.every((r) => d.divisions.some((x) => x.unitId === r.id && x.tanks === r.tanks && x.ifvs === 2));
    row('V8b', 'every real division within 50 km: 1 tank per 25 % integrity + 2 IFVs at its real position', `${d.divisions.length} drawn / ${real.length} in the sim within 49 km (${d.divisions.map((x) => `#${x.unitId} ${x.tanks}T+${x.ifvs}`).join(', ')}), max centroid offset ${Math.round(posErr)} m`, allShown && d.divisions.every((x) => x.ifvs === 2 && x.tanks >= 1 && x.tanks <= 4) && posErr < 300);
    // Independent reading of the sim's line at the battle's anchor, straight from the FrontView (not the battle's own
    // numbers): the published sub-tile line (FrontView.line, T41) offset along the battle's normal, else the tile-level
    // contact line (samples, half a tile along dir, moved by the per-vertex progress) where it crosses that normal.
    const ind = await page.evaluate(simLineAtAnchor);
    const lineErr = ind ? Math.abs(d.lineShift - ind.shiftM) : Infinity;
    row('V8c', 'the local line lies within 2 km of the sub-tile front position (independent reading of FrontView at the anchor)', ind ? `drawn ${Math.round(d.lineShift)} m vs FrontView ${ind.source} ${Math.round(ind.shiftM)} m (Δ ${Math.round(lineErr)} m; battle's own sim reading ${Math.round(d.simShift)} m, snaps ${d.lineSnaps}); ${ind.note}` : 'no FrontView reading', !!ind && lineErr <= 2000);
  } else row('V8', 'ground battle built', 'no battle', false);
  row('V11a', 'nation banners above each side (both on screen, clear of every HUD panel) and the HUD strip (es): name, sides, troops, advance, days', `${g.banners.map((b) => `${b.text} [${b.state}]`).join(' | ')} || ${g.strip}`, g.banners.length === 2 && g.banners.every((b) => b.state === 'clear') && g.banners.some((b) => /ataca/.test(b.text)) && g.banners.some((b) => /defiende/.test(b.text)) && g.stripOn && /ataca/.test(g.strip) && /día de combate/.test(g.strip) && /avance/.test(g.strip));
  await page.evaluate(() => __front.ctx.settings.set({ language: 'en' }));
  await sleep(20000);
  const en = await page.evaluate(bannerState);
  const clock = await page.evaluate(() => document.querySelector('.fu-day-label')?.textContent ?? '');
  row('V11b', 'the strip, banners and the clock in English after the language switch', `${en.banners.map((b) => `${b.text} [${b.state}]`).join(' | ')} || ${en.strip} || clock «${clock}»`, /attacking/.test(en.strip) && /day of fighting/.test(en.strip) && /advance/.test(en.strip) && en.banners.every((b) => /attacking|defending/.test(b.text) && b.state === 'clear') && /day/i.test(clock) && !/día/i.test(clock));
  await shot(page, 'front-ground-real-en');
  await page.close();
});

// ---------------------------------------------------------------------------------------------------------------
// V17 (W6 final fix pass, FEEDBACK #11 at night): the ground battle staged in the middle of the night (&night=1: the sun
// on the far side of the planet) must read as well as by day: the moonlit scene, flares, fire and tracers light the
// line; soldiers of both sides and both banners on screen; measured on the frame's brightness where the battle is (the
// HUD panels excluded), at the shot's framing and again at 450 m.
// ---------------------------------------------------------------------------------------------------------------
async function frameLight(page) {
  const b64 = (await page.screenshot({ timeout: 300000 })).toString('base64');
  return page.evaluate(async (src) => {
    const im = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + src; });
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
    const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const sx = c.width / window.innerWidth;
    const rects = [...__front.ctx.ui.getOccludedRects()].map((r) => ({ l: r.left * sx, r: r.right * sx, t: r.top * sx, b: r.bottom * sx }));
    let n = 0, sum = 0, lit = 0;
    const lum = [];
    for (let y = Math.floor(c.height * 0.2); y < c.height * 0.85; y += 2) for (let x = 0; x < c.width; x += 2) {
      if (rects.some((q) => x >= q.l && x < q.r && y >= q.t && y < q.b)) continue;
      const k = (y * c.width + x) * 4;
      const L = 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2];
      sum += L; n++;
      if (L > 45) lit++;
      lum.push(L);
    }
    lum.sort((p, q) => p - q);
    return { mean: sum / Math.max(1, n), lit: lit / Math.max(1, n), p90: lum[Math.floor(lum.length * 0.9)] ?? 0 };
  }, b64);
}
if (!only || only.has('night')) await section('night', async () => {
  const page = await open('front-ground-real', '&night=1&quality=medium');
  await sleep(3000);
  const read = async (tag) => {
    const g = await page.evaluate(bannerState);
    const o = await page.evaluate(() => ({ soldiers: window.__battleDebug.soldiersOnScreen(200), d: window.__battleDebug.shown() }));
    const light = await frameLight(page);
    await shot(page, `night-${tag}`);
    return { g, o, light };
  };
  const verdict = (r) => {
    const both = !!r.o.soldiers && r.o.soldiers.length === 2 && r.o.soldiers.every((x) => x.onScreen >= 10);
    const banners = r.g.banners.length === 2 && r.g.banners.every((b) => b.state === 'clear');
    return { both, banners, text: `night ${r.o.d ? r.o.d.night.toFixed(2) : '-'}, flares ${r.o.d?.flares ?? '-'}; frame mean luma ${r.light.mean.toFixed(1)}, lit (>45) ${(r.light.lit * 100).toFixed(1)} %, p90 ${r.light.p90.toFixed(0)}; soldiers ${r.o.soldiers ? r.o.soldiers.map((x) => `${x.onScreen}/${x.sampled} (${x.medianPx} px)`).join(' vs ') : 'none'}; banners ${r.g.banners.map((b) => `${b.text} [${b.state}]`).join(' | ')}` };
  };
  const lightOk = (r) => r.light.mean >= NIGHT_MIN_MEAN && r.light.lit >= NIGHT_MIN_LIT;
  const r1 = await read('ground');
  const v1 = verdict(r1);
  row('V17a', 'night battle at the shot framing: really night, lit enough to read (moon, flares, fire), both sides and both banners on screen', v1.text, !!r1.o.d && r1.o.d.night >= 0.9 && r1.o.d.flares >= 1 && lightOk(r1) && v1.both && v1.banners);
  // Down to 450 m over the battle (the iter-3 evidence was a black frame here).
  await page.evaluate(() => { const c = __front.ctx.cameraRig.getState(); __front.ctx.cameraRig.setState({ ...c, altitudeKm: 0.45 }); });
  await sleep(25000);
  const r2 = await read('450');
  const v2 = verdict(r2);
  row('V17b', 'night battle at 450 m: lit enough to read, both sides and both banners on screen', v2.text, !!r2.o.d && lightOk(r2) && v2.both && v2.banners);
  await page.close();
});

// ---------------------------------------------------------------------------------------------------------------
// V14: the ground battle where the player looks, WITHOUT the shot's framing (FEEDBACK #11 «where they are»):
//   V14a Guerra panel «Ir», then the mouse wheel at the centre of the screen down to ~3 km: the battle stands under the
//        view target, soldiers of both sides and both banners on screen.
//   V14b the camera put down 35 km behind the line, low and tilted like a player looking around: no battle is built
//        far outside the view; the battle pointer says where it is; «Ir a la batalla» glides there and the soldiers
//        and both banners are on screen.
// ---------------------------------------------------------------------------------------------------------------
if (!only || only.has('descent')) await section('descent', async () => {
  const page = await open('front-orbit', '&quality=medium');
  await page.evaluate(() => __front.ctx.app.setSpeed(0));
  const waitBattle = async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const ok = await page.evaluate(() => { const d = window.__battleDebug; return !!d && d.built && !!d.shown() && __front.ctx.battle.active; });
      if (ok) return true;
      await sleep(2000);
    }
    return false;
  };
  // The camera at rest (a glide or the zoom damping finished): three equal readings 3 s apart (frames are slow here).
  const settle = async (maxMs) => {
    const t0 = Date.now();
    let prev = null, same = 0;
    while (Date.now() - t0 < maxMs) {
      await sleep(3000);
      // Compared across rendered frames only (a frame can take several seconds here: two readings between the same
      // two frames are always equal).
      const c = await page.evaluate(() => { const s = __front.ctx.cameraRig.getState(); return { k: `${s.lat.toFixed(4)},${s.lon.toFixed(4)},${s.altitudeKm.toFixed(2)},${s.tilt.toFixed(2)}`, f: __front.ctx.frame.frame }; });
      if (prev && c.f < prev.f + 2) continue;
      same = prev && c.k === prev.k ? same + 1 : 0;
      prev = c;
      if (same >= 2) return true;
    }
    return false;
  };
  const onScreen = () => page.evaluate(() => ({ soldiers: window.__battleDebug.soldiersOnScreen(200), cam: __front.ctx.cameraRig.getState(), anchor: window.__battleDebug.anchor }));
  const gcKm = (a, b) => { const R = 6371, d = Math.PI / 180; const x = Math.sin(((b.lat - a.lat) * d) / 2) ** 2 + Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin(((b.lon - a.lon) * d) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
  const verdict = (o, g) => {
    const both = !!o.soldiers && o.soldiers.every((x) => x.onScreen >= 10);
    const banners = g.banners.length === 2 && g.banners.every((b) => b.state === 'clear');
    return { both, banners, text: `soldiers on screen ${o.soldiers ? o.soldiers.map((x) => `${x.onScreen}/${x.sampled} (${x.medianPx} px)`).join(' vs ') : 'none'}; anchor ${o.anchor ? gcKm(o.anchor, o.cam).toFixed(1) : '-'} km from the view target (alt ${o.cam.altitudeKm.toFixed(1)} km, tilt ${o.cam.tilt.toFixed(2)}); banners ${g.banners.map((b) => `${b.text} [${b.state}]`).join(' | ')}` };
  };
  // V14a: Ir, then zoom with the wheel.
  await page.mouse.move(800, 450);
  await page.keyboard.press('g');
  await sleep(1500);
  await uiClick(page, '.fu-war-front .fu-war-actions button:first-child');
  await sleep(4000);
  await page.keyboard.press('g');
  await sleep(1000);
  for (let i = 0; i < 80; i++) {
    const alt = await page.evaluate(() => __front.ctx.cameraRig.getState().altitudeKm);
    if (alt < 3.2) break;
    await page.mouse.move(800, 450);
    await page.mouse.wheel(0, -300);
    await sleep(700);
  }
  await settle(300000);
  const builtA = await waitBattle(240000);
  // (A battle whose line is just out of view makes the camera settle onto it: wait for that glide too.)
  await sleep(4000);
  await settle(400000);
  await waitBattle(240000);
  const oA = await onScreen();
  const gA = await page.evaluate(bannerState);
  await shot(page, 'descent-ir-zoom');
  const vA = verdict(oA, gA);
  row('V14a', 'Ir then wheel zoom to ~3 km (no shot framing): battle under the view, soldiers of both sides and both banners on screen', `${builtA ? 'built' : 'NOT built'}; ${vA.text}`, builtA && vA.both && vA.banners);
  // V14b: put down 35 km behind our line, looking around.
  const put = await page.evaluate(() => {
    const v = __front.ctx.sim.view;
    const f = v.fronts.find((q) => !q.quiet && (q.a === 1 || q.b === 1));
    const n = f.samples.length >> 1, m = n >> 1;
    const s = f.b === 1 ? 1 : -1; // into our land
    const x = f.samples[m * 2] + f.dirX * (0.5 + 1.4 * s), y = f.samples[m * 2 + 1] + f.dirY * (0.5 + 1.4 * s);
    const lat = 90 - (y / 800) * 180, lon = (x / 1600) * 360 - 180;
    __front.ctx.cameraRig.setState({ lat, lon, altitudeKm: 2.5, tilt: 1.15, heading: 0.7 });
    return { lat, lon };
  });
  // The previous battle (35 km away now) fades out over a few frames; then the pointer is read, twice in a row the same.
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const on = await page.evaluate(() => { const a = window.__battleDebug.anchor; const c = __front.ctx.cameraRig.getState(); if (!a || !__front.ctx.battle.active) return false; const d = Math.hypot((a.lat - c.lat) * 111.2, (a.lon - c.lon) * 111.2 * Math.cos((c.lat * Math.PI) / 180)); return d > 12; });
    if (!on) break;
  }
  let ptr = null, prev = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1500);
    const now = await page.evaluate(() => { const e = document.querySelector('.fu-bpointer'); return e && !e.classList.contains('fu-hidden') ? e.textContent : null; });
    if (now && now === prev) { ptr = now; break; }
    prev = now;
  }
  const far = await page.evaluate(() => { const a = window.__battleDebug.anchor; const c = __front.ctx.cameraRig.getState(); return a && __front.ctx.battle.active ? { a, c } : null; });
  const farKm = far ? gcKm(far.a, far.c) : 0;
  await shot(page, 'descent-offline');
  row('V14b', 'camera low 35 km behind the line: no battle built outside the view, the pointer says where the battle is', `pointer «${ptr ?? 'none'}»; ${far ? `a battle is shown ${farKm.toFixed(1)} km away` : 'no battle built there'} (camera at ${put.lat.toFixed(2)}, ${put.lon.toFixed(2)})`, !!ptr && (!far || farKm <= 12));
  if (ptr) {
    await uiClick(page, '.fu-bpointer .fu-btn');
    // The glide runs on the frame clock (slow under SwiftShader): wait for the camera to land.
    for (let i = 0; i < 300; i++) {
      await sleep(1500);
      const c = await page.evaluate(() => __front.ctx.cameraRig.getState());
      if (c.altitudeKm < 3.3) break;
    }
    await settle(400000);
    const builtC = await waitBattle(240000);
    await sleep(4000);
    await settle(400000);
    await waitBattle(240000);
    const oC = await onScreen();
    const gC = await page.evaluate(bannerState);
    await shot(page, 'descent-pointer-go');
    const vC = verdict(oC, gC);
    row('V14c', '«Ir a la batalla» glides down to the line: soldiers of both sides and both banners on screen', `${builtC ? 'built' : 'NOT built'}; ${vC.text}`, builtC && vC.both && vC.banners);
  } else row('V14c', '«Ir a la batalla» glides down to the line', 'no pointer', false);
  await page.close();
});

// ---------------------------------------------------------------------------------------------------------------
// V9 / V10: observation time moves the line continuously at advanceKmh × rate / 3600; animation clock on real time
// ---------------------------------------------------------------------------------------------------------------
if (!only || only.has('obs')) await section('obs', async () => {
  const obsRuns = Math.max(1, Number(args.obsRuns ?? 1));
  let page = null;
  for (let run = 1; run <= obsRuns; run++) {
    if (page) await page.close();
    page = await open('front-observation', '&quality=low&observe=4000');
    const samples = [];
    let obsBanners = null, maxLineErr = 0, lineErrN = 0, lineErrAt = '';
    for (let i = 0; i < 44; i++) {
      // The shot as the player sees it when the camera arrives, and again after 10 s and at the end of the window (the
      // shot's camera pans with the line); banners and strip on the first.
      if (i === 0) {
        obsBanners = await page.evaluate(bannerState);
        await shot(page, run === 1 ? 'front-observation' : `front-observation-${run}`);
      }
      if (i === 10) await shot(page, run === 1 ? 'front-observation-10s' : `front-observation-${run}-10s`);
      // The drawn line (battle debug) and, independently, what the sim publishes for that front (FrontView).
      const s = await page.evaluate(() => {
        const d = window.__battleDebug.shown();
        const v = __front.ctx.sim.view;
        const f = d ? v.frontByKey.get(d.frontKey) : null;
        return { t: performance.now() / 1000, d, mode: v.clock.mode, rate: v.clock.rate, tick: v.tick, kmh: f ? f.advanceKmh : 0, sign: f && f.line ? Math.sign(f.line.kmh) : 0, focus: !!(f && f.line && f.line.focus) };
      });
      samples.push(s);
      // V8c through the observation: the drawn line against the independent FrontView reading, every sample.
      const ind = s.d && s.d.subTile ? await page.evaluate(simLineAtAnchor) : null;
      const d2 = ind ? await page.evaluate(() => window.__battleDebug.shown()?.lineShift ?? null) : null;
      if (ind && d2 !== null) {
        const e = Math.abs(d2 - ind.shiftM);
        lineErrN++;
        if (e > maxLineErr) { maxLineErr = e; lineErrAt = `drawn ${Math.round(d2)} m vs ${Math.round(ind.shiftM)} m at sample ${i}`; }
      }
      await sleep(1000);
    }
    await shot(page, run === 1 ? 'front-observation-end' : `front-observation-${run}-end`);
    console.log('   V9 series', JSON.stringify(samples.map((s) => s.d && [+s.t.toFixed(1), Math.round(s.d.lineShift), s.tick, +s.kmh.toFixed(2), s.focus ? 1 : 0, s.d.builds])), JSON.stringify(samples[samples.length - 1]?.d?.reanchorWhy));
    // Least-squares slope of the drawn line over real time (m per real s), per battle build (a re-anchor re-centres the
    // battle on the line: offsets restart there), combined by the time each build covers.
    const slope = (pts) => {
      const n = pts.length;
      const mt = pts.reduce((a, p) => a + p[0], 0) / n, mv = pts.reduce((a, p) => a + p[1], 0) / n;
      let num = 0, den = 0;
      for (const [t, v] of pts) { num += (t - mt) * (v - mv); den += (t - mt) ** 2; }
      return den > 0 ? num / den : 0;
    };
    const ok = samples.filter((s) => s.d && s.d.subTile);
    const segs = new Map();
    for (const s of ok) {
      const k = s.d.builds;
      if (!segs.has(k)) segs.set(k, []);
      segs.get(k).push(s);
    }
    let wsum = 0, msum = 0, jumps = 0;
    for (const seg of segs.values()) {
      for (let i = 1; i < seg.length; i++) if (Math.abs(seg[i].d.lineShift - seg[i - 1].d.lineShift) > 5000) jumps++;
      if (seg.length < 8) continue;
      const dur = seg[seg.length - 1].t - seg[0].t;
      msum += slope(seg.map((s) => [s.t, s.d.lineShift])) * dur;
      wsum += dur;
    }
    const measured = wsum > 0 ? msum / wsum : 0;
    // Expected: the front's measured advance as the badge, panel and strip show it (FrontView.advanceKmh), in the
    // direction the published line moves, at the clock's rate: km/h × rate / 3.6 = m per real second.
    const used = ok.filter((s) => s.sign !== 0);
    const expected = used.length ? used.reduce((a, s) => a + (s.sign * s.kmh * s.rate) / 3.6, 0) / used.length : 0;
    const last = samples[samples.length - 1];
    const dTick = last.tick - samples[0].tick, dT = last.t - samples[0].t;
    row(obsRuns > 1 ? `V8d.${run}` : 'V8d', 'observation: the drawn line stays within 2 km of the independent FrontView reading at every sample', `${lineErrN} samples, max Δ ${Math.round(maxLineErr)} m${lineErrAt ? ` (${lineErrAt})` : ''}`, lineErrN >= 20 && maxLineErr <= 2000);
    const ob = obsBanners;
    row(obsRuns > 1 ? `V11c.${run}` : 'V11c', 'observation shot: both nation banners on screen and clear of the HUD, strip shown', ob ? `${ob.banners.map((b) => `${b.text} [${b.state}]`).join(' | ')} || ${ob.strip}` : 'none', !!ob && ob.banners.length === 2 && ob.banners.every((b) => b.state === 'clear') && ob.stripOn && /ataca/.test(ob.strip));
    row(obsRuns > 1 ? `V9.${run}` : 'V9', 'observation: clock observation, line speed = advanceKmh × rate / 3600 (±15 %), no 25 km jumps', `mode ${last?.mode} rate ${last?.rate}; drawn ${measured.toFixed(1)} m/s vs FrontView advanceKmh×rate/3.6 ${expected.toFixed(1)} m/s (${((measured / (expected || 1) - 1) * 100).toFixed(1)} %) over ${ok.length} samples in ${segs.size} build(s), ${used.filter((s) => s.focus).length} at the focus; sim ${dTick} ticks in ${dT.toFixed(0)} s (${((dTick * 360) / Math.max(1, dT)).toFixed(0)} game s per s); jumps ${jumps}`, last?.mode === 'observation' && expected !== 0 && wsum >= 20 && Math.abs(measured / expected - 1) <= 0.15 && jumps === 0);
  }
  // V10: battle animation clock per real second at 0.5x and 4x and paused.
  // A rebuild (the moving line left the patch) pre-ages the new battlefield by 12 s of battle time: measure a window
  // without one.
  const rate = async (speed) => {
    await page.evaluate((sp) => __front.ctx.app.setSpeed(sp), speed);
    await sleep(1500);
    let r = null;
    for (let k = 0; k < 4; k++) {
      // Clock and frame time read together (both set by the same frame), over a 20 s window.
      const a = await page.evaluate(() => ({ c: window.__battleDebug.clock, t: __front.ctx.frame.now / 1000, f: __front.ctx.frame.frame, b: window.__battleDebug.shown()?.builds ?? -1 }));
      await sleep(20000);
      const b = await page.evaluate(() => ({ c: window.__battleDebug.clock, t: __front.ctx.frame.now / 1000, f: __front.ctx.frame.frame, b: window.__battleDebug.shown()?.builds ?? -1 }));
      r = { perS: (b.c - a.c) / (b.t - a.t), fps: (b.f - a.f) / (b.t - a.t) };
      if (a.b === b.b && a.b >= 0) break;
    }
    return r;
  };
  const r05 = await rate(0.5), r4 = await rate(4), r0 = await rate(0);
  row('V10', 'battle animation per real second equal at 0.5x and 4x (±15 %), frozen on pause', `0.5x ${r05.perS.toFixed(3)}/s (${r05.fps.toFixed(1)} fps), 4x ${r4.perS.toFixed(3)}/s (${r4.fps.toFixed(1)} fps), paused ${r0.perS.toFixed(3)}/s`, Math.abs(r05.perS / r4.perS - 1) <= 0.15 && r0.perS === 0);
  await page.close();
});

// ---------------------------------------------------------------------------------------------------------------
// V15 / V16 (W6 final fix pass): real play on a war the player starts, driven through the UI.
//   V16 «Enviar divisiones»: a division 400 km from the front is listed with its ETA and an enabled ENVIAR; the click
//       gives it the order 'attach' and it later carries that front's key.
//   V15 an offensive launched from the dialog runs >= 300 ticks and advances far past its first axis point: the arrow
//       stays on the front where it fights, its tip on enemy land ahead of the line, the measured km/h > 0 and in line
//       with the rate tiles fall, and the ground battle at its contact shows the offensive's troops.
// ---------------------------------------------------------------------------------------------------------------
if (!only || only.has('advance')) await section('advance', async () => {
  // The plains theatre (Picardy / Artois): the §4.5 plains speed applies, so an offensive at ~3 : 1 covers 300+ km in
  // 42 h. (Across the Pyrenees it crawls at 0.3-0.5 km/h and never reaches its axis point in 420 ticks.)
  const page = await open('front-orbit', '&theatre=plains&attacker=none&humanTroops=1400000&enemyTroops=150000&run=30');
  await page.evaluate(() => {
    __front.ctx.app.setSpeed(0);
    window.__w6msgs = [];
    __front.ctx.bus.on('message', (e) => window.__w6msgs.push({ key: e.key, tick: __front.ctx.sim.view.tick }));
    // A division of ours in the south of our land (Limousin), some 500 km from the front.
    const tile = (lat, lon) => Math.floor(((90 - lat) / 180) * 800) * 1600 + Math.floor(((lon + 180) / 360) * 1600);
    __front.ctx.sim.debug({ type: 'spawnUnit', unit: 3, owner: 1, tile: tile(45.6, 1.4), targetTile: -1 });
  });
  await page.evaluate(() => __front.ctx.sim.fastForward(2));
  await sleep(2500);
  const st0 = await page.evaluate(() => {
    const v = __front.ctx.sim.view;
    const f = v.fronts.filter((q) => q.a === 1 || q.b === 1).sort((p, q) => q.length - p.length)[0];
    const us = [...v.units.values()].filter((u) => u.owner === 1 && u.type === 3);
    const far = us.filter((u) => u.frontKey !== f?.key).sort((p, q) => q.id - p.id)[0];
    return { k: f?.key ?? 0, enemy: f ? (f.a === 1 ? f.b : f.a) : 0, unit: far ? { id: far.id, order: far.order, frontKey: far.frontKey } : null };
  });
  if (!st0.k || !st0.unit) {
    row('V16', 'Enviar divisiones', `staging failed: front ${st0.k}, far division ${JSON.stringify(st0.unit)}`, false);
    await page.close();
    return;
  }
  await page.evaluate(() => window.__fuFronts.panel.open());
  await sleep(2000);
  const rowSel = `.fu-war-front[data-key="${st0.k}"]`;
  let v16 = null;
  try {
    await uiClick(page, page.locator(`${rowSel} .fu-war-actions > button`, { hasText: /Enviar divisiones/ }));
    await sleep(3500);
    v16 = await page.evaluate((sel) => [...document.querySelectorAll(`${sel} .fu-war-send`)].map((e) => ({ text: e.textContent, eta: e.querySelector('.fu-war-send-eta')?.textContent ?? '', enabled: !e.querySelector('button').disabled })), rowSel);
  } catch (e) {
    row('V16a', 'Enviar divisiones lists the division with its ETA', `step failed: ${errText(e)}`, false);
  }
  if (v16) {
    const first = v16[0];
    row('V16a', 'Enviar divisiones lists a division far from the front with its ETA and an enabled ENVIAR', v16.map((r) => `${r.text} [${r.enabled ? 'enabled' : 'DISABLED'}]`).join(' | ') || 'empty list', !!first && /\d/.test(first.eta) && first.enabled);
    if (first && first.enabled) {
      await safeClick(page, `${rowSel} .fu-war-send button`, 'V16b', 'ENVIAR');
      await sleep(1500);
      await page.evaluate(() => __front.ctx.sim.fastForward(2));
      await sleep(2500);
      const u1 = await page.evaluate((id) => { const u = __front.ctx.sim.view.units.get(id); return u ? { order: u.order, frontKey: u.frontKey, tick: __front.ctx.sim.view.tick } : null; }, st0.unit.id);
      let u2 = u1;
      for (let i = 0; i < 30 && u2 && u2.frontKey !== st0.k; i++) {
        await page.evaluate(() => __front.ctx.sim.fastForward(10));
        await sleep(1500);
        u2 = await page.evaluate((id) => { const u = __front.ctx.sim.view.units.get(id); return u ? { order: u.order, frontKey: u.frontKey, tick: __front.ctx.sim.view.tick } : null; }, st0.unit.id);
      }
      row('V16b', 'the click orders the division to attach (UnitView.order = attach) and it later joins that front (frontKey)', `before: order ${st0.unit.order}, key ${st0.unit.frontKey}; after the click: order ${u1?.order}; joined key ${u2?.frontKey} of front ${st0.k} after ${u2 && u1 ? u2.tick - u1.tick : '-'} ticks (listed ETA ${first.eta})`, !!u1 && u1.order === 1 && !!u2 && u2.frontKey === st0.k);
    }
  }
  // V15: the offensive from the dialog.
  await page.evaluate(() => { const el = document.querySelector('.fu-warpanel'); if (!el || el.classList.contains('fu-hidden')) window.__fuFronts.panel.open(); });
  await sleep(1500);
  if (!(await safeClick(page, `${rowSel} .fu-btn--amber`, 'V15', 'Ofensiva… opens the dialog'))) { await page.close(); return; }
  await page.waitForSelector('.fu-offdlg', { timeout: 20000 });
  await sleep(4000);
  if (!(await safeClick(page, '.fu-offdlg .fu-offdlg-go', 'V15', 'Lanzar ofensiva'))) { await page.close(); return; }
  await sleep(1500);
  await page.evaluate(() => __front.ctx.sim.fastForward(2));
  await sleep(2500);
  const a0 = await page.evaluate(() => { const v = __front.ctx.sim.view; const a = v.attacks.find((x) => x.attacker === 1 && x.defender > 0); return a ? { id: a.id, x: a.x, y: a.y, ox: a.originX, oy: a.originY, key: a.frontKey, tick: v.tick, troops: a.troops } : null; });
  if (!a0) {
    row('V15', 'offensive launched from the dialog', 'no offensive of ours', false);
    await page.close();
    return;
  }
  const sample = () => page.evaluate((id) => {
    const v = __front.ctx.sim.view;
    const a = v.attacks.find((x) => x.id === id);
    if (!a) return null;
    const wdx = (d) => (d > 800 ? d - 1600 : d < -800 ? d + 1600 : d);
    const pair = v.fronts.filter((q) => (q.a === 1 && q.b === a.defender) || (q.b === 1 && q.a === a.defender));
    // Independent: the pair's front whose contact line is nearest to the offensive's live contact.
    let near = 0, nd = Infinity;
    if (a.contactX >= 0) for (const f of pair) for (let k = 0; k < f.samples.length; k += 2) {
      const d = Math.hypot(wdx(f.samples[k] - a.contactX), f.samples[k + 1] - a.contactY);
      if (d < nd) { nd = d; near = f.key; }
    }
    let ux = wdx(a.x - a.originX), uy = a.y - a.originY;
    const ul = Math.hypot(ux, uy) || 1;
    ux /= ul; uy /= ul;
    const along = (x, y) => wdx(x - a.originX) * ux + (y - a.originY) * uy;
    const ar = window.__frontOverlay.stats().arrows.find((r) => r.attackId === id);
    const tileOf = (ll) => { const y = Math.floor(((90 - ll[0]) / 180) * 800), x = Math.floor(((ll[1] + 180) / 360) * 1600) % 1600; return y * 1600 + x; };
    const tipXY = ar ? { x: ((ar.tip[1] + 180) / 360) * 1600, y: ((90 - ar.tip[0]) / 180) * 800 } : null;
    const f = v.frontByKey.get(a.frontKey);
    const badge = document.querySelector(`.fu-fb[data-key="${a.frontKey}"]`);
    return {
      tick: v.tick, state: a.state, key: a.frontKey, near, nd, arrowKey: ar ? ar.frontKey : -1,
      tipOwner: ar ? v.owner[tileOf(ar.tip)] : -1, tipAlong: tipXY ? along(tipXY.x, tipXY.y) : NaN,
      axisOwner: v.owner[Math.floor(a.y) * 1600 + Math.floor(a.x)], axisAlong: along(a.x, a.y),
      contactAlong: a.contactX >= 0 ? along(a.contactX, a.contactY) : NaN, contact: [a.contactX, a.contactY],
      axis: [+a.x.toFixed(2), +a.y.toFixed(2)], origin: [+a.originX.toFixed(2), +a.originY.toFixed(2)],
      kmh: f ? f.advanceKmh : -1, tiles: a.tilesTaken, frontage: a.frontageTiles, defender: a.defender, ux, uy, oy: a.originY,
      badge: badge && badge.style.display !== 'none' ? badge.textContent : '',
    };
  }, a0.id);
  const S = [];
  for (let i = 0; i < 24; i++) {
    await page.evaluate(() => __front.ctx.sim.fastForward(20));
    await sleep(2500);
    const s1 = await sample();
    if (!s1) break;
    if (s1.tick - a0.tick >= 40) S.push(s1);
    if (args.trace) console.log(`   t${s1.tick} ${s1.state} key ${s1.key}/${s1.arrowKey} origin ${s1.origin} axis ${s1.axis} (along ${s1.axisAlong.toFixed(1)}, owner ${s1.axisOwner}) contact along ${s1.contactAlong.toFixed(1)} tip along ${s1.tipAlong.toFixed(1)} owner ${s1.tipOwner} kmh ${s1.kmh}`);
    if (s1.tick - a0.tick >= 420) break;
  }
  const last = S[S.length - 1];
  const ran = last ? last.tick - a0.tick : 0;
  const firstAxis = S.length ? (() => { const s0 = S[0]; return (a0.x - a0.ox) * s0.ux + (a0.y - a0.oy) * s0.uy; })() : 0;
  const maxContact = Math.max(0, ...S.map((q) => q.contactAlong).filter(Number.isFinite));
  const keyOk = S.filter((q) => q.key === q.near && q.arrowKey === q.key).length;
  // Axis moves seen in the samples (the axis point jumped forward along the advance). The «objetivo» message the player
  // gets each time is not counted here: fastForward (the verifier's exact-tick stepping) drops per-tick messages by
  // design, so that check is headless (w6-audit A9b: moved N times, the player told each time).
  let moved = 0;
  for (let i = 1; i < S.length; i++) if ((S[i].axis[0] !== S[i - 1].axis[0] || S[i].axis[1] !== S[i - 1].axis[1]) && S[i].axisAlong > S[i - 1].axisAlong) moved++;
  const movedMsgs = await page.evaluate(() => window.__w6msgs.filter((m) => m.key === 'msg.offensiveObjective').length);
  const badKey = S.filter((q) => !(q.key === q.near && q.arrowKey === q.key)).slice(0, 2).map((q) => `tick ${q.tick}: key ${q.key}, arrow ${q.arrowKey}, contact nearest ${q.near}`);
  row('V15a', 'offensive from the dialog, >= 300 ticks, far past its first axis point: attack and arrow on the front where it fights', `${ran} ticks, contact ${(maxContact * 25).toFixed(0)} km from the origin (first axis point ${(firstAxis * 25).toFixed(0)} km); key and arrow key = nearest front to the contact ${keyOk}/${S.length}${badKey.length ? ` [${badKey.join('; ')}]` : ''}`, ran >= 300 && maxContact > firstAxis + 4 && S.length > 0 && keyOk === S.length);
  const tipOk = S.filter((q) => q.tipOwner === q.defender && q.tipAlong >= q.contactAlong - 0.5 && q.axisOwner === q.defender).length;
  const badTip = S.filter((q) => !(q.tipOwner === q.defender && q.tipAlong >= q.contactAlong - 0.5 && q.axisOwner === q.defender)).slice(0, 2).map((q) => `tick ${q.tick}: tip owner ${q.tipOwner} along ${q.tipAlong.toFixed(1)} vs contact ${q.contactAlong.toFixed(1)}, axis owner ${q.axisOwner}`);
  row('V15b', 'the arrow\'s tip and the axis point stay on enemy land ahead of the line (the axis moved forward, the player told)', `${tipOk}/${S.length} samples; axis moved forward ${moved} times (${movedMsgs} messages outside fastForward)${badTip.length ? ` [${badTip.join('; ')}]` : ''}`, S.length > 0 && tipOk === S.length && moved > 0);
  const adv = S.filter((q) => q.state === 'advancing');
  const zero = adv.filter((q) => q.kmh < 0.05 || /(^|\D)0 km\/h/.test(q.badge)).length;
  let rateKmh = 0, meanKmh = 0;
  if (adv.length >= 2) {
    const A = adv[0], B = adv[adv.length - 1];
    const W0 = 25.02 * Math.cos(((90 - (A.oy / 800) * 180) * Math.PI) / 180);
    const widthKm = A.frontage * Math.sqrt((A.uy * W0) ** 2 + (A.ux * 25.02) ** 2);
    rateKmh = ((B.tiles - A.tiles) * 25.02 * W0) / widthKm / Math.max(0.1, (B.tick - A.tick) / 10);
    meanKmh = adv.slice(1).reduce((s2, q) => s2 + q.kmh, 0) / Math.max(1, adv.length - 1);
  }
  row('V15c', 'while it takes ground the front never reads 0 km/h (panel data and badge), and the km/h matches the rate tiles fall', `${zero} zero readings of ${adv.length} advancing samples; mean ${meanKmh.toFixed(2)} km/h vs tile rate ${rateKmh.toFixed(2)} km/h; badge «${last?.badge ?? ''}»`, adv.length >= 5 && zero === 0 && rateKmh > 0 && meanKmh / rateKmh >= 0.5 && meanKmh / rateKmh <= 1.6);
  // The ground battle where the offensive fights now: the camera down at the live contact.
  if (last && last.contact[0] >= 0) {
    await page.evaluate((c) => { const lat = 90 - (c[1] / 800) * 180, lon = (c[0] / 1600) * 360 - 180; __front.ctx.cameraRig.setState({ lat, lon, altitudeKm: 3, tilt: 0.9, heading: 0 }); }, last.contact);
    let g = null;
    for (let i = 0; i < 120; i++) {
      await sleep(2500);
      g = await page.evaluate(() => { const d = window.__battleDebug?.shown(); if (!d || !__front.ctx.battle.active) return null; const f = __front.ctx.sim.view.frontByKey.get(d.frontKey); return { key: d.frontKey, a: d.a, b: d.b, split: d.split, trA: f?.troopsA ?? 0, trB: f?.troopsB ?? 0, fa: f?.a, fb: f?.b }; });
      if (g) break;
    }
    await shot(page, 'advance-ground');
    if (g) {
      const us = g.a === 1 ? 0 : 1;
      const shareUs = g.split[us] / Math.max(1, g.split[0] + g.split[1]);
      const trUs = g.fa === 1 ? g.trA : g.trB, trThem = g.fa === 1 ? g.trB : g.trA;
      const want = Math.min(0.8, Math.max(0.2, trUs / Math.max(1, trUs + trThem)));
      row('V15d', 'the ground battle at the contact is on the offensive\'s front and its soldiers reflect the offensive (split vs the front\'s troops)', `battle front ${g.key} (offensive's ${last.key}); split ${g.split.join('/')} = our share ${shareUs.toFixed(2)} vs front troops ${Math.round(trUs)} : ${Math.round(trThem)} (share ${want.toFixed(2)} after the 0.2-0.8 clamp)`, g.key === last.key && Math.abs(shareUs - want) <= 0.15 && shareUs > 0.5);
    } else row('V15d', 'the ground battle at the contact', 'no battle built', false);
  }
  await page.close();
});

await browser.close();
const failed = results.filter((r) => !r.pass).length;
console.log(`--- ${results.length - failed}/${results.length} pass, ${errors} page errors`);
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
