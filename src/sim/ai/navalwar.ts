// FRONT ULTRA — AI naval warfare on the sea lanes (owner item 30, DESIGN_V2 §20.6; owner: sim-ai). Worker-only.
//
// * Closing lanes: a nation at war sends a warship to close the strait its enemy's ships sail through (the busiest
//   one within reach), else to blockade the enemy's nearest port (military.ts calls blockadeOrder).
// * Answering what others do to our ships (the shipStopped events): at peace it is piracy — a public protest, then an
//   embargo, escorted convoys, and war when the nation is angry enough and not too weak (its allies are called to
//   arms); at war — escorts for the merchants and convoys near the enemy's blockades, and our warships sent to break
//   a blockade when we have at least as many near it.

import { PIRACY_EMBARGO_OPINION, PIRACY_WAR_OPINION } from '../../shared/naval';
import type { SimEvent } from '../../shared/protocol';
import type { SimPlayer } from '../../shared/simapi';
import { UnitState, UnitType } from '../../shared/types';
import { alive, relation, strength, type AiContext } from './context';
import { dist2, tileAt } from './mapindex';
import type { Brain, NavalGrievance } from './state';

/** How often a nation reviews its grievances (ticks), how long one lasts without new stops, protest spacing. */
export const NAVAL_WAR_EVERY = 20;
const GRIEF_KEEP_TICKS = 4_800;
const PROTEST_EVERY = 480;
/** A nation deliberates this long after the first stop before it goes to war over piracy. */
const WAR_DELIBERATION = 120;
/** Merchants and convoys within this many tiles of an enemy blockade get an escort. */
const ESCORT_NEAR_TILES = 40;

/** Record what a shipStopped event did to one of our ships. */
export function onShipStopped(b: Brain, e: Extract<SimEvent, { type: 'shipStopped' }>): void {
  if (e.action === 'passed' || e.action === 'hailed' || e.by <= 0) return;
  b.navalGrief ??= new Map();
  let gr = b.navalGrief.get(e.by);
  if (!gr) b.navalGrief.set(e.by, (gr = { stops: 0, piracy: false, first: e.tick, last: e.tick, protested: -1_000_000, escorted: -1_000_000, declared: false }));
  gr.stops++;
  gr.last = e.tick;
  if (e.piracy) gr.piracy = true;
  const r = relation(b, e.by);
  r.grievance += e.action === 'sunk' ? 0.6 : 0.3;
  r.trust = Math.max(-1, r.trust - (e.piracy ? 0.12 : 0.05));
}

export function thinkNavalWar(ctx: AiContext, b: Brain, p: SimPlayer): void {
  const g = ctx.g;
  const grief = b.navalGrief;
  if (!grief || !grief.size) return;
  for (const [o, gr] of grief) {
    const O = g.player(o);
    if (!alive(O) || g.tick - gr.last > GRIEF_KEEP_TICKS) {
      grief.delete(o);
      continue;
    }
    const war = g.war.atWar(p.id, o);
    if (!war && gr.piracy) answerPiracy(ctx, b, p, O, gr);
    if (g.tick - gr.escorted > 60) {
      gr.escorted = g.tick;
      escortConvoys(ctx, p, o);
    }
    if (war) breakBlockades(ctx, p, o);
  }
}

/** Protest, embargo, war (with the allies called to arms). */
function answerPiracy(ctx: AiContext, b: Brain, p: SimPlayer, O: SimPlayer, gr: NavalGrievance): void {
  const g = ctx.g;
  const op = g.diplomacy.opinion(p.id, O.id);
  // Once angry enough for war, no fresh protest: each protest is a public warning and restarts the warning clock a
  // declaration on the human must wait out (TENSION_LEAD_TICKS, 48-72 h), so repeating it every 480 ticks would hold
  // the war off forever (gauntlet round 1 regression, naval-audit N10b).
  const decided = gr.protested >= 0 && op <= PIRACY_WAR_OPINION;
  if (!decided && g.tick - gr.protested >= PROTEST_EVERY) {
    gr.protested = g.tick;
    g.diplomacy.issueTension(p.id, O.id, 'tension.piracy', { n: gr.stops });
  }
  if (!p.embargoes.has(O.id) && !g.isAllied(p.id, O.id) && (gr.stops >= 2 || op <= PIRACY_EMBARGO_OPINION)) {
    g.issue(p.id, { type: 'embargo', target: O.id, active: true });
  }
  if (gr.declared || op > PIRACY_WAR_OPINION || g.tick - gr.first < WAR_DELIBERATION || g.isAllied(p.id, O.id)) return;
  // Not suicidal: at least half the offender's strength, or allies to call.
  const allies = [...p.allies].filter((a) => alive(g.player(a)) && !g.war.atWar(a, O.id));
  if (strength(p) < strength(O) * 0.5 && allies.length === 0) return;
  if (g.war.declareError(p.id, O.id) !== null) return;
  if (g.issue(p.id, { type: 'declareWar', target: O.id, goal: 'retaliation', reasonKey: 'war.reason.piracy' })) {
    gr.declared = true;
    b.enemy = O.id;
    b.enemySince = g.tick;
    for (const a of allies.slice(0, 3)) g.issue(p.id, { type: 'propose', target: a, kind: 'callToArms', against: O.id });
  }
}

/** Free warships escort our merchants and convoys sailing near the offender's blockades. */
function escortConvoys(ctx: AiContext, p: SimPlayer, o: number): void {
  const g = ctx.g;
  const zones = g.naval.activeAgainst(p.id).filter((z) => z.owner === o);
  const units = g.units(p.id);
  const free = units.filter((u) => u.type === UnitType.Warship && (u.state === UnitState.Idle || u.state === UnitState.Moving) && !g.naval.blockadeOfUnit(u.id));
  if (!free.length) return;
  const ships = units.filter((u) => u.type === UnitType.TransportShip || u.type === UnitType.TradeShip);
  // Convoys first (troops), then merchants near a zone (or any merchant when the zone is unknown: a ship taken in open sea).
  ships.sort((a, b) => (a.type === UnitType.TransportShip ? 0 : 1) - (b.type === UnitType.TransportShip ? 0 : 1));
  let n = 0;
  for (const s of ships) {
    if (n >= free.length || n >= 3) break;
    const near = !zones.length || zones.some((z) => {
      const d = dist2(tileAt(Math.floor(s.x), Math.floor(s.y)), tileAt(Math.floor(z.x), Math.floor(z.y)));
      return d < ESCORT_NEAR_TILES * ESCORT_NEAR_TILES;
    });
    if (!near) continue;
    const st = tileAt(Math.floor(s.x), Math.floor(s.y));
    // The nearest free warship.
    let best = -1, bd = Infinity;
    for (let i = 0; i < free.length; i++) {
      const w = free[i];
      if (!w) continue;
      const d = dist2(tileAt(Math.floor(w.x), Math.floor(w.y)), st);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (best < 0 || bd > 120 * 120) continue;
    const w = free[best];
    if (g.issue(p.id, { type: 'unitOrder', unitIds: [w.id], order: 'escort', tile: st, targetId: s.id })) {
      free.splice(best, 1);
      n++;
    }
  }
}

/** At war: our warships go for a blockade of the enemy that stops us when we have at least as many near it. */
function breakBlockades(ctx: AiContext, p: SimPlayer, o: number): void {
  const g = ctx.g;
  for (const z of g.naval.activeAgainst(p.id)) {
    if (z.owner !== o || !z.warships.length) continue;
    const zt = tileAt(Math.floor(z.x), Math.floor(z.y));
    const near = g.units(p.id, UnitType.Warship).filter((w) => !g.naval.blockadeOfUnit(w.id) && dist2(tileAt(Math.floor(w.x), Math.floor(w.y)), zt) < 160 * 160);
    if (near.length < z.warships.length) continue;
    const target = z.warships[0];
    g.issue(p.id, { type: 'unitOrder', unitIds: near.slice(0, z.warships.length + 1).map((w) => w.id), order: 'attack', tile: zt, targetId: target });
    return;
  }
}

/**
 * military.ts: the blockade a warship at war should hold (a strait the enemy's ships use, within reach; else the
 * enemy's nearest port) as a water tile, or -1.
 */
export function blockadeTile(ctx: AiContext, enemy: number, here: number, portWater: number): number {
  const g = ctx.g;
  for (const c of g.naval.chokepointsFor(enemy)) {
    if (c.ships < 1) break;
    if (dist2(c.tile, here) < 320 * 320) return c.tile;
  }
  return portWater;
}
