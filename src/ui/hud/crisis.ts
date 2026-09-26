// FRONT ULTRA — the one crisis component (DESIGN_V2 §2.2, §8.2; owner: ui, built by W3). Replaces the v1 nuke banner.
//
// While any nuclear weapon flies the world runs on crisis time (1 s = 1 min, decided by the worker). This component is
// the only place the crisis is shown:
//   * AMBER banner under the top bar for a foreign launch: «TIEMPO DE CRISIS · Rusia → Japón · impacto en 0:21»;
//   * RED nuclear alarm (v1's styling: stripes, blinking frame, the siren) when the target is the human's land or an
//     ally's, listing every weapon in flight with its own countdown.
// Countdowns are real seconds at the clock now running (remaining game time / the clock rate), frozen while paused.

import { h, setText, toggleClass } from '../dom';
import { icon, UNIT_ICON } from '../icons';
import { describeTile } from '../places';
import { tip } from '../tooltip';
import { tx } from '../tx';
import type { AlertCenter } from './alerts';
import type { HudShared } from './shared';
import { GAME_SECONDS_PER_TICK, HUMAN_ID, MAP_W, UNIT_DEFS } from '../../shared/constants';
import { tileToLatLon } from '../../shared/geo';
import { t } from '../../shared/i18n';
import { UnitType } from '../../shared/types';

interface Flight {
  unitId: number;
  weapon: UnitType;
  owner: number;
  fromTile: number;
  targetTile: number;
  arriveTick: number;
  alerted: boolean;
}

export interface Crisis {
  el: HTMLElement;
  edge: HTMLElement;
  update(): void;
  clear(): void;
  /** Debug: the flights shown. */
  flights(): Flight[];
}

const NUCLEAR = new Set<number>([UnitType.AtomBomb, UnitType.HydrogenBomb, UnitType.Mirv, UnitType.MirvWarhead]);

function mmss(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function createCrisis(hs: HudShared, alerts: AlertCenter): Crisis {
  const ctx = hs.ctx;
  const view = () => ctx.sim.view;
  const title = h('div', { class: 'fu-crisis-title' });
  const sub = h('div', { class: 'fu-crisis-sub' });
  const count = h('div', { class: 'fu-crisis-count fu-mono' });
  const rows = h('div', { class: 'fu-crisis-rows' });
  const ico = h('div', { class: 'fu-crisis-ico' }, icon('radiation'));
  const el = h('div', { class: 'fu-crisis fu-interactive fu-hidden' },
    h('div', { class: 'fu-crisis-stripes' }),
    h('div', { class: 'fu-crisis-head' }, ico, h('div', { class: 'fu-crisis-body' }, title, sub), h('div', { class: 'fu-crisis-eta' }, tx('crisis.impact', undefined, 'small'), count)),
    rows,
  );
  const edge = h('div', { class: 'fu-alarm-edge fu-hidden' });
  tip(el, () => ({ title: t(red ? 'crisis.red.tipTitle' : 'crisis.amber.tipTitle'), text: t('crisis.tip'), lines: [t('crisis.tip.setting')] }));
  const flights = new Map<number, Flight>();
  let red = false, active = false;

  const nameOf = (id: number) => (id === HUMAN_ID ? t('news.you') : hs.name(id) || t('news.rebels'));
  const isMineOrAlly = (tile: number) => {
    const o = view().owner[tile] ?? 0;
    return o === HUMAN_ID || (o > 0 && hs.isAlly(o));
  };
  const secondsLeft = (f: Flight) => {
    const v = view();
    const rate = v.speed === 0 ? 0 : v.clock.rate;
    const tickNow = ctx.frame.gameHours * 10;
    const gameSec = Math.max(0, (f.arriveTick - tickNow) * GAME_SECONDS_PER_TICK);
    return rate > 0 ? gameSec / rate : gameSec / 60;
  };

  ctx.bus.on('nukeLaunched', (e) => {
    if (!NUCLEAR.has(e.weapon)) return;
    flights.set(e.unitId, { unitId: e.unitId, weapon: e.weapon, owner: e.owner, fromTile: e.fromTile, targetTile: e.targetTile, arriveTick: e.tick + e.flightTicks, alerted: false });
    // An ally's land as the target: the siren too (the client raises it itself for the human's land).
    const o = view().owner[e.targetTile] ?? 0;
    if (o !== HUMAN_ID && o > 0 && hs.isAlly(o) && e.owner !== HUMAN_ID) {
      const f = flights.get(e.unitId)!;
      ctx.bus.emit('nukeAlarm', { unitId: e.unitId, targetTile: e.targetTile, etaSec: secondsLeft(f), weapon: e.weapon });
    }
  });
  const drop = (id: number) => flights.delete(id);
  ctx.bus.on('nukeDetonated', (e) => drop(e.unitId));
  ctx.bus.on('nukeIntercepted', (e) => drop(e.unitId));
  ctx.bus.on('gameTornDown', () => flights.clear());

  el.addEventListener('click', () => {
    const f = [...flights.values()].sort((a, b) => a.arriveTick - b.arriveTick)[0];
    if (!f) return;
    const ll = tileToLatLon(f.targetTile);
    hs.sound('click');
    ctx.bus.emit('focusRequest', { lat: ll.lat, lon: ll.lon, altitudeKm: 2500, durationMs: 1000 });
  });

  function update(): void {
    const v = view();
    for (const f of [...flights.values()]) {
      if (!v.units.has(f.unitId) && v.tick > f.arriveTick + 5) flights.delete(f.unitId);
      else if (v.tick > f.arriveTick + 60) flights.delete(f.unitId);
    }
    const list = [...flights.values()].sort((a, b) => a.arriveTick - b.arriveTick);
    const nowActive = list.length > 0;
    const nowRed = list.some((f) => isMineOrAlly(f.targetTile));
    if (nowActive !== active || nowRed !== red) {
      active = nowActive;
      red = nowRed;
      ctx.bus.emit('crisis', { active, red, secondsLeft: list[0] ? secondsLeft(list[0]) : 0 });
    }
    toggleClass(el, 'fu-hidden', !active);
    toggleClass(edge, 'fu-hidden', !red);
    if (!active) return;
    toggleClass(el, 'is-red', red);
    // The located critical alert for each weapon aimed at the human's land (auto-pause «Lanzamiento nuclear contra ti»).
    for (const f of list) {
      if (f.alerted || f.owner === HUMAN_ID) continue;
      f.alerted = true;
      const o = v.owner[f.targetTile] ?? 0;
      if (o !== HUMAN_ID && !(o > 0 && hs.isAlly(o))) continue;
      const ll = tileToLatLon(f.targetTile);
      const place = describeTile(v, f.targetTile).name;
      alerts.raise({
        kind: 'nukeAtYou', severity: 'critical', icon: UNIT_ICON[f.weapon] ?? 'radiation', lat: ll.lat, lon: ll.lon, actors: [f.owner],
        title: t(o === HUMAN_ID ? 'alert.nukeAtYou.title' : 'alert.nukeAtAlly.title', { place }),
        body: t('alert.nukeAtYou.body', { name: nameOf(f.owner), w: t(`unit.${UNIT_DEFS[f.weapon].id}`), ally: o === HUMAN_ID ? '' : nameOf(o), secs: mmss(secondsLeft(f)) }),
        autoPause: o === HUMAN_ID ? 'nukeAtYou' : undefined, groupKey: `nuke:${f.unitId}`,
      });
    }
    const first = list.find((f) => isMineOrAlly(f.targetTile)) ?? list[0];
    const tgtOwner = v.owner[first.targetTile] ?? 0;
    const place = describeTile(v, first.targetTile).name;
    if (red) {
      setText(title, t('crisis.red.title'));
      setText(sub, t('crisis.red.sub', { w: t(`unit.${UNIT_DEFS[first.weapon].id}`), place, name: nameOf(first.owner) }));
    } else {
      setText(title, t('crisis.amber.title'));
      setText(sub, t('crisis.amber.sub', { a: nameOf(first.owner), b: tgtOwner ? nameOf(tgtOwner) : place }));
    }
    setText(count, mmss(secondsLeft(first)));
    ico.replaceChildren(icon(UNIT_ICON[first.weapon] ?? 'radiation'));
    // Red: every weapon in flight with its own countdown.
    if (red && list.length > 1) {
      rows.classList.remove('fu-hidden');
      const want = list.slice(0, 6);
      while (rows.children.length > want.length) rows.lastElementChild!.remove();
      want.forEach((f, i) => {
        let r = rows.children[i] as HTMLElement | undefined;
        if (!r) {
          r = h('div', { class: 'fu-crisis-row' }, h('span'), h('b', { class: 'fu-mono' }));
          rows.append(r);
        }
        const tgt = v.owner[f.targetTile] ?? 0;
        setText(r.children[0] as HTMLElement, t('crisis.row', { w: t(`unit.${UNIT_DEFS[f.weapon].id}`), a: nameOf(f.owner), place: describeTile(v, f.targetTile).name, b: tgt ? nameOf(tgt) : '' }));
        setText(r.children[1] as HTMLElement, mmss(secondsLeft(f)));
        toggleClass(r, 'is-mine', isMineOrAlly(f.targetTile));
      });
    } else rows.classList.add('fu-hidden');
    void MAP_W;
  }

  (window as unknown as { __fuCrisis?: unknown }).__fuCrisis = () => ({ active, red, text: el.classList.contains('fu-hidden') ? '' : el.innerText, n: flights.size, v1Banner: !!document.querySelector('.fu-alarm:not(.fu-hidden)') });

  return {
    el, edge, update,
    clear() {
      flights.clear();
      el.classList.add('fu-hidden');
      edge.classList.add('fu-hidden');
      active = red = false;
    },
    flights: () => [...flights.values()],
  };
}
