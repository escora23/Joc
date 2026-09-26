// FRONT ULTRA — sim events → world news and located alerts (DESIGN_V2 §8.2; owner: ui, rewired by W3).
//
// Two audiences:
//   * the WORLD: wars, peace, capitulations, eliminations, capitals, alliances, rebellions, world events, nuclear
//     strikes and hegemony go to the breaking-news ticker (clickable when located);
//   * the PLAYER: everything that concerns the human becomes an ALERT (bus `alert`, ui/hud/alerts.ts) with a place
//     («cerca de Lyon (Francia)»), numbers, a reason and a severity, grouped one entry per front / convoy / proposal.
//
// Monitors running at 1 Hz turn the published state into alerts the sim does not emit as events: the numbers of every
// offensive on a front (the entry updates instead of stacking), front losses at 10/25/50 %, the capital threatened,
// enemy troops massing (mobilization), pacts about to expire. W1's `toast` and `message` events land here too.

import type { AlertCenter } from './alerts';
import type { Ticker } from './feed';
import type { HudShared } from './shared';
import { isHumanFacingProposal, proposalAlert } from './inboxText';
import { describeTile, describeXY } from '../places';
import type { AlertInput } from '../../shared/events';
import { HUMAN_ID, MAP_W, UNIT_DEFS } from '../../shared/constants';
import { tileToLatLon, tileXYToLatLon } from '../../shared/geo';
import { countryName, formatCompact, formatNumber, inSentence, t } from '../../shared/i18n';
import { UnitType, type ProposalView } from '../../shared/types';

/** Structure noun inside a sentence with its gender («nuestro puerto» / «nuestra fábrica»). */
function structParams(id: string): { s: string; g: 'm' | 'f' } {
  return { s: inSentence(t(`structure.${id}`)), g: t(`structure.${id}.g`) === 'f' ? 'f' : 'm' };
}

const STRUCT_IDS = ['city', 'port', 'factory', 'defensePost', 'samSite', 'missileSilo', 'airbase', 'armyBase', 'navalYard', 'radar'];
const structId = (s: number): string => STRUCT_IDS[s] ?? 'city';

function ordSuffix(n: number): string {
  const m100 = n % 100;
  if (m100 >= 11 && m100 <= 13) return 'th';
  return n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
}

/** «1.ª División acorazada» / «1st Armored division» (unnamed units: the type). */
export function unitLabel(type: UnitType, serial: number): string {
  const id = UNIT_DEFS[type]?.id ?? 'armoredDivision';
  const base = t(`unit.${id}`);
  if (!(serial > 0)) return base;
  const g = t(`unit.${id}.g`) === 'f' ? 'f' : 'm';
  return t('unit.named', { n: serial, ord: g === 'f' ? '.ª' : '.º', name: base, suffix: ordSuffix(serial) });
}

const decimal = (v: number) => (Math.round(v * 10) / 10).toString().replace('.', t('num.dec'));

export function wireNews(hs: HudShared, ticker: Ticker, alerts: AlertCenter): void {
  const ctx = hs.ctx;
  const bus = ctx.bus;
  const view = () => ctx.sim.view;
  const live = () => ctx.app.state === 'playing' || ctx.app.state === 'command' || ctx.app.state === 'spawn';
  const name = (id: number) => (id === HUMAN_ID ? t('news.you') : hs.name(id) || t('news.rebels'));
  const nukeArticle = (w: number) => t(`news.art.${UNIT_DEFS[w as UnitType]?.id ?? 'atomBomb'}`);
  const isMajor = (id: number) => {
    const p = view().players[id];
    return !!p && (p.kind === 'human' || p.kind === 'nation');
  };
  const alert = (input: AlertInput) => {
    if (live()) bus.emit('alert', { input });
  };
  const at = (tile: number) => (tile >= 0 ? tileToLatLon(tile) : null);
  const atXY = (x: number, y: number) => tileXYToLatLon(x, y);

  /** «la capital de X», else the country, else the owner (world news). */
  function placeOf(tile: number): string {
    const v = view();
    const world = v.world;
    const x = tile % MAP_W, y = (tile / MAP_W) | 0;
    for (const p of v.playerList) {
      if (!p.alive || p.capitalTile < 0) continue;
      let dx = Math.abs((p.capitalTile % MAP_W) - x);
      if (dx > MAP_W / 2) dx = MAP_W - dx;
      const dy = ((p.capitalTile / MAP_W) | 0) - y;
      if (dx * dx + dy * dy < 49) return t('news.capitalOf', { name: name(p.id) });
    }
    if (world) {
      const cn = countryName(world.countries[world.country[tile]]);
      if (cn) return cn;
    }
    const owner = v.owner[tile];
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
  alerts.onTicker = (text, severity, lat, lon) => {
    if (live()) ticker.push({ text, severity, lat, lon });
  };

  bus.on('news', (e) => live() && ticker.push({ text: e.text, severity: e.severity, lat: e.lat, lon: e.lon }));
  // W1's and every other subsystem's toasts go through the alert feed (§16.4).
  bus.on('toast', (e) => alert({
    kind: 'notice', severity: e.kind === 'danger' ? 'danger' : e.kind === 'warning' ? 'warning' : 'info', title: e.text,
    icon: e.kind === 'success' ? 'check' : undefined, ttlSec: Math.max(6, ((e.durationMs ?? 5000) / 1000) * 1.5),
  }));

  // Sim messages to the human: the ones an alert already tells in full are not repeated.
  const COVERED = new Set(['msg.structureCaptured', 'msg.structureLost', 'msg.capitalLost', 'msg.nukeInbound', 'msg.nukeHit', 'msg.betrayed', 'msg.allianceExpiring', 'msg.allyTarget']);
  bus.on('message', (e) => {
    if (e.playerId !== HUMAN_ID) return;
    if (COVERED.has(e.key.replace(/\.(m|f)$/, ''))) return;
    const sev = e.severity === 'danger' ? 'danger' : e.severity === 'warning' ? 'warning' : 'info';
    alert({ kind: 'message', severity: sev, title: t(e.key, e.params), groupKey: `msg:${e.key}`, ttlSec: sev === 'info' ? 8 : 12 });
    if (sev !== 'info') hs.sound('error');
  });

  // ---- world news, and what of it concerns us ---------------------------------------------------
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
    const ll = at(e.tile)!;
    if (e.playerId === HUMAN_ID) {
      const me = view().human;
      const moved = me && me.capitalTile >= 0 && me.capitalTile !== e.tile ? describeTile(view(), me.capitalTile).name : '';
      alert({
        kind: 'capitalLost', severity: 'critical', icon: 'flag', lat: ll.lat, lon: ll.lon, actors: [e.by],
        title: t('alert.capitalLost.title', { place: describeTile(view(), e.tile).name }),
        body: moved ? t('alert.capitalLost.moved', { place: moved, name: name(e.by) }) : t('alert.capitalLost.body', { name: name(e.by) }),
      });
    } else if (e.by === HUMAN_ID) {
      alert({ kind: 'capitalTaken', severity: 'info', icon: 'crown', lat: ll.lat, lon: ll.lon, title: t('alert.capitalTaken.title', { name: name(e.playerId) }) });
    }
  });
  bus.on('allianceFormed', (e) => {
    if (e.a === HUMAN_ID || e.b === HUMAN_ID) {
      const other = e.a === HUMAN_ID ? e.b : e.a;
      alert({ kind: 'treaty', severity: 'info', icon: 'alliance', actors: [other], title: t('toast.allianceFormed', { name: name(other) }), body: t('alert.alliance.body') });
    } else if (isMajor(e.a) && isMajor(e.b)) news(t('news.alliance', { a: name(e.a), b: name(e.b) }), 'info');
  });
  bus.on('allianceBroken', (e) => {
    news(t('news.betrayal', { a: name(e.breaker), b: name(e.victim) }), e.victim === HUMAN_ID ? 'critical' : 'warning');
  });
  bus.on('embargoChanged', (e) => {
    if (e.to !== HUMAN_ID) return;
    alert({
      kind: 'embargo', severity: e.active ? 'warning' : 'info', icon: 'embargo', actors: [e.from], groupKey: `embargo:${e.from}`,
      title: t(e.active ? 'toast.embargoAgainst' : 'toast.embargoLifted', { name: name(e.from) }), body: e.active ? t('alert.embargo.body') : undefined,
    });
  });
  bus.on('donation', (e) => {
    if (e.to !== HUMAN_ID) return;
    const what = [e.gold > 0 ? `${formatCompact(e.gold)} ${t('hud.gold').toLowerCase()}` : '', e.troops > 0 ? `${formatCompact(e.troops)} ${t('hud.troops').toLowerCase()}` : ''].filter(Boolean).join(' + ');
    alert({ kind: 'gift', severity: 'info', icon: 'donate', actors: [e.from], title: t('toast.donation', { name: name(e.from), what }) });
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
    const ll = atXY(e.x, e.y);
    const w = t(`unit.${UNIT_DEFS[e.weapon].id}`);
    if (e.owner === HUMAN_ID) alert({ kind: 'intercepted', severity: 'warning', icon: 'samSite', lat: ll.lat, lon: ll.lon, title: t('toast.ourNukeIntercepted', { w, name: name(e.by) }) });
    else if (e.by === HUMAN_ID) alert({ kind: 'intercepted', severity: 'info', icon: 'samSite', lat: ll.lat, lon: ll.lon, title: t('toast.weIntercepted', { w, name: name(e.owner) }) });
  });
  bus.on('worldEvent', (e) => {
    if (e.stage === 'end' || e.kind === 'doomsday') return;
    const tile = Math.floor(e.y) * MAP_W + Math.floor(e.x);
    const affectsMe = e.players.includes(HUMAN_ID);
    const key = `news.event.${e.kind}${e.stage === 'warning' ? '.warning' : ''}`;
    const place = e.radius > 0 ? placeOf(tile) : '';
    newsXY(t(key, { place, a: e.players.length ? name(e.players[0]) : place }), affectsMe || e.kind === 'earthquake' ? 'critical' : 'warning', e.x, e.y);
    if (affectsMe && e.kind !== 'rebellion') {
      const ll = atXY(e.x, e.y);
      alert({
        kind: 'worldEvent', severity: e.kind === 'goldRush' ? 'info' : 'warning', icon: e.kind, lat: ll.lat, lon: ll.lon, groupKey: `ev:${e.id}`,
        title: t(key, { place: describeXY(view(), e.x, e.y).name, a: name(HUMAN_ID) }), body: t(`alert.event.${e.kind}`),
      });
    }
  });
  bus.on('doomsday', (e) => news(t('news.doomsday', { m: Math.max(0, Math.round(e.minutesToMidnight)) }), 'critical'));
  bus.on('commandResultApplied', (e) => {
    if (e.owner !== HUMAN_ID) return;
    alert({ kind: 'command', severity: e.unitLost ? 'danger' : 'info', icon: 'takeControl', title: t(e.unitLost ? 'toast.commandLost' : 'toast.commandResult', { n: formatCompact(e.troopsKilled) }) });
  });
  bus.on('structureCaptured', (e) => {
    const id = structId(e.structure);
    const ll = at(e.tile)!;
    if (e.to === HUMAN_ID) alert({ kind: 'structureCaptured', severity: 'info', icon: 'flag', lat: ll.lat, lon: ll.lon, title: t('toast.captured', structParams(id)) });
    else if (e.from === HUMAN_ID) {
      alert({ kind: 'structureLost', severity: 'warning', icon: id, lat: ll.lat, lon: ll.lon, actors: [e.to], title: t('alert.structureCaptured.title', { ...structParams(id), name: name(e.to) }), body: describeTile(view(), e.tile).text });
    }
  });
  bus.on('structureDestroyed', (e) => {
    if (e.owner !== HUMAN_ID || e.by === HUMAN_ID || e.by <= 0) return;
    const id = structId(e.structure);
    const ll = at(e.tile)!;
    alert({ kind: 'structureLost', severity: 'warning', icon: id, lat: ll.lat, lon: ll.lon, actors: [e.by], title: t('alert.structureDestroyed.title', { ...structParams(id), name: name(e.by) }), body: describeTile(view(), e.tile).text });
  });

  // ---- war and peace (§4.2, §8.2) ---------------------------------------------------------------
  const warStartTiles = new Map<number, number>();
  bus.on('warDeclared', (e) => {
    if (!isMajor(e.aggressor) && !isMajor(e.target)) return;
    const involved = e.aggressor === HUMAN_ID || e.target === HUMAN_ID;
    const key = e.parentWar ? 'news.warJoined' : e.betrayal ? 'news.warDeclaredBetrayal' : 'news.warDeclared';
    const capTile = view().players[e.target]?.capitalTile ?? -1;
    const worldText = t(key, { a: name(e.aggressor), b: name(e.target), reason: t(e.reasonKey) });
    const hours = Math.max(0, Math.round((e.mobilizeUntilTick - e.tick) / 10));
    const me = view().human;
    news(worldText, involved ? 'critical' : 'warning', capTile >= 0 ? capTile : undefined);
    if (e.target === HUMAN_ID) {
      warStartTiles.set(e.aggressor, me?.tiles ?? 0);
      // Where their troops mass: the queued offensive's axis, else the aggressor's capital.
      const q = view().attacks.find((a) => a.attacker === e.aggressor && a.defender === HUMAN_ID);
      const agg = view().players[e.aggressor];
      const ll = q ? atXY(q.x, q.y) : agg && agg.capitalTile >= 0 ? at(agg.capitalTile) : null;
      alert({
        kind: e.betrayal ? 'betrayal' : 'warDeclared', severity: 'critical', icon: 'attack', actors: [e.aggressor],
        lat: ll?.lat, lon: ll?.lon, autoPause: 'warOnYou', groupKey: `war:${e.aggressor}`,
        title: t(e.betrayal ? 'alert.betrayal.title' : e.parentWar ? 'alert.warJoinedOnUs.title' : 'alert.warOnUs.title', { name: name(e.aggressor) }),
        body: t('alert.warOnUs.body', { reason: t(e.reasonKey), hours }),
      });
      return;
    }
    if (e.aggressor === HUMAN_ID) {
      warStartTiles.set(e.target, me?.tiles ?? 0);
      alert({ kind: 'warByUs', severity: 'warning', icon: 'attack', actors: [e.target], groupKey: `war:${e.target}`, title: t('alert.warByUs.title', { name: name(e.target) }), body: t('alert.warByUs.body', { hours }) });
    } else if (e.parentWar && me?.allies.includes(e.aggressor)) {
      alert({ kind: 'allyJoined', severity: 'info', icon: 'alliance', actors: [e.aggressor, e.target], title: t('toast.allyJoined', { name: name(e.aggressor) }), body: t('alert.allyJoined.body', { enemy: name(e.target) }) });
    } else if (me?.allies.includes(e.target)) {
      const ll = capTile >= 0 ? at(capTile) : null;
      alert({ kind: 'allyAttacked', severity: 'warning', icon: 'alliance', actors: [e.aggressor, e.target], lat: ll?.lat, lon: ll?.lon, title: t('alert.allyAttacked.title', { a: name(e.aggressor), b: name(e.target) }), body: t('alert.allyAttacked.body') });
    }
  });
  bus.on('warEnded', (e) => {
    if (!isMajor(e.a) && !isMajor(e.b)) return;
    if (e.terms.kind === 'capitulation') return; // the capitulation event tells it
    const loser = e.winner ? (e.winner === e.a ? e.b : e.a) : 0;
    const text = t(`news.warEnded.${e.terms.kind}`, { a: name(e.a), b: name(e.b), loser: loser ? name(loser) : '', winner: e.winner ? name(e.winner) : '', tiles: e.terms.tiles ?? 0 });
    news(text, e.a === HUMAN_ID || e.b === HUMAN_ID ? 'critical' : 'info');
    if (e.a === HUMAN_ID || e.b === HUMAN_ID) {
      const other = e.a === HUMAN_ID ? e.b : e.a;
      alerts.resolve(`war:${other}`);
      alert({ kind: 'peace', severity: 'info', icon: 'peace', actors: [other], title: t('toast.peace', { name: name(other) }), body: text });
    }
  });
  bus.on('capitulation', (e) => {
    news(t('news.capitulation', { loser: name(e.loser), winner: name(e.winner), tiles: e.tiles }), e.loser === HUMAN_ID || e.winner === HUMAN_ID ? 'critical' : 'warning');
    if (e.winner === HUMAN_ID) alert({ kind: 'capitulation', severity: 'info', icon: 'flag', actors: [e.loser], title: t('toast.capitulationUs', { name: name(e.loser), tiles: formatNumber(e.tiles) }) });
  });
  bus.on('tension', (e) => {
    if (e.to !== HUMAN_ID) return;
    const p = view().players[e.from];
    const ll = p && p.capitalTile >= 0 ? at(p.capitalTile) : null;
    alert({
      kind: 'tension', severity: 'warning', icon: 'megaphone', actors: [e.from], lat: ll?.lat, lon: ll?.lon, groupKey: `tension:${e.from}`, ttlSec: 40,
      title: t(e.reasonKey, { ...e.params, name: name(e.from) }), body: t(e.reasonKey === 'tension.demandRefused' ? 'alert.tension.refused' : 'alert.tension.body'),
    });
  });
  bus.on('siege', (e) => {
    if (!isMajor(e.owner)) return;
    const by = e.by.filter((x) => x > 0);
    if (e.stage === 'start') {
      newsXY(t('news.siegeStart', { a: name(e.owner), b: by.map(name).join(', '), tiles: e.tiles }), e.owner === HUMAN_ID || by.includes(HUMAN_ID) ? 'critical' : 'warning', e.x, e.y);
      const ll = atXY(e.x, e.y);
      if (e.owner === HUMAN_ID) {
        alert({ kind: 'siege', severity: 'danger', icon: 'attack', lat: ll.lat, lon: ll.lon, actors: by, groupKey: `siege:${Math.round(e.x / 8)}:${Math.round(e.y / 8)}`, title: t('toast.siegeOurs', { place: describeXY(view(), e.x, e.y).name, tiles: e.tiles }), body: t('alert.siege.body') });
      } else if (by.includes(HUMAN_ID)) alert({ kind: 'siege', severity: 'info', icon: 'attack', lat: ll.lat, lon: ll.lon, title: t('toast.besieging', { name: name(e.owner), tiles: e.tiles }) });
    } else if (e.owner === HUMAN_ID || by.includes(HUMAN_ID)) newsXY(t('news.siegeEnd', { a: name(e.owner) }), 'info', e.x, e.y);
  });
  bus.on('offensive', (e) => {
    const ll = atXY(e.x, e.y);
    const place = describeXY(view(), e.x, e.y).name;
    if (e.attacker === HUMAN_ID) {
      if (e.stage === 'stalled') {
        alert({ kind: 'offensiveStalled', severity: 'info', icon: 'attack', lat: ll.lat, lon: ll.lon, groupKey: `our:${e.attackId}`, title: t('alert.offensiveStalled.title', { place }), body: t('alert.offensiveStalled.body', { ratio: decimal(e.ratio), name: name(e.defender) }) });
      } else if (e.stage === 'retreating' || e.stage === 'ended') {
        alert({ kind: 'offensiveEnded', severity: 'info', icon: 'attack', lat: ll.lat, lon: ll.lon, groupKey: `our:${e.attackId}`, title: t('alert.offensiveEnded.title', { place }), body: t('toast.offensiveEnded', { name: name(e.defender) }) });
      }
    } else if (e.defender === HUMAN_ID && e.stage === 'retreating') {
      alert({ kind: 'offensiveRetreat', severity: 'info', icon: 'shield', lat: ll.lat, lon: ll.lon, title: t('toast.offensiveRetreat', { name: name(e.attacker) }) });
    }
  });
  bus.on('invasionDetected', (e) => {
    if (e.target !== HUMAN_ID) return;
    const ll = at(e.toTile)!;
    const hours = Math.max(1, Math.round(e.etaTicks / 10));
    alert({
      kind: 'invasionDetected', severity: 'danger', icon: 'boat', lat: ll.lat, lon: ll.lon, actors: [e.owner], autoPause: 'invasion', groupKey: `inv:${e.unitId}`,
      title: t('alert.invasion.title', { name: name(e.owner), place: describeTile(view(), e.toTile).name }),
      body: t('alert.invasion.body', { troops: formatCompact(e.troops), hours, by: t(`alert.invasion.by.${e.by}`) }),
    });
  });
  bus.on('boatLanded', (e) => {
    if (e.defender !== HUMAN_ID || e.owner === HUMAN_ID) return;
    const ll = at(e.tile)!;
    alerts.resolve(`inv:${e.unitId}`);
    alert({ kind: 'landing', severity: 'danger', icon: 'boat', lat: ll.lat, lon: ll.lon, actors: [e.owner], title: t('alert.landing.title', { place: describeTile(view(), e.tile).name }), body: t('alert.landing.body', { name: name(e.owner), troops: formatCompact(e.troops) }) });
  });
  bus.on('airRaid', (e) => {
    if (e.target !== HUMAN_ID) return;
    const ll = at(e.toTile)!;
    const drones = e.unit === UnitType.DroneSwarm;
    alert({
      kind: 'airRaid', severity: 'warning', icon: drones ? 'droneSwarm' : 'bomber', lat: ll.lat, lon: ll.lon, actors: [e.owner], groupKey: `air:${e.unitId}`,
      title: t(drones ? 'alert.airRaid.drones' : 'alert.airRaid.bombers', { name: name(e.owner), from: describeTile(view(), e.fromTile).name, to: describeTile(view(), e.toTile).name }),
      body: t('alert.airRaid.body', { hours: Math.max(1, Math.round(e.etaTicks / 10)), by: t(`alert.airRaid.by.${e.by}`) }),
    });
  });
  bus.on('escalation', (e) => {
    if (!isMajor(e.by)) return;
    news(t('news.escalation', { a: name(e.by), b: name(e.against), level: t(`escalation.${e.level}`) }), e.against === HUMAN_ID || e.level >= 3 ? 'critical' : 'warning');
    if (e.against === HUMAN_ID) alert({ kind: 'escalation', severity: 'danger', icon: 'radiation', actors: [e.by], title: t('toast.escalation', { name: name(e.by), level: t(`escalation.${e.level}`) }), body: t(e.reasonKey) });
  });
  bus.on('unitReady', (e) => {
    if (e.owner !== HUMAN_ID) return;
    const ll = atXY(e.x, e.y);
    alert({ kind: 'unitReady', severity: 'info', icon: UNIT_DEFS[e.unit]?.id ?? 'info', lat: ll.lat, lon: ll.lon, title: t('alert.unitReady.title', { unit: unitLabel(e.unit, e.serial), place: describeXY(view(), e.x, e.y).text, g: t(`unit.${UNIT_DEFS[e.unit]?.id ?? 'armoredDivision'}.g`) === 'f' ? 'f' : 'm' }) });
  });
  const LOSS_ALERT = new Set<number>([UnitType.ArmoredDivision, UnitType.Warship, UnitType.FighterSquadron, UnitType.Bomber, UnitType.DroneSwarm, UnitType.TransportShip]);
  bus.on('unitDestroyed', (e) => {
    if (e.owner !== HUMAN_ID || !LOSS_ALERT.has(e.unit) || e.by === HUMAN_ID) return;
    const ll = atXY(e.x, e.y);
    const u = view().units.get(e.unitId);
    alert({ kind: 'unitLost', severity: 'warning', icon: UNIT_DEFS[e.unit]?.id ?? 'warning', lat: ll.lat, lon: ll.lon, actors: e.by > 0 ? [e.by] : [], title: t('alert.unitLost.title', { unit: unitLabel(e.unit, u?.serial ?? 0), place: describeXY(view(), e.x, e.y).text }) });
  });
  bus.on('unrest', (e) => {
    const hours = Math.max(0, Math.round((e.untilTick - e.tick) / 10));
    if (e.owner === HUMAN_ID) {
      const ll = atXY(e.x, e.y);
      const place = describeXY(view(), e.x, e.y).name;
      const g = `unrest:${Math.round(e.x / 6)}:${Math.round(e.y / 6)}`;
      if (e.stage === 'start') {
        alert({ kind: 'unrest', severity: 'warning', icon: 'rebellion', lat: ll.lat, lon: ll.lon, groupKey: g, sticky: true, tiles: e.region, title: t('alert.unrest.title', { place, hours }), body: t(`unrest.${e.cause}`, { place, hours }) });
      } else if (e.stage === 'cancelled') {
        alerts.resolve(g);
        alert({ kind: 'unrestCancelled', severity: 'info', icon: 'check', lat: ll.lat, lon: ll.lon, title: t('unrest.cancelled', { place }) });
      } else {
        alerts.resolve(g);
        alert({ kind: 'rebellion', severity: 'danger', icon: 'rebellion', lat: ll.lat, lon: ll.lon, ticker: true, tiles: e.region, title: t('unrest.rebellion', { place, cause: t(`unrest.cause.${e.cause}`) }), body: t('alert.rebellion.body') });
      }
      return;
    }
    if (!isMajor(e.owner)) return;
    if (e.stage === 'start') newsXY(t('news.unrest', { a: name(e.owner), cause: t(`unrest.cause.short.${e.cause}`), hours }), 'info', e.x, e.y);
  });
  bus.on('hegemony', (e) => {
    const days = Math.max(1, Math.round((e.untilTick - e.tick) / 240));
    if (e.stage === 'start') news(t('news.hegemony.start', { name: name(e.leader), days }), 'critical');
    else if (e.stage === 'broken') news(t('news.hegemony.broken', { name: name(e.leader) }), 'warning');
    if (e.stage === 'start') {
      alert({
        kind: 'hegemony', severity: e.leader === HUMAN_ID ? 'info' : 'warning', icon: 'crown',
        title: e.leader === HUMAN_ID ? t('hegemony.chipUs', { days }) : t('hegemony.chip', { name: name(e.leader), days }),
        body: t(e.leader === HUMAN_ID ? 'alert.hegemony.us' : 'alert.hegemony.them'),
      });
    }
  });
  bus.on('treatyChanged', (e) => {
    if (e.a !== HUMAN_ID && e.b !== HUMAN_ID) return;
    const other = e.a === HUMAN_ID ? e.b : e.a;
    if (e.treaty === 'alliance' && e.active && e.reasonKey === 'treaty.reason.signed') return; // allianceFormed tells it
    if (e.reasonKey === 'treaty.reason.war' || e.reasonKey === 'treaty.reason.betrayal' || e.reasonKey === 'treaty.reason.gone') return;
    const notice = e.reasonKey === 'treaty.reason.notice';
    const key = e.active ? (notice ? 'alert.treaty.notice' : `alert.treaty.signed.${e.treaty}`) : `alert.treaty.ended.${e.treaty}`;
    alert({
      kind: 'treaty', severity: e.active && !notice ? 'info' : 'warning', icon: e.treaty === 'alliance' ? 'alliance' : e.treaty, actors: [other],
      title: t(key, { name: name(other) }), body: t(e.reasonKey, { name: name(other) }),
    });
  });

  // ---- proposals (§5.3, §8.2 proposal, proposalAnswered, peaceOffer, callToArms, ultimatum) ---------
  bus.on('proposal', (e) => {
    const p: ProposalView = e.proposal;
    if (!isHumanFacingProposal(p)) return;
    const input = proposalAlert(hs, p);
    if (input) alert(input);
    else if (p.status !== 'considering' && p.status !== 'pending') alerts.resolve(`prop:${p.id}`);
  });

  // ---- monitors (1 Hz): fronts on us, losses, capital, mobilization, expiring pacts -----------------
  interface FrontTrack { taken: Map<number, number>; milestones: number; enemy: number }
  const fronts = new Map<string, FrontTrack>();
  const flagged = new Map<string, number>();
  const lastTroops = new Map<string, number>();
  let capitalAlarm = 0;
  let lastRun = 0;

  function monitor(): void {
    const v = view();
    const me = v.human;
    if (!me || !me.alive || v.phase !== 'playing') return;
    const now = performance.now();
    // Offensives on us, one entry per front: attacker, place, troops, ratio.
    const groups = new Map<string, { attacker: number; troops: number; x: number; y: number; ratio: number; ids: number[]; mobilizing: boolean; eta: number }>();
    for (const a of v.attacks) {
      if (a.defender !== HUMAN_ID || a.attacker === 0 || a.attacker === HUMAN_ID) continue;
      const mob = a.state === 'mobilizing';
      if (!mob && a.naval && (a.state === 'embarking' || a.state === 'sailing')) continue;
      const key = mob ? `mob:${a.attacker}` : `front:${a.frontKey || `a${a.attacker}`}`;
      let g = groups.get(key);
      // Where the fighting is: the offensive's front (its origin on our border), not the far axis point it aims at.
      const fx = mob || !(a.originX > 0) ? a.x : a.originX, fy = mob || !(a.originY > 0) ? a.y : a.originY;
      if (!g) groups.set(key, (g = { attacker: a.attacker, troops: 0, x: fx, y: fy, ratio: 0, ids: [], mobilizing: mob, eta: a.etaTicks }));
      g.troops += a.troops;
      g.ratio = Math.max(g.ratio, a.ratio);
      g.ids.push(a.id);
    }
    for (const [key, g] of groups) {
      const ll = atXY(g.x, g.y);
      const place = describeXY(v, g.x, g.y);
      if (g.mobilizing) {
        const hours = Math.max(0, Math.round(Math.max(0, g.eta) / 10));
        if (!flagged.has(key)) {
          alert({ kind: 'mobilization', severity: 'warning', icon: 'troops', lat: ll.lat, lon: ll.lon, actors: [g.attacker], groupKey: key, ttlSec: 30, title: t('alert.mobilization.title', { name: name(g.attacker), place: place.text }), body: t('alert.mobilization.body', { hours, troops: formatCompact(g.troops) }) });
        }
        flagged.set(key, now);
        continue;
      }
      const prev = flagged.get(key);
      const last = lastTroops.get(key) ?? 0;
      // Update the entry (never restack) when the numbers move by more than 10 %; else refresh it now and then.
      if (prev === undefined || Math.abs(g.troops - last) > 0.1 * Math.max(1, last) || now - prev > 25_000) {
        alert({
          kind: 'offensive', severity: 'danger', icon: 'attack', lat: ll.lat, lon: ll.lon, actors: [g.attacker], groupKey: key, ttlSec: 30,
          title: t('alert.offensive.title', { name: name(g.attacker), place: place.text }),
          body: t('alert.offensive.body', { troops: formatNumber(Math.max(1000, Math.round(g.troops / 1000) * 1000)), ratio: decimal(g.ratio) }),
        });
        lastTroops.set(key, g.troops);
        flagged.set(key, now);
      }
      // Front losses at 10 / 25 / 50 % of our land at the start of this war.
      let ft = fronts.get(key);
      if (!ft) fronts.set(key, (ft = { taken: new Map(), milestones: 0, enemy: g.attacker }));
      for (const a of v.attacks) if (g.ids.includes(a.id)) ft.taken.set(a.id, Math.max(ft.taken.get(a.id) ?? 0, a.tilesTaken));
      (ft as FrontTrack & { x?: number; y?: number }).x = g.x;
      (ft as FrontTrack & { x?: number; y?: number }).y = g.y;
    }
    for (const key of [...flagged.keys()]) {
      if ((key.startsWith('front:') || key.startsWith('mob:')) && !groups.has(key)) {
        flagged.delete(key);
        alerts.resolve(key);
      }
    }
    for (const [key, ft] of fronts) {
      let lost = 0;
      for (const n of ft.taken.values()) lost += n;
      const base = Math.max(1, warStartTiles.get(ft.enemy) ?? me.tiles + lost);
      const pct = (lost / base) * 100;
      const steps = [10, 25, 50];
      const fx = (ft as FrontTrack & { x?: number }).x, fy = (ft as FrontTrack & { y?: number }).y;
      for (let i = ft.milestones; i < steps.length; i++) {
        if (pct < steps[i]) break;
        ft.milestones = i + 1;
        const ll = fx !== undefined && fy !== undefined ? atXY(fx, fy) : null;
        const place = fx !== undefined && fy !== undefined ? describeXY(v, fx, fy).name : '';
        alert({
          kind: 'frontLoss', severity: steps[i] >= 25 ? 'danger' : 'warning', icon: 'territory', lat: ll?.lat, lon: ll?.lon, actors: [ft.enemy], groupKey: `loss:${key}`,
          title: t('alert.frontLoss.title', { place, pct: steps[i] }), body: t('alert.frontLoss.body', { tiles: formatNumber(lost), name: name(ft.enemy) }),
        });
      }
    }
    // Capital threatened: an enemy front within 5 tiles, or an offensive axis within 10 tiles.
    if (me.capitalTile >= 0) {
      const cx = (me.capitalTile % MAP_W) + 0.5, cy = ((me.capitalTile / MAP_W) | 0) + 0.5;
      const d2 = (x: number, y: number) => {
        let dx = Math.abs(x - cx);
        if (dx > MAP_W / 2) dx = MAP_W - dx;
        return dx * dx + (y - cy) * (y - cy);
      };
      let best = Infinity, by = 0;
      for (const f of v.fronts) {
        if (f.b !== HUMAN_ID && f.a !== HUMAN_ID) continue;
        const enemy = f.a === HUMAN_ID ? f.b : f.a;
        if (!enemy || v.pairState(HUMAN_ID, enemy) !== 'war') continue;
        const s = f.samples;
        for (let i = 0; i + 1 < s.length; i += 2) {
          const d = d2(s[i], s[i + 1]);
          if (d < best) {
            best = d;
            by = enemy;
          }
        }
      }
      let threat = best <= 25;
      let axisBy = 0;
      for (const a of v.attacks) {
        if (a.defender !== HUMAN_ID || a.attacker === 0 || a.state === 'mobilizing') continue;
        // An offensive aimed at the capital (axis within 10 tiles) whose front is already within 500 km of it: AI war
        // plans aim at the enemy capital from the first day, so the aim alone is not yet a threat.
        if (d2(a.x, a.y) <= 100 && (!(a.originX > 0) || d2(a.originX, a.originY) <= 400)) {
          threat = true;
          axisBy = a.attacker;
          by = by || a.attacker;
          if (!Number.isFinite(best) && a.originX > 0) best = d2(a.originX, a.originY);
        }
      }
      if (threat && capitalAlarm === 0) {
        capitalAlarm = now;
        const ll = at(me.capitalTile)!;
        const km = Number.isFinite(best) ? Math.max(25, Math.round((Math.sqrt(best) * 25) / 5) * 5) : 0;
        const place = describeTile(v, me.capitalTile).name;
        const title = best <= 25 || !axisBy ? t('alert.capitalThreat.title', { km: formatNumber(km), place }) : t('alert.capitalThreat.axis', { name: name(axisBy), place, km: formatNumber(km) });
        alert({
          kind: 'capitalThreat', severity: 'critical', icon: 'flag', lat: ll.lat, lon: ll.lon, actors: by ? [by] : [], autoPause: 'capitalThreat', groupKey: 'capital',
          title, body: t('alert.capitalThreat.body'),
        });
      } else if (!threat && capitalAlarm > 0 && now - capitalAlarm > 60_000) {
        capitalAlarm = 0;
        alerts.resolve('capital');
      } else if (threat) capitalAlarm = now;
    }
    // Pacts about to expire (24 h).
    for (const tr of v.treaties) {
      if (tr.kind !== 'nap' || (tr.a !== HUMAN_ID && tr.b !== HUMAN_ID) || tr.untilTick <= 0) continue;
      const left = tr.untilTick - v.tick;
      const key = `nap:${tr.a}:${tr.b}:${tr.untilTick}`;
      if (left > 0 && left <= 240 && !flagged.has(key)) {
        flagged.set(key, now);
        const other = tr.a === HUMAN_ID ? tr.b : tr.a;
        alert({ kind: 'treatyExpiring', severity: 'info', icon: 'nap', actors: [other], title: t('alert.napExpiring.title', { name: name(other), hours: Math.max(1, Math.round(left / 10)) }), body: t('alert.napExpiring.body') });
      }
    }
  }
  bus.on('simTick', () => {
    const now = performance.now();
    if (now - lastRun < 1000) return;
    lastRun = now;
    monitor();
  });
  // An offensive on us raises its entry the same frame it starts (T13), not a second later.
  bus.on('attackStarted', (e) => {
    if (e.defender !== HUMAN_ID || e.attacker === 0 || e.attacker === HUMAN_ID) return;
    lastRun = 0;
    queueMicrotask(monitor);
  });

  bus.on('saved', (e) => alert({ kind: 'saved', severity: 'info', icon: 'save', ttlSec: 5, groupKey: 'saved', title: t(e.key === 'autosave' ? 'saved.auto' : 'saved.toast', { day: e.day }) }));

  bus.on('gameTornDown', () => {
    ticker.clear();
    alerts.clear();
    fronts.clear();
    flagged.clear();
    warStartTiles.clear();
    lastTroops.clear();
    capitalAlarm = 0;
  });
}
