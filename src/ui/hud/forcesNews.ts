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

  bus.on('orderAck', (e) => {
    if (e.owner !== HUMAN_ID || e.accepted.length || !e.errorKey) return;
    const u = view().units.get(e.unitIds[0]);
    bus.emit('toast', {
      text: t('alert.order.refused', { why: reasonText(hs, { key: e.errorKey, params: e.errorParams }) }) + (u ? ` (${unitLabel(u.type, u.serial)})` : ''),
      kind: 'warning', durationMs: 3500,
    });
  });
}
