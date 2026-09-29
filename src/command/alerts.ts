// FRONT ULTRA — command mode: incursion alerts (DESIGN_V2 §8.2 `incursionResponse`, §9.7.4; owner: W5-command-v2).
// The sim's borderIncursion events become located alerts for the human, in command mode and on the strategic map
// alike (a unit released inside foreign land stays there and keeps its incursion until it is out, so the warning,
// the interception, the last warning and the fire can all come after exit — owner feedback #18/#19).

import { HUMAN_ID } from '../shared/constants';
import type { GameContext } from '../shared/api';
import type { AlertInput } from '../shared/events';
import { tileToLatLon, tileXYToLatLon } from '../shared/geo';
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

/** Units of the human released inside foreign land whose incursion is still running (the «sigue dentro» row). */
const held = new Map<number, number>();

const isControlled = (ctx: GameContext, unitId: number): boolean => (ctx.sim.view.command?.controlled ?? []).some((c) => c.unitId === unitId);

function raiseAlert(ctx: GameContext, input: AlertInput): void {
  if (ctx.ui.alert) ctx.ui.alert(input);
  else ctx.bus.emit('alert', { input });
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
    const ll = u ? tileXYToLatLon(u.x, u.y) : tileToLatLon(e.tile);
    // Released inside (owner feedback #18): on the map a whole incursion takes game minutes, so every escalation is a
    // crisis that pauses (setting «Tu unidad dentro de otra nación») and says how to get the unit out.
    const released = !isControlled(ctx, e.unitId);
    const groupKey = `incursion:${e.unitId}:${e.victim}`;
    if (e.stage === 'left') {
      ctx.bus.emit('alertResolve', { groupKey });
      ctx.bus.emit('alertResolve', { groupKey: `held:${e.unitId}` });
      const wasHeld = held.delete(e.unitId);
      const alive = !!u && u.hp > 0;
      if (wasHeld && alive && view.pairState(HUMAN_ID, e.victim) !== 'war') {
        raiseAlert(ctx, { kind: 'incursionResponse', severity: 'info', title: t('alert.incursion.out.title', { nation, unit }), body: t('alert.incursion.out.body', { nation }), lat: ll.lat, lon: ll.lon, actors: [e.victim], groupKey, unitId: e.unitId, ttlSec: 20 });
      }
      return;
    }
    let input: AlertInput | null = null;
    const base = { lat: ll.lat, lon: ll.lon, actors: [e.victim], groupKey, unitId: e.unitId };
    const orderOut = released ? ` ${t('alert.incursion.orderOut', { unit })}` : '';
    if (e.stage === 'entered') {
      const body = t('alert.incursion.entered.body', { nation, unit, t: fmtDur(e.graceSec ?? 30) }) + (e.nearCapital ? ` ${t('alert.incursion.enteredCapital')}` : '');
      input = { kind: 'incursionResponse', severity: 'warning', title: t('alert.incursion.entered.title', { nation }), body, ...base, ttlSec: 40 };
    } else if (e.stage === 'response' && e.response) {
      const extra = e.escalated ? ` ${t('alert.incursion.escalated')}` : '';
      let body: string;
      if (e.response === 'intercept') body = t(`alert.incursion.intercept.body.${e.qrfMode ?? 'ground'}`, { nation, unit, t: fmtDur(e.etaSec ?? 120) });
      else if (e.response === 'protest') body = e.deadlineSec ? t('alert.incursion.protestStay.body', { nation, unit, t: fmtDur(e.deadlineSec) }) : t('alert.incursion.protest.body', { nation, unit });
      else body = t(`alert.incursion.${e.response}.body`, { nation, unit });
      const fire = e.response === 'war' || e.response === 'engage';
      input = {
        kind: 'incursionResponse',
        severity: fire ? 'critical' : e.response === 'intercept' ? 'danger' : 'info',
        title: t(`alert.incursion.${e.response}.title`, { nation, unit }), body: body + extra + (e.response === 'engage' ? orderOut : ''), ...base, ticker: e.response === 'war', ttlSec: 45,
        ...(released && e.response === 'engage' ? { autoPause: 'incursion' as const } : {}),
      };
      if (released && held.has(e.unitId) && fire) heldAlert(ctx, e.unitId, e.victim, e.response);
    } else if (e.stage === 'arrived') {
      input = {
        kind: 'incursionResponse', severity: released ? 'critical' : 'danger', title: t('alert.incursion.arrived.title', { nation }),
        body: t('alert.incursion.arrived.body', { nation, unit, t: fmtDur(e.deadlineSec ?? 60) }) + orderOut, ...base, ttlSec: 45,
        ...(released ? { autoPause: 'incursion' as const } : {}),
      };
    }
    if (input) raiseAlert(ctx, input);
  });
  // After the exit (the map is live again, so the pause can hold it): the unit left inside says so and pauses.
  ctx.bus.on('commandExit', (e) => {
    const r = e.result;
    if (r.unitLost) return;
    const inc = [...(ctx.sim.view.command?.incursions ?? [])].filter((i) => i.unitId === r.unitId && !i.left).sort((a, b) => b.id - a.id)[0];
    if (!inc) return;
    held.set(r.unitId, inc.victim);
    heldAlert(ctx, r.unitId, inc.victim, inc.response);
  });
}

/**
 * The «Tu … sigue dentro de …» row of a unit released inside foreign land (#18): critical (it stays until the unit is
 * out or lost), pauses once on release, and its body follows the victim's reaction; resolved when the incursion ends.
 */
function heldAlert(ctx: GameContext, unitId: number, victim: number, response: string): void {
  const view = ctx.sim.view;
  const p = view.players[victim];
  const nation = p ? playerName(p, ctx.world) : '—';
  const u = view.units.get(unitId);
  const unit = u ? unitLabel(u.type, u.serial).toLowerCase() : '';
  const ll = u ? tileXYToLatLon(u.x, u.y) : { lat: 0, lon: 0 };
  const body = response === 'war' ? t('alert.incursion.released.bodyWar', { nation, unit })
    : response === 'engage' ? t('alert.incursion.released.bodyFire', { nation, unit })
      : t('alert.incursion.released.body', { nation, unit });
  raiseAlert(ctx, {
    kind: 'incursionHeld', severity: 'critical', title: t('alert.incursion.released.title', { nation, unit }), body,
    lat: ll.lat, lon: ll.lon, actors: [victim], groupKey: `held:${unitId}`, unitId, autoPause: 'incursion',
  });
}
