// FRONT ULTRA — alerts of the war at sea (owner item 30; owner: ui). Every one is located (click: the camera flies
// there) and names who, what and where:
//   * our blockade comes into force / ends; another nation's blockade closes a lane our ships use (it stops us);
//   * a ship stopped: ours seized / sunk / turned back by X, or theirs by us (the gold, the troops, piracy or not);
//     an escorted convoy let through; hail and warning shot results;
//   * our merchants rerouted around a blockade (one grouped entry per blockade: ships and the trade it costs);
//   * a prize reached our port with its cargo.
// The answers of the AI (protest, embargo, war) come through the existing tension / embargo / war alerts.

import type { AlertCenter } from './alerts';
import type { HudShared } from './shared';
import { unitLabel } from './news';
import { blockadePlace, gold, specText } from './navalInfo';
import { HUMAN_ID, MAP_W } from '../../shared/constants';
import { tileToLatLon, tileXYToLatLon } from '../../shared/geo';
import { formatNumber, t } from '../../shared/i18n';
import { blockadeApplies } from '../../shared/naval';
import { UnitType } from '../../shared/types';
import { describeXY } from '../places';
import { viewRelations } from './navalInfo';

export function wireNavalNews(hs: HudShared, alerts: AlertCenter): void {
  const ctx = hs.ctx;
  const bus = ctx.bus;
  const view = () => ctx.sim.view;
  /** Grouped reroute counts per blockade (the entry updates instead of stacking). */
  const rerouted = new Map<number, { n: number; km: number; lost: number }>();

  bus.on('blockade', (e) => {
    const v = view();
    const ll = tileXYToLatLon(e.x, e.y);
    const place = blockadePlace(hs, e);
    if (e.owner === HUMAN_ID) {
      alerts.raise({
        kind: 'blockade', severity: 'info', icon: 'shield', lat: ll.lat, lon: ll.lon, groupKey: `blk:${e.blockade}`,
        title: t(e.stage === 'start' ? 'naval.alert.oursOn' : 'naval.alert.oursOff', { place }),
        body: e.stage === 'start' ? specText(hs, e.spec) : undefined,
      });
      return;
    }
    const rel = viewRelations(v);
    const hits = blockadeApplies(rel, e.owner, e.spec, HUMAN_ID, 'trade') || blockadeApplies(rel, e.owner, e.spec, HUMAN_ID, 'transport');
    if (!hits) return;
    alerts.raise({
      kind: 'blockade', severity: e.stage === 'start' ? 'danger' : 'info', icon: 'shield', lat: ll.lat, lon: ll.lon, actors: [e.owner], groupKey: `blk:${e.blockade}`,
      title: t(e.stage === 'start' ? 'naval.alert.theirsOn' : 'naval.alert.theirsOff', { name: hs.name(e.owner), place }),
      body: e.stage === 'start' ? t('naval.alert.theirsOn.body') : undefined, ticker: e.stage === 'start',
    });
  });

  bus.on('shipStopped', (e) => {
    if (e.by !== HUMAN_ID && e.victim !== HUMAN_ID) return;
    const v = view();
    const ll = tileXYToLatLon(e.x, e.y);
    const where = describeXY(v, e.x, e.y).text;
    const what = t(e.unit === UnitType.TransportShip ? 'naval.what.convoy' : 'naval.what.merchant');
    if (e.by === HUMAN_ID) {
      const w = v.units.get(e.warshipId);
      const ship = w ? unitLabel(UnitType.Warship, w.serial) : t('naval.what.ourShip');
      const key = e.action === 'seized' ? (e.unit === UnitType.TradeShip ? 'naval.alert.weSeized' : 'naval.alert.weBoarded') : `naval.alert.we.${e.action}`;
      alerts.raise({
        kind: 'shipStopped', severity: e.piracy ? 'warning' : 'info', icon: e.unit === UnitType.TransportShip ? 'transportShip' : 'tradeShip', lat: ll.lat, lon: ll.lon,
        actors: [e.victim], unitId: e.warshipId || undefined, groupKey: e.action === 'passed' ? `pass:${e.blockade}:${e.victim}` : undefined,
        title: t(key, { ship, what, name: hs.name(e.victim), gold: formatNumber(e.gold), troops: formatNumber(e.troops), where }),
        body: e.piracy ? t('naval.alert.piracyBody', { name: hs.name(e.victim) }) : undefined,
      });
      return;
    }
    // Ours stopped by someone.
    if (e.action === 'passed') {
      alerts.raise({ kind: 'shipStopped', severity: 'info', icon: 'shield', lat: ll.lat, lon: ll.lon, actors: [e.by], groupKey: `passed:${e.by}`, title: t('naval.alert.ourPassed', { name: hs.name(e.by), where }) });
      return;
    }
    alerts.raise({
      kind: 'shipStopped', severity: e.action === 'hailed' ? 'info' : e.unit === UnitType.TransportShip ? 'danger' : 'warning',
      icon: e.unit === UnitType.TransportShip ? 'transportShip' : 'tradeShip', lat: ll.lat, lon: ll.lon, actors: [e.by], groupKey: e.unit === UnitType.TradeShip ? `ours:${e.by}:${e.action}` : undefined,
      title: t(`naval.alert.ours.${e.action}`, { what, name: hs.name(e.by), gold: formatNumber(e.gold), troops: formatNumber(e.troops), where }),
      body: e.piracy ? t('naval.alert.oursPiracy', { name: hs.name(e.by) }) : undefined,
    });
  });

  bus.on('shipRerouted', (e) => {
    if (e.owner !== HUMAN_ID) return;
    const r = rerouted.get(e.blockade) ?? { n: 0, km: 0, lost: 0 };
    r.n++;
    r.km += e.extraKm;
    r.lost += e.lost;
    rerouted.set(e.blockade, r);
    const b = view().blockades.find((x) => x.id === e.blockade);
    const place = b ? blockadePlace(hs, b) : describeXY(view(), e.x, e.y).text;
    const ll = b ? tileXYToLatLon(b.x, b.y) : tileXYToLatLon(e.x, e.y);
    alerts.raise({
      kind: 'shipRerouted', severity: 'warning', icon: 'tradeShip', lat: ll.lat, lon: ll.lon, actors: [e.by], groupKey: `rer:${e.blockade}`,
      title: t('naval.alert.rerouted', { n: r.n, place, name: hs.name(e.by), km: formatNumber(Math.round(r.km / Math.max(1, r.n))) }),
      body: t('naval.alert.rerouted.body', { g: gold(r.lost) }),
    });
  });

  bus.on('prizeDelivered', (e) => {
    if (e.owner !== HUMAN_ID) return;
    const ll = tileToLatLon(e.tile);
    alerts.raise({
      kind: 'prizeDelivered', severity: 'info', icon: 'tradeShip', lat: ll.lat, lon: ll.lon, actors: e.from > 0 ? [e.from] : [], groupKey: 'prize',
      title: t('naval.alert.prize', { name: e.from > 0 ? hs.name(e.from) : '—', gold: formatNumber(e.gold), place: describeXY(view(), (e.tile % MAP_W) + 0.5, Math.floor(e.tile / MAP_W) + 0.5).text }),
    });
  });
}
