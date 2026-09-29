// FRONT ULTRA — W6 audit (DESIGN_V2 §11, §16.7): what the front overlay, the badge and the Guerra panel show, measured
// on the real simulation, headless. Test tooling only, never bundled.
//
//   npx tsx src/sim/test/w6-audit.mjs            all checks
//   npx tsx src/sim/test/w6-audit.mjs --json out.json
//
// A2  chevrons follow FrontView.momentum: the defender gets the troops to turn the battle and counter-attacks; the
//     chevron direction (sign of momentum beyond ±0.1, as render/battle/overlay.ts draws it) flips within 20 ticks.
// A4  garrisons are published for quiet fronts (before any offensive); «Prioridad alta» (the same setFrontPriority
//     command the panel sends) raises the front's target share and Gf rises over ~60 ticks; alta/baja set during the
//     enemy's mobilization reproduces T34 (≥ 1.5× the passive garrison on the offensive's first tick); «Retirar» ends
//     our offensive and brings the troops home with a 10 % loss.
// A5  front keys are stable: over a 600-tick offensive the front it pushes keeps its key in ≥ 95 % of the samples.
// A7  owner items #22/#23 (fix pass 2): the corridor never outgrows its front; a human offensive persists (it re-forms
//     on the contact when its origin loses touch, and a broken one halts and holds the line with a message instead of
//     withdrawing); intensity: all-out assault ×1.25 power, hold = no push and a quarter of the casualties.
// A8  save round trip (§12.8) in the middle of a human offensive with a published line (the FrontLines view state is
//     not saved and is re-measured): the save succeeds, the restored game has the same fronts, garrisons and offensive,
//     both games stay identical tick for tick (ownership, troops, offensive), and the restored front publishes its line
//     again with the same speed within a few ticks.
// A9  an offensive that advances far past its axis point (W6 final fix pass, the verifier's iter-3 evidence): the axis
//     point moves ahead of the advance on enemy land, the offensive's front key stays on the front where its frontier
//     is (not a quiet front near the origin it left behind), the front reads km/h > 0 matching the fallen area's rate
//     while tiles fall, its published line lies at the live contact, and local forces count the offensive there.
// A6  T41: the front's line published as one smoothed depth offset at the observation focus moves every tick by exactly
//     its published speed, never jumps, sets the front's advanceKmh, and stays inside the tile being taken.

import fs from 'node:fs';
import { loadWorldInit } from './world.mjs';
import { Game } from '../game.ts';
import { HUMAN_ID } from '../../shared/constants.ts';
import { SaveReader, SaveWriter } from '../save.ts';
import { latLonToTile, latLonToTileXY } from '../../shared/geo.ts';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 || argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? def : argv[i + 1];
};
const results = [];
const row = (id, what, value, target, pass) => results.push({ id, what, value, target, pass });

const world = await loadWorldInit(() => {});
const W = 1600;

function controlledGame(seed) {
  const cfg = {
    seed, playerName: 'Audit', playerColor: 0x3fa9f5, difficulty: 'normal', aiCount: 0, tribeCount: 0, speed: 1, nukes: true,
    worldEvents: false, startWorldTimeSec: 0, spawnTimeoutTicks: 900, autoSpawnTile: latLonToTile(40.4, -3.7),
    instantStart: true, humanAutopilot: false, duration: 'normal',
  };
  const g = new Game(cfg, world);
  g.ai = { setup() {}, tick() {}, onEvent() {} };
  const step = () => {
    g.tick1();
    g.buildUpdate(1);
  };
  while (g.phase !== 'playing') step();
  return { g, step };
}
function stageLand(g, owner, pred) {
  g.transferContext = 'staging';
  for (let t = 0; t < g.owner.length; t++) if (g.playable[t] && pred(t)) g.setOwner(t, owner);
  g.transferContext = 'none';
  const p = g.playerById[owner];
  if (p) {
    p.spawned = true;
    p.metaDirty = true;
  }
}
const inRect = (t, x0, x1, y0, y1) => {
  const x = t % W, y = Math.floor(t / W);
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
};
/** The front record (what the client receives) of a key. */
const record = (g, key) => g.fronts.take().find((f) => f.key === key);
/** Chevron direction as the overlay draws it: +1 toward side b, -1 toward side a, 0 none. */
const chevron = (m) => (m > 0.1 ? 1 : m < -0.1 ? -1 : 0);

/** Two blocks side by side on the Great Plains: the human west, the enemy east, one long straight border. */
function theatre(seed = 7) {
  const { g, step } = controlledGame(seed);
  const H = HUMAN_ID;
  stageLand(g, 0, (t) => g.owner[t] === H);
  const c = latLonToTileXY(40, -98);
  const cx = Math.floor(c.x), cy = Math.floor(c.y);
  stageLand(g, H, (t) => inRect(t, cx - 30, cx - 1, cy - 20, cy + 20));
  const E = g.addPlayer({ name: 'Enemigo', kind: 'nation', personality: 'conqueror', color: 0xcc3333, countryIndex: 0 });
  stageLand(g, E, (t) => inRect(t, cx, cx + 29, cy - 20, cy + 20));
  const D = g.playerById[H], P = g.playerById[E];
  D.capitalTile = cy * W + cx - 18;
  P.capitalTile = cy * W + cx + 18;
  step();
  return { g, step, H, E, D, P, cx, cy };
}

// ---- A2: momentum reversal -------------------------------------------------------------------------
function reversal() {
  const { g, step, H, E, D, P, cx, cy } = theatre(7);
  g.war.declare(E, H, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
  for (let i = 0; i < 25; i++) step();
  D.troops = 150_000;
  P.troops = 900_000;
  g.issue(E, { type: 'attack', target: H, ratio: 0.7, tile: cy * W + cx - 15 });
  const a = g.attackList.find((x) => !x.ended && x.attacker === E);
  let key = 0, m = 0;
  for (let i = 0; i < 400; i++) {
    D.troops = Math.max(D.troops, 150_000);
    step();
    key = a?.frontKey ?? 0;
    const r = key ? record(g, key) : null;
    m = r?.momentum ?? 0;
    if (i > 60 && m > 0.3) break;
  }
  const before = chevron(m);
  // Turn the battle: the defender gets 3 M troops and counter-attacks on the same front (the panel's Contraofensiva).
  D.troops += 3_000_000;
  g.issue(H, { type: 'attack', target: E, ratio: 0.8, tile: cy * W + cx + 12 });
  let flipped = -1;
  const trace = [];
  for (let i = 1; i <= 60; i++) {
    step();
    const r = record(g, key);
    const mm = r?.momentum ?? 0;
    if (i % 2 === 0) trace.push(+mm.toFixed(2));
    if (flipped < 0 && chevron(mm) === -before && before !== 0) flipped = i;
  }
  row('A2', `chevrons flip after the defender turns the battle (momentum before ${m.toFixed(2)}; trace ${trace.slice(0, 12).join(' ')})`, flipped < 0 ? 'never' : `${flipped} ticks`, '<= 20 ticks', flipped > 0 && flipped <= 20);
}

// ---- A4: garrisons, priority, T34, retreat ------------------------------------------------------------
function garrisons() {
  const { g, step, H, E, D } = theatre(8);
  g.war.declare(E, H, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
  for (let i = 0; i < 25; i++) step();
  D.troops = 400_000;
  const fr = g.fronts.frontsOfPair(E, H);
  const recs = g.fronts.take().filter((r) => fr.some((f) => f.key === r.key));
  const quietOk = recs.length > 0 && recs.every((r) => r.quiet && r.garrisonA > 0 && r.garrisonB > 0);
  row('A4a', `quiet fronts publish both garrisons before any offensive (${recs.map((r) => `#${r.key} ${Math.round(r.garrisonA)}/${Math.round(r.garrisonB)}`).join(', ')})`, quietOk ? 'yes' : 'no', 'every front', quietOk);
}

function priorityRise() {
  // Two fronts: the human holds a block between two enemy strips (west and east), so priority moves troops between them.
  const { g, step } = controlledGame(9);
  const H = HUMAN_ID;
  stageLand(g, 0, (t) => g.owner[t] === H);
  const c = latLonToTileXY(40, -98);
  const cx = Math.floor(c.x), cy = Math.floor(c.y);
  stageLand(g, H, (t) => inRect(t, cx - 20, cx + 20, cy - 20, cy + 20));
  const E = g.addPlayer({ name: 'Enemigo', kind: 'nation', personality: 'conqueror', color: 0xcc3333, countryIndex: 0 });
  stageLand(g, E, (t) => inRect(t, cx - 24, cx - 21, cy - 20, cy + 20) || inRect(t, cx + 21, cx + 24, cy - 20, cy + 20));
  const D = g.playerById[H];
  D.capitalTile = cy * W + cx;
  g.playerById[E].capitalTile = cy * W + cx - 23;
  step();
  g.war.declare(E, H, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
  for (let i = 0; i < 80; i++) {
    D.troops = 300_000;
    step();
  }
  const fronts = g.fronts.frontsOfPair(E, H);
  const fA = fronts.reduce((a, b) => (a.x < b.x ? a : b));
  const r0 = record(g, fA.key);
  const side = r0.a === H ? 'A' : 'B';
  const g0 = r0[`garrison${side}`], t0 = r0[`targetShare${side}`];
  // The Guerra panel's «Alta» button sends exactly this command.
  g.issue(H, { type: 'setFrontPriority', frontKey: fA.key, priority: 2 });
  const samples = [];
  for (let i = 1; i <= 120; i++) {
    D.troops = 300_000;
    step();
    if (i === 1 || i === 30 || i === 60 || i === 120) samples.push([i, record(g, fA.key)]);
  }
  const r1 = samples[0][1], r60 = samples[2][1], r120 = samples[3][1];
  const t1 = r1[`targetShare${side}`];
  row('A4b', `Prioridad alta raises the target share (${(t0 * 100).toFixed(0)} % -> ${(t1 * 100).toFixed(0)} %, priority ${r1[`priority${side}`]})`, `${(t1 / Math.max(1e-6, t0)).toFixed(2)}x`, '> 1', t1 > t0 && r1[`priority${side}`] === 2);
  const gap = r120[`garrison${side}`] - g0;
  const at60 = (r60[`garrison${side}`] - g0) / Math.max(1, gap);
  row('A4c', `Gf rises over ~60 ticks (${Math.round(g0)} -> ${Math.round(r60[`garrison${side}`])} at 60 -> ${Math.round(r120[`garrison${side}`])} at 120)`, `${(at60 * 100).toFixed(0)} % of the 120-tick rise by tick 60`, '50-95 % (gradual, not instant)', gap > 0 && at60 >= 0.5 && at60 <= 0.95);
}

function t34Run(active) {
  const { g, step } = controlledGame(7);
  const H = HUMAN_ID;
  stageLand(g, 0, (t) => g.owner[t] === H);
  const c = latLonToTileXY(40, -98);
  const cx = Math.floor(c.x), cy = Math.floor(c.y);
  stageLand(g, H, (t) => inRect(t, cx - 20, cx + 20, cy - 20, cy + 20));
  const E = g.addPlayer({ name: 'Enemigo', kind: 'nation', personality: 'conqueror', color: 0xcc3333, countryIndex: 0 });
  stageLand(g, E, (t) => inRect(t, cx - 24, cx - 21, cy - 20, cy + 20) || inRect(t, cx + 21, cx + 24, cy - 20, cy + 20));
  const D = g.playerById[H], P = g.playerById[E];
  D.capitalTile = cy * W + cx;
  P.capitalTile = cy * W + cx - 23;
  step();
  D.troops = 300_000;
  P.troops = 600_000;
  const w = g.war.declare(E, H, 'conquest', 'war.reason.debug', { force: true, queuedAttack: { tile: cy * W + cx - 10, ratio: 0.5 } });
  const fronts = g.fronts.frontsOfPair(E, H);
  const fA = fronts.reduce((a, b) => (a.x < b.x ? a : b));
  const fB = fronts.find((f) => f !== fA);
  if (active) {
    // What the player does in the Guerra panel on seeing the mobilization: Alta on the threatened front, Baja elsewhere.
    g.issue(H, { type: 'setFrontPriority', frontKey: fA.key, priority: 2 });
    if (fB) g.issue(H, { type: 'setFrontPriority', frontKey: fB.key, priority: 0 });
  }
  let gf = -1;
  for (let i = 0; i < 200 && gf < 0; i++) {
    D.troops = 300_000;
    step();
    const a = g.attackList.find((x) => !x.ended && x.attacker === E);
    if (a) gf = g.fronts.garrison(g.fronts.get(fA.key) ?? fA, H);
  }
  return { gf, mob: w.mobilizeUntilTick - w.startTick };
}

function t34() {
  const passive = t34Run(false), active = t34Run(true);
  const ratio = active.gf / Math.max(1, passive.gf);
  row('A4d', `alta/baja during the enemy mobilization (${passive.mob} ticks): Gf on the first offensive tick, active / passive`, `${Math.round(active.gf)} / ${Math.round(passive.gf)} = ${ratio.toFixed(2)}x`, '>= 1.5x (T34)', ratio >= 1.5);
}

function retreat() {
  const { g, step, H, E, D, P, cx, cy } = theatre(10);
  g.war.declare(H, E, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
  for (let i = 0; i < 25; i++) step();
  D.troops = 800_000;
  P.troops = 200_000;
  g.issue(H, { type: 'attack', target: E, ratio: 0.5, tile: cy * W + cx + 15 });
  const a = g.attackList.find((x) => !x.ended && x.attacker === H);
  for (let i = 0; i < 40; i++) step();
  const inOffensive = a.troops;
  const home0 = D.troops;
  // The panel's «Retirar» sends exactly this command.
  g.issue(H, { type: 'retreat', attackId: a.id });
  let back = -1;
  for (let i = 0; i < 60; i++) {
    const before = D.troops;
    step();
    if (a.ended && back < 0) back = D.troops - before;
  }
  const loss = back >= 0 ? 1 - back / Math.max(1, inOffensive) : -1;
  row('A4e', `Retirar ends our offensive (${Math.round(inOffensive)} troops in it, home ${Math.round(home0)}); troops back ${Math.round(back)}`, back < 0 ? 'not ended' : `${(loss * 100).toFixed(1)} % lost`, '10 % (±2)', back >= 0 && Math.abs(loss - 0.1) <= 0.02);
}

// ---- A5: key stability ------------------------------------------------------------------------------------------
function keys() {
  const { g, step, H, E, D, P, cx, cy } = theatre(11);
  g.war.declare(E, H, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
  for (let i = 0; i < 25; i++) step();
  D.troops = 200_000;
  P.troops = 700_000;
  g.issue(E, { type: 'attack', target: H, ratio: 0.6, tile: cy * W + cx - 15 });
  const a = g.attackList.find((x) => !x.ended && x.attacker === E);
  let k0 = 0, same = 0, n = 0;
  const seen = new Set();
  for (let i = 0; i < 600 && !a.ended; i++) {
    D.troops = Math.max(D.troops, 120_000);
    step();
    if (i % 5 !== 0 || !a.frontKey) continue;
    if (!k0) k0 = a.frontKey;
    // What the badge and the panel show for this offensive: the front record its frontKey points to, which must exist.
    const r = record(g, a.frontKey);
    n++;
    seen.add(a.frontKey);
    if (a.frontKey === k0 && r) same++;
  }
  row('A5', `front key of a 600-tick offensive (keys seen: ${[...seen].join(', ')})`, `${n ? ((same / n) * 100).toFixed(1) : 0} % of ${n} samples`, '>= 95 %', n > 0 && same / n >= 0.95);
}

// ---- A6: T41 — the front's line as one smoothed depth offset -------------------------------------------------
// With the observation focus on the line, over a 300-tick offensive: every tick the published line moves by exactly
// its published speed (kmh / 10 km), never jumps (< 1.2 km a tick, the 8 km/h cap is 0.8), the front's advanceKmh is
// |line.kmh|, and the line stays with the territory: its depth minus the side-a share of the same window by ownership
// alone (the tile line, no pressure) lies within 0 .. +1 tile (it is inside the tile being taken).
function depthLine() {
  const { g, step, H, E, D, P, cx, cy } = theatre(12);
  g.war.declare(E, H, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
  for (let i = 0; i < 25; i++) step();
  D.troops = 300_000;
  P.troops = 900_000;
  g.issue(E, { type: 'attack', target: H, ratio: 0.7, tile: cy * W + cx - 15 });
  const a = g.attackList.find((x) => !x.ended && x.attacker === E);
  // On the offensive's axis: the front's line there is measured every tick and is also its advanceKmh (W6 final).
  g.observationFocus = { x: cx - 0.5, y: cy };
  const TILE = 25.02;
  // Ownership-only depth of the same window (independent of the sim's measure): mean over 2.5 km columns.
  const ownDepth = (L) => {
    const kmX = TILE * Math.cos(((90 - (L.y / 800) * 180) * Math.PI) / 180);
    let sum = 0, cols = 0;
    for (let u = -L.halfKm; u <= L.halfKm; u += 2.5) {
      let na = 0, nab = 0;
      for (let d = L.depthKm - 75; d <= L.depthKm + 75; d += 2.5) {
        const east = d * L.e - u * L.n, north = d * L.n + u * L.e;
        const x = Math.floor(L.x + east / kmX), y = Math.floor(L.y - north / TILE);
        const o = g.owner[y * W + x];
        if (o === E) { na++; nab++; } else if (o === H) nab++;
      }
      if (nab < 50 || na === 0 || na === nab) continue;
      sum += L.depthKm - 75 + (na * 61 / nab) * 2.5 - 1.25;
      cols++;
    }
    return cols ? sum / cols : NaN;
  };
  let prev = null, maxErr = 0, maxStep = 0, kmhErr = 0, n = 0, lagMin = Infinity, lagMax = -Infinity, first = -1, last = -1;
  for (let i = 0; i < 300 && !a.ended; i++) {
    D.troops = Math.max(D.troops, 300_000);
    step();
    const r = record(g, a.frontKey);
    const L = r?.line;
    if (!L || !L.focus) { prev = null; continue; }
    kmhErr = Math.max(kmhErr, Math.abs(r.advanceKmh - Math.abs(L.kmh)));
    if (prev && prev.x === L.x && prev.y === L.y) {
      const moved = L.depthKm - prev.depthKm;
      maxErr = Math.max(maxErr, Math.abs(moved - L.kmh / 10));
      maxStep = Math.max(maxStep, Math.abs(moved));
    }
    const lag = L.depthKm - ownDepth(L);
    if (Number.isFinite(lag) && i > 40) {
      lagMin = Math.min(lagMin, lag);
      lagMax = Math.max(lagMax, lag);
    }
    if (first < 0) first = i;
    last = i;
    n++;
    prev = { ...L };
  }
  row('A6a', `T41: the published line moves each tick by exactly its speed, no jumps (${n} ticks with a focus line)`, `step error ${maxErr.toFixed(4)} km, largest step ${maxStep.toFixed(2)} km`, 'error < 0.001 km, step < 1.2 km', n > 200 && maxErr < 1e-3 && maxStep < 1.2);
  row('A6b', 'T41: FrontView.advanceKmh = |line.kmh|; the line lies inside the tile being taken (depth − tile line)', `|Δ| ${kmhErr.toFixed(3)} km/h; ${lagMin.toFixed(1)} .. ${lagMax.toFixed(1)} km`, '0 .. 25 km', kmhErr <= 0.01 && lagMin >= -2 && lagMax <= 25);
}

// ---- A7: offensives that persist and are managed (#23), corridor capped at the front (#22) ------------------------
function persistence() {
  // A short front: the enemy is a 12-tile-high block beside the human's 41-tile one.
  const { g, step } = controlledGame(12);
  const H = HUMAN_ID;
  stageLand(g, 0, (t) => g.owner[t] === H);
  const c = latLonToTileXY(40, -98);
  const cx = Math.floor(c.x), cy = Math.floor(c.y);
  stageLand(g, H, (t) => inRect(t, cx - 30, cx - 1, cy - 20, cy + 20));
  const E = g.addPlayer({ name: 'Enemigo', kind: 'nation', personality: 'conqueror', color: 0xcc3333, countryIndex: 0 });
  stageLand(g, E, (t) => inRect(t, cx, cx + 29, cy - 6, cy + 5));
  const D = g.playerById[H], P = g.playerById[E];
  D.capitalTile = cy * W + cx - 18;
  P.capitalTile = cy * W + cx + 18;
  step();
  const msgs = [];
  const orig = g.message.bind(g);
  g.message = (pid, key, sev, params) => { msgs.push({ tick: g.tick, key, params }); orig(pid, key, sev, params); };
  g.war.declare(H, E, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
  for (let i = 0; i < 25; i++) step();
  // (a) 1.6 M troops would buy 40 tiles of corridor (80 by troops): the front is ~12 tiles long.
  D.troops = 3_200_000;
  P.troops = 400_000;
  g.issue(H, { type: 'attack', target: E, ratio: 0.5, tile: cy * W + cx + 8 });
  let a = g.attackList.find((x) => !x.ended && x.attacker === H);
  const f = a && a.frontKey ? g.fronts.get(a.frontKey) : null;
  row('A7a', `the corridor never outgrows its front (${a ? Math.round(a.troops) : 0} troops committed)`, a && f ? `corridor ${a.frontage.toFixed(1)} tiles, front ${f.length} tiles` : 'no offensive', 'corridor <= front length', !!a && !!f && a.frontage <= Math.max(3, f.length) + 1e-6);
  // (d) intensity: the same offensive at all-out assault has 1.25x its power; holding pushes nothing.
  for (let i = 0; i < 15; i++) step();
  const pa1 = a.pa;
  g.issue(H, { type: 'offensiveIntensity', attackId: a.id, intensity: 2 });
  step();
  const pa2 = a.pa;
  g.issue(H, { type: 'offensiveIntensity', attackId: a.id, intensity: 0 });
  let pushHold = 0, lossHold = 0;
  for (let i = 0; i < 10; i++) {
    step();
    pushHold += a.pushThisTick;
    lossHold += a.lossThisTick;
  }
  row('A7d', 'intensity: all-out assault ×1.25 attack power; hold the line pushes nothing', `Pa ${Math.round(pa1)} -> ${Math.round(pa2)} (${(pa2 / Math.max(1, pa1)).toFixed(3)}x); holding: push ${pushHold.toFixed(3)}, state ${a.state}`, '1.25x (±3 %, same troops), push 0, holding', Math.abs(pa2 / Math.max(1, pa1) - 1.25) < 0.04 && pushHold === 0 && a.state === 'holding');
  g.issue(H, { type: 'retreat', attackId: a.id });
  for (let i = 0; i < 30; i++) step();
  // (b) a hopeless human offensive (R ≈ 0.1): it breaks after 60 ticks at R < 0.5 and then HOLDS with a message.
  D.troops = 200_000;
  P.troops = 3_000_000;
  const m0 = msgs.length;
  g.issue(H, { type: 'attack', target: E, ratio: 0.5, tile: cy * W + cx + 8 });
  a = g.attackList.find((x) => !x.ended && x.attacker === H);
  for (let i = 0; i < 220 && a && !a.ended; i++) step();
  const halted = msgs.slice(m0).find((m) => m.key === 'msg.offensiveHalted');
  row('A7b', 'a broken human offensive halts and holds the line (with a message) instead of withdrawing', a ? `after 220 ticks: ${a.ended ? 'ended' : a.state}, intensity ${a.intensity}, ratio ${a.ratio.toFixed(2)}, message ${halted ? `«${halted.key}» at tick ${halted.tick}` : 'none'}` : 'no offensive', 'alive, holding, message', !!a && !a.ended && a.state === 'holding' && !!halted);
  // (c) our own line falls back under the corridor's origin: the offensive re-forms on the new contact.
  const ox = Math.floor(a.originX);
  stageLand(g, E, (t) => inRect(t, ox - 4, cx - 1, cy - 8, cy + 7));
  g.issue(H, { type: 'offensiveIntensity', attackId: a.id, intensity: 1 });
  const o0 = a.originX;
  for (let i = 0; i < 25 && !a.ended; i++) step();
  row('A7c', 'the offensive re-forms on the contact when its origin loses touch (no silent cancel)', `${a.ended ? 'ended' : `alive (${a.state})`}, origin x ${o0.toFixed(1)} -> ${a.originX.toFixed(1)}, frontier ${a.pressure.size} tiles`, 'alive, origin moved back, frontier > 0', !a.ended && a.originX < o0 - 1 && a.pressure.size > 0);
}

// ---- A8: save round trip during an offensive (the FrontLines regression) --------------------------------------
function saveRoundTrip() {
  const mk = () => {
    const t = theatre(13);
    const { g, step, H, E, D, P, cx, cy } = t;
    g.war.declare(H, E, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
    for (let i = 0; i < 25; i++) step();
    D.troops = 900_000;
    P.troops = 250_000;
    g.issue(H, { type: 'attack', target: E, ratio: 0.6, tile: cy * W + cx + 12 });
    g.observationFocus = { x: cx + 0.5, y: cy + 2 };
    for (let i = 0; i < 80; i++) step();
    return t;
  };
  const A = mk();
  let blob = null, err = '';
  try {
    const w = new SaveWriter();
    A.g.serialize(w);
    blob = w.finish();
  } catch (e) {
    err = String(e?.message ?? e);
  }
  row('A8a', 'save in the middle of an offensive with a published front line', blob ? `${(blob.byteLength / 1024).toFixed(0)} KB` : `failed: ${err}`, 'saved', !!blob);
  if (!blob) return;
  const B = Game.restore(new SaveReader(blob), world);
  B.ai = { setup() {}, tick() {}, onEvent() {} };
  B.observationFocus = { ...A.g.observationFocus };
  const stepB = () => {
    B.tick1();
    B.buildUpdate(1);
  };
  const sig = (g) => {
    let own = 0;
    for (let t = 0; t < g.owner.length; t++) own = (own * 31 + g.owner[t]) >>> 0;
    const at = g.attackList.filter((x) => !x.ended).map((x) => `${x.id}:${x.frontKey}:${Math.round(x.troops)}:${x.pressure.size}:${x.state}`).join('|');
    const fr = [...g.fronts.all()].map((f) => `${f.key}:${f.a}/${f.b}:${Math.round(g.fronts.garrison(f, f.a))}/${Math.round(g.fronts.garrison(f, f.b))}`).sort().join('|');
    return `${own}#${at}#${fr}#${Math.round(g.playerById[HUMAN_ID].troops)}`;
  };
  const same0 = sig(A.g) === sig(B);
  let sameAll = same0, firstDiff = -1;
  let kmhA = 0, kmhB = 0, keyA = 0;
  for (let i = 1; i <= 120; i++) {
    A.step();
    stepB();
    if (sameAll && sig(A.g) !== sig(B)) {
      sameAll = false;
      firstDiff = i;
    }
  }
  const a = A.g.attackList.find((x) => !x.ended && x.attacker === HUMAN_ID);
  keyA = a?.frontKey ?? 0;
  const ra = record(A.g, keyA), rb = B.fronts.take().find((f) => f.key === keyA);
  kmhA = ra?.advanceKmh ?? -1;
  kmhB = rb?.advanceKmh ?? -1;
  row('A8b', 'restored game identical right after the load and for 120 ticks (ownership, offensive, fronts, garrisons, troops)', same0 && sameAll ? 'identical' : `differs${firstDiff > 0 ? ` from tick ${firstDiff}` : ' at load'}`, 'identical', same0 && sameAll);
  row('A8c', 'the restored front publishes its line again (advanceKmh original / restored, 120 ticks later)', `${kmhA.toFixed(2)} / ${kmhB.toFixed(2)} km/h, line ${rb?.line ? 'published' : 'missing'}`, 'line published, |Δ| <= max(0.5 km/h, 10 %) (view data re-measured)', !!rb?.line && kmhA >= 0 && Math.abs(kmhA - kmhB) <= Math.max(0.5, 0.1 * kmhA));
}

// ---- A9: far past the axis point ------------------------------------------------------------------------------
async function farAdvance() {
  const { g, step } = controlledGame(14);
  const H = HUMAN_ID;
  stageLand(g, 0, (t) => g.owner[t] === H);
  const c = latLonToTileXY(40, -98);
  const cx = Math.floor(c.x), cy = Math.floor(c.y);
  // The human west of x = cx; the enemy east (30 tiles deep) and a second enemy block touching the human's south
  // flank 11+ tiles west of the main front: a separate front close to where the offensive starts.
  stageLand(g, H, (t) => inRect(t, cx - 30, cx - 1, cy - 8, cy + 8));
  const E = g.addPlayer({ name: 'Enemigo', kind: 'nation', personality: 'conqueror', color: 0xcc3333, countryIndex: 0 });
  stageLand(g, E, (t) => inRect(t, cx, cx + 29, cy - 20, cy + 20) || inRect(t, cx - 22, cx - 12, cy + 9, cy + 12));
  const D = g.playerById[H], P = g.playerById[E];
  D.capitalTile = cy * W + cx - 25;
  P.capitalTile = (cy - 18) * W + cx + 27;
  step();
  const msgs = [];
  const orig = g.message.bind(g);
  g.message = (pid, key, sev, params) => { msgs.push({ tick: g.tick, key, params }); orig(pid, key, sev, params); };
  g.war.declare(H, E, 'conquest', 'war.reason.debug', { mobilizeTicks: 0, force: true });
  for (let i = 0; i < 25; i++) step();
  D.troops = 1_400_000;
  P.troops = 150_000;
  // The objective 3 tiles into the enemy, level with the middle of our block.
  g.issue(H, { type: 'attack', target: E, ratio: 0.5, tile: cy * W + cx + 3 });
  const a = g.attackList.find((x) => !x.ended && x.attacker === H);
  const lf = await import('../../shared/localForces.ts');
  const kmX = (y) => 25.02 * Math.cos(((90 - (y / 800) * 180) * Math.PI) / 180);
  let samples = 0, keyOk = 0, axisOk = 0, lineOk = 0, zero = 0, taking = 0, fullOk = 0;
  const keys = new Set();
  let tiles0 = -1, t0 = -1, kmhSum = 0, kmhN = 0, rateKmh = 0, localOff = 0, localOk = 0, localN = 0, maxAlong = 0;
  const bad = [];
  for (let i = 1; i <= 700 && !a.ended; i++) {
    D.troops = Math.max(D.troops, 700_000);
    step();
    if (i < 40 || i % 10 !== 0) continue;
    samples++;
    // Independent: the front of the pair that most of the offensive's frontier tiles lie on (each tile counted on the
    // front whose contact line is nearest to it).
    const count = new Map();
    const fr = g.fronts.frontsOfPair(H, E);
    for (const t of a.pressure.keys()) {
      const tx = (t % W) + 0.5, ty = Math.floor(t / W) + 0.5;
      let bk = 0, bdd = Infinity;
      for (const f of fr) {
        for (let v = 0; v < f.samples.length; v += 2) {
          const dx = f.samples[v] - tx, dy = f.samples[v + 1] - ty;
          if (dx * dx + dy * dy < bdd) { bdd = dx * dx + dy * dy; bk = f.key; }
        }
      }
      count.set(bk, (count.get(bk) ?? 0) + 1);
    }
    let best = 0, bn = -1;
    for (const [k, n] of count) if (n > bn) { bn = n; best = k; }
    keys.add(a.frontKey);
    if (a.frontKey === best) keyOk++;
    else if (bad.length < 3) bad.push(`tick ${i}: key ${a.frontKey}, frontier on ${best}`);
    if (process.env.A9DBG && a.frontKey !== best) console.log(i, g.tick, 'contact', a.liveX.toFixed(1), a.liveY.toFixed(1), 'fronts', g.fronts.frontsOfPair(H, E).map((f) => `${f.key}:len${f.length}@${f.x.toFixed(0)},${f.y.toFixed(0)} seen${f.seenTick}`).join(' '), 'pressure', [...a.pressure.keys()].map((t) => `${t % W - cx},${Math.floor(t / W) - cy}`).join(' '));
    // The axis point: on enemy land, ahead of the contact along the axis.
    const ct = Math.floor(a.clickY) * W + Math.floor(a.clickX);
    const clickAlong = (a.clickX - a.originX) * a.dirX + (a.clickY - a.originY) * a.dirY;
    if (g.owner[ct] === E && clickAlong >= a.liveAlong - 0.5) axisOk++;
    else if (bad.length < 6) bad.push(`tick ${i}: axis owner ${g.owner[ct]} along ${clickAlong.toFixed(1)} vs contact ${a.liveAlong.toFixed(1)}`);
    maxAlong = Math.max(maxAlong, a.liveAlong);
    const r = record(g, a.frontKey);
    const L = r?.line;
    if (L) {
      const lx = L.x + (L.depthKm * L.e) / kmX(L.y), ly = L.y - (L.depthKm * L.n) / 25.02;
      const dk = Math.hypot((lx - a.liveX) * kmX(L.y), (ly - a.liveY) * 25.02);
      if (dk <= 40) lineOk++;
      else if (bad.length < 9) bad.push(`tick ${i}: line ${dk.toFixed(0)} km from the contact`);
    }
    const kmh = r?.advanceKmh ?? 0;
    if (a.state === 'advancing') {
      taking++;
      if (kmh < 0.05) zero++;
    }
    if (tiles0 < 0 && a.state === 'advancing') { tiles0 = a.tilesTaken; t0 = g.tick; }
    else if (tiles0 >= 0) { kmhSum += kmh; kmhN++; }
    // Local forces at the live contact count this offensive on the front it fights.
    if (i % 50 === 0) {
      const players = [];
      for (const p of g.playerArr) players[p.id] = { id: p.id, alive: p.alive, troops: p.troops, tiles: p.tiles };
      const view = {
        tick: g.tick, world: { terrain: g.terrain }, owner: g.owner, players, units: new Map(), structures: new Map(),
        fronts: g.fronts.take(), attacks: g.attackList.filter((x) => !x.ended).map((x) => g.attacks.view(x)),
        pairState: () => 'war', hasTreaty: () => false, isOccupied: () => false,
      };
      try {
        const loc = lf.deriveLocalForces(view, a.liveX, a.liveY, 30, H);
        const us = loc.sides.find((sd) => sd.owner === H);
        localOff = us?.pools?.offensive ?? 0;
        localN++;
        if (localOff > 0 && loc.frontKey === a.frontKey) localOk++;
      } catch (e) {
        if (bad.length < 12) bad.push(`localForces: ${String(e?.message ?? e).slice(0, 80)}`);
      }
    }
  }
  if (tiles0 >= 0) {
    const hours = (g.tick - t0) / 10;
    const W0 = 25.02 * Math.cos(((90 - (a.originY / 800) * 180) * Math.PI) / 180);
    const widthKm = a.frontage * Math.sqrt((a.dirY * W0) ** 2 + (a.dirX * 25.02) ** 2);
    rateKmh = ((a.tilesTaken - tiles0) * 25.02 * W0) / widthKm / Math.max(1, hours);
  }
  const meanKmh = kmhN ? kmhSum / kmhN : 0;
  const moved = msgs.filter((m) => m.key === 'msg.offensiveObjective').length;
  row('A9a', `the offensive advanced ${(maxAlong * 25).toFixed(0)} km past its origin (axis point 3 tiles in); its front key is the front most of its frontier is on (keys ${[...keys].join(', ')})${bad.length ? ` [${bad.slice(0, 2).join('; ')}]` : ''}`, `${keyOk}/${samples} samples`, 'all, advance >= 300 km', samples > 0 && keyOk === samples && maxAlong * 25 >= 300);
  row('A9b', `the axis point stays on enemy land, never behind the line (moved ${moved} times, the player told each time)`, `${axisOk}/${samples} samples`, 'all', samples > 0 && axisOk === samples && moved > 0);
  row('A9c', 'the front never reads 0 km/h while its offensive advances; the line speed matches the fallen area', `${zero} zero readings of ${taking}; mean ${meanKmh.toFixed(2)} km/h vs area ${rateKmh.toFixed(2)} km/h`, '0 zero; ratio 0.6-1.4', taking > 0 && zero === 0 && rateKmh > 0 && meanKmh / rateKmh >= 0.6 && meanKmh / rateKmh <= 1.4);
  row('A9d', 'the published line stands at the live contact; local forces there count the offensive', `line ${lineOk}/${samples}; local offensive pool at the contact on the offensive's front ${localOk}/${localN} (last ${localOff.toFixed(0)} soldiers)`, 'all; all', lineOk === samples && localN > 0 && localOk === localN);
}

saveRoundTrip();
await farAdvance();
reversal();
persistence();
depthLine();
garrisons();
priorityRise();
t34();
retreat();
keys();

console.log('\n=== W6 audit ===');
const w = Math.max(...results.map((r) => r.what.length));
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${String(r.id).padEnd(5)} ${r.what.padEnd(w)}  ${String(r.value).padEnd(26)} target ${r.target}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`--- ${results.length - failed}/${results.length} pass`);
const out = arg('json', '');
if (out) fs.writeFileSync(out, JSON.stringify({ results }, null, 2));
process.exit(failed ? 1 : 0);
