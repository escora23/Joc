// FRONT ULTRA — alerts about our forces (DESIGN_V2 §7.4, §7.8, §8.2; owner: ui, W4): the result of a strike when the
// icon arrives, captured trade ships (ours or theirs), and a refused order with the sim's reason. W3's news.ts covers
// unitReady, airRaid and losses; this module adds what W4's events tell.

import type { AlertCenter } from './alerts';
import type { HudShared } from './shared';
import { unitLabel } from './news';
import { structId } from './forcesInfo';
import { reasonText } from './orderCtl';
import { describeXY } from '../places';
import { HUMAN_ID } from '../../shared/constants';
import { tileXYToLatLon } from '../../shared/geo';
import { formatNumber, t } from '../../shared/i18n';
import { UnitType } from '../../shared/types';

export function wireForcesNews(hs: HudShared, alerts: AlertCenter): void {
  const ctx = hs.ctx;
  const bus = ctx.bus;
  const view = () => ctx.sim.view;

  bus.on('strikeResult', (e) => {
    if (e.owner !== HUMAN_ID) return;
    const ll = tileXYToLatLon(e.x, e.y);
    const u = view().units.get(e.unitId);
    const unit = unitLabel(e.unit, u?.serial ?? 0);
    let what: string;
    if (e.kind === 'structure' && e.structure >= 0) {
      const s = t(`structure.${structId(e.structure)}`);
      what = e.destroyed ? t('alert.strike.destroyed', { s }) : t('alert.strike.structure', { s, dmg: `−${formatNumber(e.damage, 2)}` });
    } else if (e.kind === 'division' || e.kind === 'ship') what = t('alert.strike.division', { p: Math.round(e.damage * 100) });
    else if (e.kind === 'front') what = t('alert.strike.front', { n: formatNumber(Math.round(e.damage)) });
    else what = t('alert.strike.none');
    alerts.raise({
      kind: 'strikeResult', severity: 'info', icon: e.unit === UnitType.DroneSwarm ? 'droneSwarm' : 'bomber', lat: ll.lat, lon: ll.lon,
      actors: e.victim > 0 ? [e.victim] : [], groupKey: `strike:${e.unitId}`, unitId: e.unit === UnitType.DroneSwarm ? undefined : e.unitId,
      title: t('alert.strike.result', { unit, what }), body: describeXY(view(), e.x, e.y).text,
    });
  });

  // Captured trade ships: owner item 30's navalNews.ts (shipStopped) reports them with the rest of the war at sea.

  // Gauntlet round 1: the refusals of one order fold into ONE line. A click sends one command per (order, target)
  // group, and a box of units may answer with several acks in the same tick: they are gathered for 250 ms and told
  // once («Orden rechazada para 5 unidades: Las divisiones no navegan…»), on the order chip at the cursor while it is
  // shown (the units are still selected), else as one grouped alert entry that a repeat updates (×n) instead of
  // stacking a card per unit.
  let fold: { refused: number; total: number; why: string; timer: number } | null = null;
  const flush = () => {
    const f = fold;
    fold = null;
    if (!f || f.refused <= 0) return;
    const text = f.refused === f.total
      ? (f.total > 1 ? t('g1.order.refusedAll', { n: f.total, why: f.why }) : t('alert.order.refused', { why: f.why }))
      : t('g1.order.refusedSome', { n: f.refused, m: f.total, why: f.why });
    hs.orderNote = { text, bad: f.refused === f.total, until: performance.now() + 4500 };
    const chipShown = !!document.querySelector('.fu-cursor-layer .fu-chip:not(.fu-hidden)');
    if (chipShown) return;
    alerts.raise({ kind: 'notice', severity: f.refused === f.total ? 'warning' : 'info', icon: 'warning', groupKey: 'order:refused', ttlSec: 7, title: text });
  };
  bus.on('orderAck', (e) => {
    if (e.owner !== HUMAN_ID) return;
    const key = e.accepted.length ? e.refusedKey : e.errorKey;
    const refused = e.unitIds.length - e.accepted.length;
    if (!fold) fold = { refused: 0, total: 0, why: '', timer: window.setTimeout(flush, 250) };
    fold.total += e.unitIds.length;
    if (refused > 0 && key) {
      fold.refused += refused;
      if (!fold.why) fold.why = reasonText(hs, { key, params: e.accepted.length ? e.refusedParams : e.errorParams });
    }
  });
}
