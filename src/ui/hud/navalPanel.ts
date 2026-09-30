// FRONT ULTRA — «Mar», the naval tab of the Guerra y frentes panel (owner item 30; owner: ui).
//
//   * the ledger: trade we lose to blockades per hour (and in total), the seized cargo we gain, our merchants on a
//     detour and our ports without a way out;
//   * OUR BLOCKADES: where, whom they stop, in force or on the way, what they took (gold per hour, the enemy's trade
//     cut, troops denied, ships stopped) and what it cost with each nation (piracy: opinion now, casus belli). Buttons:
//     Ir, Cambiar (the blockade dialog again), Levantar;
//   * BLOCKADES AGAINST US: who closes what, what it costs us; Romper el bloqueo (our free warships attack its ships:
//     at war only), Escoltar mercantes (free warships escort our merchants that sail through it);
//   * CLOSE A STRAIT: the world's chokepoints with the ships that pass them now; «Cerrar» picks our nearest free
//     warships and opens the blockade dialog there.

import { h } from '../dom';
import { icon } from '../icons';
import { tip } from '../tooltip';
import { tx } from '../tx';
import { hexToCss } from '../../shared/color';
import { HUMAN_ID, MAP_W } from '../../shared/constants';
import { tileXYToLatLon } from '../../shared/geo';
import { formatNumber, t } from '../../shared/i18n';
import { CHOKEPOINTS, chokepointTile, zoneDist2, type BlockadeView } from '../../shared/naval';
import { UnitMode, UnitType, type UnitView } from '../../shared/types';
import { openBlockadeDialog } from './blockade';
import { unitName } from './forcesInfo';
import { blockadePlace, blockadesAgainstHuman, gold, shipsThrough, specText, stopsText } from './navalInfo';
import type { HudShared } from './shared';

/** Our warships free for a new job (not holding a blockade, not escorting, not in a fight). */
export function freeWarships(hs: HudShared): UnitView[] {
  const out: UnitView[] = [];
  for (const u of hs.ctx.sim.view.units.values()) {
    if (u.owner !== HUMAN_ID || u.type !== UnitType.Warship) continue;
    if (u.mode === UnitMode.Blockade || u.mode === UnitMode.Escort || u.mode === UnitMode.Engaged || u.mode === UnitMode.Bombard) continue;
    out.push(u);
  }
  return out;
}

function nearest(list: UnitView[], x: number, y: number, n: number): UnitView[] {
  return [...list].sort((a, b) => zoneDist2(x, y, a.x, a.y) - zoneDist2(x, y, b.x, b.y)).slice(0, n);
}

const tileOf = (x: number, y: number) => Math.max(0, Math.min(799, Math.floor(y))) * MAP_W + ((Math.floor(x) % MAP_W) + MAP_W) % MAP_W;

export interface SeaTab {
  el: HTMLElement;
  update(): void;
}

export function createSeaTab(hs: HudShared): SeaTab {
  const ctx = hs.ctx;
  const view = () => ctx.sim.view;
  const ledger = h('div', { class: 'fu-sea-ledger' });
  const mine = h('div', { class: 'fu-sea-list' });
  const theirs = h('div', { class: 'fu-sea-list' });
  const straits = h('div', { class: 'fu-sea-list' });
  const el = h('div', { class: 'fu-sea' },
    ledger,
    h('div', { class: 'fu-caps fu-sea-title' }, tx('naval.tab.mine')), mine,
    h('div', { class: 'fu-caps fu-sea-title' }, tx('naval.tab.against')), theirs,
    h('div', { class: 'fu-caps fu-sea-title' }, tx('naval.tab.straits')), h('div', { class: 'fu-war-note' }, tx('naval.tab.straits.help')), straits,
  );
  let acc = 1e9;
  let lastKey = '';

  function fly(x: number, y: number, alt = 1400): void {
    const ll = tileXYToLatLon(x, y);
    ctx.bus.emit('focusRequest', { lat: ll.lat, lon: ll.lon, altitudeKm: alt, durationMs: 1300 });
  }
  const btn = (label: string, ic: string, cls: string, fn: () => void, tipText?: () => { title: string; text: string }) => {
    const b = h('button', { class: `fu-btn fu-btn--sm ${cls}` }, icon(ic as never), h('span', null, label)) as HTMLButtonElement;
    b.addEventListener('click', () => {
      hs.sound('click');
      fn();
    });
    if (tipText) tip(b, tipText);
    return b;
  };

  function stateText(b: BlockadeView): string {
    if (b.endTick) return t('naval.state.ended');
    if (b.active) return t('naval.state.active', { n: b.onStation, total: b.warships.length });
    return t('naval.state.onWay', { n: b.warships.length });
  }

  function consequences(b: BlockadeView): HTMLElement {
    const box = h('div', { class: 'fu-sea-nations' });
    const v = view();
    for (const n of b.nations) {
      const P = v.players[n.id];
      const op = v.opinions.get(n.id)?.score;
      const line = n.piracy
        ? t('naval.cons.piracy', { stops: stopsText(n), op: op === undefined ? '—' : String(Math.round(op)) })
        : v.pairState(HUMAN_ID, n.id) === 'war' ? t('naval.cons.war', { stops: stopsText(n) }) : t('naval.cons.none', { stops: stopsText(n) });
      box.append(h('div', { class: `fu-sea-nation${n.piracy ? ' is-bad' : ''}` },
        h('span', { class: 'fu-blk-chip', style: `background:${hexToCss(P?.color ?? 0x888888)}` }), h('b', null, hs.name(n.id)), h('span', null, line),
        n.lost > 0 ? h('span', { class: 'fu-mono' }, t('naval.cons.lost', { g: gold(n.lost) })) : null));
    }
    if (!b.nations.length) box.append(h('div', { class: 'fu-war-note' }, t('naval.cons.nobody')));
    return box;
  }

  function ourCard(b: BlockadeView): HTMLElement {
    const place = blockadePlace(hs, b);
    const acts = h('div', { class: 'fu-war-actions' },
      btn(t('fr.go'), 'target', 'fu-btn--ghost', () => fly(b.x, b.y)),
    );
    if (!b.endTick) {
      acts.append(btn(t('naval.change'), 'shield', 'fu-btn--ghost', () => openBlockadeDialog(hs, b.warships, tileOf(b.x, b.y), b.spec), () => ({ title: t('naval.change'), text: t('naval.change.tip') })));
      acts.append(btn(t('naval.lift'), 'close', 'fu-btn--ghost', () => {
        ctx.sim.send({ type: 'unitOrder', unitIds: b.warships, order: 'hold', tile: tileOf(b.x, b.y), targetId: 0 });
      }, () => ({ title: t('naval.lift'), text: t('naval.lift.tip') })));
    }
    return h('div', { class: 'fu-war-card fu-sea-card' },
      h('div', { class: 'fu-war-head' }, icon('shield'), h('b', null, place), h('span', { class: `fu-sea-state${b.active ? ' is-on' : ''}` }, stateText(b))),
      h('div', { class: 'fu-war-line is-dim' }, specText(hs, b.spec)),
      h('div', { class: 'fu-war-line fu-sea-gain' }, t('naval.gain.line', { g: gold(b.goldPerHour), total: gold(b.gold), cut: gold(b.enemyLostPerHour), troops: formatNumber(b.troopsDenied) })),
      h('div', { class: 'fu-war-line' }, stopsText(b)),
      consequences(b),
      acts,
    );
  }

  function theirCard(b: BlockadeView): HTMLElement {
    const v = view();
    const place = blockadePlace(hs, b);
    const me = b.nations.find((n) => n.id === HUMAN_ID);
    const atWar = v.pairState(HUMAN_ID, b.owner) === 'war';
    const free = freeWarships(hs);
    const acts = h('div', { class: 'fu-war-actions' }, btn(t('fr.go'), 'target', 'fu-btn--ghost', () => fly(b.x, b.y)));
    const brk = btn(t('naval.break'), 'attack', 'fu-btn--amber', () => {
      const ships = nearest(free, b.x, b.y, Math.max(1, b.warships.length + 1));
      if (!atWar || !ships.length || !b.warships.length) {
        ctx.bus.emit('toast', { text: t(!atWar ? 'naval.break.peace' : 'naval.break.none', { name: hs.name(b.owner) }), kind: 'warning', durationMs: 3500 });
        return;
      }
      ctx.sim.send({ type: 'unitOrder', unitIds: ships.map((s) => s.id), order: 'attack', tile: tileOf(b.x, b.y), targetId: b.warships[0] });
    }, () => ({ title: t('naval.break'), text: t(atWar ? 'naval.break.tip' : 'naval.break.peace', { name: hs.name(b.owner), ours: free.length, theirs: b.warships.length }) }));
    brk.disabled = !atWar || !free.length;
    const esc = btn(t('naval.escort'), 'shield', 'fu-btn--ghost', () => {
      const ours = [...v.units.values()].filter((u) => u.owner === HUMAN_ID && u.type === UnitType.TradeShip && zoneDist2(b.x, b.y, u.x, u.y) < 60 * 60);
      const ships = nearest(free, b.x, b.y, Math.min(3, ours.length));
      let n = 0;
      for (const w of ships) {
        const m = nearest(ours, w.x, w.y, 1)[0];
        if (!m) break;
        ours.splice(ours.indexOf(m), 1);
        ctx.sim.send({ type: 'unitOrder', unitIds: [w.id], order: 'escort', tile: tileOf(m.x, m.y), targetId: m.id });
        n++;
      }
      ctx.bus.emit('toast', { text: t(n ? 'naval.escort.sent' : 'naval.escort.none', { n }), kind: n ? 'info' : 'warning', durationMs: 3500 });
    }, () => ({ title: t('naval.escort'), text: t('naval.escort.tip') }));
    esc.disabled = !free.length;
    acts.append(brk, esc);
    return h('div', { class: 'fu-war-card fu-sea-card is-against' },
      h('div', { class: 'fu-war-head' }, h('span', { class: 'fu-war-swatch', style: `background:${hexToCss(v.players[b.owner]?.color ?? 0x888888)}` }), h('b', null, t('naval.against.head', { name: hs.name(b.owner), place })), h('span', { class: 'fu-sea-state is-bad' }, stateText(b))),
      h('div', { class: 'fu-war-line is-dim' }, specText(hs, b.spec)),
      h('div', { class: 'fu-war-line is-bad' }, me ? t('naval.against.loss', { stops: stopsText(me), g: gold(me.lost) }) : t('naval.against.none')),
      h('div', { class: 'fu-war-line is-dim' }, t(atWar ? 'naval.against.atWar' : 'naval.against.piracy', { name: hs.name(b.owner) })),
      acts,
    );
  }

  function strait(key: string): HTMLElement {
    const v = view();
    const ct = chokepointTile(CHOKEPOINTS.find((c) => c.key === key)!);
    const x = (ct % MAP_W) + 0.5, y = Math.floor(ct / MAP_W) + 0.5;
    const pass = shipsThrough(v, x, y);
    let enemy = 0, neutral = 0;
    for (const p of pass) {
      if (v.pairState(HUMAN_ID, p.owner) === 'war') enemy += p.trade + p.convoys;
      else neutral += p.trade + p.convoys;
    }
    const held = v.blockades.find((b) => !b.endTick && b.kind === 'strait' && b.key === key);
    const free = freeWarships(hs);
    const close = btn(t('naval.close'), 'shield', 'fu-btn--ghost', () => {
      const ships = nearest(free, x, y, 2);
      if (!ships.length) {
        ctx.bus.emit('toast', { text: t('naval.close.none'), kind: 'warning', durationMs: 3500 });
        return;
      }
      openBlockadeDialog(hs, ships.map((s) => s.id), ct);
    }, () => ({ title: t('naval.close'), text: t('naval.close.tip', { ships: nearest(free, x, y, 2).map((s) => unitName(s)).join(', ') || t('naval.close.noneShort') }) }));
    close.disabled = !free.length || (!!held && held.owner === HUMAN_ID);
    const go = btn(t('fr.go'), 'target', 'fu-btn--ghost', () => fly(x, y, 1800));
    return h('div', { class: 'fu-sea-strait' },
      h('b', null, t(`naval.cp.${key}`)),
      h('span', { class: 'fu-war-note' }, held ? t('naval.strait.held', { name: hs.name(held.owner) }) : t('naval.strait.pass', { e: enemy, n: neutral })),
      h('span', { class: 'fu-sea-strait-acts' }, go, close),
    );
  }

  function paintLedger(): void {
    const n = view().naval;
    ledger.replaceChildren(
      h('div', { class: 'fu-sea-stat is-bad' }, h('span', null, t('naval.ledger.lost')), h('b', { class: 'fu-mono' }, `−${gold(n?.lostPerHour ?? 0)}/h`), h('small', null, t('naval.ledger.total', { g: gold(n?.lostTotal ?? 0) }))),
      h('div', { class: 'fu-sea-stat is-good' }, h('span', null, t('naval.ledger.gain')), h('b', { class: 'fu-mono' }, `+${gold(n?.gainPerHour ?? 0)}/h`), h('small', null, t('naval.ledger.total', { g: gold(n?.gainTotal ?? 0) }))),
      h('div', { class: 'fu-sea-stat' }, h('span', null, t('naval.ledger.detour')), h('b', { class: 'fu-mono' }, String(n?.rerouted ?? 0)), h('small', null, t('naval.ledger.ports', { n: n?.portsBlocked ?? 0 }))),
    );
    tip(ledger, () => ({ title: t('naval.ledger.title'), text: t('naval.ledger.tip') }));
  }

  function update(): void {
    acc += ctx.frame.dt;
    const v = view();
    const key = `${v.blockades.map((b) => `${b.id}:${b.active}:${b.endTick}:${b.seized + b.sunk + b.turnedBack + b.rerouted}:${b.nations.length}`).join(',')}|${v.naval?.lostTotal ?? 0}|${v.naval?.gainTotal ?? 0}`;
    if (key === lastKey && acc < 2) return;
    lastKey = key;
    acc = 0;
    paintLedger();
    const ours = v.blockades.filter((b) => b.owner === HUMAN_ID);
    mine.replaceChildren(...(ours.length ? ours.map(ourCard) : [h('div', { class: 'fu-war-note' }, t('naval.mine.none'))]));
    const against = blockadesAgainstHuman(v);
    theirs.replaceChildren(...(against.length ? against.map(theirCard) : [h('div', { class: 'fu-war-note' }, t('naval.against.noneAll'))]));
    straits.replaceChildren(...CHOKEPOINTS.map((c) => strait(c.key)));
  }
  return { el, update };
}
