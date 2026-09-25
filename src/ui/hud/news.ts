// FRONT ULTRA — turns simulation events into breaking news, toasts and alarms (owner: ui).
// "ÚLTIMA HORA: Francia detona una bomba de hidrógeno sobre la capital de España".

import { EMOTE_GLYPH } from '../icons';
import type { NukeAlarm, Ticker, Toasts } from './feed';
import type { HudShared } from './shared';
import { BALANCE, HUMAN_ID, MAP_W, STRUCTURE_DEFS, UNIT_DEFS } from '../../shared/constants';
import { tileToLatLon, tileXYToLatLon } from '../../shared/geo';
import { countryName, formatCompact, t } from '../../shared/i18n';
import { UnitType } from '../../shared/types';

export function wireNews(hs: HudShared, ticker: Ticker, toasts: Toasts, alarm: NukeAlarm): void {
  const ctx = hs.ctx;
  const bus = ctx.bus;
  const live = () => ctx.app.state === 'playing' || ctx.app.state === 'command' || ctx.app.state === 'spawn';
  const name = (id: number) => (id === HUMAN_ID ? t('news.you') : hs.name(id) || t('news.rebels'));
  const weaponName = (w: number) => t(`unit.${UNIT_DEFS[w as UnitType]?.id ?? 'atomBomb'}`);
  const nukeArticle = (w: number) => t(`news.art.${UNIT_DEFS[w as UnitType]?.id ?? 'atomBomb'}`);

  /** Human-readable place for a tile: "la capital de X", else the country, else the owner. */
  function placeOf(tile: number): string {
    const view = ctx.sim.view;
    const world = view.world;
    const x = tile % MAP_W, y = (tile / MAP_W) | 0;
    for (const p of view.playerList) {
      if (!p.alive || p.capitalTile < 0) continue;
      let dx = Math.abs((p.capitalTile % MAP_W) - x);
      if (dx > MAP_W / 2) dx = MAP_W - dx;
      const dy = ((p.capitalTile / MAP_W) | 0) - y;
      if (dx * dx + dy * dy < 49) return t('news.capitalOf', { name: name(p.id) });
    }
    const owner = view.owner[tile];
    if (world) {
      const c = world.countries[world.country[tile]];
      const cn = countryName(c);
      if (cn) return cn;
    }
    return owner ? name(owner) : t('news.theOcean');
  }

  const news = (text: string, severity: 'info' | 'warning' | 'critical', tile?: number) => {
    if (!live()) return;
    const ll = tile !== undefined && tile >= 0 ? tileToLatLon(tile) : null;
    ticker.push({ text, severity, lat: ll?.lat, lon: ll?.lon });
  };
  const newsXY = (text: string, severity: 'info' | 'warning' | 'critical', x: number, y: number) => {
    if (!live()) return;
    const ll = tileXYToLatLon(x, y);
    ticker.push({ text, severity, lat: ll.lat, lon: ll.lon });
  };
  const isMajor = (id: number) => {
    const p = ctx.sim.view.players[id];
    return !!p && (p.kind === 'human' || p.kind === 'nation');
  };

  bus.on('news', (e) => live() && ticker.push({ text: e.text, severity: e.severity, lat: e.lat, lon: e.lon }));
  bus.on('toast', (e) => live() && toasts.push(e.text, e.kind, e.durationMs));

  bus.on('nationEliminated', (e) => {
    if (e.playerId === HUMAN_ID) return;
    if (!isMajor(e.playerId) && e.by !== HUMAN_ID) return;
    const text = e.by > 0 ? t('news.eliminatedBy', { a: name(e.playerId), b: name(e.by) }) : t('news.eliminated', { a: name(e.playerId) });
    news(text, e.by === HUMAN_ID ? 'critical' : 'warning');
    if (e.by === HUMAN_ID) hs.sound('confirm');
  });
  bus.on('capitalCaptured', (e) => {
    if (!isMajor(e.playerId)) return;
    news(t('news.capitalCaptured', { a: name(e.by), b: name(e.playerId) }), e.playerId === HUMAN_ID || e.by === HUMAN_ID ? 'critical' : 'warning', e.tile);
  });
  bus.on('allianceFormed', (e) => {
    if (e.a === HUMAN_ID || e.b === HUMAN_ID) {
      const other = e.a === HUMAN_ID ? e.b : e.a;
      toasts.push(t('toast.allianceFormed', { name: name(other) }), 'success', 5000, 'alliance');
      hs.sound('confirm');
    } else if (isMajor(e.a) && isMajor(e.b)) news(t('news.alliance', { a: name(e.a), b: name(e.b) }), 'info');
  });
  bus.on('allianceBroken', (e) => {
    news(t('news.betrayal', { a: name(e.breaker), b: name(e.victim) }), e.victim === HUMAN_ID ? 'critical' : 'warning');
  });
  bus.on('allianceRequested', (e) => {
    if (e.to !== HUMAN_ID) return;
    toasts.allianceRequest(e.from, BALANCE.allianceRequestTimeoutTicks / 10);
  });
  bus.on('allianceRejected', (e) => {
    if (e.from === HUMAN_ID) toasts.push(t('toast.allianceRejected', { name: name(e.to) }), 'warning', 4200, 'alliance');
  });
  bus.on('allianceExpired', (e) => {
    if (e.a === HUMAN_ID || e.b === HUMAN_ID) toasts.push(t('toast.allianceExpired', { name: name(e.a === HUMAN_ID ? e.b : e.a) }), 'info', 4200, 'alliance');
  });
  bus.on('embargoChanged', (e) => {
    if (e.to === HUMAN_ID) toasts.push(t(e.active ? 'toast.embargoAgainst' : 'toast.embargoLifted', { name: name(e.from) }), e.active ? 'warning' : 'info', 4200, 'embargo');
  });
  bus.on('donation', (e) => {
    if (e.to !== HUMAN_ID) return;
    const what = [e.gold > 0 ? `${formatCompact(e.gold)} ${t('hud.gold').toLowerCase()}` : '', e.troops > 0 ? `${formatCompact(e.troops)} ${t('hud.troops').toLowerCase()}` : ''].filter(Boolean).join(' + ');
    toasts.push(t('toast.donation', { name: name(e.from), what }), 'success', 4500, 'donate');
  });
  bus.on('emote', (e) => {
    if (e.from === HUMAN_ID || (e.to !== HUMAN_ID && e.to !== 0)) return;
    if (e.to === 0 && !isMajor(e.from)) return;
    toasts.push(`${name(e.from)}: ${EMOTE_GLYPH[e.emote] ?? ''} ${t(`emote.${e.emote}`)}`, 'info', 3500, 'emote');
  });
  bus.on('nukeLaunched', (e) => {
    if (e.weapon === UnitType.CruiseMissile || e.weapon === UnitType.MirvWarhead) return;
    const big = e.weapon === UnitType.HydrogenBomb || e.weapon === UnitType.Mirv;
    const involved = e.owner === HUMAN_ID || e.targetOwner === HUMAN_ID;
    if (!big && !involved && !isMajor(e.owner)) return;
    news(t('news.launch', { a: name(e.owner), w: nukeArticle(e.weapon), b: e.targetOwner ? name(e.targetOwner) : placeOf(e.targetTile) }), big || involved ? 'critical' : 'warning', e.targetTile);
  });
  bus.on('nukeDetonated', (e) => {
    if (e.weapon === UnitType.CruiseMissile) return;
    if (e.weapon === UnitType.MirvWarhead && e.targetOwner !== HUMAN_ID) return;
    news(t('news.detonation', { a: name(e.owner), w: nukeArticle(e.weapon), place: placeOf(e.tile) }), 'critical', e.tile);
  });
  bus.on('nukeIntercepted', (e) => {
    if (e.owner === HUMAN_ID) toasts.push(t('toast.ourNukeIntercepted', { w: weaponName(e.weapon), name: name(e.by) }), 'warning', 4200, 'samSite');
    else if (e.by === HUMAN_ID) toasts.push(t('toast.weIntercepted', { w: weaponName(e.weapon), name: name(e.owner) }), 'success', 4200, 'samSite');
  });
  bus.on('nukeAlarm', (e) => alarm.add(e.unitId, e.targetTile, e.etaSec, e.weapon));
  bus.on('worldEvent', (e) => {
    if (e.stage === 'end') return;
    if (e.kind === 'doomsday') return;
    const tile = Math.floor(e.y) * MAP_W + Math.floor(e.x);
    const affectsMe = e.players.includes(HUMAN_ID);
    const key = `news.event.${e.kind}${e.stage === 'warning' ? '.warning' : ''}`;
    const place = e.radius > 0 ? placeOf(tile) : '';
    newsXY(t(key, { place, a: e.players.length ? name(e.players[0]) : place }), affectsMe || e.kind === 'earthquake' ? 'critical' : 'warning', e.x, e.y);
  });
  bus.on('doomsday', (e) => {
    news(t('news.doomsday', { m: Math.max(0, Math.round(e.minutesToMidnight)) }), 'critical');
  });
  bus.on('message', (e) => {
    if (e.playerId !== HUMAN_ID) return;
    const kind = e.severity === 'danger' ? 'danger' : e.severity === 'warning' ? 'warning' : 'info';
    toasts.push(t(e.key, e.params), kind, kind === 'info' ? 3500 : 4500);
    if (kind !== 'info') hs.sound('error');
  });
  bus.on('commandResultApplied', (e) => {
    if (e.owner !== HUMAN_ID) return;
    toasts.push(t(e.unitLost ? 'toast.commandLost' : 'toast.commandResult', { n: formatCompact(e.troopsKilled) }), e.unitLost ? 'danger' : 'success', 6000, 'takeControl');
  });
  const lastAttackToast = new Map<number, number>();
  bus.on('attackStarted', (e) => {
    if (e.defender !== HUMAN_ID || e.attacker === 0) return;
    const now = performance.now();
    if (now - (lastAttackToast.get(e.attacker) ?? -1e9) < 25_000) return;
    lastAttackToast.set(e.attacker, now);
    toasts.push(t(e.naval ? 'toast.navalInvasion' : 'toast.underAttack', { name: name(e.attacker), n: formatCompact(e.troops) }), 'danger', 5000, e.naval ? 'boat' : 'attack');
  });
  bus.on('boatLanded', (e) => {
    if (e.defender === HUMAN_ID && e.owner !== HUMAN_ID) toasts.push(t('toast.landing', { name: name(e.owner) }), 'danger', 4500, 'boat');
  });
  bus.on('structureCaptured', (e) => {
    if (e.to === HUMAN_ID) toasts.push(t('toast.captured', { s: t(`structure.${STRUCTURE_DEFS[e.structure].id}`) }), 'success', 3500, 'flag');
  });
  // ---- v2 (W1): war, peace, sieges, offensives, invasions (§4, §8.2). v2-stub(W1→W3): W3 routes these through
  // the alert API; until then they are ticker news and toasts.
  const reason = (key: string) => t(key);
  bus.on('warDeclared', (e) => {
    if (!isMajor(e.aggressor) && !isMajor(e.target)) return;
    const involved = e.aggressor === HUMAN_ID || e.target === HUMAN_ID;
    const key = e.parentWar ? 'news.warJoined' : e.betrayal ? 'news.warDeclaredBetrayal' : 'news.warDeclared';
    const tile = ctx.sim.view.players[e.target]?.capitalTile ?? -1;
    news(t(key, { a: name(e.aggressor), b: name(e.target), reason: reason(e.reasonKey) }), involved ? 'critical' : 'warning', tile >= 0 ? tile : undefined);
    const hours = Math.max(0, Math.round((e.mobilizeUntilTick - e.tick) / 10));
    if (e.target === HUMAN_ID) {
      toasts.push(t('toast.warOnUs', { name: name(e.aggressor), reason: reason(e.reasonKey), hours }), 'danger', 8000, 'attack');
      hs.sound('error');
    } else if (e.aggressor === HUMAN_ID) toasts.push(t('toast.warByUs', { name: name(e.target), hours }), 'warning', 5000, 'attack');
    else if (e.parentWar && ctx.sim.view.human?.allies.includes(e.aggressor)) toasts.push(t('toast.allyJoined', { name: name(e.aggressor) }), 'success', 5000, 'alliance');
  });
  bus.on('warEnded', (e) => {
    if (!isMajor(e.a) && !isMajor(e.b)) return;
    if (e.terms.kind === 'capitulation') return; // the capitulation event tells it
    const loser = e.winner ? (e.winner === e.a ? e.b : e.a) : 0;
    news(t(`news.warEnded.${e.terms.kind}`, { a: name(e.a), b: name(e.b), loser: loser ? name(loser) : '', winner: e.winner ? name(e.winner) : '', tiles: e.terms.tiles ?? 0 }), e.a === HUMAN_ID || e.b === HUMAN_ID ? 'critical' : 'info');
    if (e.a === HUMAN_ID || e.b === HUMAN_ID) toasts.push(t('toast.peace', { name: name(e.a === HUMAN_ID ? e.b : e.a) }), 'info', 5000, 'alliance');
  });
  bus.on('capitulation', (e) => {
    news(t('news.capitulation', { loser: name(e.loser), winner: name(e.winner), tiles: e.tiles }), e.loser === HUMAN_ID || e.winner === HUMAN_ID ? 'critical' : 'warning');
    if (e.winner === HUMAN_ID) toasts.push(t('toast.capitulationUs', { name: name(e.loser), tiles: e.tiles }), 'success', 6000, 'flag');
  });
  bus.on('tension', (e) => {
    if (e.to !== HUMAN_ID) return;
    toasts.push(t(e.reasonKey, { name: name(e.from) }), 'warning', 7000, 'attack');
  });
  bus.on('siege', (e) => {
    if (!isMajor(e.owner)) return;
    const by = e.by.filter((x) => x > 0);
    if (e.stage === 'start') {
      newsXY(t('news.siegeStart', { a: name(e.owner), b: by.map(name).join(', '), tiles: e.tiles }), e.owner === HUMAN_ID || by.includes(HUMAN_ID) ? 'critical' : 'warning', e.x, e.y);
      if (e.owner === HUMAN_ID) toasts.push(t('toast.besieged', { tiles: e.tiles }), 'danger', 7000, 'attack');
      else if (by.includes(HUMAN_ID)) toasts.push(t('toast.besieging', { name: name(e.owner), tiles: e.tiles }), 'success', 5000, 'attack');
    } else if (e.owner === HUMAN_ID || by.includes(HUMAN_ID)) newsXY(t('news.siegeEnd', { a: name(e.owner) }), 'info', e.x, e.y);
  });
  bus.on('offensive', (e) => {
    if (e.attacker === HUMAN_ID) {
      if (e.stage === 'stalled') toasts.push(t('toast.offensiveStalled', { name: name(e.defender), ratio: e.ratio.toFixed(1) }), 'warning', 5000, 'attack');
      else if (e.stage === 'retreating') toasts.push(t('toast.offensiveEnded', { name: name(e.defender) }), 'warning', 5000, 'attack');
    } else if (e.defender === HUMAN_ID && e.stage === 'retreating') toasts.push(t('toast.offensiveRetreat', { name: name(e.attacker) }), 'success', 4500, 'attack');
  });
  bus.on('invasionDetected', (e) => {
    if (e.target !== HUMAN_ID) return;
    toasts.push(t('toast.invasionDetected', { name: name(e.owner), troops: formatCompact(e.troops), hours: Math.max(1, Math.round(e.etaTicks / 10)) }), 'danger', 8000, 'boat');
    hs.sound('error');
  });
  bus.on('escalation', (e) => {
    if (!isMajor(e.by)) return;
    news(t('news.escalation', { a: name(e.by), b: name(e.against), level: t(`escalation.${e.level}`) }), e.against === HUMAN_ID || e.level >= 3 ? 'critical' : 'warning');
    if (e.against === HUMAN_ID) toasts.push(t('toast.escalation', { name: name(e.by), level: t(`escalation.${e.level}`) }), 'danger', 6000, 'attack');
  });

  bus.on('unrest', (e) => {
    const tile = Math.floor(e.y) * MAP_W + Math.floor(e.x);
    const place = placeOf(tile);
    const hours = Math.max(0, Math.round((e.untilTick - e.tick) / 10));
    if (e.owner === HUMAN_ID) {
      if (e.stage === 'start') toasts.push(t(`unrest.${e.cause}`, { place, hours }), 'warning', 9000, 'flag');
      else if (e.stage === 'cancelled') toasts.push(t('unrest.cancelled', { place }), 'success', 5000, 'flag');
      else if (e.stage === 'rebellion') toasts.push(t('unrest.rebellion', { place, cause: t(`unrest.cause.${e.cause}`) }), 'danger', 8000, 'flag');
      return;
    }
    if (!isMajor(e.owner)) return;
    if (e.stage === 'start') newsXY(t('news.unrest', { a: name(e.owner), cause: t(`unrest.cause.short.${e.cause}`), hours }), 'info', e.x, e.y);
  });
  bus.on('hegemony', (e) => {
    if (e.stage === 'start') news(t('news.hegemony.start', { name: name(e.leader), days: Math.max(1, Math.round((e.untilTick - e.tick) / 240)) }), 'critical');
    else if (e.stage === 'broken') news(t('news.hegemony.broken', { name: name(e.leader) }), 'warning');
  });

  bus.on('gameTornDown', () => {
    ticker.clear();
    toasts.clear();
    alarm.clear();
    lastAttackToast.clear();
  });
}
