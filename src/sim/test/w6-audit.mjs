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

import fs from 'node:fs';
import { loadWorldInit } from './world.mjs';
import { Game } from '../game.ts';
import { HUMAN_ID } from '../../shared/constants.ts';
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

reversal();
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
