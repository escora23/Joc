// FRONT ULTRA — command mode: incursion alerts (DESIGN_V2 §8.2 `incursionResponse`, §9.7.4; owner: W5-command-v2).
// The sim's borderIncursion events become located alerts for the human, in command mode and on the strategic map
// alike (a unit released inside foreign land stays there and keeps its incursion until it is out, so the warning,
// the interception, the last warning and the fire can all come after exit — owner feedback #18/#19).

import { HUMAN_ID } from '../shared/constants';
import type { GameContext } from '../shared/api';
import type { AlertInput } from '../shared/events';
import { tileToLatLon } from '../shared/geo';
import { playerName, t } from '../shared/i18n';
import { unitLabel } from '../ui/hud/news';

let wired = false;

/** «25 s», «4 min», «1 min 30 s» for a span of game seconds (= real seconds at ×1). */
export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 90) return t('command.dur.s', { n: s });
  if (s % 60 === 0 || s >= 600) return t('command.dur.min', { n: Math.round(s / 60) });
  return t('command.dur.ms', { m: Math.floor(s / 60), s: String(s % 60).padStart(2, '0') });
}

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
      const body = t('alert.incursion.entered.body', { nation, unit, t: fmtDur(e.graceSec ?? 30) }) + (e.nearCapital ? ` ${t('alert.incursion.enteredCapital')}` : '');
      input = { kind: 'incursionResponse', severity: 'warning', title: t('alert.incursion.entered.title', { nation }), body, ...base, ttlSec: 40 };
    } else if (e.stage === 'response' && e.response) {
      const extra = e.escalated ? ` ${t('alert.incursion.escalated')}` : '';
      let body: string;
      if (e.response === 'intercept') body = t(`alert.incursion.intercept.body.${e.qrfMode ?? 'ground'}`, { nation, unit, t: fmtDur(e.etaSec ?? 120) });
      else if (e.response === 'protest') body = e.deadlineSec ? t('alert.incursion.protestStay.body', { nation, unit, t: fmtDur(e.deadlineSec) }) : t('alert.incursion.protest.body', { nation, unit });
      else body = t(`alert.incursion.${e.response}.body`, { nation, unit });
      input = {
        kind: 'incursionResponse',
        severity: e.response === 'war' || e.response === 'engage' ? 'critical' : e.response === 'intercept' ? 'danger' : 'info',
        title: t(`alert.incursion.${e.response}.title`, { nation, unit }), body: body + extra, ...base, ticker: e.response === 'war', ttlSec: 45,
      };
    } else if (e.stage === 'arrived') {
      input = {
        kind: 'incursionResponse', severity: 'danger', title: t('alert.incursion.arrived.title', { nation }),
        body: t('alert.incursion.arrived.body', { nation, unit, t: fmtDur(e.deadlineSec ?? 60) }), ...base, ttlSec: 45,
      };
    }
    if (!input) return;
    if (ctx.ui.alert) ctx.ui.alert(input);
    else ctx.bus.emit('alert', { input });
  });
}

/** Leaving command mode with the unit inside foreign land: say it stays there and the incursion goes on (#18). */
export function releasedInsideAlert(ctx: GameContext, unitId: number, victim: number, lat: number, lon: number): void {
  const view = ctx.sim.view;
  const p = view.players[victim];
  const nation = p ? playerName(p, ctx.world) : '—';
  const u = view.units.get(unitId);
  const unit = u ? unitLabel(u.type, u.serial).toLowerCase() : '';
  const input: AlertInput = {
    kind: 'incursionResponse', severity: 'warning', title: t('alert.incursion.released.title', { nation, unit }),
    body: t('alert.incursion.released.body', { nation, unit }), lat, lon, actors: [victim], groupKey: `incursion:${unitId}:${victim}`, unitId, ttlSec: 40,
  };
  if (ctx.ui.alert) ctx.ui.alert(input);
  else ctx.bus.emit('alert', { input });
}
