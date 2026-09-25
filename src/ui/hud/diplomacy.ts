// FRONT ULTRA — diplomacy & order actions shared by the radial menu, the selection panel and hotkeys (owner: ui).
// Everything goes through ctx.sim.send(cmd); the sim validates and answers with 'message' events.

import type { HudShared } from './shared';
import { HUMAN_ID } from '../../shared/constants';
import { tileXYToLatLon, tileToLatLon } from '../../shared/geo';
import { t } from '../../shared/i18n';
import type { EmoteId } from '../../shared/types';

export function nationRelation(hs: HudShared, id: number): 'self' | 'ally' | 'embargoed' | 'traitor' | 'neutral' | 'hostile' {
  if (id === HUMAN_ID) return 'self';
  const view = hs.ctx.sim.view;
  const p = view.players[id];
  const me = view.human;
  if (!p || !me) return 'neutral';
  if (me.allies.includes(id)) return 'ally';
  if (me.embargoes.includes(id)) return 'embargoed';
  if (p.traitorTicks > 0) return 'traitor';
  for (const a of view.attacks) if ((a.attacker === id && a.defender === HUMAN_ID) || (a.attacker === HUMAN_ID && a.defender === id)) return 'hostile';
  return 'neutral';
}

export function focusNation(hs: HudShared, id: number, altitudeKm = 4800): void {
  const p = hs.ctx.sim.view.players[id];
  if (!p) return;
  const ll = p.labelSize > 0 ? tileXYToLatLon(p.labelX, p.labelY) : p.capitalTile >= 0 ? tileToLatLon(p.capitalTile) : null;
  if (ll) hs.ctx.bus.emit('focusRequest', { lat: ll.lat, lon: ll.lon, altitudeKm, durationMs: 1400 });
}

/** Land attack toward `target` (or a naval invasion when there is no shared border). */
export function attackNation(hs: HudShared, target: number, tile = -1): boolean {
  const ctx = hs.ctx;
  const view = ctx.sim.view;
  const me = view.human;
  if (!me) return false;
  if (target !== 0 && hs.isAlly(target)) {
    ctx.bus.emit('toast', { text: t('msg.cannotAttackAlly'), kind: 'warning' });
    hs.sound('error');
    return false;
  }
  let aim = tile;
  if (aim < 0) {
    const p = view.players[target];
    aim = p && p.capitalTile >= 0 ? p.capitalTile : -1;
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

export function requestAlliance(hs: HudShared, id: number): void {
  hs.ctx.sim.send({ type: 'allianceRequest', target: id });
  hs.ctx.bus.emit('toast', { text: t('hud.toast.allianceSent', { name: hs.name(id) }), kind: 'info', durationMs: 3000 });
  hs.sound('confirm');
}

export function breakAlliance(hs: HudShared, id: number): void {
  hs.ctx.sim.send({ type: 'breakAlliance', target: id });
  hs.sound('alert');
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

export function sendEmote(hs: HudShared, id: number, emote: EmoteId): void {
  hs.ctx.sim.send({ type: 'emote', target: id, emote });
  hs.sound('click');
}

export function markTarget(hs: HudShared, id: number): void {
  hs.ctx.sim.send({ type: 'targetPlayer', target: id });
  hs.ctx.bus.emit('toast', { text: t('hud.toast.target', { name: hs.name(id) }), kind: 'warning', durationMs: 3000 });
  hs.sound('confirm');
}
