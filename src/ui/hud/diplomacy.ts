// FRONT ULTRA — diplomacy actions shared by the nations panel, the radial menu, the selection card and hotkeys
// (owner: ui, reworked by W3 for DESIGN_V2 §5). Everything goes through ctx.sim.send(cmd); the sim validates and
// answers with events. `whyNot*` mirror the sim's rules (diplomacy.ts proposeError) so a disabled control can say why
// before the player tries; the sim stays authoritative.

import type { HudShared } from './shared';
import { needsDeclaration, openDeclareWar } from './declare';
import { HUMAN_ID } from '../../shared/constants';
import { tileXYToLatLon, tileToLatLon } from '../../shared/geo';
import { t } from '../../shared/i18n';
import { StructureType, type Demand, type PeaceTerms, type ProposalKind, type TreatyKind } from '../../shared/types';

export type Relation = 'self' | 'ally' | 'embargoed' | 'traitor' | 'neutral' | 'hostile' | 'truce';

export function nationRelation(hs: HudShared, id: number): Relation {
  if (id === HUMAN_ID) return 'self';
  const view = hs.ctx.sim.view;
  const p = view.players[id];
  const me = view.human;
  if (!p || !me) return 'neutral';
  const st = view.pairState(HUMAN_ID, id);
  if (st === 'war') return 'hostile';
  if (me.allies.includes(id)) return 'ally';
  if (st === 'truce') return 'truce';
  if (me.embargoes.includes(id)) return 'embargoed';
  if (p.traitorTicks > 0) return 'traitor';
  return 'neutral';
}

export function focusNation(hs: HudShared, id: number, altitudeKm = 4800): void {
  const p = hs.ctx.sim.view.players[id];
  if (!p) return;
  const ll = p.labelSize > 0 ? tileXYToLatLon(p.labelX, p.labelY) : p.capitalTile >= 0 ? tileToLatLon(p.capitalTile) : null;
  if (ll) hs.ctx.bus.emit('focusRequest', { lat: ll.lat, lon: ll.lon, altitudeKm, durationMs: 1400 });
}

/** The AI's rough strength (troops + 15 % of the cap), the same yardstick its staff uses. */
export function strengthOf(hs: HudShared, id: number): number {
  const p = hs.ctx.sim.view.players[id];
  return p ? p.troops + p.maxTroops * 0.15 : 0;
}

/** The allies of `target` that will receive a call to arms if `aggressor` declares war on it (§4.2, §5.5). */
export function defendersOf(hs: HudShared, aggressor: number, target: number): number[] {
  const view = hs.ctx.sim.view;
  const B = view.players[target];
  if (!B) return [];
  const out: number[] = [];
  for (const ally of B.allies) {
    const A = view.players[ally];
    if (ally === aggressor || !A || !A.alive || (A.kind !== 'nation' && A.kind !== 'human')) continue;
    if (view.pairState(ally, aggressor) === 'war') continue;
    if (A.allies.includes(aggressor)) continue;
    out.push(ally);
  }
  return out;
}

/** Why the human may not propose `kind` to `to` now (translated), or null (mirror of the sim's proposeError). */
export function whyNotPropose(hs: HudShared, to: number, kind: ProposalKind, gold = 0, against = 0): string | null {
  const view = hs.ctx.sim.view;
  const me = view.human, T = view.players[to];
  if (view.phase !== 'playing') return t('msg.notYet');
  if (!me || !T || !T.alive || !me.alive) return t('msg.cannotPropose');
  if (T.kind === 'tribe' || T.kind === 'rebel') return t('msg.cannotAllyTribe');
  if (gold > me.gold) return t('msg.notEnoughGold');
  for (const p of view.proposals.values()) {
    if (p.from === HUMAN_ID && p.to === to && p.kind === kind && (p.status === 'considering' || p.status === 'pending')) return t('msg.proposalPending');
  }
  const atWar = view.pairState(HUMAN_ID, to) === 'war';
  switch (kind) {
    case 'alliance': case 'nap': case 'trade': case 'openBorders':
      if (atWar) return t('msg.atWarNoAlliance');
      if (view.hasTreaty(HUMAN_ID, to, kind)) return t('msg.treatyExists');
      if (kind === 'nap' && me.allies.includes(to)) return t('msg.napAllied');
      if (kind === 'openBorders' && me.allies.includes(to)) return t('msg.alliesTransit');
      if (kind === 'trade' && hs.ownStructures(StructureType.Port, false) === 0) return t('why.trade.noPort');
      return null;
    case 'peace':
      return atWar ? null : t('msg.notAtWar');
    case 'callToArms':
      if (!me.allies.includes(to)) return t('msg.callAlliesOnly');
      if (!(against > 0) || view.pairState(HUMAN_ID, against) !== 'war') return t('why.call.noWar');
      if (view.pairState(to, against) === 'war') return t('msg.allyAlreadyAtWar');
      return null;
    case 'demand':
      if (atWar) return t('msg.demandAtWar');
      return null;
  }
  return null;
}

/** Land attack toward `target` (or a naval invasion when there is no shared border); a nation at peace is declared on first. */
export function attackNation(hs: HudShared, target: number, tile = -1): boolean {
  const ctx = hs.ctx;
  const view = ctx.sim.view;
  const me = view.human;
  if (!me) return false;
  let aim = tile;
  if (aim < 0) {
    const p = view.players[target];
    aim = p && p.capitalTile >= 0 ? p.capitalTile : -1;
  }
  // §4.2: a nation at peace (or in truce, or an ally) needs a declaration first; the offensive waits for mobilization.
  if (needsDeclaration(hs, target)) {
    const naval = !hs.borders(target);
    const shore = naval && aim >= 0 ? hs.nearestShoreOf(target, aim, 30) : -1;
    openDeclareWar(hs, target, naval ? shore : aim, naval);
    return true;
  }
  if (hs.borders(target)) {
    ctx.sim.send({ type: 'attack', target, ratio: hs.attackRatio, tile: aim });
    hs.sound('confirm');
    return true;
  }
  const shore = aim >= 0 ? hs.nearestShoreOf(target, aim, 30) : -1;
  if (shore >= 0) {
    ctx.sim.send({ type: 'boatAttack', targetTile: shore, ratio: hs.attackRatio });
    ctx.bus.emit('toast', { text: t('hud.toast.boat', { name: hs.name(target) || t('hud.neutralLand') }), kind: 'info', durationMs: 2600 });
    hs.sound('confirm');
    return true;
  }
  // Let the sim explain why (no border / no path).
  ctx.sim.send({ type: 'attack', target, ratio: hs.attackRatio, tile: aim });
  return false;
}

/** Send a proposal (with an optional gold sweetener); the answer arrives after the AI's deliberation. */
export function propose(hs: HudShared, to: number, kind: ProposalKind, opts: { gold?: number; terms?: PeaceTerms; demand?: Demand; against?: number } = {}): boolean {
  const why = whyNotPropose(hs, to, kind, opts.gold ?? 0, opts.against ?? 0);
  if (why) {
    hs.ctx.bus.emit('toast', { text: why, kind: 'warning', durationMs: 4000 });
    hs.sound('error');
    return false;
  }
  hs.ctx.sim.send({ type: 'propose', target: to, kind, terms: opts.terms, demand: opts.demand, against: opts.against, gold: opts.gold && opts.gold > 0 ? Math.floor(opts.gold) : undefined });
  hs.flags.proposalSent = true;
  hs.sound('confirm');
  return true;
}

export function requestAlliance(hs: HudShared, id: number, gold = 0): void {
  propose(hs, id, 'alliance', { gold });
}

export function answer(hs: HudShared, proposalId: number, accept: boolean): void {
  hs.ctx.sim.send({ type: 'answer', proposalId, accept });
  hs.flags.proposalAnswered = true;
  hs.sound(accept ? 'confirm' : 'cancel');
}

export function leaveTreaty(hs: HudShared, id: number, treaty: TreatyKind): void {
  hs.ctx.sim.send({ type: 'leaveTreaty', target: id, treaty });
  hs.sound('alert');
}

export function breakAlliance(hs: HudShared, id: number): void {
  leaveTreaty(hs, id, 'alliance');
}

/** «Pedir ayuda»: a call to arms to every ally not yet fighting `enemy` (or to one ally). */
export function askHelp(hs: HudShared, enemy: number, ally = 0): number {
  const me = hs.human;
  if (!me) return 0;
  let n = 0;
  for (const a of ally ? [ally] : me.allies) {
    if (whyNotPropose(hs, a, 'callToArms', 0, enemy)) continue;
    hs.ctx.sim.send({ type: 'propose', target: a, kind: 'callToArms', against: enemy });
    n++;
  }
  if (n === 0) hs.ctx.bus.emit('toast', { text: t('msg.noAllyToCall'), kind: 'warning' });
  else hs.sound('confirm');
  return n;
}

export function toggleEmbargo(hs: HudShared, id: number): void {
  const me = hs.human;
  const active = !(me?.embargoes.includes(id) ?? false);
  hs.ctx.sim.send({ type: 'embargo', target: id, active });
  hs.ctx.bus.emit('toast', { text: t(active ? 'hud.toast.embargoOn' : 'hud.toast.embargoOff', { name: hs.name(id) }), kind: active ? 'warning' : 'info', durationMs: 3000 });
  hs.sound('confirm');
}

export function donate(hs: HudShared, id: number, kind: 'gold' | 'troops', fraction: number): void {
  const me = hs.human;
  if (!me) return;
  const gold = kind === 'gold' ? Math.floor(me.gold * fraction) : 0;
  const troops = kind === 'troops' ? Math.floor(me.troops * fraction) : 0;
  hs.ctx.sim.send({ type: 'donate', target: id, gold, troops });
  hs.sound('confirm');
}
