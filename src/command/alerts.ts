// FRONT ULTRA — command mode: incursion alerts (DESIGN_V2 §8.2 `incursionResponse`, §9.7.4; owner: W5-command-v2).
// The sim's borderIncursion events become located alerts for the human, in command mode and on the strategic map
// alike (a unit released inside foreign land keeps its incursion until it is out, so answers can come after exit).

import { HUMAN_ID } from '../shared/constants';
import type { GameContext } from '../shared/api';
import type { AlertInput } from '../shared/events';
import { tileToLatLon } from '../shared/geo';
import { playerName, t } from '../shared/i18n';
import { unitLabel } from '../ui/hud/news';

let wired = false;

export function wireIncursionAlerts(ctx: GameContext): void {
  if (wired) return;
  wired = true;
  ctx.bus.on('borderIncursion', (e) => {
    if (e.intruder !== HUMAN_ID) return;
    const view = ctx.sim.view;
    const p = view.players[e.victim];
    const nation = p ? playerName(p, ctx.world) : '—';
    const u = view.units.get(e.unitId);
    const unit = u ? unitLabel(u.type, u.serial).toLowerCase() : t(`command.kind.${e.kind}`).toLowerCase();
    const ll = tileToLatLon(e.tile);
    let input: AlertInput | null = null;
    const base = { lat: ll.lat, lon: ll.lon, actors: [e.victim], groupKey: `incursion:${e.unitId}:${e.victim}`, unitId: e.unitId };
    if (e.stage === 'entered') {
      input = { kind: 'incursionResponse', severity: 'info', title: t('alert.incursion.entered.title', { nation }), body: t('alert.incursion.entered.body', { nation, unit }), ...base, ttlSec: 25 };
    } else if (e.stage === 'response' && e.response) {
      const extra = e.escalated ? ` ${t('alert.incursion.escalated')}` : '';
      const min = Math.max(1, Math.round((e.etaSec ?? 600) / 60));
      input = {
        kind: 'incursionResponse', severity: e.response === 'war' ? 'critical' : e.response === 'intercept' ? 'danger' : 'warning',
        title: t(`alert.incursion.${e.response}.title`, { nation }),
        body: t(`alert.incursion.${e.response}.body`, { nation, unit, min }) + extra, ...base, ticker: e.response === 'war', ttlSec: 40,
      };
    } else if (e.stage === 'arrived') {
      input = { kind: 'incursionResponse', severity: 'warning', title: t('alert.incursion.arrived.title', { nation }), body: t('alert.incursion.arrived.body', { nation, unit }), ...base, ttlSec: 30 };
    }
    if (!input) return;
    if (ctx.ui.alert) ctx.ui.alert(input);
    else ctx.bus.emit('alert', { input });
  });
}
