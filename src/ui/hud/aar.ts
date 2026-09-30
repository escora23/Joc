// FRONT ULTRA — after-action reports and damage reports (owner feedback #3, items 27 and 29d; owner: ui).
//
// When an offensive, a strike or a unit's mission ends, the sim sends `afterAction` with its result and numbers; this
// module turns it into one alert (feed + REGISTRO log, clickable: the camera flies to the place; a unit's report
// selects the unit): the result in words, ground gained / lost, losses on both sides and the damage done.
// Structure damage (`structureDamaged`) is reported when it matters: one of ours changed damage state, lost a level or
// was destroyed (with the civilians and troops killed in a city), or the player's own weapons did it to an enemy.
// Debug hook: window.__fuAar (the last reports as text).

import type { AlertCenter } from './alerts';
import type { HudShared } from './shared';
import { unitLabel } from './news';
import { stationOrder, structId, structureName } from './forcesInfo';
import { troopsText } from './frontsInfo';
import { describeXY } from '../places';
import { HUMAN_ID, MAP_W } from '../../shared/constants';
import { DAMAGE_IDS, damageState, functionFactor } from '../../shared/damage';
import { tileXYToLatLon } from '../../shared/geo';
import { formatNumber, t, tn } from '../../shared/i18n';
import type { SimEventMap } from '../../shared/protocol';
import { UnitMode, UnitState, UnitType, type UnitView } from '../../shared/types';

type Aar = SimEventMap['afterAction'];

export interface AarLog {
  text: string;
  kind: string;
  result: string;
  tick: number;
}

const UNIT_ID: Record<number, string> = {
  [UnitType.ArmoredDivision]: 'armoredDivision', [UnitType.FighterSquadron]: 'fighterSquadron', [UnitType.Bomber]: 'bomber',
  [UnitType.DroneSwarm]: 'droneSwarm', [UnitType.Warship]: 'warship',
};

/** An own combat unit with nothing to do (the same rule as the Fuerzas panel's advisor). */
function isIdleForce(u: UnitView): boolean {
  if (u.state === UnitState.Controlled || u.state === UnitState.Destroyed) return false;
  if (u.type === UnitType.ArmoredDivision || u.type === UnitType.Warship) return u.mode === UnitMode.Idle && u.order < 0;
  if (u.type === UnitType.FighterSquadron || u.type === UnitType.Bomber || u.type === UnitType.DroneSwarm) return u.mode === UnitMode.Docked && !stationOrder(u);
  return false;
}

export function wireAfterAction(hs: HudShared, alerts: AlertCenter): void {
  const ctx = hs.ctx;
  const bus = ctx.bus;
  const view = () => ctx.sim.view;
  const log: AarLog[] = [];
  (window as unknown as { __fuAar?: unknown }).__fuAar = { log: () => log.slice(), last: () => log[log.length - 1] ?? null };

  const duration = (e: Aar): string => {
    const h = Math.max(0, (e.tick - e.startTick) / 10);
    return h >= 24 ? t('aar.days', { n: formatNumber(h / 24, 1) }) : t('aar.hours', { n: formatNumber(h, h < 10 ? 1 : 0) });
  };
  const where = (x: number, y: number) => describeXY(view(), x, y).text;

  bus.on('afterAction', (e) => {
    const ll = tileXYToLatLon(e.x, e.y);
    const ours = e.owner === HUMAN_ID;
    const enemy = ours ? e.enemy : e.owner;
    let title = '', body = '', severity: 'info' | 'warning' | 'danger' = 'info', icon = 'attack', unitId: number | undefined;
    let groupKey = `aar:${e.kind}:${e.attackId ?? e.unitId ?? e.tick}`;
    if (e.kind === 'offensive') {
      // Ours: won / held / failed / cancelled. Theirs against us: the same words from our side.
      const res = ours ? e.result : e.result === 'won' ? 'theyWon' : e.result === 'held' ? 'theyHeld' : 'weHeld';
      title = t(`aar.off.${res}`, { name: hs.name(enemy), place: where(e.x, e.y) });
      const km2 = Math.round(e.tilesTaken * 25 * 25 / 100) * 100;
      body = t('aar.off.body', {
        time: duration(e), taken: formatNumber(e.tilesTaken), km2: formatNumber(km2), lost: formatNumber(e.tilesLost),
        own: troopsText(ours ? e.lossesOwn : e.lossesEnemy), their: troopsText(ours ? e.lossesEnemy : e.lossesOwn),
      });
      if (ours && e.units?.length) body += ` ${t('aar.off.support', { n: e.units.length })}`;
      severity = ours ? (e.result === 'failed' ? 'warning' : 'info') : e.result === 'won' || e.result === 'held' ? 'danger' : 'info';
      icon = 'swords';
    } else if (e.kind === 'strike') {
      if (!ours) return; // the victim hears of it through the raid alert and the damage report
      const unit = unitLabel(e.unitType ?? UnitType.Bomber, view().units.get(e.unitId ?? 0)?.serial ?? 0);
      groupKey = `strike:${e.unitId}`;
      if (e.result === 'lost') {
        title = t('aar.strike.lost', { unit, name: hs.name(enemy) });
        severity = 'warning';
      } else {
        const s = e.structure !== undefined && e.structure >= 0 ? t(`structure.${structId(e.structure)}`) : '';
        title = e.result === 'destroyed' ? t('aar.strike.destroyed', { unit, s }) : s ? t('aar.strike.hit', { unit, s, dmg: Math.round((e.damage ?? 0) * 100) })
          : t('aar.strike.front', { unit, n: formatNumber(Math.round(e.lossesEnemy)) });
      }
      body = t('aar.strike.body', { place: where(e.x, e.y), own: e.lossesOwn, time: duration(e) });
      icon = e.unitType === UnitType.DroneSwarm ? 'droneSwarm' : 'bomber';
      unitId = e.result === 'lost' ? undefined : e.unitId;
    } else {
      const unit = unitLabel(e.unitType ?? UnitType.ArmoredDivision, view().units.get(e.unitId ?? 0)?.serial ?? 0);
      const s = e.structure !== undefined && e.structure >= 0 ? t(`structure.${structId(e.structure)}`) : t('fstate.target');
      if (!ours) {
        if (e.result !== 'captured' && e.result !== 'razed' && e.result !== 'destroyed') return;
        title = t(`aar.mission.enemy.${e.result}`, { name: hs.name(e.owner), s, place: where(e.x, e.y) });
        severity = 'danger';
      } else title = t(`aar.mission.${e.result}`, { unit, s, place: where(e.x, e.y) });
      body = t('aar.mission.body', { time: duration(e), dmg: Math.round((e.damage ?? 0) * 100), own: e.lossesOwn });
      if (ours && e.result === 'lost') severity = 'warning';
      icon = 'armoredDivision';
      unitId = ours && e.result !== 'lost' ? e.unitId : undefined;
    }
    const text = `${title} — ${body}`;
    log.push({ text, kind: e.kind, result: e.result, tick: e.tick });
    if (log.length > 60) log.shift();
    alerts.raise({
      kind: 'afterAction', severity, icon, lat: ll.lat, lon: ll.lon, actors: enemy > 0 ? [enemy] : [], groupKey, unitId,
      title, body: `${t('aar.kicker')} · ${body}`, ttlSec: 30,
    });
  });

  // ---- structure damage ---------------------------------------------------------------------------------------------
  bus.on('structureDamaged', (e) => {
    const ours = e.owner === HUMAN_ID, byUs = e.by === HUMAN_ID;
    if (!ours && !byUs) return;
    const changed = e.levelLost || e.destroyed || e.state !== damageState(e.hpBefore);
    if (!changed && !(ours && e.civilians > 0 && e.cause !== 'naval')) return;
    const x = (e.tile % MAP_W) + 0.5, y = Math.floor(e.tile / MAP_W) + 0.5;
    const ll = tileXYToLatLon(x, y);
    const st = view().structures.get(e.structureId);
    const name = st ? structureName(hs, st) : t('structure.named', { s: t(`structure.${structId(e.structure)}`), place: describeXY(view(), x, y).name });
    const stateTxt = e.destroyed ? t(e.cause === 'raze' ? 'aar.dmg.razed' : 'aar.dmg.rubble') : e.levelLost ? t('aar.dmg.levelLost', { n: e.level }) : t(`card.dmg.${DAMAGE_IDS[e.state]}`).toLocaleLowerCase();
    const fn = e.destroyed ? 0 : functionFactor(e.hp);
    let body = e.destroyed ? '' : t('card.dmg.fn', { p: Math.round(fn * 100) });
    if (e.civilians > 0 || e.troops > 0) body = `${t('aar.dmg.losses', { civ: formatNumber(Math.round(e.civilians / 100) * 100), troops: formatNumber(Math.round(e.troops / 10) * 10) })}${body ? ` · ${body}` : ''}`;
    if (ours && !e.destroyed) body += ` · ${t('aar.dmg.repair')}`;
    alerts.raise({
      kind: 'structureDamaged', severity: ours ? (e.destroyed || e.levelLost ? 'danger' : 'warning') : 'info', icon: 'demolish',
      lat: ll.lat, lon: ll.lon, actors: [ours ? e.by : e.owner].filter((p) => p > 0), groupKey: `dmg:${e.structureId}`,
      title: t(ours ? `aar.dmg.ours.${e.cause === 'command' ? 'command' : 'strike'}` : 'aar.dmg.theirs', { s: name, state: stateTxt, name: hs.name(ours ? e.by : e.owner) }),
      body,
    });
  });

  // ---- the operations advisor (29c): idle units during a war, at most every 12 game hours --------------------------
  let lastIdleTick = -1_000_000;
  bus.on('simTick', () => {
    const v = view();
    if (v.tick - lastIdleTick < 120) return;
    if (!v.wars.some((w) => w.aggressor === HUMAN_ID || w.target === HUMAN_ID)) return;
    const idle = [...v.units.values()].filter((u) => u.owner === HUMAN_ID && isIdleForce(u));
    if (!idle.length) return;
    lastIdleTick = v.tick;
    const n = new Map<number, number>();
    for (const u of idle) n.set(u.type, (n.get(u.type) ?? 0) + 1);
    const parts = [...n].map(([type, k]) => tn(`adv.idle.${UNIT_ID[type] ?? 'armoredDivision'}`, k));
    const ll = tileXYToLatLon(idle[0].x, idle[0].y);
    alerts.raise({
      kind: 'advisorIdle', severity: 'info', icon: 'info', lat: ll.lat, lon: ll.lon, groupKey: 'advisor:idle', unitId: idle[0].id,
      title: t('adv.alert', { list: parts.join(', ') }), body: t('adv.alert.body'), ttlSec: 25,
    });
  });

  bus.on('structureRepaired', (e) => {
    if (e.owner !== HUMAN_ID) return;
    const x = (e.tile % MAP_W) + 0.5, y = Math.floor(e.tile / MAP_W) + 0.5;
    const ll = tileXYToLatLon(x, y);
    const st = view().structures.get(e.structureId);
    alerts.raise({
      kind: 'structureRepaired', severity: 'info', icon: 'upgrade', lat: ll.lat, lon: ll.lon, groupKey: `dmg:${e.structureId}`,
      title: t('aar.repaired', { s: st ? structureName(hs, st) : t(`structure.${structId(e.structure)}`) }), ttlSec: 12,
    });
  });
}
