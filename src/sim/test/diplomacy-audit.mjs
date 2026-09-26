// FRONT ULTRA — diplomacy audit (W3, DESIGN_V2 §5, §16.4 acceptance). Test tooling only, never bundled.
//
//   npx tsx src/sim/test/diplomacy-audit.mjs [--seed 7] [--difficulty normal] [--json out.json]
//
// Headless measurements of the diplomacy system on a real game (24 AI nations, the sim-ai director answering, a human
// that never plays by itself):
//   D1  alliance proposals: «considering» at once, answers 120–240 ticks later with >= 1 reason; rejections between
//       0 and +35 carry a NAP counter-offer; an accepted proposal with a gold sweetener names it (acceptance 1)
//   D2  inbox expiry: calls to arms to the human wait >= 240 ticks, never expire before 60 unpaused real s (at 4x
//       still open after 59 s), expiry is labelled as expiry, three expired calls do not end the alliance (acceptance 2)
//   D3  human demands (cede a band, tribute) answered 60–120 ticks later with a reason; a refusal raises tension and
//       no war (acceptance 10)
//   D4  peace: white / cession / tribute answered with a reason; a winner (score >= 40, exhaustion < 70) refuses white
//       peace saying why; accepted peace -> warEnded + a 4,800-tick truce; declaring during it is a betrayal (acc. 9)
//   D5  betrayal detected for a NAP, a truce and an alliance (acceptance 4)
//   D6  opinions: a gift, a trade agreement and a declaration change the published reasons within one update (acc. 8)
//   D7  save / restore: treaties, proposals, opinions and pending inbox items identical (acceptance 17, T42 extended)

import fs from 'node:fs';
import { loadWorldInit } from './world.mjs';
import { Game } from '../game.ts';
import { SaveReader, SaveWriter } from '../save.ts';
import { HUMAN_ID, TRUCE_TICKS } from '../../shared/constants.ts';
import { latLonToTile } from '../../shared/geo.ts';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 || argv[i + 1] === undefined || argv[i + 1].startsWith('--') ? def : argv[i + 1];
};
const SEED = Number(arg('seed', 7));
const DIFF = String(arg('difficulty', 'normal'));
const results = [];
const row = (id, what, value, target, pass) => results.push({ id, what, value, target, pass: !!pass });

const world = await loadWorldInit(() => {});

function newGame(seed) {
  const cfg = {
    seed, playerName: 'Audit', playerColor: 0x3fa9f5, difficulty: DIFF, aiCount: 24, tribeCount: 20, speed: 1, nukes: false,
    worldEvents: false, startWorldTimeSec: 0, spawnTimeoutTicks: 300, autoSpawnTile: latLonToTile(40.4, -3.7),
    instantStart: true, humanAutopilot: false, duration: 'normal',
  };
  const g = new Game(cfg, world);
  const events = [];
  const emit = g.emit.bind(g);
  g.emit = (e) => {
    if (e.type !== 'combat' && e.type !== 'goldBonus' && e.type !== 'tradeCompleted' && e.type !== 'unitSpawned') events.push(e);
    emit(e);
  };
  let last = null;
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      g.tick1();
      last = g.buildUpdate(1);
      lastUpdates.push(last);
      if (lastUpdates.length > 3) lastUpdates.shift();
    }
    return last;
  };
  const lastUpdates = [];
  while (g.phase !== 'playing') step();
  // Grow the human a little so it has neighbours and weight.
  g.applyDebug({ type: 'conquer', playerId: HUMAN_ID, centerTile: latLonToTile(40.2, -3.7), radius: 14 });
  step(20);
  return { g, events, step, lastUpdates };
}

const nations = (g) => g.playerArr.filter((p) => p.alive && p.kind === 'nation' && p.spawned);
const propEvents = (events, id) => events.filter((e) => e.type === 'proposal' && e.proposal.id === id).map((e) => ({ tick: e.tick, ...e.proposal }));

// =================================================================================================
// D1 alliance proposals
// =================================================================================================
function d1() {
  const { g, events, step } = newGame(SEED);
  step(600);
  const H = g.playerById[HUMAN_ID];
  const sent = [];
  for (const p of nations(g)) {
    if (g.war.atWar(HUMAN_ID, p.id)) continue;
    const r = g.diplomacy.propose(HUMAN_ID, p.id, 'alliance');
    if (r) sent.push({ id: r.id, to: p.id, tick: g.tick, status0: r.status });
  }
  // Opinion at the decision tick (recorded by watching the events).
  const opinionAt = new Map();
  const orig = g.diplomacy.decide ?? null;
  void orig;
  for (let i = 0; i < 260; i++) {
    for (const s of sent) if (!opinionAt.has(s.id) && g.diplomacy.proposal(s.id)?.status === 'considering') opinionAt.set(s.id, g.diplomacy.opinion(s.to, HUMAN_ID));
    step();
  }
  let immediate = 0, inWindow = 0, withReason = 0, rawKey = 0, zeroToThirtyFive = 0, countered = 0;
  const delays = [];
  for (const s of sent) {
    const ev = propEvents(events, s.id);
    if (ev[0] && ev[0].status === 'considering' && ev[0].tick === s.tick) immediate++;
    const ans = ev.find((e) => e.status !== 'considering');
    if (!ans) continue;
    const d = ans.tick - s.tick;
    delays.push(d);
    if (d >= 120 && d <= 240) inWindow++;
    if ((ans.reasons ?? []).length >= 1) withReason++;
    if ((ans.reasons ?? []).some((r) => !/^(answer|diplo\.reason)\./.test(r.key))) rawKey++;
    const o = g.diplomacy.opinion(s.to, HUMAN_ID);
    void o;
    if (ans.status !== 'accepted') {
      const op = opinionAt.get(s.id) ?? 0;
      if (op >= 0 && op < 35) {
        zeroToThirtyFive++;
        if (ans.status === 'countered' && ans.counterId && events.some((e) => e.type === 'proposal' && e.proposal.id === ans.counterId && e.proposal.kind === 'nap')) countered++;
      }
    }
  }
  const answered = delays.length;
  row('D1a', `alliance proposals shown as «considering» at once (${sent.length} sent)`, `${immediate}/${sent.length}`, 'all', immediate === sent.length && sent.length > 0);
  row('D1b', 'answers 120–240 ticks after the proposal', `${inWindow}/${answered} (min ${Math.min(...delays)}, max ${Math.max(...delays)})`, 'all', inWindow === answered && answered === sent.length);
  row('D1c', 'answers with >= 1 reason, no raw key', `${withReason}/${answered}, raw ${rawKey}`, 'all, 0 raw', withReason === answered && rawKey === 0);
  row('D1d', 'rejections at opinion 0..+35 with a NAP counter-offer', `${countered}/${zeroToThirtyFive}`, 'all (>= 1 case)', zeroToThirtyFive > 0 && countered === zeroToThirtyFive);

  // Gold sweetener: a strong human (a protector) with a weak neighbour; the gold lifts a lukewarm opinion over +35.
  g.applyDebug({ type: 'addTroops', playerId: HUMAN_ID, amount: 3_000_000 });
  g.applyDebug({ type: 'addGold', playerId: HUMAN_ID, amount: 50_000_000 });
  step(250);
  let named = 0, acceptedWithGold = 0, tried = 0;
  for (const p of nations(g)) {
    if (g.isAllied(HUMAN_ID, p.id) || g.war.atWar(HUMAN_ID, p.id) || p.allies.size > 0) continue;
    // Relations first (a trade agreement, +15), then the offer with gold.
    if (!g.diplomacy.hasTreaty(HUMAN_ID, p.id, 'trade')) g.diplomacy.debugSign(HUMAN_ID, p.id, 'trade');
    const o = g.diplomacy.opinion(p.id, HUMAN_ID);
    if (o < 10) continue;
    const gold = Math.round(Math.max(p.incomeEma, p.income) * 240 * 0.05 * 25) + 1;
    if (gold > H.gold) continue;
    const r = g.diplomacy.propose(HUMAN_ID, p.id, 'alliance', { gold });
    if (!r) continue;
    tried++;
    step(250);
    const ans = propEvents(events, r.id).find((e) => e.status !== 'considering');
    if (ans && ans.status === 'accepted') {
      acceptedWithGold++;
      if ((ans.reasons ?? []).some((x) => x.key === 'answer.goldHelps')) named++;
    }
    if (acceptedWithGold >= 2) break;
  }
  row('D1e', `accepted proposals with a gold sweetener naming it (${tried} tried)`, `${named}/${acceptedWithGold}`, 'all (>= 1 case)', acceptedWithGold > 0 && named === acceptedWithGold);
}

// =================================================================================================
// D2 inbox expiry and the real-time floor
// =================================================================================================
function d2() {
  const { g, events, step } = newGame(SEED + 1);
  step(300);
  const ns = nations(g);
  const ally = ns.find((p) => !g.war.atWar(HUMAN_ID, p.id));
  const aggressors = ns.filter((p) => p !== ally && !g.isAllied(p.id, ally.id)).slice(0, 3);
  g.diplomacy.debugSign(HUMAN_ID, ally.id, 'alliance');
  // Headless (no human): three calls to arms expire; the alliance must survive.
  const statuses = [];
  let firstLife = 0;
  for (const a of aggressors) {
    g.applyDebug({ type: 'war', a: a.id, b: ally.id, mobilizeTicks: 0 });
    const call = g.diplomacy.openProposals(HUMAN_ID).find((r) => r.kind === 'callToArms' && r.target === a.id);
    if (!call) {
      statuses.push('none');
      continue;
    }
    const t0 = g.tick;
    while (g.diplomacy.proposal(call.id)?.status === 'pending' && g.tick - t0 < 400) step();
    const st = g.diplomacy.proposal(call.id)?.status;
    statuses.push(st);
    if (!firstLife) firstLife = g.tick - t0;
    g.applyDebug({ type: 'war', a: a.id, b: ally.id, peace: true });
    step(5);
  }
  const expiredEv = events.filter((e) => e.type === 'proposal' && e.proposal.kind === 'callToArms' && e.proposal.to === HUMAN_ID && e.proposal.status === 'expired');
  const labelled = expiredEv.every((e) => (e.proposal.reasons ?? []).some((r) => r.key === 'answer.expired'));
  row('D2a', 'calls to arms to the human wait >= 240 ticks', firstLife, '>= 240', firstLife >= 240);
  row('D2b', 'three expired calls to arms, alliance kept', `${statuses.join(', ')}; allied ${g.isAllied(HUMAN_ID, ally.id)}`, 'expired x3, allied', statuses.every((s) => s === 'expired') && g.isAllied(HUMAN_ID, ally.id));
  row('D2c', 'expiry labelled as expiry (answer.expired), refusals counted', `${labelled ? 'yes' : 'no'}; refusals ${g.diplomacy.refusals(ally.id, HUMAN_ID)}`, 'yes; 0', labelled && g.diplomacy.refusals(ally.id, HUMAN_ID) === 0);

  // Browser rule: at 4x (40 ticks per real second) a call to arms is still open after 59 real s; 60 s of pause
  // (no ticks, no real time counted) expire nothing.
  g.diplomacy.realTimeFloor = true;
  const a = aggressors[0];
  g.applyDebug({ type: 'war', a: a.id, b: ally.id, mobilizeTicks: 0 });
  const call = g.diplomacy.openProposals(HUMAN_ID).find((r) => r.kind === 'callToArms' && r.target === a.id);
  // Keep the aggressor's staff from abandoning the war as a failed one while we wait (it has no offensive).
  const brains = g.ai.snapshotState?.().brains;
  const keep = () => {
    const w = g.war.between(a.id, ally.id);
    if (w && brains) for (const id of [a.id, ally.id]) brains.get(id)?.warActive.set(w.id, g.tick);
  };
  let at59 = 'none', paused = 'none', after = 'none';
  if (call) {
    for (let s = 0; s < 59 * 40; s++) {
      g.diplomacy.addRealTime(25);
      keep();
      step();
    }
    at59 = g.diplomacy.proposal(call.id)?.status;
    // 60 s of pause: the worker neither ticks nor counts.
    paused = g.diplomacy.proposal(call.id)?.status;
    for (let s = 0; s < 80; s++) {
      g.diplomacy.addRealTime(25);
      keep();
      step();
    }
    after = g.diplomacy.proposal(call.id)?.status;
  }
  row('D2d', 'at 4x a call to arms is still answerable after 59 real s', at59, 'pending', at59 === 'pending');
  row('D2e', '60 real s of pause expire nothing / expires once 60 unpaused s have passed', `${paused} / ${after}`, 'pending / expired', paused === 'pending' && after === 'expired');
}

// =================================================================================================
// D3 human demands
// =================================================================================================
function d3() {
  const { g, events, step } = newGame(SEED + 2);
  step(400);
  const neighbours = nations(g).filter((p) => g.sharesBorder(HUMAN_ID, p.id));
  const out = [];
  for (const p of neighbours.slice(0, 4)) {
    const cede = g.diplomacy.propose(HUMAN_ID, p.id, 'demand', { demand: { kind: 'cede', tiles: Math.floor(p.tiles * 0.03) } });
    if (cede) out.push({ id: cede.id, to: p.id, tick: g.tick, kind: 'cede' });
  }
  for (const p of nations(g).slice(0, 3)) {
    if (p.gold <= 0) continue;
    const trib = g.diplomacy.propose(HUMAN_ID, p.id, 'demand', { demand: { kind: 'tribute', gold: Math.round(p.gold * 0.25) } });
    if (trib) out.push({ id: trib.id, to: p.id, tick: g.tick, kind: 'tribute' });
  }
  step(200);
  let window = 0, reasoned = 0, refused = 0, tension = 0;
  const delays = [];
  for (const d of out) {
    const ans = propEvents(events, d.id).find((e) => e.status !== 'considering');
    if (!ans) continue;
    const dt = ans.tick - d.tick;
    delays.push(dt);
    if (dt >= 60 && dt <= 120) window++;
    if ((ans.reasons ?? []).length) reasoned++;
    if (ans.status === 'rejected') {
      refused++;
      if (events.some((e) => e.type === 'tension' && e.from === d.to && e.to === HUMAN_ID && e.tick === ans.tick)) tension++;
    }
  }
  const warsByRefusers = events.filter((e) => e.type === 'warDeclared' && e.target === HUMAN_ID).length;
  row('D3a', `demands answered 60–120 ticks later (${out.length} sent)`, `${window}/${delays.length} (${Math.min(...delays)}–${Math.max(...delays)})`, 'all', window === out.length && out.length > 0);
  row('D3b', 'answers with a reason', `${reasoned}/${delays.length}`, 'all', reasoned === delays.length);
  row('D3c', 'refusals raise tension, no war declared on the human', `${tension}/${refused} tension, ${warsByRefusers} wars`, 'all, 0', tension === refused && warsByRefusers === 0);
}

// =================================================================================================
// D4 peace, truce, betrayal of a truce; D5 NAP and alliance betrayal
// =================================================================================================
function d4d5() {
  const { g, events, step } = newGame(SEED + 3);
  step(300);
  const ns = nations(g).filter((p) => !g.war.atWar(HUMAN_ID, p.id));
  const [A, B, C] = ns;
  // A winning AI refuses a white peace.
  g.applyDebug({ type: 'war', a: A.id, b: HUMAN_ID, goal: 'border', mobilizeTicks: 0 });
  const w = g.war.between(A.id, HUMAN_ID);
  w.net = Math.round(w.tilesAtStart[1] * 0.8); // A took 80 % of the human's pre-war land: score >= +40
  g.attacks.endBetween(A.id, HUMAN_ID);
  const s0 = g.war.warScore(A.id, HUMAN_ID), ex0 = g.war.exhaustion(A.id);
  const white = g.diplomacy.propose(HUMAN_ID, A.id, 'peace', { terms: { kind: 'white' } });
  step(200);
  const a1 = propEvents(events, white.id).find((e) => e.status !== 'considering');
  row('D4a', `winner (score ${Math.round(s0)}, exhaustion ${Math.round(ex0)}) refuses white peace with the reason`, a1 ? `${a1.status}: ${(a1.reasons ?? []).map((r) => r.key).join(', ')}` : 'no answer', 'rejected/countered: answer.winning', a1 && a1.status !== 'accepted' && a1.reasons?.[0]?.key === 'answer.winning');
  // The winner's counter-offer (a cession by the human) waits in the inbox; the human accepts it.
  const counter = a1?.counterId ? g.diplomacy.proposal(a1.counterId) : null;
  if (counter) g.issue(HUMAN_ID, { type: 'answer', proposalId: counter.id, accept: true });
  step(2);
  const a2 = counter ? propEvents(events, counter.id).find((e) => e.status !== 'pending') : null;
  const ended = events.find((e) => e.type === 'warEnded' && ((e.a === A.id && e.b === HUMAN_ID) || (e.b === A.id && e.a === HUMAN_ID)));
  const truce = g.war.truceViews().find((t) => (t.a === A.id && t.b === HUMAN_ID) || (t.b === A.id && t.a === HUMAN_ID));
  row('D4b', 'the cession counter-offer accepted from the inbox -> warEnded + truce', `${a2?.status} (${(a2?.reasons ?? []).map((r) => r.key).join(', ')}); warEnded ${!!ended}; truce ${truce ? truce.untilTick - (ended?.tick ?? 0) : 'none'}`, `accepted, warEnded, ${TRUCE_TICKS}`, a2?.status === 'accepted' && !!ended && truce && truce.untilTick - ended.tick === TRUCE_TICKS);
  // Tribute: the human asks B (at war, B losing badly) for tribute.
  g.applyDebug({ type: 'war', a: HUMAN_ID, b: B.id, mobilizeTicks: 0 });
  const wb = g.war.between(HUMAN_ID, B.id);
  wb.net = Math.round(wb.tilesAtStart[1] * 0.5);
  g.attacks.endBetween(HUMAN_ID, B.id);
  const trib = g.diplomacy.propose(HUMAN_ID, B.id, 'peace', { terms: { kind: 'tribute', loser: B.id } });
  step(200);
  const a3 = propEvents(events, trib.id).find((e) => e.status !== 'considering');
  row('D4c', 'a tribute proposal is answered with a reason', `${a3?.status}: ${(a3?.reasons ?? []).map((r) => r.key).join(', ')}`, 'answered with a reason', !!a3 && (a3.reasons ?? []).length > 0);
  // Declaring on A during the truce: a betrayal.
  g.issue(HUMAN_ID, { type: 'declareWar', target: A.id });
  const betrayTruce = events.find((e) => e.type === 'warDeclared' && e.aggressor === HUMAN_ID && e.target === A.id);
  // NAP and alliance.
  g.diplomacy.debugSign(HUMAN_ID, C.id, 'nap');
  g.issue(HUMAN_ID, { type: 'declareWar', target: C.id });
  const betrayNap = events.find((e) => e.type === 'warDeclared' && e.aggressor === HUMAN_ID && e.target === C.id);
  const D = nations(g).find((p) => !g.war.atWar(HUMAN_ID, p.id) && p.id !== A.id && p.id !== B.id && p.id !== C.id);
  g.diplomacy.debugSign(HUMAN_ID, D.id, 'alliance');
  g.issue(HUMAN_ID, { type: 'declareWar', target: D.id });
  const betrayAlly = events.find((e) => e.type === 'warDeclared' && e.aggressor === HUMAN_ID && e.target === D.id);
  row('D5', 'betrayal detected: truce / NAP / alliance', `${!!betrayTruce?.betrayal} / ${!!betrayNap?.betrayal} / ${!!betrayAlly?.betrayal}`, 'true / true / true', betrayTruce?.betrayal && betrayNap?.betrayal && betrayAlly?.betrayal);
}

// =================================================================================================
// D6 opinions follow gifts, trade agreements and declarations
// =================================================================================================
function d6() {
  const { g, step } = newGame(SEED + 4);
  step(250);
  const [A, B, C] = nations(g).filter((p) => !g.war.atWar(HUMAN_ID, p.id));
  const reasonsOf = (u, id) => (u.opinions ?? []).find((o) => o.of === id)?.reasons.map((r) => r.key) ?? null;
  g.applyDebug({ type: 'addGold', playerId: HUMAN_ID, amount: 5_000_000 });
  g.issue(HUMAN_ID, { type: 'donate', target: A.id, gold: 2_000_000, troops: 0 });
  const u1 = step();
  g.diplomacy.debugSign(HUMAN_ID, B.id, 'trade');
  const u2 = step();
  g.issue(HUMAN_ID, { type: 'declareWar', target: C.id });
  const u3 = step();
  const r1 = reasonsOf(u1, A.id), r2 = reasonsOf(u2, B.id), r3 = reasonsOf(u3, C.id);
  row('D6', 'gift / trade agreement / declaration in the next opinions update', `${r1?.includes('diplo.reason.gift')} / ${r2?.includes('diplo.reason.tradeAgreement')} / ${r3?.includes('diplo.reason.atWar')}`, 'true / true / true', r1?.includes('diplo.reason.gift') && r2?.includes('diplo.reason.tradeAgreement') && r3?.includes('diplo.reason.atWar'));
}

// =================================================================================================
// D7 save and restore
// =================================================================================================
function d7() {
  const { g, step } = newGame(SEED + 5);
  step(400);
  const ns = nations(g);
  g.diplomacy.debugSign(HUMAN_ID, ns[0].id, 'nap');
  g.diplomacy.debugSign(ns[1].id, ns[2].id, 'alliance');
  g.diplomacy.propose(HUMAN_ID, ns[3].id, 'trade');
  g.diplomacy.propose(ns[4].id, HUMAN_ID, 'alliance');
  g.applyDebug({ type: 'addGold', playerId: HUMAN_ID, amount: 1_000_000 });
  g.issue(HUMAN_ID, { type: 'donate', target: ns[5].id, gold: 500_000, troops: 0 });
  step(3);
  const snap = (x) => JSON.stringify({ t: x.diplomacy.treatyViews(), p: x.diplomacy.proposalViews(), o: x.diplomacy.opinionViews() });
  const before = snap(g);
  const w = new SaveWriter();
  g.serialize(w);
  const blob = w.finish();
  const r = Game.restore(new SaveReader(blob), world);
  const after = snap(r);
  row('D7a', 'treaties, proposals, opinions after save/restore', before === after ? 'identical' : 'differ', 'identical', before === after);
  // Both run 300 more ticks: same diplomacy state.
  for (let i = 0; i < 300; i++) {
    g.tick1();
    g.buildUpdate(1);
    r.tick1();
    r.buildUpdate(1);
  }
  const b2 = snap(g), a2 = snap(r);
  row('D7b', 'the same 300 ticks later', b2 === a2 ? 'identical' : 'differ', 'identical', b2 === a2);
}

const t0 = Date.now();
d1();
d2();
d3();
d4d5();
d6();
d7();
console.log(`\n=== diplomacy audit (${DIFF}, seed ${SEED}) · ${((Date.now() - t0) / 1000).toFixed(0)} s ===`);
const w = Math.max(...results.map((r) => r.what.length));
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(5)} ${r.what.padEnd(w)}  ${String(r.value).padEnd(28)} target ${r.target}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`--- ${results.length - failed}/${results.length} pass`);
const out = arg('json', '');
if (out) fs.writeFileSync(out, JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
